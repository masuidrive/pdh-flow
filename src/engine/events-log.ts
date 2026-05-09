// Append-only log of per-node activity events for a single run.
//
// Lives at `.pdh-flow/runs/<runId>/events.jsonl`. One JSON object per
// line, in chronological order. Mirrors transitions-log.ts, but at a
// finer grain — every provider/guardian/system actor entry and exit
// gets its own line. Used by the Web UI's bottom bar to show "running
// implementer (codex) — 1m23s" while the engine is mid-step.
//
// Bookkeeping only — engine flow decisions never read this file. If
// the file gets truncated or deleted the engine continues unaffected.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RunEventKind =
  | "provider_start"
  | "provider_finish"
  | "guardian_start"
  | "guardian_finish"
  | "system_start"
  | "system_finish";

export interface RunEvent {
  ts: string;
  node_id: string;
  round: number;
  kind: RunEventKind;
  /** Subprocess provider used. Set on provider/guardian events. */
  provider?: "claude" | "codex";
  /** Role (implementer / planner / reviewer / final_verifier / etc). */
  role?: string;
  /** system_step action name when kind is system_*. */
  action?: string;
  /** "ok" / "error" / "fixture" — set on _finish events. */
  outcome?: "ok" | "error" | "fixture";
  /** Wall-clock duration since the matching _start event, set on _finish. */
  duration_ms?: number;
  /** Short error message when outcome === "error". */
  error?: string;
}

function eventsPath(worktreePath: string, runId: string): string {
  return join(worktreePath, ".pdh-flow", "runs", runId, "events.jsonl");
}

export function appendEvent(
  worktreePath: string,
  runId: string,
  entry: RunEvent,
): void {
  try {
    const path = eventsPath(worktreePath, runId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // Bookkeeping log — never let a log-append failure break the engine.
  }
}

export function readEvents(
  worktreePath: string,
  runId: string,
): RunEvent[] {
  const path = eventsPath(worktreePath, runId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate partial-write tail */
    }
  }
  return out;
}
