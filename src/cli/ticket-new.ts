// `pdh-flow ticket new <slug>` — provision a fresh worktree + ticket file.
//
// Goal: let a PdM open a second (third, …) ticket without manually wrestling
// with `git worktree add`, ticket-frontmatter boilerplate, and remembering
// where the new tree lives. The worktree is a real `git worktree`, so:
//  - source / .git refs are shared with the host repo,
//  - `.pdh-flow/` is per-checkout (gitignored), so each ticket gets its own
//    runs/, judgements/, leases/, evidence/ etc.,
//  - branches don't collide because each ticket lives on its own branch.
//
// We deliberately do NOT spawn run-engine here. The user composes that
// step themselves (or via a separate `pdh-flow ticket run` command we may
// add later), so this stays the sole concern of "set up the workspace".

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseSubcommandArgs } from "./index.ts";
import { resolveEpic } from "./epic-helpers.ts";

const TICKET_SLUG_RE = /^[a-z][a-z0-9._-]{0,79}$/;

export async function cmdTicketNew(argv: string[]): Promise<void> {
  const { values, positionals } = parseSubcommandArgs(argv, {
    title: { type: "string" },
    branch: { type: "string" },
    path: { type: "string" },
    repo: { type: "string" },
    "from-ref": { type: "string" },
    epic: { type: "string" },
  });

  const slug = positionals[0];
  if (!slug) throw new Error("usage: pdh-flow ticket new <slug> [--title …] [--branch …] [--path …] [--epic <slug>]");
  if (!TICKET_SLUG_RE.test(slug)) {
    throw new Error(
      `invalid slug ${JSON.stringify(slug)}: must match ${TICKET_SLUG_RE} (lowercase, starts with letter)`,
    );
  }

  const repoPath = (values.repo as string | undefined)
    ? resolve(values.repo as string)
    : process.cwd();
  const branch = (values.branch as string | undefined) ?? `ticket/${slug}`;
  const explicitFromRef = values["from-ref"] as string | undefined;
  const title = (values.title as string | undefined) ?? slug;

  // --epic <slug>: resolve the epic and (when it has a branch policy
  // beyond plain main) default --from-ref to that branch so the worktree
  // is based on the epic's history rather than main. The user can still
  // override by passing --from-ref explicitly. The ticket frontmatter
  // gets epic_id set so close/cancel preflight can find it.
  const epicSlug = values.epic as string | undefined;
  let epicId: string | undefined;
  let fromRef = explicitFromRef ?? "HEAD";
  if (epicSlug) {
    const epic = resolveEpic(repoPath, epicSlug);
    epicId = epic.slug;
    if (!explicitFromRef && epic.branch !== "main") {
      fromRef = epic.branch;
    }
  }

  const targetPath = resolveWorktreePath(values.path as string | undefined, repoPath, slug);
  if (existsSync(targetPath)) {
    throw new Error(`worktree path already exists: ${targetPath}`);
  }
  ensureParentDir(targetPath);

  // Create the worktree on a new branch from the requested ref.
  // `-b` fails if the branch already exists, which is the right check —
  // re-using a stale ticket branch would give the user a worktree pointing
  // at someone else's history.
  try {
    execFileSync(
      "git",
      ["worktree", "add", "-b", branch, targetPath, fromRef],
      { cwd: repoPath, stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch (e) {
    throw new Error(
      `git worktree add failed (branch=${branch}, target=${targetPath}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // Scaffold tickets/<slug>.md with minimal valid frontmatter so that
  // `pdh-flow run-engine --ticket <slug>` can immediately consume it.
  const ticketsDir = resolve(targetPath, "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  const ticketFile = resolve(ticketsDir, `${slug}.md`);
  if (!existsSync(ticketFile)) {
    writeFileSync(ticketFile, renderTicketStub({ slug, title, epicId }), "utf8");
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        slug,
        worktree_path: targetPath,
        branch,
        from_ref: fromRef,
        epic_id: epicId ?? null,
        ticket_file: ticketFile,
        next_steps: [
          `cd ${targetPath}`,
          `# fill in tickets/${slug}.md (Why / What / Acceptance Criteria)`,
          `pdh-flow run-engine --worktree . --ticket ${slug} --flow pdh-c-v2`,
          `pdh-flow serve --worktree . --port <free-port>`,
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

function resolveWorktreePath(
  raw: string | undefined,
  repoPath: string,
  slug: string,
): string {
  if (raw) return isAbsolute(raw) ? raw : resolve(repoPath, raw);
  // Default placement: sibling directory `<repo>--<slug>`. We deliberately
  // don't put worktrees under `.pdh-flow/` because that path is gitignored
  // per-checkout and putting a worktree inside another worktree is asking
  // for nested-.git confusion.
  const parent = dirname(repoPath);
  const repoName = basename(repoPath);
  return resolve(parent, `${repoName}--${slug}`);
}

function ensureParentDir(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function renderTicketStub({ slug, title, epicId }: { slug: string; title: string; epicId?: string }): string {
  const now = new Date().toISOString();
  // Minimal frontmatter that satisfies ticket-frontmatter.schema.json:
  // version, ticket_id, title, status, created_at are required. Anything
  // else (priority, ac, labels) the human / agent can fill in.
  const epicLine = epicId ? `\nepic_id: ${epicId}` : "";
  return `---
version: 1
ticket_id: ${slug}
title: ${JSON.stringify(title)}
status: open
created_at: ${JSON.stringify(now)}${epicLine}
---

## ${title}

### Why

(why this ticket exists — link the product-brief section it serves)

### What

(behavioural change in user-visible terms)

### Acceptance Criteria

- AC-1: (testable assertion)
`;
}
