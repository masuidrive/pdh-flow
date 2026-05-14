import { useEffect, useState } from "react";
import { useRunEvents } from "../hooks/useRunSummary";
import type { RunEvent, RunSummary } from "../types/api";

/** "Right now" card — what step the engine is currently inside, with the
 *  per-node provider + role and live elapsed time. Designed to sit at the
 *  top of the Summary tab so the user gets an at-a-glance answer to
 *  "what's it doing?" without scrolling through the historical lists.
 *
 *  Source of truth:
 *    - `s.current_state`: the engine's XState value (parent state for a
 *      parallel group, single node id otherwise).
 *    - events.jsonl: provider_start / provider_finish records we use to
 *      decide which children of the current state are still running.
 *
 *  Auto-update is already wired via the page's SSE invalidation — every
 *  state change appends to events.jsonl + bumps snapshot.json, both of
 *  which trigger the React Query refetch. */
export function CurrentStepCard({
  s,
  runId,
}: {
  s: RunSummary;
  runId: string;
}) {
  const events = useRunEvents(runId);
  const state = s.current_state ?? null;
  // 1-second tick to keep the "elapsed" column live without waiting for
  // an SSE event. Only rerenders when there's an in-flight provider —
  // otherwise the tick is a no-op.
  const tick = useTickWhenActive(events.data ?? []);
  void tick;

  if (!state) return null;
  if (isTerminal(state)) {
    return (
      <div className="card bg-base-100 shadow">
        <div className="card-body p-3">
          <h2 className="card-title text-base">
            Status: <span className="font-mono">{state}</span>
            <span className="badge badge-success badge-sm">finished</span>
          </h2>
        </div>
      </div>
    );
  }

  // Parse "<group> (N parallel)" so we know which sub-nodes belong to the
  // active state. Engine extractState formats parallel as that string.
  const parallel = parseParallel(state);
  const activeNodeIds = parallel
    ? activeChildren(events.data ?? [], parallel.group)
    : [state];

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-3 gap-2">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h2 className="card-title text-base">
            Now:{" "}
            <span className="font-mono text-primary">
              {parallel ? parallel.group : state}
            </span>
          </h2>
          {parallel ? (
            <span className="badge badge-info badge-sm">
              {parallel.regions} parallel
            </span>
          ) : null}
          <span className="badge badge-ghost badge-sm">round {s.round}</span>
          {s.last_guardian_decision ? (
            <span className="badge badge-ghost badge-sm font-mono">
              last: {s.last_guardian_decision}
            </span>
          ) : null}
          <span className="ml-auto text-xs opacity-50">
            updated {timeAgoShort(s.saved_at)}
          </span>
        </div>
        <ul className="text-xs space-y-1">
          {activeNodeIds.map((nodeId) => {
            const live = liveFor(events.data ?? [], nodeId);
            return (
              <li key={nodeId} className="flex items-center gap-2">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    live ? "bg-success animate-pulse" : "bg-base-300"
                  }`}
                />
                <span className="font-mono">{nodeId}</span>
                {live ? (
                  <>
                    <span className="badge badge-ghost badge-xs">
                      {live.provider}
                    </span>
                    {live.role ? (
                      <span className="opacity-70">{live.role}</span>
                    ) : null}
                    <span className="ml-auto font-mono opacity-70">
                      {formatElapsed(Date.now() - Date.parse(live.start))}
                    </span>
                  </>
                ) : (
                  <span className="ml-auto opacity-50">idle</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

interface Live {
  provider: string;
  role?: string;
  start: string;
}

/** Look at the latest provider_start / provider_finish pair per node id;
 *  return the start record if the node is still in-flight. */
function liveFor(events: RunEvent[], nodeId: string): Live | null {
  let start: RunEvent | null = null;
  for (const e of events) {
    if (e.node_id !== nodeId) continue;
    if (e.kind === "provider_start") {
      start = e;
    } else if (e.kind === "provider_finish") {
      if (start && Date.parse(e.ts) > Date.parse(start.ts)) {
        start = null;
      }
    }
  }
  if (!start) return null;
  return {
    provider: start.provider ?? "?",
    role: start.role ?? undefined,
    start: start.ts,
  };
}

/** Active provider_step children of the current parallel group — picked
 *  by node_id prefix and matched against unmatched starts in the event log. */
function activeChildren(events: RunEvent[], groupId: string): string[] {
  const inFlight = new Set<string>();
  for (const e of events) {
    if (!e.node_id.startsWith(`${groupId}.`)) continue;
    if (e.kind === "provider_start") inFlight.add(e.node_id);
    else if (e.kind === "provider_finish") inFlight.delete(e.node_id);
  }
  const all = new Set<string>();
  for (const e of events) {
    if (e.node_id.startsWith(`${groupId}.`)) all.add(e.node_id);
  }
  // Show ALL children seen for this group (running + done) so the user
  // sees the full set; the dot indicator distinguishes live vs idle.
  return Array.from(all).sort();
}

function parseParallel(state: string): { group: string; regions: number } | null {
  const m = state.match(/^(.+?)\s+\((\d+)\s+parallel\)$/);
  if (!m) return null;
  return { group: m[1], regions: parseInt(m[2], 10) };
}

function isTerminal(state: string): boolean {
  return (
    state === "terminal" ||
    state === "__stopped__" ||
    state === "__failed__" ||
    state === "human_intervention" ||
    state === "success"
  );
}

function formatElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m${r > 0 ? `${r}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? `${m % 60}m` : ""}`;
}

function timeAgoShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(t).toLocaleTimeString();
}

/** Re-render once a second while any provider event is unmatched (= in
 *  flight). Idle state stops the timer so the page doesn't burn renders
 *  when nothing's happening. */
function useTickWhenActive(events: RunEvent[]): number {
  const [n, setN] = useState(0);
  const inFlight = events.some((e, _i, all) => {
    if (e.kind !== "provider_start") return false;
    return !all.some(
      (f) =>
        f.node_id === e.node_id &&
        f.kind === "provider_finish" &&
        Date.parse(f.ts) > Date.parse(e.ts),
    );
  });
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(() => setN((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [inFlight]);
  return n;
}
