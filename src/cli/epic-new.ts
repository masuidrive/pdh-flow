// `pdh-flow epic new <slug>` — create an Epic file + the epic branch.
//
// Default branch policy is `epic/<slug>` so subsequent `pdh-flow ticket
// new --epic <slug>` calls can branch off it. Pass --main-direct for
// the no-branch flavour (epic body lives on main and tickets branch off
// main as usual).
//
// We write epics/<slug>.md with the v2 epic-frontmatter shape and one
// commit `[epic/new] Create epic <slug>` on whichever branch policy
// applies. The user is expected to fill in Outcome / Scope / Exit
// Criteria afterwards (the stub leaves placeholders).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSubcommandArgs } from "./index.ts";
import {
  EPIC_SLUG_RE,
  gitBranchExists,
  gitCurrentBranch,
  runGit,
  runGitOrThrow,
  serializeFrontmatter,
} from "./epic-helpers.ts";

export async function cmdEpicNew(argv: string[]): Promise<void> {
  const { values, positionals } = parseSubcommandArgs(argv, {
    title: { type: "string" },
    "main-direct": { type: "boolean" },
    repo: { type: "string" },
    "from-ref": { type: "string" },
  });

  const slug = positionals[0];
  if (!slug) {
    throw new Error("usage: pdh-flow epic new <slug> [--title \"…\"] [--main-direct] [--repo <dir>] [--from-ref <ref>]");
  }
  if (!EPIC_SLUG_RE.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)}: must match ${EPIC_SLUG_RE} (lowercase, starts with letter)`);
  }

  const repo = (values.repo as string | undefined) ? resolve(values.repo as string) : process.cwd();
  const title = (values.title as string | undefined) ?? slug;
  const mainDirect = !!values["main-direct"];
  const branchPolicy = mainDirect ? "main" : `epic/${slug}`;
  const fromRef = (values["from-ref"] as string | undefined) ?? "main";

  // Refuse if the file or branch we'd create already exists. We check
  // main via `git show` (works regardless of the current checkout) and
  // the branch via `rev-parse --verify`.
  const onMain = runGit(repo, ["show", `main:epics/${slug}.md`]);
  if (onMain.status === 0) {
    throw new Error(`Epic already exists on main: epics/${slug}.md`);
  }
  if (!mainDirect && gitBranchExists(repo, branchPolicy)) {
    throw new Error(`Epic branch already exists: ${branchPolicy}`);
  }

  // Working tree must be clean — we're about to commit and possibly
  // switch branches. Stale uncommitted edits would either get pulled
  // into the epic commit or cause `git switch` to refuse.
  const status = runGit(repo, ["status", "--short"]);
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `Working tree dirty:\n${status.stdout.trim()}\nCommit / stash / discard before creating an epic.`,
    );
  }

  const originalBranch = gitCurrentBranch(repo);
  let switchedToBranch: string | null = null;

  try {
    if (!mainDirect) {
      runGitOrThrow(repo, ["switch", "-c", branchPolicy, fromRef], `git switch -c ${branchPolicy} ${fromRef}`);
      switchedToBranch = branchPolicy;
    } else if (originalBranch !== "main") {
      runGitOrThrow(repo, ["switch", "main"], "git switch main");
      switchedToBranch = "main";
    }

    const epicFile = join(repo, "epics", `${slug}.md`);
    mkdirSync(dirname(epicFile), { recursive: true });
    writeFileSync(epicFile, renderEpicStub({ slug, title, branch: branchPolicy }), "utf8");

    runGitOrThrow(repo, ["add", "--", `epics/${slug}.md`], "git add epic");
    runGitOrThrow(repo, ["commit", "-m", `[epic/new] Create epic ${slug}`], "commit new epic");
  } catch (err) {
    // Best-effort cleanup: switch back to the user's branch and drop the
    // half-made epic branch so they can retry without manual surgery.
    if (switchedToBranch && switchedToBranch !== originalBranch) {
      runGit(repo, ["switch", originalBranch]);
      if (switchedToBranch !== "main") runGit(repo, ["branch", "-D", switchedToBranch]);
    }
    throw err;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    slug,
    title,
    branch: branchPolicy,
    epic_file: `epics/${slug}.md`,
    next_steps: [
      `# fill in epics/${slug}.md (Outcome / Scope / Exit Criteria)`,
      `pdh-flow ticket new --epic ${slug} <ticket-slug>`,
      `pdh-flow epic close ${slug}  # once all linked tickets are done`,
    ],
  }, null, 2) + "\n");
}

function renderEpicStub(args: { slug: string; title: string; branch: string }): string {
  const meta = {
    version: 1,
    epic_id: args.slug,
    title: args.title,
    status: "open",
    branch: args.branch,
    created_at: new Date().toISOString(),
  };
  const body = [
    "",
    `# ${args.title}`,
    "",
    "## Outcome",
    "",
    "(when this epic completes, what new capability exists?)",
    "",
    "## Problem",
    "",
    "(what problem does this directly solve?)",
    "",
    "## Scope",
    "",
    "(concrete deliverables — granular enough that \"is X in scope\" is unambiguous)",
    "",
    "## Non-goals",
    "",
    "(what we are deliberately NOT doing — name the AI-temptations to drift into)",
    "",
    "## Exit Criteria",
    "",
    "(when these are true, close the epic. all linked tickets done is necessary but not sufficient)",
    "",
    "## Tickets",
    "",
    "(filled as tickets are cut)",
    "",
  ].join("\n");
  return serializeFrontmatter(meta, body);
}
