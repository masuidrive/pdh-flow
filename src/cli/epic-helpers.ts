// Shared helpers for the epic CLI commands.
//
// Mirrors pdh-flow v1 src/cli/epic.ts (close + cancel cycle), lightly
// adapted for v2 conventions:
//   - `epic_id` is slug-style, matching v2 ticket-new (the historical
//     YYMMDD-HHMMSS-<slug> TicketId form is too rigid for hand-authored
//     epics)
//   - linked-ticket detection scans frontmatter `epic_id: <slug>` (v1
//     used `epic: <slug>`)
//   - commit subjects use `[epic/<phase>] …` to align with the v2
//     "single commit owner with phase prefix" convention
//
// Branch policy lives entirely in the epic frontmatter `branch` field:
// `branch: epic/<slug>` triggers the epic-branch close path
// (squash-merge to main); `branch: main` triggers the main-direct path
// (no branch ops, just edit on main).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const EPIC_SLUG_RE = /^[a-z][a-z0-9._-]{0,79}$/;

export interface EpicMeta {
  version: 1;
  epic_id: string;
  title: string;
  status: "open" | "in_progress" | "closed" | "cancelled";
  branch: string;
  created_at: string;
  started_at?: string;
  closed_at?: string;
  cancelled_at?: string;
  cancel_reason?: string;
  [k: string]: unknown;
}

export interface EpicSource {
  slug: string;
  branch: string;
  meta: EpicMeta;
  body: string;
  origin: "main" | "branch";
  pathOnMain: string;
}

export interface Preflight {
  blockers: string[];
  notes: string[];
  openTickets: string[];
}

export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: Record<string, unknown> = {};
  try {
    meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { meta, body: text.slice(m[0].length) };
}

export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  const yamlText = stringifyYaml(meta).trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}

export function runGit(repo: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

export function runGitOrThrow(repo: string, args: string[], description: string) {
  const r = runGit(repo, args);
  if (r.status !== 0) {
    throw new Error(
      `git failed (${description}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r;
}

export function gitBranchExists(repo: string, branch: string): boolean {
  return runGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]).status === 0;
}

export function gitCurrentBranch(repo: string): string {
  return runGitOrThrow(repo, ["rev-parse", "--abbrev-ref", "HEAD"], "rev-parse HEAD").stdout.trim();
}

export function listEpicBranches(repo: string): string[] {
  const r = runGit(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/epic/*"]);
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

// Resolve an epic file by slug. Tries main first via `git show`, then
// scans every epic/* branch — the file slug is canonical, the branch
// name doesn't have to match (mirrors v1).
export function resolveEpic(repo: string, slug: string): EpicSource {
  const slugClean = slug.trim().replace(/\.md$/u, "");
  if (!EPIC_SLUG_RE.test(slugClean)) {
    throw new Error(
      `invalid epic slug ${JSON.stringify(slug)}: must match ${EPIC_SLUG_RE} (lowercase, starts with a letter)`,
    );
  }
  const mainPath = join(repo, "epics", `${slugClean}.md`);

  const onMain = runGit(repo, ["show", `main:epics/${slugClean}.md`]);
  if (onMain.status === 0) {
    const { meta, body } = splitFrontmatter(onMain.stdout);
    const branch = stringField(meta.branch) || "main";
    return { slug: slugClean, branch, meta: meta as EpicMeta, body, origin: "main", pathOnMain: mainPath };
  }

  for (const branchName of listEpicBranches(repo)) {
    const r = runGit(repo, ["show", `${branchName}:epics/${slugClean}.md`]);
    if (r.status !== 0) continue;
    const { meta, body } = splitFrontmatter(r.stdout);
    const branch = stringField(meta.branch) || branchName;
    return { slug: slugClean, branch, meta: meta as EpicMeta, body, origin: "branch", pathOnMain: mainPath };
  }

  const branches = listEpicBranches(repo);
  throw new Error(
    `Epic ${slugClean} not found: epics/${slugClean}.md is missing on main and on every epic/* branch. ` +
      `Looked at: main, ${branches.length ? branches.join(", ") : "(no epic/* branches)"}.`,
  );
}

export function collectPreflight(
  repo: string,
  epic: EpicSource,
  mode: "close" | "cancel",
): Preflight {
  const blockers: string[] = [];
  const notes: string[] = [];

  if (mode === "close" && epic.meta.closed_at) {
    blockers.push(`Epic frontmatter already has closed_at=${String(epic.meta.closed_at)}; appears already closed.`);
  }
  if (mode === "cancel" && epic.meta.cancelled_at) {
    blockers.push(`Epic frontmatter already has cancelled_at=${String(epic.meta.cancelled_at)}; appears already cancelled.`);
  }

  const status = runGit(repo, ["status", "--short"]);
  if (status.stdout.trim().length > 0) {
    blockers.push(
      `Working tree is dirty:\n${status.stdout.trim().split("\n").map((l) => "    " + l).join("\n")}\n` +
        `  Commit, stash, or discard the changes before retrying.`,
    );
  }

  const onEpicBranch = epic.branch !== "main";
  if (onEpicBranch && !gitBranchExists(repo, epic.branch)) {
    blockers.push(`Epic frontmatter says branch=${epic.branch} but that branch does not exist locally.`);
  }

  const openTickets = findOpenLinkedTickets(repo, epic.slug, onEpicBranch ? epic.branch : null);
  if (openTickets.length > 0) {
    blockers.push(
      `Epic still has ${openTickets.length} open ticket(s) linked to it:\n` +
        openTickets.map((t) => "    " + t).join("\n") +
        `\n  Move them to tickets/done/ (or pass --force to override).`,
    );
  }

  if (mode === "close" && onEpicBranch) {
    const merge = simulateMerge(repo, epic.branch);
    if (merge.conflict) {
      blockers.push(
        `Merging ${epic.branch} into main would conflict:\n${merge.detail.split("\n").map((l) => "    " + l).join("\n")}`,
      );
    }
  }

  if (epic.origin === "main") {
    notes.push(`Epic file resolved on main (${epic.pathOnMain}).`);
  } else {
    notes.push(`Epic file resolved via git show ${epic.branch}:epics/${epic.slug}.md`);
  }

  return { blockers, notes, openTickets };
}

export function findOpenLinkedTickets(repo: string, epicSlug: string, epicBranch: string | null): string[] {
  const open: string[] = [];
  // Working-tree scan on main / current checkout (we don't switch here —
  // preflight runs before any branch ops).
  const mainTicketsDir = join(repo, "tickets");
  if (existsSync(mainTicketsDir)) {
    for (const entry of readdirSync(mainTicketsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name === "README.md") continue;
      const text = readFileSync(join(mainTicketsDir, entry.name), "utf8");
      const { meta } = splitFrontmatter(text);
      const e = stringField(meta.epic_id);
      if (e && e === epicSlug) open.push(`tickets/${entry.name} (working tree)`);
    }
  }
  // For epic-branch case also look at the epic branch itself — there may
  // be tickets there that haven't been merged out.
  if (epicBranch) {
    const ls = runGit(repo, ["ls-tree", "-r", "--name-only", epicBranch, "--", "tickets/"]);
    if (ls.status === 0) {
      for (const path of ls.stdout.trim().split(/\r?\n/)) {
        if (!path) continue;
        if (!path.endsWith(".md")) continue;
        if (path === "tickets/README.md") continue;
        if (path.startsWith("tickets/done/")) continue;
        const show = runGit(repo, ["show", `${epicBranch}:${path}`]);
        if (show.status !== 0) continue;
        const { meta } = splitFrontmatter(show.stdout);
        const e = stringField(meta.epic_id);
        if (e && e === epicSlug) open.push(`${path} (on ${epicBranch})`);
      }
    }
  }
  return open;
}

// Squash-merge dry-run. Snapshots HEAD + main's sha, performs `merge
// --squash -X theirs`, attempts conflict resolution, then resets main
// back. Returns whether residual unmerged paths remain.
export function simulateMerge(repo: string, branch: string): { conflict: boolean; detail: string } {
  const headRef = runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (headRef.status !== 0) return { conflict: false, detail: "" };
  const originalRef = headRef.stdout.trim();
  const mainBefore = runGit(repo, ["rev-parse", "main"]);
  if (mainBefore.status !== 0) {
    return { conflict: true, detail: `Could not resolve main sha: ${mainBefore.stderr.trim()}` };
  }
  const mainSha = mainBefore.stdout.trim();
  const switched = originalRef !== "main";
  if (switched) {
    const sw = runGit(repo, ["switch", "main"]);
    if (sw.status !== 0) {
      return { conflict: true, detail: `Could not switch to main for merge dry-run: ${sw.stderr.trim()}` };
    }
  }
  const merge = runGit(repo, ["merge", "--squash", "-X", "theirs", branch]);
  try {
    resolveEpicMergeConflicts(repo, branch);
  } catch {
    // ignore — residual check below catches actual leftovers
  }
  const residual = runGit(repo, ["diff", "--name-only", "--diff-filter=U"]);
  const conflict = residual.status === 0 && residual.stdout.trim().length > 0;
  let detail = "";
  if (conflict) {
    const stderr = `${merge.stdout.trim()}\n${merge.stderr.trim()}`.trim();
    detail = `Unresolvable paths after auto-resolve:\n  ${residual.stdout.trim().split(/\r?\n/u).join("\n  ")}\n\n--- raw merge output ---\n${stderr}`;
  } else if (merge.status !== 0) {
    detail = `Merge had conflicts but auto-resolve handled them: ${merge.stdout.trim().split(/\r?\n/u).slice(0, 3).join(" / ")}`;
  }
  runGit(repo, ["reset", "--hard", mainSha]);
  if (switched) runGit(repo, ["switch", originalRef]);
  return { conflict, detail };
}

// After `git merge --squash -X theirs <branch>`, walk unmerged paths
// and force the epic-branch's view (or `git rm` if the file was deleted
// on the epic branch). Handles modify/delete + rename/delete which
// `-X theirs` cannot auto-resolve.
export function resolveEpicMergeConflicts(repo: string, epicBranch: string): void {
  const status = runGit(repo, ["diff", "--name-only", "--diff-filter=U"]);
  if (status.status !== 0) return;
  const paths = status.stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) return;
  for (const path of paths) {
    const onEpic = runGit(repo, ["cat-file", "-e", `${epicBranch}:${path}`]);
    if (onEpic.status === 0) {
      runGitOrThrow(repo, ["checkout", "--theirs", "--", path], `take theirs for ${path}`);
      runGitOrThrow(repo, ["add", path], `stage resolved ${path}`);
    } else {
      runGitOrThrow(repo, ["rm", "-f", path], `remove ${path} (not on ${epicBranch})`);
    }
  }
}

function stringField(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
