// `pdh-flow epic <action>` — Epic lifecycle dispatcher.
// Dispatches to ./epic-new.ts and ./epic-close.ts (close + cancel).

import { cmdEpicNew } from "./epic-new.ts";
import { cmdEpicCancel, cmdEpicClose } from "./epic-close.ts";

const EPIC_ACTIONS = {
  new: cmdEpicNew,
  close: cmdEpicClose,
  cancel: cmdEpicCancel,
} as const;

export async function cmdEpic(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(`pdh-flow epic — Epic lifecycle (create, close, cancel)

Usage:
  pdh-flow epic new <slug> [--title "..."] [--main-direct]
                           [--repo <dir>] [--from-ref <ref>]
       Create epics/<slug>.md and (default) the epic/<slug> branch.
       Pass --main-direct to skip the branch — file lives on main.
       Branch is created off --from-ref (default main).

  pdh-flow epic close <slug> [--dry-run] [--no-push] [--no-delete-remote]
                             [--force] [--repo <dir>]
       Close cycle. Epic-branch case: mv to epics/done/<slug>/index.md
       on the epic branch, commit, switch to main, squash-merge,
       commit, push, delete branch. Main-direct case: edit on main,
       commit, push. Refuses if any open ticket links the epic via
       frontmatter epic_id (override with --force).

  pdh-flow epic cancel <slug> --reason "..." [--dry-run] [--no-push]
                              [--no-delete-remote] [--force]
                              [--repo <dir>]
       Cancel cycle. Epic-branch case: transplant epic file to main
       with cancelled_at + cancel_reason; implementation commits on
       the branch are NOT merged. Force-delete the branch.
`);
    return;
  }
  const handler = EPIC_ACTIONS[action as keyof typeof EPIC_ACTIONS];
  if (!handler) {
    process.stderr.write(`unknown epic action: ${action}\n`);
    process.exitCode = 2;
    return;
  }
  await handler(rest);
}
