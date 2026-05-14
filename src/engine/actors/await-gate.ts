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

    if (fixture) {
      output = fixture;
      fromFixture = true;
    } else {
      output = await pollForGateFile({
        worktreePath,
        runId,
        nodeId,
        pollIntervalMs: input.pollIntervalMs ?? 1000,
        signal,
      });
      fromFixture = false;
    }

    // Validate.
    const v = getValidator();
    const validated = v.validateOrThrow<GateStepOutput>(
      SCHEMA_IDS.gateOutput,
      output,
    );

    // close_gate strict deferral approvals. The skill's close procedure
    // requires that every `unverified` AC row has an explicit deferral
    // approval (follow-up ticket + reason) when the human approves close.
    // We enforce by counting `unverified` rows in the most recent
    // `## final_verification` section of current-note.md and requiring at
    // least that many entries in `validated.deferral_approvals`. Skipped
    // for non-close gates and for non-approved decisions.
    if (nodeId === "close_gate" && validated.decision === "approved") {
      const unverifiedCount = countUnverifiedInFinalVerification(
        join(worktreePath, "current-note.md"),
      );
      const provided = validated.deferral_approvals?.length ?? 0;
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

    // PDH: every concern surfaced by gate-summary must be explicitly
    // triaged when the human approves. We count concerns by parsing the
    // gate-summary cache (volatile but always present when the gate is
    // active — engine pre-warms it on entry). On approve, require
    // concern_triage to cover every concern. Reject / cancel skip the
    // check. Applies to ALL gates, not just close_gate.
    if (validated.decision === "approved") {
      const concernCount = countConcernsInGateSummary({
        worktreePath,
        runId,
        nodeId,
      });
      const triageCount = validated.concern_triage?.length ?? 0;
      if (concernCount > triageCount) {
        throw new Error(
          `[await-gate] ${nodeId} "approved" rejected: gate-summary surfaced ` +
            `${concernCount} concern(s) but only ${triageCount} concern_triage ` +
            `entry(ies) in the gate decision. Every concern must be triaged ` +
            `(accept / defer / dismiss + rationale; defer also needs a ` +
            `follow_up_ticket) before approval can proceed.`,
        );
      }
      // Defer entries must include a follow-up ticket pointer.
      for (const t of validated.concern_triage ?? []) {
        if (t.action === "defer" && !t.follow_up_ticket?.trim()) {
          throw new Error(
            `[await-gate] ${nodeId} "approved" rejected: concern_triage ` +
              `entry with action=defer is missing follow_up_ticket: "${t.concern}"`,
          );
        }
      }
      // fix_in_this_ticket forces a reject — the PdM consciously asked
      // the implementer to address the concern in this ticket, which is
      // incompatible with closing it right now. Surface the conflict
      // loudly: the human should re-classify or click Reject explicitly.
      const fixers = (validated.concern_triage ?? []).filter(
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

/** Count concerns in the cached gate-summary for this gate. The engine
 *  pre-warms the gate-summary file at
 *  `.pdh-flow/runs/<runId>/gate-summaries/<nodeId>__round-N.json` when
 *  the engine enters a gate. We parse the `## 注意点 / Concerns` bullet
 *  list from that summary's markdown. Returns 0 on any failure path —
 *  the engine continues to gate normally, just without the per-concern
 *  enforcement (matches the volatile-cache nature of gate-summary). */
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
    const summary: string =
      typeof obj.summary === "string"
        ? obj.summary
        : typeof obj.markdown === "string"
          ? obj.markdown
          : "";
    if (!summary) return 0;
    return extractConcernBullets(summary).length;
  } catch {
    return 0;
  }
}

/** Pull bullet items out of the `## 注意点 / Concerns` section. Mirrors
 *  the FE extractor in GateCard.tsx. */
function extractConcernBullets(summary: string): string[] {
  const headingRe =
    /^##[ \t]+(?:注意点[ \t]*\/[ \t]*Concerns|Concerns|注意点)\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|\Z)/im;
  const m = headingRe.exec(summary);
  if (!m) return [];
  const out: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const bm = line.match(/^[ \t]*[-*+•・][ \t]+(.+)$/);
    if (bm) {
      const t = bm[1].trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** Parse the most recent `## final_verification ...` section in
 *  `current-note.md` and count rows in its AC verification table whose
 *  status column is `unverified`. Returns 0 when:
 *    - the note file doesn't exist (run started past final_verification)
 *    - no final_verification section is present
 *    - the section's table has no `unverified` rows
 *  The check is tolerant: we look at any markdown table row whose third
 *  pipe-separated cell trims to "unverified" (case-insensitive). */
function countUnverifiedInFinalVerification(notePath: string): number {
  if (!existsSync(notePath)) return 0;
  const content = readFileSync(notePath, "utf8");
  // Find the LAST `## final_verification` section (round N may produce
  // multiple). Match heading then capture until the next `## ` or EOF.
  const headingRe = /^##\s+final_verification\b[^\n]*$/gim;
  let lastMatch: RegExpExecArray | null = null;
  for (let m: RegExpExecArray | null; (m = headingRe.exec(content)); ) {
    lastMatch = m;
  }
  if (!lastMatch) return 0;
  const startIdx = lastMatch.index + lastMatch[0].length;
  const rest = content.slice(startIdx);
  const nextHeading = rest.match(/^##\s+/m);
  const section = nextHeading ? rest.slice(0, nextHeading.index!) : rest;
  // Count table rows whose third cell is "unverified". A table row looks
  // like `| col1 | col2 | col3 | col4 |` — we split on `|` and trim.
  let count = 0;
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    // Skip the header separator row (`|---|---|`).
    if (/^\s*\|\s*-+/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells[2].toLowerCase() === "unverified") count++;
  }
  return count;
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
