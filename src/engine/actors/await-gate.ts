// gate_step actor — waits for a human (or fixture) decision and returns it.
//
// Two modes:
//
//   1. Fixture replay — when fixtureMeta.gate_decisions[nodeId] is present,
//      auto-respond immediately. Used by tests.
//
//   2. Real (file-poll) — looks for a gate-decision file at
//      `<worktree>/.pdh-flow/runs/<runId>/gates/<nodeId>.json`. The file
//      shape matches gate-output.schema.json. Polls until the file exists
//      or the actor is aborted.
//
// External delivery (CLI / Web UI / API) writes that file. The engine
// reads it and resolves; XState branches on `decision`.

import { fromPromise } from "xstate";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getValidator, SCHEMA_IDS } from "../validate.ts";
import type { GateStepOutput } from "../../types/index.ts";
import type { FixtureMeta } from "./run-provider.ts";

export interface GateActorInput {
  nodeId: string;
  round: number;
  worktreePath: string;
  runId: string;
  fixtureMeta?: FixtureMeta;
  /** Polling interval in ms when in real mode. Defaults to 1000. */
  pollIntervalMs?: number;
}

export interface GateActorOutput {
  status: "completed";
  nodeId: string;
  decision: GateStepOutput["decision"];
  approver: string;
  comment?: string;
  fromFixture: boolean;
}

export const awaitGate = fromPromise<GateActorOutput, GateActorInput>(
  async ({ input, signal }) => {
    const { nodeId, round, worktreePath, runId } = input;
    const fixture = (input.fixtureMeta as
      | (FixtureMeta & { gate_decisions?: Record<string, GateStepOutput> })
      | undefined)?.gate_decisions?.[nodeId];

    let output: GateStepOutput;
    let fromFixture: boolean;
    let validated: GateStepOutput;
    const v = getValidator();

    if (fixture) {
      // Fixture mode: a malformed test fixture is a test bug — fail loudly.
      output = fixture;
      fromFixture = true;
      validated = v.validateOrThrow<GateStepOutput>(SCHEMA_IDS.gateOutput, output);
      validateBusinessRules({ nodeId, runId, worktreePath, decision: validated });
    } else {
      // Real mode: defensive retry loop. A bad decision file (schema
      // violation, missing concern_triage, missing deferral_approvals)
      // used to throw → engine → __failed__ → unrecoverable run.
      // Now: quarantine the bad file, record a rejection sidecar the
      // UI can surface, and poll again so the human can re-submit.
      while (true) {
        output = await pollForGateFile({
          worktreePath,
          runId,
          nodeId,
          pollIntervalMs: input.pollIntervalMs ?? 1000,
          signal,
        });
        const schemaCheck = v.validate<GateStepOutput>(
          SCHEMA_IDS.gateOutput,
          output,
        );
        if (schemaCheck.ok === false) {
          quarantineBadGate({
            worktreePath,
            runId,
            nodeId,
            badOutput: output,
            errorMessage:
              "gate decision file failed schema validation: " +
              schemaCheck.errors
                .map((e) => `${e.instancePath} ${e.message}`)
                .join("; "),
          });
          continue;
        }
        try {
          validateBusinessRules({
            nodeId,
            runId,
            worktreePath,
            decision: schemaCheck.data,
          });
        } catch (err) {
          quarantineBadGate({
            worktreePath,
            runId,
            nodeId,
            badOutput: output,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        validated = schemaCheck.data;
        break;
      }
      fromFixture = false;
    }

    // Persist the decision file (if real mode it's already there; in
    // fixture mode we write it for audit symmetry).
    if (fromFixture) {
      const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${nodeId}.json`),
        JSON.stringify(validated, null, 2),
      );
    }

    // F-011/H10-4 (Gap B): echo the decision to current-note.md so the
    // approver / comment / decided_at survive `.pdh-flow/` being wiped.
    // Single-commit-owner: this is the gate's commit.
    echoGateToNote({
      nodeId,
      round,
      worktreePath,
      decision: validated,
    });

    // Archive the consumed decision so the next time the same gate is
    // entered (e.g. close_gate after a rejected → implement loop) the
    // engine waits for a fresh decision instead of immediately picking
    // up the stale one. The "active slot" is gates/<nodeId>.json;
    // archived form is gates/<nodeId>__consumed.json (overwritten each
    // time, so we always keep the most recent decision for downstream
    // readers — hasRejectedFixActions, close_ticket triage write-back).
    // Best-effort: rename failure logs but does not abort the actor —
    // worst case is the same stale-file bug we're patching, which the
    // human can recover from by re-issuing a decision once it's clear.
    if (!fromFixture) {
      try {
        const activePath = join(
          worktreePath,
          ".pdh-flow",
          "runs",
          runId,
          "gates",
          `${nodeId}.json`,
        );
        const consumedPath = join(
          worktreePath,
          ".pdh-flow",
          "runs",
          runId,
          "gates",
          `${nodeId}__consumed.json`,
        );
        if (existsSync(activePath)) {
          renameSync(activePath, consumedPath);
        }
      } catch (e) {
        process.stderr.write(
          `[await-gate] failed to archive consumed decision for ${nodeId}: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
      }
    }

    return {
      status: "completed",
      nodeId,
      decision: validated.decision,
      approver: validated.approver ?? "(unknown)",
      comment: validated.comment,
      fromFixture,
    };
  },
);

/** Business-rule validation that runs after schema validation has passed.
 *  Throws Error when the decision fails any rule — callers translate the
 *  throw into a quarantine action so the engine doesn't crash on bad
 *  human input. Encapsulates the close_gate deferral_approvals rule and
 *  the universal concern_triage rule so both can be reused by the
 *  server-side gate-confirm endpoint (defense in depth). */
export function validateBusinessRules(p: {
  nodeId: string;
  runId: string;
  worktreePath: string;
  decision: GateStepOutput;
}): void {
  const { nodeId, runId, worktreePath, decision } = p;

  if (nodeId === "close_gate" && decision.decision === "approved") {
    const unverifiedCount = countUnverifiedInFinalVerification({
      worktreePath,
      runId,
    });
    const provided = decision.deferral_approvals?.length ?? 0;
    if (unverifiedCount > provided) {
      throw new Error(
        `[await-gate] close_gate "approved" rejected: ${unverifiedCount} ` +
          `unverified AC row(s) in final_verification table but only ` +
          `${provided} deferral_approval entry(ies) in the gate decision. ` +
          `Each unverified row requires a deferral_approvals entry with a ` +
          `follow_up_ticket and reason before the close can proceed.`,
      );
    }
  }

  if (decision.decision === "approved") {
    const concernCount = countConcernsInGateSummary({
      worktreePath,
      runId,
      nodeId,
    });
    const triageCount = decision.concern_triage?.length ?? 0;
    if (concernCount > triageCount) {
      throw new Error(
        `[await-gate] ${nodeId} "approved" rejected: gate-summary surfaced ` +
          `${concernCount} concern(s) but only ${triageCount} concern_triage ` +
          `entry(ies) in the gate decision. Every concern must be triaged ` +
          `(accept / defer / dismiss + rationale) before approval can proceed.`,
      );
    }
    // follow_up_ticket for defer is *recommended* but not required.
    // The audit trail (concern text + rationale) is enough to recreate
    // a follow-up ticket later; forcing slug entry at the gate adds
    // friction without a real safety win. The UI still nudges the
    // human to fill it via a warning-styled empty input.
    const fixers = (decision.concern_triage ?? []).filter(
      (t) => t.action === "fix_in_this_ticket",
    );
    if (fixers.length > 0) {
      throw new Error(
        `[await-gate] ${nodeId} "approved" rejected: ${fixers.length} concern_triage ` +
          `entry(ies) marked action=fix_in_this_ticket. Those route the run back ` +
          `to implement — use Reject (not Approve) on the gate, or re-classify ` +
          `each one to accept / defer / dismiss before approving.`,
      );
    }
  }
}

/** Move an invalid decision file out of the active-poll path and drop a
 *  sidecar that records what came in + why it was rejected. The UI
 *  picks the sidecar up so the human sees their previous submission
 *  bounced. Engine then keeps polling for a fresh `<nodeId>.json`. */
function quarantineBadGate(p: {
  worktreePath: string;
  runId: string;
  nodeId: string;
  badOutput: unknown;
  errorMessage: string;
}): void {
  try {
    const dir = join(p.worktreePath, ".pdh-flow", "runs", p.runId, "gates");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const activePath = join(dir, `${p.nodeId}.json`);
    const rejectedPath = join(dir, `${p.nodeId}__rejected-${ts}.json`);
    const summaryPath = join(dir, `${p.nodeId}__rejection.json`);
    if (existsSync(activePath)) {
      try { renameSync(activePath, rejectedPath); } catch { /* keep active to fall through */ }
    }
    writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          rejected_at: new Date().toISOString(),
          node_id: p.nodeId,
          error: p.errorMessage,
          attempted_decision: p.badOutput,
        },
        null,
        2,
      ),
    );
    process.stderr.write(
      `[await-gate] ${p.nodeId}: rejected bad decision — ${p.errorMessage}\n`,
    );
  } catch (e) {
    process.stderr.write(
      `[await-gate] failed to quarantine bad ${p.nodeId} decision: ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
  }
}

/** Count concerns in the cached gate-summary for this gate. The engine
 *  pre-warms the gate-summary file at
 *  `.pdh-flow/runs/<runId>/gate-summaries/<nodeId>__round-N.json` when
 *  the engine enters a gate. The new schema stores a structured
 *  `concerns: []` array (drop-in replacement for the old practice of
 *  parsing bullets out of `summary` markdown). Returns 0 on any
 *  failure path — the engine continues to gate normally without per-
 *  concern enforcement (matches the volatile-cache nature of gate-
 *  summary). */
function countConcernsInGateSummary(p: {
  worktreePath: string;
  runId: string;
  nodeId: string;
}): number {
  try {
    const dir = join(
      p.worktreePath,
      ".pdh-flow",
      "runs",
      p.runId,
      "gate-summaries",
    );
    if (!existsSync(dir)) return 0;
    // Pick the latest round-N file for this node.
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${p.nodeId}__round-`) && f.endsWith(".json"))
      .sort((a, b) => {
        const ra = parseInt(a.match(/round-(\d+)/)?.[1] ?? "0", 10);
        const rb = parseInt(b.match(/round-(\d+)/)?.[1] ?? "0", 10);
        return rb - ra;
      });
    if (files.length === 0) return 0;
    const obj = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    if (Array.isArray(obj.concerns)) return obj.concerns.length;
    return 0;
  } catch {
    return 0;
  }
}

/** Count rows in the most recent `final_verification` judgement whose
 *  status is `unverified`. The structured judgement is written by
 *  `run-provider.ts` when the `final_verifier` role finishes; previously
 *  this function parsed the markdown AC table back out of current-note.md,
 *  which broke whenever the LLM shifted column order, header language, or
 *  status wording. Returns 0 when:
 *    - no judgement file exists yet (engine hasn't reached final_verifier)
 *    - the judgement is malformed (best-effort: close_gate proceeds
 *      without per-AC enforcement, matching prior fallback behaviour) */
function countUnverifiedInFinalVerification(p: {
  worktreePath: string;
  runId: string;
}): number {
  try {
    const dir = join(p.worktreePath, ".pdh-flow", "runs", p.runId, "judgements");
    if (!existsSync(dir)) return 0;
    // Pick the highest-round final_verification judgement, since rounds
    // ratchet upward and the latest reflects the current ac_verification.
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("final_verification__round-") && f.endsWith(".json"))
      .sort((a, b) => {
        const ra = parseInt(a.match(/round-(\d+)/)?.[1] ?? "0", 10);
        const rb = parseInt(b.match(/round-(\d+)/)?.[1] ?? "0", 10);
        return rb - ra;
      });
    if (files.length === 0) return 0;
    const obj = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    if (!Array.isArray(obj.ac_verification)) return 0;
    let count = 0;
    for (const row of obj.ac_verification) {
      if (row && row.status === "unverified") count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function echoGateToNote(p: {
  nodeId: string;
  round: number;
  worktreePath: string;
  decision: GateStepOutput;
}): void {
  const notePath = join(p.worktreePath, "current-note.md");
  if (!existsSync(notePath)) return;
  const d = p.decision;
  const lines = [
    `## ${p.nodeId} (round ${p.round})`,
    "",
    `**Decision**: ${d.decision}`,
    `**Approver**: ${d.approver ?? "(unknown)"}`,
    `**Decided_at**: ${d.decided_at ?? ""}`,
  ];
  if (d.via) lines.push(`**Via**: ${d.via}`);
  if (d.comment) {
    lines.push("", "**Comment**:", "", d.comment);
  }

  // Echo every triage decision, grouped by action, so a future reader can
  // see *exactly* what the PdM did with each concern raised at this gate.
  // The fix_in_this_ticket entries also drive the next implement round
  // (see implementer.j2 gate_fix mode + run-provider.ts mode detection).
  const triage = d.concern_triage ?? [];
  if (triage.length > 0) {
    const byAction: Record<string, typeof triage> = {
      fix_in_this_ticket: [],
      accept: [],
      defer: [],
      dismiss: [],
    };
    for (const t of triage) {
      (byAction[t.action] ??= []).push(t);
    }

    if (byAction.fix_in_this_ticket.length > 0) {
      lines.push("", "### Fix-in-this-ticket actions");
      lines.push(
        "_implementer must address each item in the next round; close is blocked until cleared._",
      );
      lines.push("");
      for (const t of byAction.fix_in_this_ticket) {
        lines.push(`- **${t.concern}**`);
        lines.push(`    - 指示: ${t.rationale}`);
      }
    }
    if (byAction.accept.length > 0) {
      lines.push("", "### Accepted (Out of scope)");
      for (const t of byAction.accept) {
        lines.push(`- ${t.concern} — _${t.rationale}_`);
      }
    }
    if (byAction.defer.length > 0) {
      lines.push("", "### Deferred to follow-up tickets");
      for (const t of byAction.defer) {
        lines.push(
          `- \`${t.follow_up_ticket ?? "(missing slug)"}\` — ${t.concern} — _${t.rationale}_`,
        );
      }
    }
    if (byAction.dismiss.length > 0) {
      lines.push("", "### Dismissed (false positives)");
      for (const t of byAction.dismiss) {
        lines.push(`- ${t.concern} — _${t.rationale}_`);
      }
    }
  }

  appendFileSync(notePath, "\n" + lines.join("\n") + "\n");

  // Stage and commit. Subject mirrors provider/guardian convention:
  //   [<nodeId>/round-N] gate: <decision> by <approver>
  spawnSync("git", ["add", "-A"], { cwd: p.worktreePath });
  const subject = `[${p.nodeId}/round-${p.round}] gate: ${d.decision}` +
    (d.approver ? ` by ${d.approver}` : "");
  const r = spawnSync(
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
    { cwd: p.worktreePath, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `await-gate: git commit failed for ${p.nodeId} echo: ${r.stderr}`,
    );
  }
}

async function pollForGateFile(opts: {
  worktreePath: string;
  runId: string;
  nodeId: string;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<GateStepOutput> {
  const path = join(
    opts.worktreePath,
    ".pdh-flow",
    "runs",
    opts.runId,
    "gates",
    `${opts.nodeId}.json`,
  );
  while (true) {
    if (opts.signal?.aborted) {
      throw new Error(`gate poll aborted for ${opts.nodeId}`);
    }
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as GateStepOutput;
    }
    await sleep(opts.pollIntervalMs, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
