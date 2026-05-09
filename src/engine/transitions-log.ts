// Append-only log of XState transitions for a single run.
//
// Lives at .pdh-flow/runs/<runId>/transitions.jsonl. One JSON object per
// line, in chronological order:
//
//   {"ts":"2026-05-09T...","from":"assist","to":"investigate_plan",
//    "event":"xstate.done.actor.assist"}
//
// On resume, the engine reads the last `to` field and seeds its in-memory
// "previous state" so the actor.subscribe callback that fires immediately
// after restoration doesn't re-log the already-recorded state. Bookkeeping
// only — engine flow decisions never read this file.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TransitionEntry {
  ts: string;
  from: string | null;
  to: string;
  event: string | null;
}

function transitionsPath(worktreePath: string, runId: string): string {
  return join(worktreePath, ".pdh-flow", "runs", runId, "transitions.jsonl");
}

export function appendTransition(
  worktreePath: string,
  runId: string,
  entry: TransitionEntry,
): void {
  const path = transitionsPath(worktreePath, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readTransitions(
  worktreePath: string,
  runId: string,
): TransitionEntry[] {
  const path = transitionsPath(worktreePath, runId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: TransitionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Tolerate a partial-write tail; engine appends are line-buffered
      // but defensive parsing keeps a corrupt last line from breaking
      // the whole timeline view.
    }
  }
  return out;
}

/** Last `to` field on disk, so a resumed engine doesn't re-log the
 *  state it just restored. Returns null if the log is missing or empty. */
export function lastSeenState(worktreePath: string, runId: string): string | null {
  const entries = readTransitions(worktreePath, runId);
  return entries.length === 0 ? null : entries[entries.length - 1].to;
}

/** Best-effort serialization of an XState v5 state.value into a single
 *  node id. Strings pass through; single-key compound walks deeper;
 *  parallel returns the parent's id (so the timeline shows "entered the
 *  parallel group" once, not one entry per region). */
export function serializeStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replaceAll("__", ".");
  if (typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [key, child] = entries[0];
    const deeper = serializeStateValue(child);
    return deeper ?? key.replaceAll("__", ".");
  }
  // Parallel — return the first key (the group containing the regions).
  return entries[0][0].replaceAll("__", ".");
}
