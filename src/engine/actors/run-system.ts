// system_step actor.
//
// Action dispatcher for deterministic runtime work. Each action is
// idempotent — re-invocation should produce the same result.
//
//   close_ticket      — write a "closed" marker; if ticket.sh exists,
//                       invoke it (best-effort). Real impl will move the
//                       ticket file from tickets/active/ → tickets/done/.
//   close_epic        — shell out to `ticket.sh epic close <slug>`; the
//                       branch ops + squash-merge live entirely in
//                       ticket.sh (see scripts/dev/ticket.sh and the
//                       gist spec). Engine just reports the outcome.
//   release_lease     — stub (lease integration lives in Phase H4)
//   cleanup_worktree  — stub (no-op success)
//   barrier           — no-op (real barrier is XState parallel.onDone)
//   noop              — no-op success

import { fromPromise } from "xstate";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  acquireForTicket,
  LeaseConfigError,
  LeaseExhaustedError,
  releaseForTicket,
} from "../leases/leases.ts";
import { writeEnvLease, removeEnvLease } from "../leases/env-lease.ts";

export interface SystemActorInput {
  nodeId: string;
  action: string;
  worktreePath: string;
  runId?: string;
  /** Required for acquire_lease / release_lease actions. */
  ticketId?: string;
  /** Required for close_epic. Set by the engine when --epic was passed
   * to run-engine; close_epic shells to ticket.sh with this slug. */
  epicId?: string;
  params?: Record<string, unknown>;
}

export interface SystemActorOutput {
  status: "completed" | "failed";
  nodeId: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

export const runSystem = fromPromise<SystemActorOutput, SystemActorInput>(
  async ({ input }) => {
    const { nodeId, action, worktreePath } = input;
    switch (action) {
      case "close_ticket":
        return closeTicket({
          nodeId,
          worktreePath,
          runId: input.runId,
          ticketId: input.ticketId,
        });
      case "close_epic":
        return closeEpic({
          nodeId,
          worktreePath,
          runId: input.runId,
          epicId: input.epicId,
          params: input.params,
        });
      case "acquire_lease":
        return acquireLeaseAction({
          nodeId,
          worktreePath,
          ticketId: input.ticketId,
        });
      case "release_lease":
        return releaseLeaseAction({
          nodeId,
          worktreePath,
          ticketId: input.ticketId,
        });
      case "cleanup_worktree":
      case "barrier":
      case "noop":
        return {
          status: "completed",
          nodeId,
          action,
          summary: `system_step ${action} (stub)`,
        };
      default:
        throw new Error(`system_step unknown action: ${action}`);
    }
  },
);

async function acquireLeaseAction(p: {
  nodeId: string;
  worktreePath: string;
  ticketId?: string;
}): Promise<SystemActorOutput> {
  if (!p.ticketId) {
    throw new Error(
      "system_step acquire_lease requires ticketId in actor input (engine should derive from current-note frontmatter)",
    );
  }
  try {
    const result = await acquireForTicket({
      mainRepo: p.worktreePath,
      ticketId: p.ticketId,
      worktree: p.worktreePath,
    });
    if (result.leases.length > 0) {
      writeEnvLease(p.worktreePath, result.leases);
    }
    return {
      status: "completed",
      nodeId: p.nodeId,
      action: "acquire_lease",
      summary: `acquired ${result.leases.length} lease(s)`,
      details: {
        leases: result.leases.map((l) => ({
          pool: l.pool,
          kind: l.kind,
          value: l.value,
          env: l.env,
        })),
        reclaimed_count: result.reclaimed.length,
      },
    };
  } catch (e) {
    if (e instanceof LeaseConfigError || e instanceof LeaseExhaustedError) {
      return {
        status: "failed",
        nodeId: p.nodeId,
        action: "acquire_lease",
        summary: `lease acquire failed: ${e.message}`,
      };
    }
    throw e;
  }
}

async function releaseLeaseAction(p: {
  nodeId: string;
  worktreePath: string;
  ticketId?: string;
}): Promise<SystemActorOutput> {
  if (!p.ticketId) {
    throw new Error("system_step release_lease requires ticketId");
  }
  const result = await releaseForTicket({
    mainRepo: p.worktreePath,
    ticketId: p.ticketId,
  });
  removeEnvLease(p.worktreePath);
  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "release_lease",
    summary: `released ${result.released.length} lease(s)`,
    details: {
      released: result.released.map((l) => ({
        pool: l.pool,
        kind: l.kind,
        value: l.value,
      })),
    },
  };
}

function closeTicket(p: {
  nodeId: string;
  worktreePath: string;
  runId?: string;
  ticketId?: string;
}): SystemActorOutput {
  // F-011/H10-2: durable close lives in ticket + note frontmatter, not
  // in `.pdh-flow/runs/<runId>/closed.json`. The .pdh-flow tree is now
  // ephemeral — wiping it must not lose the "this ticket is closed" fact.
  const closedAt = new Date().toISOString();
  const updated: string[] = [];

  if (p.ticketId) {
    const ticketPath = join(p.worktreePath, "tickets", `${p.ticketId}.md`);
    if (
      mergeFrontmatter(ticketPath, { status: "done", closed_at: closedAt })
    ) {
      updated.push(`tickets/${p.ticketId}.md`);
    }
    const notePath = join(
      p.worktreePath,
      "tickets",
      `${p.ticketId}-note.md`,
    );
    if (
      mergeFrontmatter(notePath, {
        status: "completed",
        completed_at: closedAt,
      })
    ) {
      updated.push(`tickets/${p.ticketId}-note.md`);
    }

    // F-011/H10-7 (Gap C): append `# Resolution` to the ticket so a
    // future reader gets the ticket-level outcome (status, who closed,
    // when, and a pointer to known limitations) without diving into
    // the note prose. Best-effort — gate decisions live in
    // `.pdh-flow/runs/<runId>/gates/` while the run is in-flight.
    if (existsSync(ticketPath)) {
      const closeApprover = p.runId
        ? readGateApprover(p.worktreePath, p.runId, "close_gate")
        : null;
      const hasOutOfScope = readFileSync(ticketPath, "utf8").includes(
        "# Out of scope",
      );
      const lines: string[] = [];
      if (!readFileSync(ticketPath, "utf8").includes("# Resolution")) {
        lines.push("", "# Resolution", "");
      } else {
        lines.push("");
      }
      lines.push(`- **Status**: closed`);
      lines.push(`- **Closed_at**: ${closedAt}`);
      if (closeApprover) {
        lines.push(`- **Approved_by**: ${closeApprover}`);
      }
      if (p.runId) {
        lines.push(`- **Run_id**: ${p.runId}`);
      }
      if (hasOutOfScope) {
        lines.push(
          "- **Known limitations**: see `# Out of scope` section above.",
        );
      }
      lines.push(
        "- **Follow-ups**: see `tickets/` for any new tickets opened to address deferred items.",
      );
      appendFileSync(ticketPath, lines.join("\n") + "\n");
      updated.push(`tickets/${p.ticketId}.md (Resolution)`);
    }
  }

  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "close_ticket",
    summary: `ticket closed (${updated.length} edit(s))`,
    details: {
      closed_at: closedAt,
      ticket_id: p.ticketId ?? null,
      updated,
    },
  };
}

function readGateApprover(
  worktreePath: string,
  runId: string,
  gateNodeId: string,
): string | null {
  const path = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "gates",
    `${gateNodeId}.json`,
  );
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf8"));
    return typeof obj.approver === "string" && obj.approver.trim().length > 0
      ? obj.approver.trim()
      : null;
  } catch {
    return null;
  }
}

// Locate the ticket.sh executable. Resolution order:
//   1. PDH_FLOW_TICKET_SH env var (explicit override; CI / dev tests)
//   2. <worktree>/ticket.sh (project-installed; the normal user setup)
//   3. <pdh-flow source root>/scripts/dev/ticket.sh (vendored copy)
// Returns null if none found; caller must surface a clear failure.
function resolveTicketSh(worktreePath: string): string | null {
  const envOverride = process.env.PDH_FLOW_TICKET_SH;
  if (envOverride && existsSync(envOverride)) return envOverride;
  const local = join(worktreePath, "ticket.sh");
  if (existsSync(local)) return local;
  // src/engine/actors/run-system.ts → up to pdh-flow root → scripts/dev/
  const vendored = join(__dirname, "..", "..", "..", "scripts", "dev", "ticket.sh");
  if (existsSync(vendored)) return vendored;
  return null;
}

function closeEpic(p: {
  nodeId: string;
  worktreePath: string;
  runId?: string;
  epicId?: string;
  params?: Record<string, unknown>;
}): SystemActorOutput {
  // We THROW on failure (rather than returning {status: "failed"}) so
  // xstate routes to the actor's onError → the system_step's on_failure
  // transition (human_intervention in pdh-d). A returned object is
  // treated as a successful resolve and runs onDone, which would
  // silently mark the epic as closed even when ticket.sh failed.
  if (!p.epicId) {
    throw new Error("close_epic requires epic slug (pass --epic <slug> to run-engine)");
  }
  const ts = resolveTicketSh(p.worktreePath);
  if (!ts) {
    throw new Error(
      `ticket.sh not found (looked at $PDH_FLOW_TICKET_SH, ${p.worktreePath}/ticket.sh, ` +
        `<pdh-flow>/scripts/dev/ticket.sh). Install ticket.sh or copy the vendored stub.`,
    );
  }
  // The system_step's `params` block in the flow YAML can pin push +
  // remote-delete behaviour per environment. Defaults err on the safe
  // side (no push, no remote delete) so a misconfigured run doesn't
  // mutate origin unexpectedly. Override via params: { push: true }.
  const push = (p.params?.push as boolean | undefined) ?? false;
  const deleteRemote = (p.params?.delete_remote as boolean | undefined) ?? false;
  const args = ["epic", "close", p.epicId];
  if (!push) args.push("--no-push");
  if (!deleteRemote) args.push("--no-delete-remote");

  const r = spawnSync(ts, args, {
    cwd: p.worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  if (r.status !== 0) {
    throw new Error(
      `ticket.sh epic close failed (exit ${r.status}) for epic=${p.epicId} via ${ts}\n` +
        `stderr: ${stderr || "(empty)"}\n` +
        `stdout: ${stdout || "(empty)"}`,
    );
  }
  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "close_epic",
    summary: `epic ${p.epicId} closed via ticket.sh`,
    details: {
      epic_id: p.epicId,
      ticket_sh_path: ts,
      args,
      stdout,
      stderr,
    },
  };
}

// Merge `updates` into the YAML frontmatter of `path`. Existing keys are
// replaced in place; missing keys are appended at the end of the
// frontmatter block. Returns true on success, false if the file does not
// exist or has no frontmatter block.
function mergeFrontmatter(
  path: string,
  updates: Record<string, string>,
): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return false;
  let fm = m[1];
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}:.*$`, "m");
    const line = `${key}: ${value}`;
    if (re.test(fm)) {
      fm = fm.replace(re, line);
    } else {
      fm = fm.replace(/\s*$/, "") + `\n${line}`;
    }
  }
  const rest = content.slice(m[0].length);
  writeFileSync(path, `---\n${fm}\n---\n${rest}`);
  return true;
}
