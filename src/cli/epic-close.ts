// `pdh-flow epic close <slug>` and `pdh-flow epic cancel <slug> --reason "…"`
//
// Close (epic-branch case):
//   1. switch to epic/<slug>
//   2. mv epics/<slug>.md → epics/done/<slug>/index.md, set status: closed + closed_at
//   3. commit `[epic/close] Close epic <slug>` on the epic branch
//   4. switch to main, `git merge --squash -X theirs epic/<slug>`,
//      resolve modify/delete + rename/delete residuals
//   5. commit `[epic/close] Close epic <slug>` on main
//   6. push main (unless --no-push)
//   7. force-delete epic branch locally, and remotely (unless --no-delete-remote)
//
// Close (main-direct case): edit on main, commit, push. No branch ops.
//
// Cancel (epic-branch case): transplant only the epic file (status:
// cancelled, cancelled_at, cancel_reason) to main. Implementation
// commits on the epic branch are intentionally NOT merged. Force-delete
// the branch.
//
// Cancel (main-direct case): edit on main, commit, push.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSubcommandArgs } from "./index.ts";
import {
  collectPreflight,
  resolveEpic,
  resolveEpicMergeConflicts,
  runGit,
  runGitOrThrow,
  serializeFrontmatter,
} from "./epic-helpers.ts";
import type { EpicSource, Preflight } from "./epic-helpers.ts";

interface LifecycleOptions {
  repo: string;
  slug: string;
  mode: "close" | "cancel";
  reason?: string;
  dryRun: boolean;
  noPush: boolean;
  noDeleteRemote: boolean;
  force: boolean;
}

export async function cmdEpicClose(argv: string[]): Promise<void> {
  await runLifecycle(parseLifecycleArgs(argv, "close"));
}

export async function cmdEpicCancel(argv: string[]): Promise<void> {
  const opts = parseLifecycleArgs(argv, "cancel");
  if (!opts.reason) {
    throw new Error("pdh-flow epic cancel requires --reason \"<text>\"");
  }
  await runLifecycle(opts);
}

function parseLifecycleArgs(argv: string[], mode: "close" | "cancel"): LifecycleOptions {
  const { values, positionals } = parseSubcommandArgs(argv, {
    repo: { type: "string" },
    reason: { type: "string" },
    "dry-run": { type: "boolean" },
    "no-push": { type: "boolean" },
    "no-delete-remote": { type: "boolean" },
    force: { type: "boolean" },
  });
  const slug = positionals[0];
  if (!slug) {
    throw new Error(
      `usage: pdh-flow epic ${mode} <slug>${mode === "cancel" ? " --reason \"…\"" : ""} ` +
        `[--dry-run] [--no-push] [--no-delete-remote] [--force] [--repo <dir>]`,
    );
  }
  return {
    repo: (values.repo as string | undefined) ? resolve(values.repo as string) : process.cwd(),
    slug,
    mode,
    reason: values.reason as string | undefined,
    dryRun: !!values["dry-run"],
    noPush: !!values["no-push"],
    noDeleteRemote: !!values["no-delete-remote"],
    force: !!values.force,
  };
}

async function runLifecycle(opts: LifecycleOptions): Promise<void> {
  const epic = resolveEpic(opts.repo, opts.slug);
  const branchKind: "main" | "epic" = epic.branch === "main" ? "main" : "epic";

  const preflight = collectPreflight(opts.repo, epic, opts.mode);
  printPreflight(epic, opts, preflight);
  if (!opts.force && preflight.blockers.length > 0) {
    throw new Error(
      `Preflight failed for epic ${epic.slug}:\n  - ${preflight.blockers.join("\n  - ")}\n` +
        `Resolve the blockers above, or pass --force to override at your own risk.`,
    );
  }
  if (opts.dryRun) {
    process.stdout.write("--dry-run: no changes were made.\n");
    return;
  }

  if (opts.mode === "close") {
    if (branchKind === "epic") await executeCloseEpicBranch(opts, epic);
    else await executeCloseMainDirect(opts, epic);
  } else {
    if (branchKind === "epic") await executeCancelEpicBranch(opts, epic);
    else await executeCancelMainDirect(opts, epic);
  }
}

function printPreflight(epic: EpicSource, opts: LifecycleOptions, pre: Preflight): void {
  process.stdout.write(`Epic: ${epic.slug}\n`);
  process.stdout.write(`Branch policy: ${epic.branch}\n`);
  process.stdout.write(`Mode: ${opts.mode}${opts.reason ? ` (reason: ${opts.reason})` : ""}\n`);
  process.stdout.write(`Push: ${opts.noPush ? "skip" : "push to origin"}\n`);
  process.stdout.write(`Remote branch delete: ${opts.noDeleteRemote ? "skip" : "delete after merge"}\n`);
  for (const note of pre.notes) process.stdout.write(`note: ${note}\n`);
  if (pre.blockers.length === 0) {
    process.stdout.write("Preflight: OK\n");
  } else {
    process.stdout.write("Preflight: BLOCKED\n");
    for (const b of pre.blockers) process.stdout.write(`  ✗ ${b}\n`);
  }
}

// ---------------- close: epic-branch ----------------

async function executeCloseEpicBranch(opts: LifecycleOptions, epic: EpicSource): Promise<void> {
  const stamp = new Date().toISOString();
  const closedMeta = { ...epic.meta, status: "closed", closed_at: stamp };

  runGitOrThrow(opts.repo, ["switch", epic.branch], `switch to ${epic.branch}`);

  const oldRel = join("epics", `${epic.slug}.md`);
  const newRel = join("epics", "done", epic.slug, "index.md");
  const oldAbs = join(opts.repo, oldRel);
  const newAbs = join(opts.repo, newRel);
  mkdirSync(dirname(newAbs), { recursive: true });

  // git mv when the file exists in the working tree (preserves rename
  // history). Otherwise (already moved on a previous attempt) just write.
  if (existsSync(oldAbs)) {
    runGitOrThrow(opts.repo, ["mv", oldRel, newRel], `git mv ${oldRel} → ${newRel}`);
  }
  writeFileSync(newAbs, serializeFrontmatter(closedMeta, epic.body));
  runGitOrThrow(opts.repo, ["add", "-A", "epics/"], "stage epic close changes");
  runGitOrThrow(
    opts.repo,
    ["commit", "-m", `[epic/close] Close epic ${epic.slug}`],
    "commit epic close (epic branch)",
  );

  // Squash merge into main. `-X theirs` resolves content-modify
  // conflicts in favour of the epic branch; structural conflicts
  // (modify/delete, rename/delete) are handled by the explicit pass
  // below. We don't use runGitOrThrow here because squash with
  // conflicts returns nonzero but still leaves the index in a state we
  // can resolve.
  runGitOrThrow(opts.repo, ["switch", "main"], "switch to main");
  runGit(opts.repo, ["merge", "--squash", "-X", "theirs", epic.branch]);
  resolveEpicMergeConflicts(opts.repo, epic.branch);
  runGitOrThrow(
    opts.repo,
    ["commit", "-m", `[epic/close] Close epic ${epic.slug}`],
    "commit squash merge on main",
  );

  if (!opts.noPush) {
    const push = runGit(opts.repo, ["push", "origin", "main"]);
    if (push.status !== 0) {
      process.stderr.write(`warning: push failed (continuing): ${push.stderr.trim()}\n`);
    }
  }

  // Force-delete: squash merge does not mark the branch as merged in
  // git's reachability sense, even though the work landed on main.
  runGit(opts.repo, ["branch", "-D", epic.branch]);
  if (!opts.noPush && !opts.noDeleteRemote) {
    runGit(opts.repo, ["push", "origin", "--delete", epic.branch]);
  }

  process.stdout.write(
    `Epic ${epic.slug} closed. main contains the squash merge; ${epic.branch} branch deleted.\n`,
  );
}

// ---------------- close: main-direct ----------------

async function executeCloseMainDirect(opts: LifecycleOptions, epic: EpicSource): Promise<void> {
  const stamp = new Date().toISOString();
  const closedMeta = { ...epic.meta, status: "closed", closed_at: stamp };
  const oldRel = join("epics", `${epic.slug}.md`);
  const newRel = join("epics", "done", epic.slug, "index.md");
  const oldAbs = join(opts.repo, oldRel);
  const newAbs = join(opts.repo, newRel);

  runGitOrThrow(opts.repo, ["switch", "main"], "switch to main");
  mkdirSync(dirname(newAbs), { recursive: true });
  if (existsSync(oldAbs)) {
    runGitOrThrow(opts.repo, ["mv", oldRel, newRel], `git mv ${oldRel} → ${newRel}`);
  }
  writeFileSync(newAbs, serializeFrontmatter(closedMeta, epic.body));

  runGitOrThrow(opts.repo, ["add", "-A", "epics/"], "stage epic close changes");
  runGitOrThrow(
    opts.repo,
    ["commit", "-m", `[epic/close] Close epic ${epic.slug}`],
    "commit epic close (main-direct)",
  );

  if (!opts.noPush) {
    const r = runGit(opts.repo, ["push", "origin", "main"]);
    if (r.status !== 0) {
      process.stderr.write(`warning: push failed: ${r.stderr.trim()}\n`);
    }
  }
  process.stdout.write(`Epic ${epic.slug} closed (main-direct, no branch operations).\n`);
}

// ---------------- cancel: epic-branch ----------------

async function executeCancelEpicBranch(opts: LifecycleOptions, epic: EpicSource): Promise<void> {
  const stamp = new Date().toISOString();
  const meta = {
    ...epic.meta,
    status: "cancelled",
    cancelled_at: stamp,
    cancel_reason: opts.reason ?? "",
  };
  const newRel = join("epics", "done", epic.slug, "index.md");
  const newAbs = join(opts.repo, newRel);

  runGitOrThrow(opts.repo, ["switch", "main"], "switch to main");
  mkdirSync(dirname(newAbs), { recursive: true });
  writeFileSync(newAbs, serializeFrontmatter(meta, epic.body));

  // Best-effort: copy any artefacts under epics/done/<slug>/ from the
  // epic branch (verification.md, screenshots/, etc.). We never copy
  // tickets/, src/, etc. — those are the implementation commits we are
  // intentionally discarding.
  transplantArtefacts(opts.repo, epic.branch, epic.slug);

  runGitOrThrow(opts.repo, ["add", "-A", "epics/"], "stage epic cancel changes");
  runGitOrThrow(
    opts.repo,
    ["commit", "-m", `[epic/cancel] Cancel epic ${epic.slug}: ${opts.reason ?? "(no reason)"}`],
    "commit epic cancel",
  );

  if (!opts.noPush) {
    const r = runGit(opts.repo, ["push", "origin", "main"]);
    if (r.status !== 0) {
      process.stderr.write(`warning: push failed: ${r.stderr.trim()}\n`);
    }
  }
  // Force-delete because impl commits are intentionally not merged.
  runGit(opts.repo, ["branch", "-D", epic.branch]);
  if (!opts.noPush && !opts.noDeleteRemote) {
    runGit(opts.repo, ["push", "origin", "--delete", epic.branch]);
  }
  process.stdout.write(
    `Epic ${epic.slug} cancelled. Implementation commits on ${epic.branch} were NOT merged into main.\n`,
  );
}

// ---------------- cancel: main-direct ----------------

async function executeCancelMainDirect(opts: LifecycleOptions, epic: EpicSource): Promise<void> {
  const stamp = new Date().toISOString();
  const meta = {
    ...epic.meta,
    status: "cancelled",
    cancelled_at: stamp,
    cancel_reason: opts.reason ?? "",
  };
  const oldRel = join("epics", `${epic.slug}.md`);
  const newRel = join("epics", "done", epic.slug, "index.md");
  const oldAbs = join(opts.repo, oldRel);
  const newAbs = join(opts.repo, newRel);

  runGitOrThrow(opts.repo, ["switch", "main"], "switch to main");
  mkdirSync(dirname(newAbs), { recursive: true });
  if (existsSync(oldAbs)) {
    runGitOrThrow(opts.repo, ["mv", oldRel, newRel], `git mv ${oldRel} → ${newRel}`);
  }
  writeFileSync(newAbs, serializeFrontmatter(meta, epic.body));

  runGitOrThrow(opts.repo, ["add", "-A", "epics/"], "stage epic cancel changes");
  runGitOrThrow(
    opts.repo,
    ["commit", "-m", `[epic/cancel] Cancel epic ${epic.slug}: ${opts.reason ?? "(no reason)"}`],
    "commit epic cancel",
  );

  if (!opts.noPush) {
    const r = runGit(opts.repo, ["push", "origin", "main"]);
    if (r.status !== 0) {
      process.stderr.write(`warning: push failed: ${r.stderr.trim()}\n`);
    }
  }
  process.stdout.write(`Epic ${epic.slug} cancelled (main-direct).\n`);
}

function transplantArtefacts(repo: string, branch: string, slug: string): void {
  const ls = runGit(repo, ["ls-tree", "-r", "--name-only", branch, "--", `epics/done/${slug}/`]);
  if (ls.status !== 0 || !ls.stdout.trim()) return;
  for (const file of ls.stdout.trim().split(/\r?\n/)) {
    if (!file) continue;
    if (file === `epics/done/${slug}/index.md`) continue; // we wrote our own version
    const show = runGit(repo, ["show", `${branch}:${file}`]);
    if (show.status !== 0) continue;
    const target = join(repo, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, show.stdout);
  }
}
