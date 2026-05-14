// system_step actor.
//
// Action dispatcher for deterministic runtime work. Each action is
// idempotent — re-invocation should produce the same result.
//
//   close_ticket      — write frontmatter status/closed_at, append `# Resolution`,
//                       update the Epic file's `## Tickets` checkbox (A4),
//                       commit the close-time edits, then invoke
//                       `ticket.sh close <slug>` (A2). All ticket.sh
//                       invocations are wrapped in `flock -x <lock>` so
//                       parallel-epic worktrees don't race on the shared
//                       tickets/ tree and Epic file (A3).
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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
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
          params: input.params,
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
      case "run_qa_script":
        return runQaScript({
          nodeId,
          worktreePath,
          runId: input.runId,
          params: input.params,
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
  params?: Record<string, unknown>;
}): SystemActorOutput {
  // F-011/H10-2: durable close lives in ticket + note frontmatter, not
  // in `.pdh-flow/runs/<runId>/closed.json`. The .pdh-flow tree is now
  // ephemeral — wiping it must not lose the "this ticket is closed" fact.
  const closedAt = new Date().toISOString();
  const updated: string[] = [];
  let epicCheckboxResult: { epicSlug: string; line: string } | null = null;

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

    // First, write any close_gate concern_triage entries back to the
    // ticket: `accept` → ` # Out of scope` append, `defer` → recorded
    // below in Resolution with a follow-up ticket pointer. `dismiss`
    // stays in the gate decision JSON only (audit), not on the ticket.
    // `fix_in_this_ticket` should never reach close_ticket: await-gate
    // throws when approve carries one — surface defensively if it does.
    const triage = p.runId
      ? readGateConcernTriage(p.worktreePath, p.runId, "close_gate")
      : [];
    const accepted = triage.filter((t) => t.action === "accept");
    const deferred = triage.filter((t) => t.action === "defer");
    const stragglerFixers = triage.filter(
      (t) => t.action === "fix_in_this_ticket",
    );
    if (stragglerFixers.length > 0) {
      process.stderr.write(
        `[close_ticket] WARNING: ${stragglerFixers.length} fix_in_this_ticket ` +
          `triage entry(ies) leaked into the approved close_gate decision ` +
          `for ${p.ticketId}. They should have been resolved or re-classified ` +
          `before approval. The engine is closing the ticket anyway because ` +
          `await-gate already validated the decision; these entries will not ` +
          `be written to the ticket.\n`,
      );
    }
    if (existsSync(ticketPath) && accepted.length > 0) {
      appendOutOfScope(ticketPath, accepted);
      updated.push(
        `tickets/${p.ticketId}.md (Out of scope +${accepted.length})`,
      );
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
      if (deferred.length > 0) {
        lines.push("- **Deferred concerns** (resolved in follow-up tickets):");
        for (const t of deferred) {
          lines.push(
            `    - \`${t.follow_up_ticket}\` — ${t.concern.slice(0, 200)} (rationale: ${t.rationale.slice(0, 200)})`,
          );
        }
      } else {
        lines.push(
          "- **Follow-ups**: see `tickets/` for any new tickets opened to address deferred items.",
        );
      }
      appendFileSync(ticketPath, lines.join("\n") + "\n");
      updated.push(`tickets/${p.ticketId}.md (Resolution)`);
    }

    // A4: tick the closed ticket off in the Epic file's `## Tickets`
    // section. The skill's close-step procedure mandates this audit trail; pdh-flow
    // owns the markdown checklist (ticket.sh only tracks linkage in
    // frontmatter). The Epic file path is `epics/<epic_id>.md`; epic_id
    // is read from the ticket's frontmatter.
    const epicSlug = readFrontmatterValue(ticketPath, "epic_id");
    if (epicSlug) {
      const ticketTitle =
        readFrontmatterValue(ticketPath, "title") ?? p.ticketId;
      const checkResult = checkOffEpicTicket(
        p.worktreePath,
        epicSlug,
        p.ticketId,
        ticketTitle,
      );
      if (checkResult) {
        updated.push(`epics/${epicSlug}.md (${checkResult})`);
        epicCheckboxResult = { epicSlug, line: checkResult };
      }
    }
  }

  // A2: commit the close-time edits, then invoke `ticket.sh close` so the
  // canonical lifecycle (squash-merge → done/ → branch delete → push)
  // runs. Both ops go through `flock` (A3) so multi-worktree parallel
  // Epic runs don't race. Throw on any failure → xstate routes via the
  // system_step's on_failure (human_intervention).
  let ticketShDetails:
    | { path: string; args: string[]; stdout: string; stderr: string }
    | null = null;
  let closeCommitSha: string | null = null;
  if (p.ticketId && updated.length > 0) {
    // 1. Stage + commit the in-worktree close edits. ticket.sh refuses to
    //    operate on a dirty tree; we follow the engine's single-commit-
    //    owner pattern (mirror run-provider.ts).
    closeCommitSha = stageAndCommit(
      p.worktreePath,
      `[${p.nodeId}] close: ${p.ticketId}`,
    );

    // 2. Resolve ticket.sh + invoke `ticket.sh close <slug>` under flock.
    //    We auto-skip ticket.sh when the worktree has no `.ticket-config.yaml`
    //    (= the project hasn't opted into ticket.sh management; common in
    //    fixtures and seed-only test worktrees). Explicit override:
    //    params.skip_ticket_sh in the close_finalize node.
    const ts = resolveTicketSh(p.worktreePath);
    const hasTicketConfig = existsSync(
      join(p.worktreePath, ".ticket-config.yaml"),
    );
    const skipTicketSh =
      (p.params?.skip_ticket_sh as boolean | undefined) === true ||
      !hasTicketConfig;
    if (!ts && !skipTicketSh) {
      throw new Error(
        `ticket.sh not found (looked at $PDH_FLOW_TICKET_SH, ${p.worktreePath}/ticket.sh, ` +
          `<pdh-flow>/scripts/dev/ticket.sh). Install ticket.sh or pass params: { skip_ticket_sh: true } ` +
          `in the close_finalize node for engines that close in-place.`,
      );
    }
    if (ts && !skipTicketSh) {
      const push = (p.params?.push as boolean | undefined) ?? false;
      const args = ["close", p.ticketId];
      if (!push) args.push("--no-push");

      const r = spawnSyncLocked(p.worktreePath, ts, args, {
        cwd: p.worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = (r.stdout ?? "").trim();
      const stderr = (r.stderr ?? "").trim();
      if (r.status !== 0) {
        throw new Error(
          `ticket.sh close failed (exit ${r.status}) for ticket=${p.ticketId} via ${ts}\n` +
            `stderr: ${stderr || "(empty)"}\n` +
            `stdout: ${stdout || "(empty)"}`,
        );
      }
      ticketShDetails = { path: ts, args, stdout, stderr };
    }
  }

  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "close_ticket",
    summary: ticketShDetails
      ? `ticket ${p.ticketId} closed (ticket.sh ${ticketShDetails.args.join(" ")})`
      : `ticket closed (${updated.length} edit(s))`,
    details: {
      closed_at: closedAt,
      ticket_id: p.ticketId ?? null,
      updated,
      ...(epicCheckboxResult
        ? {
            epic_id: epicCheckboxResult.epicSlug,
            epic_tickets_section: epicCheckboxResult.line,
          }
        : {}),
      ...(closeCommitSha ? { close_commit_sha: closeCommitSha } : {}),
      ...(ticketShDetails
        ? {
            ticket_sh_path: ticketShDetails.path,
            ticket_sh_args: ticketShDetails.args,
            ticket_sh_stdout: ticketShDetails.stdout,
            ticket_sh_stderr: ticketShDetails.stderr,
          }
        : {}),
    },
  };
}

/** Stage all changes in `worktreePath` and create a single commit with the
 *  given subject. Mirrors the commit pattern in run-provider.ts so the
 *  engine remains the sole commit owner. Returns the new HEAD sha. */
function stageAndCommit(worktreePath: string, subject: string): string {
  const add = spawnSync("git", ["add", "-A"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (add.status !== 0) {
    throw new Error(
      `git add -A failed in ${worktreePath}: ${add.stderr ?? "(empty)"}`,
    );
  }
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.email=engine@pdh-flow.local",
      "-c",
      "user.name=pdh-flow-engine",
      "commit",
      "-m",
      subject,
      "--allow-empty",
    ],
    {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (commit.status !== 0) {
    throw new Error(
      `git commit failed (${subject}): ${commit.stderr ?? "(empty)"}`,
    );
  }
  const rev = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (rev.stdout ?? "").trim();
}

/** Read the value of a top-level frontmatter key from a markdown file.
 *  Returns null when the file is missing, has no frontmatter, or the key
 *  isn't present. Doesn't attempt full YAML parsing — only matches simple
 *  scalar lines (`key: value`). */
function readFrontmatterValue(
  filePath: string,
  key: string,
): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => l.trimStart().startsWith(`${key}:`));
  if (!line) return null;
  return line.replace(/^[^:]*:\s*/, "").replace(/^["']|["']$/g, "").trim() || null;
}

/** Check the closed ticket off in the Epic file's `## Tickets` section.
 *  Three behaviours:
 *    - Existing `- [ ] <slug>` line → flip to `- [x] <slug>` and return "checked existing"
 *    - Existing `- [x] <slug>` line → no-op (idempotent), return "already checked"
 *    - No matching line → append `- [x] <slug> — <title>` under `## Tickets`,
 *      creating the section if absent. Return "appended new" or "section created".
 *  Returns null if the Epic file is missing entirely (caller skips).
 */
function checkOffEpicTicket(
  worktreePath: string,
  epicSlug: string,
  ticketSlug: string,
  ticketTitle: string,
): string | null {
  const epicPath = join(worktreePath, "epics", `${epicSlug}.md`);
  if (!existsSync(epicPath)) return null;
  const content = readFileSync(epicPath, "utf8");

  // 1. Section header detection. We accept `## Tickets`, `## tickets`,
  //    `## Linked Tickets` etc. — anything that case-insensitively
  //    starts with "## Tickets" or "## Linked Tickets".
  const sectionRe = /^(##\s+(?:Linked\s+)?Tickets)\s*$/im;
  const sectionMatch = sectionRe.exec(content);

  // 2. Existing checkbox line for this slug. Matches:
  //      - [ ] <slug>
  //      - [x] <slug>
  //      - [ ] <slug> — title
  //    where <slug> is at a word boundary so we don't match prefixes.
  const slugEsc = ticketSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const checkboxRe = new RegExp(
    `^(\\s*-\\s+\\[)([ xX])(\\]\\s+)(\`?)(${slugEsc})\\b(.*)$`,
    "m",
  );
  const existing = checkboxRe.exec(content);
  if (existing) {
    if (existing[2].toLowerCase() === "x") {
      return "already checked";
    }
    const updated = content.replace(checkboxRe, "$1x$3$4$5$6");
    writeFileSync(epicPath, updated);
    return "checked existing";
  }

  // 3. No existing line — append. Build the new line.
  const newLine = `- [x] ${ticketSlug} — ${ticketTitle}`;
  if (sectionMatch) {
    // Insert at the end of the section (before the next `##` heading or
    // end of file).
    const idxHeader = sectionMatch.index + sectionMatch[0].length;
    const rest = content.slice(idxHeader);
    const nextHeading = rest.match(/^##\s+/m);
    const insertAt = nextHeading
      ? idxHeader + nextHeading.index!
      : content.length;
    const before = content.slice(0, insertAt).replace(/\s*$/, "");
    const after = content.slice(insertAt);
    const sep = before.endsWith("\n") ? "" : "\n";
    const trailing = after.startsWith("\n") ? "" : "\n";
    const updated = `${before}${sep}${newLine}\n${trailing}${after}`;
    writeFileSync(epicPath, updated);
    return "appended new";
  }
  // No `## Tickets` section yet — create it at the bottom.
  const sep = content.endsWith("\n") ? "" : "\n";
  writeFileSync(epicPath, `${content}${sep}\n## Tickets\n\n${newLine}\n`);
  return "section created";
}

/** Path of the per-worktree flock. `.pdh-flow/` is gitignored, so the lock
 *  file is invisible to git but shared by every process running inside
 *  this worktree (A3 — skill L296/L563/L687). */
export function ticketLockPath(worktreePath: string): string {
  return join(worktreePath, ".pdh-flow", ".ticket.lock");
}

/** Run `flock -x -w 60 <lockPath> <cmd> <args>` so concurrent `ticket.sh`
 *  invocations across worktrees serialize on the same lock file. Falls
 *  back to plain spawnSync (with a stderr warning) when `flock` is not
 *  installed (macOS by default). */
function spawnSyncLocked(
  worktreePath: string,
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  const lockPath = ticketLockPath(worktreePath);
  mkdirSync(dirname(lockPath), { recursive: true });
  // Touch the lock file so flock has something to open (most flock
  // implementations create it themselves, but explicit touch keeps the
  // path discoverable for `lsof` debugging).
  if (!existsSync(lockPath)) {
    try {
      closeSync(openSync(lockPath, "a"));
    } catch {
      /* ignore */
    }
  }
  const hasFlock = spawnSync("flock", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
  }).status === 0;
  if (!hasFlock) {
    process.stderr.write(
      `[run-system] flock not available — running ${cmd} without lock. ` +
        `Parallel-epic worktrees may race on tickets/.\n`,
    );
    return spawnSync(cmd, args, { encoding: "utf8", ...opts }) as SpawnSyncReturns<string>;
  }
  return spawnSync(
    "flock",
    ["-x", "-w", "60", lockPath, cmd, ...args],
    { encoding: "utf8", ...opts },
  ) as SpawnSyncReturns<string>;
}

/**
 * run_qa_script — engine-driven full-suite test runner. Replaces the old
 * provider-based qa_full_suite node so the verdict comes from a real exit
 * code instead of an LLM interpreting test output. `LLM is evidence, not
 * authority` (CLAUDE.md) — for binary signals like "tests pass" we want
 * the engine to be the authority, not a model.
 *
 * Behaviour:
 *   - Spawns `bash -c <script>` from the worktree (default `scripts/test-all.sh`).
 *   - Captures stdout/stderr/exit_code/duration.
 *   - Writes `.pdh-flow/runs/<runId>/judgements/<nodeId>__round-<N>.json` with
 *     `{exit_code, stdout_tail, stderr_tail, duration_ms, script}`. Round N is
 *     derived from the number of pre-existing judgement files for this node.
 *   - Appends a `## <nodeId> (round N)` section to `current-note.md` so the
 *     next provider (typically `implement` in qa_repair mode) can read the
 *     failure context via the standard note convention.
 *   - Commits the note edits as `[<nodeId>/round-<N>] qa exit=<code>`.
 *   - On exit ≠ 0, THROWS — xstate routes to the system_step's on_failure
 *     edge. Returning {status: "failed"} would have been treated as
 *     successful resolve and run on_done instead.
 *
 * Params:
 *   - script (string, default "scripts/test-all.sh")
 *   - timeout_seconds (number, default 1800)
 */
function runQaScript(p: {
  nodeId: string;
  worktreePath: string;
  runId?: string;
  params?: Record<string, unknown>;
}): SystemActorOutput {
  const script =
    (p.params?.script as string | undefined) ?? "scripts/test-all.sh";
  const timeoutSeconds =
    (p.params?.timeout_seconds as number | undefined) ?? 1800;

  const startTs = Date.now();
  const r = spawnSync("bash", ["-c", script], {
    cwd: p.worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutSeconds * 1000,
  });
  const durationMs = Date.now() - startTs;
  const exitCode = r.status;
  const timedOut = r.signal === "SIGTERM" && exitCode === null;
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";

  // Round derivation: count existing judgement files for this node.
  let round = 1;
  if (p.runId) {
    const judgeDir = join(
      p.worktreePath,
      ".pdh-flow",
      "runs",
      p.runId,
      "judgements",
    );
    if (existsSync(judgeDir)) {
      const existing = readdirSync(judgeDir).filter((f) =>
        f.startsWith(`${p.nodeId}__round-`),
      );
      round = existing.length + 1;
    }
  }
  const roundKey = `round-${round}`;

  // Tail to keep judgement file + note sane (test suites can dump MB).
  const tail = (s: string, n = 6000): string => (s.length > n ? s.slice(-n) : s);
  const stdoutTail = tail(stdout);
  const stderrTail = tail(stderr);

  if (p.runId) {
    const judgeDir = join(
      p.worktreePath,
      ".pdh-flow",
      "runs",
      p.runId,
      "judgements",
    );
    mkdirSync(judgeDir, { recursive: true });
    const judgement = {
      node_id: p.nodeId,
      round,
      kind: "qa_script",
      script,
      exit_code: exitCode,
      timed_out: timedOut,
      duration_ms: durationMs,
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      join(judgeDir, `${p.nodeId}__${roundKey}.json`),
      JSON.stringify(judgement, null, 2),
    );
  }

  // Append note section for the next provider (qa_repair) to read.
  const verdict = exitCode === 0 ? "PASS" : timedOut ? "TIMEOUT" : "FAIL";
  const noteBody = [
    `## ${p.nodeId} (${roundKey})`,
    ``,
    `- script: \`${script}\``,
    `- verdict: **${verdict}**`,
    `- exit_code: ${exitCode === null ? "(timeout)" : exitCode}`,
    `- duration_ms: ${durationMs}`,
    ``,
    stderrTail.trim().length > 0 ? "### stderr (tail)" : "",
    stderrTail.trim().length > 0 ? "```" : "",
    stderrTail.trim().length > 0 ? stderrTail.trimEnd() : "",
    stderrTail.trim().length > 0 ? "```" : "",
    ``,
    "### stdout (tail)",
    "```",
    stdoutTail.trimEnd() || "(no output)",
    "```",
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
  appendFileSync(
    join(p.worktreePath, "current-note.md"),
    "\n" + noteBody + "\n",
  );

  // Single engine commit (engine is the only commit owner).
  const subject = `[${p.nodeId}/${roundKey}] qa ${verdict} (exit=${exitCode ?? "timeout"})`;
  stageAndCommit(p.worktreePath, subject);

  if (exitCode !== 0) {
    throw new Error(
      `qa ${verdict} (exit ${exitCode ?? "timeout"}, ${durationMs}ms). ` +
        `See note's ## ${p.nodeId} (${roundKey}) section and ` +
        `.pdh-flow/runs/${p.runId ?? "<runId>"}/judgements/${p.nodeId}__${roundKey}.json.`,
    );
  }

  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "run_qa_script",
    summary: `qa PASS (${durationMs}ms via ${script})`,
    details: {
      script,
      exit_code: exitCode,
      duration_ms: durationMs,
      round,
    },
  };
}

interface ConcernTriageEntry {
  concern: string;
  action: "fix_in_this_ticket" | "accept" | "defer" | "dismiss";
  rationale: string;
  follow_up_ticket?: string;
}

/** Read the close_gate decision file and return its concern_triage array.
 *  Returns [] on any read or parse failure (gate decision may be absent
 *  in fixture-only test runs, or older runs predating the schema field).
 *  Prefers the consumed-archive form (`<gate>__consumed.json`) since the
 *  active slot is renamed away immediately after engine consume. */
function readGateConcernTriage(
  worktreePath: string,
  runId: string,
  gateNodeId: string,
): ConcernTriageEntry[] {
  const gatesDir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  for (const filename of [
    `${gateNodeId}__consumed.json`,
    `${gateNodeId}.json`,
  ]) {
    const path = join(gatesDir, filename);
    if (!existsSync(path)) continue;
    try {
      const obj = JSON.parse(readFileSync(path, "utf8"));
      const arr = obj.concern_triage;
      if (!Array.isArray(arr)) return [];
      return arr.filter(
        (e): e is ConcernTriageEntry =>
          e &&
          typeof e === "object" &&
          typeof e.concern === "string" &&
          (e.action === "fix_in_this_ticket" ||
            e.action === "accept" ||
            e.action === "defer" ||
            e.action === "dismiss") &&
          typeof e.rationale === "string",
      );
    } catch {
      continue;
    }
  }
  return [];
}

/** Append accepted concerns to the ticket's `# Out of scope` section,
 *  creating the heading if absent. Each entry becomes a one-line bullet
 *  with the concern text + a `(accepted at close_gate: <rationale>)`
 *  suffix so a future reader sees who decided what. */
function appendOutOfScope(
  ticketPath: string,
  entries: ConcernTriageEntry[],
): void {
  if (entries.length === 0) return;
  const content = readFileSync(ticketPath, "utf8");
  const bullets = entries.map(
    (e) =>
      `- ${e.concern.slice(0, 300)} (accepted at close_gate: ${e.rationale.slice(0, 200)})`,
  );
  const headingRe = /^#[ \t]+Out of scope\b[^\n]*$/im;
  const m = headingRe.exec(content);
  let updated: string;
  if (m) {
    // Insert bullets at the end of the existing section (before next `# ` heading or EOF).
    const startIdx = m.index + m[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.match(/^#[ \t]+/m);
    const insertAt = nextHeading ? startIdx + nextHeading.index! : content.length;
    const before = content.slice(0, insertAt).replace(/\s*$/, "");
    const after = content.slice(insertAt);
    updated = `${before}\n${bullets.join("\n")}\n${after.startsWith("\n") ? "" : "\n"}${after}`;
  } else {
    // No section yet — append at the bottom.
    const sep = content.endsWith("\n") ? "" : "\n";
    updated = `${content}${sep}\n# Out of scope\n\n${bullets.join("\n")}\n`;
  }
  writeFileSync(ticketPath, updated);
}

function readGateApprover(
  worktreePath: string,
  runId: string,
  gateNodeId: string,
): string | null {
  // Prefer consumed-archive form (await-gate moves the active slot aside
  // after consuming) but fall back to the active path for compatibility.
  const gatesDir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  for (const filename of [`${gateNodeId}__consumed.json`, `${gateNodeId}.json`]) {
    const path = join(gatesDir, filename);
    if (!existsSync(path)) continue;
    try {
      const obj = JSON.parse(readFileSync(path, "utf8"));
      const approver = typeof obj.approver === "string" ? obj.approver.trim() : "";
      if (approver.length > 0) return approver;
    } catch {
      continue;
    }
  }
  return null;
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

  // A3: serialize epic-close ops against ticket.sh close / start through
  // the same per-worktree flock so concurrent operations don't race.
  const r = spawnSyncLocked(p.worktreePath, ts, args, {
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
  // Epic close contract — stamp `zero_base_reviewed: true` on the Epic
  // frontmatter and optionally run a post-merge test script ("all tests
  // pass" per skill). Failures throw → human_intervention.
  let zeroBaseStamped = false;
  if (p.params?.stamp_zero_base_reviewed === true) {
    // After ticket.sh epic close the Epic file lives at
    // `epics/done/<slug>.md`; before the move it's at `epics/<slug>.md`.
    // Try the post-close location first, fall back to the active path.
    const donePath = join(p.worktreePath, "epics", "done", `${p.epicId}.md`);
    const activePath = join(p.worktreePath, "epics", `${p.epicId}.md`);
    const target = existsSync(donePath)
      ? donePath
      : existsSync(activePath)
        ? activePath
        : null;
    if (target) {
      if (mergeFrontmatter(target, { zero_base_reviewed: "true" })) {
        zeroBaseStamped = true;
      }
    } else {
      process.stderr.write(
        `[close_epic] cannot stamp zero_base_reviewed: epic file not found ` +
          `at ${donePath} or ${activePath}\n`,
      );
    }
  }

  let postMergeTest: { script: string; status: number | null; tail: string } | null = null;
  const postMergeScript = p.params?.post_merge_test_script as string | undefined;
  if (postMergeScript && postMergeScript.length > 0) {
    // Resolve relative to the worktree; engine spawns the script via the
    // shell so `npm run …` and similar entries work transparently.
    const scriptPath = postMergeScript.startsWith("/")
      ? postMergeScript
      : join(p.worktreePath, postMergeScript);
    const r = spawnSync("bash", ["-c", scriptPath], {
      cwd: p.worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tail = ((r.stdout ?? "") + "\n" + (r.stderr ?? "")).slice(-2000);
    postMergeTest = { script: postMergeScript, status: r.status, tail };
    if (r.status !== 0) {
      throw new Error(
        `post_merge_test_script "${postMergeScript}" failed (exit ${r.status}) ` +
          `after ticket.sh epic close. Tail:\n${tail}`,
      );
    }
  }

  return {
    status: "completed",
    nodeId: p.nodeId,
    action: "close_epic",
    summary: `epic ${p.epicId} closed via ticket.sh${zeroBaseStamped ? " + zero_base_reviewed stamped" : ""}${postMergeTest ? " + post-merge test passed" : ""}`,
    details: {
      epic_id: p.epicId,
      ticket_sh_path: ts,
      args,
      stdout,
      stderr,
      zero_base_reviewed_stamped: zeroBaseStamped,
      ...(postMergeTest
        ? {
            post_merge_test_script: postMergeTest.script,
            post_merge_test_status: postMergeTest.status,
            post_merge_test_tail: postMergeTest.tail,
          }
        : {}),
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
