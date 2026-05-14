import { useEffect, useMemo, useState } from "react";
import type { RunEvent, RunSummary } from "../types/api";
import { useRunEvents } from "../hooks/useRunSummary";
import { isTerminalState, stateBadgeClass, stateLabel } from "../lib/runState";

// Persistent footer mirroring v1's BottomBar.
// Left column (always visible): two stacked rows.
//   row 1: ticketId · step badge · round · decision · awaiting flags
//   row 2: Process: <active providers/guardians, grouped, longest elapsed>
// Right column (hidden < sm): a 3-line scrolling activity log driven by
// events.jsonl. v2 emits coarse start/finish beacons (we don't yet pipe
// per-tool events from the CLI), so this log is at node-grain — still
// useful as "what just happened" while you're scrolled deep in the page.
export function BottomBar({ runId, s }: { runId: string; s: RunSummary }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const events = useRunEvents(runId).data ?? [];
  const active = useMemo(() => activeFromEvents(events), [events]);
  const recent = useMemo(() => formatRecentLog(events), [events]);

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-base-300 bg-base-100/85 px-4 py-1.5 backdrop-blur-md">
      <div className="flex items-start gap-4 text-xs">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {s.ticket_id ? (
              <span className="font-mono font-medium truncate">{s.ticket_id}</span>
            ) : null}
            {s.flow ? (
              <span className="opacity-70 font-mono shrink-0">
                {s.flow}
                {s.variant ? ` / ${s.variant}` : ""}
              </span>
            ) : null}
            {s.current_state ? (
              isTerminalState(s.current_state) ? (
                <span className={`badge ${stateBadgeClass(stateLabel(s.current_state).tone)} badge-sm shrink-0`}>
                  {stateLabel(s.current_state).text}
                </span>
              ) : (
                <span className="badge badge-outline badge-sm font-mono shrink-0">
                  {s.current_state}
                </span>
              )
            ) : null}
            <span className="opacity-70 shrink-0">round {s.round}</span>
            {s.active_gate ? (
              <span className="badge badge-warning badge-sm shrink-0">awaiting approval</span>
            ) : null}
            {s.active_turn ? (
              <span className="badge badge-info badge-sm shrink-0">awaiting answer</span>
            ) : null}
            {s.processing_answer ? (
              <span className="badge badge-info badge-sm shrink-0">answering…</span>
            ) : null}
            {s.closed ? (
              <span className="badge badge-success badge-sm shrink-0">closed</span>
            ) : null}
          </div>
          <div className="truncate opacity-70">
            <span className="font-medium opacity-100">Process: </span>
            {describeProcess(active) ||
              (isTerminalState(s.current_state)
                ? s.current_state === "terminal"
                  ? "finished"
                  : `stopped (${stateLabel(s.current_state).text})`
                : "idle")}
          </div>
        </div>
        <div className="hidden sm:block min-w-0 flex-1">
          <ScrollingLog lines={recent} />
        </div>
      </div>
    </footer>
  );
}

interface ActiveEntry {
  nodeId: string;
  role?: string;
  provider?: string;
  startedAt: number;
  kind: "provider" | "guardian" | "system";
}

function activeFromEvents(events: RunEvent[]): ActiveEntry[] {
  const live = new Map<string, ActiveEntry>();
  for (const e of events) {
    const key = `${e.node_id}__round-${e.round}`;
    if (e.kind === "provider_start") {
      live.set(key, {
        nodeId: e.node_id,
        role: e.role,
        provider: e.provider,
        startedAt: Date.parse(e.ts),
        kind: "provider",
      });
    } else if (e.kind === "guardian_start") {
      live.set(key, {
        nodeId: e.node_id,
        role: e.role,
        provider: e.provider,
        startedAt: Date.parse(e.ts),
        kind: "guardian",
      });
    } else if (e.kind === "system_start") {
      live.set(key, {
        nodeId: e.node_id,
        role: e.action,
        startedAt: Date.parse(e.ts),
        kind: "system",
      });
    } else {
      live.delete(key);
    }
  }
  return Array.from(live.values());
}

// Group active entries by role (or kind for system / guardian), report
// `<role> ×N (M:SS)` for groups with >1 member (parallel reviewers),
// elapsed = the longest-running member.
function describeProcess(active: ActiveEntry[]): string {
  if (!active.length) return "";
  const groups = new Map<string, { count: number; longest: number; provider?: string }>();
  const now = Date.now();
  for (const a of active) {
    const role = a.role ?? a.kind;
    const slot = groups.get(role) ?? { count: 0, longest: 0, provider: a.provider };
    slot.count += 1;
    slot.longest = Math.max(slot.longest, Math.floor((now - a.startedAt) / 1000));
    groups.set(role, slot);
  }
  return Array.from(groups.entries())
    .map(([role, slot]) => {
      const provider = slot.provider ? ` (${slot.provider})` : "";
      const tag = slot.count > 1 ? ` ×${slot.count}` : "";
      return `${role}${provider}${tag} ${formatMmSs(slot.longest)}`;
    })
    .join(", ");
}

interface LogLine {
  ts: string;
  label: string;
  text: string;
}

function formatRecentLog(events: RunEvent[]): LogLine[] {
  return events.map((e) => {
    const role = e.role ?? e.action ?? e.kind;
    const provider = e.provider ? ` (${e.provider})` : "";
    let label: string;
    let text: string;
    if (e.kind.endsWith("_start")) {
      label = "start";
      text = `${role}${provider} on ${e.node_id}`;
    } else {
      const tag = e.outcome === "error" ? "error" : e.outcome === "fixture" ? "fixture" : "done";
      const dur = typeof e.duration_ms === "number" ? ` ${formatMmSs(Math.floor(e.duration_ms / 1000))}` : "";
      label = tag;
      text = `${role}${provider} on ${e.node_id}${dur}`;
      if (e.error) text += ` — ${e.error}`;
    }
    return { ts: e.ts, label, text };
  });
}

const ROW_HEIGHT_PX = 18;
const VISIBLE_ROWS = 3;

function ScrollingLog({ lines }: { lines: LogLine[] }) {
  // Bottom-anchored 3-row window. We re-render when `lines` grows; the
  // newest entry just appears at the bottom and the older rows scroll
  // up via the column layout itself. Subtle (no animation library) but
  // matches v1's read order: latest at the bottom = next thing to read.
  const visible = lines.slice(-VISIBLE_ROWS);
  if (visible.length === 0) {
    return (
      <div
        className="opacity-50 italic"
        style={{ height: `${ROW_HEIGHT_PX * VISIBLE_ROWS}px`, lineHeight: `${ROW_HEIGHT_PX}px` }}
      >
        no activity yet…
      </div>
    );
  }
  return (
    <div
      className="relative min-w-0 overflow-hidden"
      style={{ height: `${ROW_HEIGHT_PX * VISIBLE_ROWS}px` }}
    >
      <ul className="absolute inset-x-0 bottom-0 flex flex-col">
        {visible.map((l, i) => (
          <li
            key={`${l.ts}-${i}`}
            className="flex min-w-0 items-center gap-2"
            style={{ height: `${ROW_HEIGHT_PX}px`, lineHeight: `${ROW_HEIGHT_PX}px` }}
          >
            <span className="font-mono text-[10px] opacity-50 shrink-0">{formatTimeAgo(l.ts)}</span>
            <span className="badge badge-ghost badge-xs shrink-0">{l.label}</span>
            <span className="truncate opacity-80">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatMmSs(s: number): string {
  if (s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatTimeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
