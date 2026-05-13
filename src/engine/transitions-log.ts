// Append-only log of XState transitions for a single run.
//
// Lives at .pdh-flow/runs/<runId>/transitions.jsonl. One JSON object per
// line, in chronological order:
//
//   {"ts":"...","from":"qa","to":"implement",
//    "event":"xstate.error.actor.qa",
//    "summary":"qa FAIL (exit=1, 47s)"}
//
// `summary` is free-form prose set by the engine when it logs a transition,
// derived from the triggering actor's output. Deliberately NOT type-
// discriminated — nodes / variants / new node types can come and go without
// breaking a schema. UI consumers (edge inspector, debuggers) treat it as a
// 1-line hint. Engine flow decisions NEVER read this file; it's bookkeeping
// and observability only.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TransitionEntry {
  ts: string;
  from: string | null;
  to: string;
  event: string | null;
  /** Optional free-form 1-line summary. The engine fills this from the
   *  triggering actor's output (provider summary / system summary /
   *  guardian decision / gate decision / error tail). Treat as advisory
   *  prose, not a typed payload. */
  summary?: string;
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
 *  node id. Strings pass through; single-key compound walks deeper into
 *  the child UNLESS the child is a multi-key parallel — in that case we
 *  stop at the parent and return its id, so the timeline records
 *  "entered the parallel group" once (not one entry per region, and
 *  not the arbitrary first region's name). */
export function serializeStateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replaceAll("__", ".");
  if (typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [key, child] = entries[0];
    if (
      child !== null &&
      typeof child === "object" &&
      Object.keys(child as Record<string, unknown>).length > 1
    ) {
      // Parallel state: parent has many simultaneously-active regions.
      // Stop here and report the parent's id.
      return key.replaceAll("__", ".");
    }
    const deeper = serializeStateValue(child);
    return deeper ?? key.replaceAll("__", ".");
  }
  // Multiple top-level keys (rare) — take the first.
  return entries[0][0].replaceAll("__", ".");
}
