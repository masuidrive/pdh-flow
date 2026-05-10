// `pdh-flow ticket <action>` — ticket / worktree lifecycle helpers.
// Dispatches to ./ticket-new.ts (and future siblings: list, archive, …).

import { cmdTicketNew } from "./ticket-new.ts";

const TICKET_ACTIONS = {
  new: cmdTicketNew,
} as const;

export async function cmdTicket(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(`pdh-flow ticket — ticket + worktree lifecycle

Usage:
  pdh-flow ticket new <slug> [--title "..."] [--branch <name>]
                             [--path <dir>] [--repo <dir>] [--from-ref <ref>]
                             [--epic <slug>]
       Provision a new git worktree for a ticket.
       Default branch: ticket/<slug>
       Default path:   <repo-parent>/<repo-name>--<slug>
       Scaffolds tickets/<slug>.md with minimal frontmatter.
       --epic <slug>  Resolve the epic, base the worktree off its branch
                      (when branch != main), and set frontmatter epic_id.
`);
    return;
  }
  const handler = TICKET_ACTIONS[action as keyof typeof TICKET_ACTIONS];
  if (!handler) {
    process.stderr.write(`unknown ticket action: ${action}\n`);
    process.exitCode = 2;
    return;
  }
  await handler(rest);
}
