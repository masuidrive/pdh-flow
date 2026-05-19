// After-close action panel. Visible only when the run has reached a
// terminal-kind state (terminal / __failed__ / __stopped__ / human_-
// intervention). The post-close worktree is on the parent ticket's
// base_branch (main or epics/<slug>) — ticket.sh close has already
// checked it out as part of the squash-merge — so terminals and
// `./ticket.sh new` spawned from here land on the correct branch with
// no extra git handling on our side.
//
// Two surfaces:
//   1. Plain "Open terminal" — a bash PTY in the worktree, useful for
//      poking around, running ad-hoc commands, or just having a shell.
//   2. Per-deferred-item "Cut follow-up ticket" — spawns a claude
//      session pre-loaded with: the parent ticket / note paths, the
//      verbatim deferred concern + rationale, the suggested slug, and
//      (when present) the parent epic_id. Claude reads the context,
//      runs `./ticket.sh new <slug> [--epic <epic_id>]`, then edits the
//      generated `tickets/<slug>.md` Why/What/AC.

import { useState } from "react";
import { postEmpty, postJson } from "../lib/api";
import { useTerminal } from "./TerminalModal";
import type { DeferredFollowup, RunSummary } from "../types/api";
import { isTerminalState, stateLabel } from "../lib/runState";

export function PostCloseCard({
  runId,
  s,
}: {
  runId: string;
  s: RunSummary;
}) {
  if (!isTerminalState(s.current_state)) return null;
  const deferred = s.deferred_followups ?? [];
  const stateText = s.current_state ? stateLabel(s.current_state).text : "";
  return (
    <div className="card bg-base-100 border border-base-300 shadow-sm">
      <div className="card-body">
        <h2 className="card-title text-lg">After close</h2>
        <p className="text-xs opacity-70">
          Run finished ({stateText}). The worktree is on the parent
          ticket's base branch — terminals you open here are safe to use
          for follow-up ticket cuts and ad-hoc commands.
        </p>
        <div className="flex gap-2 flex-wrap">
          <OpenTerminalButton runId={runId} />
        </div>
        {deferred.length > 0 ? (
          <DeferredList runId={runId} items={deferred} />
        ) : (
          <p className="text-xs opacity-60 mt-2">
            No `defer` triage entries were recorded for this run.
          </p>
        )}
      </div>
    </div>
  );
}

function OpenTerminalButton({ runId }: { runId: string }) {
  const term = useTerminal();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setErr(null);
    try {
      const r = await postEmpty<{ sessionId: string; title?: string }>(
        `/api/runs/${encodeURIComponent(runId)}/open-terminal`,
      );
      term.openExisting({
        sessionId: r.sessionId,
        title: r.title ?? "terminal",
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-outline"
        onClick={open}
        disabled={busy}
        title="Open a bash terminal in the run's worktree (main / epic branch already checked out)"
      >
        {busy ? "Opening…" : "Open terminal"}
      </button>
      {err ? <span className="text-error text-xs ml-2">{err}</span> : null}
    </>
  );
}

function DeferredList({
  runId,
  items,
}: {
  runId: string;
  items: DeferredFollowup[];
}) {
  return (
    <>
      <h3 className="text-sm font-semibold mt-2">
        Deferred follow-ups{" "}
        <span className="opacity-60 font-normal">— cut each as its own ticket</span>
      </h3>
      <ul className="space-y-2">
        {items.map((d) => (
          <DeferredRow key={d.follow_up_ticket} runId={runId} d={d} />
        ))}
      </ul>
    </>
  );
}

function DeferredRow({
  runId,
  d,
}: {
  runId: string;
  d: DeferredFollowup;
}) {
  const term = useTerminal();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function cut() {
    setBusy(true);
    setErr(null);
    try {
      const r = await postJson<{ sessionId: string; title?: string }>(
        `/api/runs/${encodeURIComponent(runId)}/cut-follow-up-ticket`,
        { follow_up_ticket: d.follow_up_ticket },
      );
      term.openExisting({
        sessionId: r.sessionId,
        title: r.title ?? `follow-up → ${d.follow_up_ticket}`,
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded border border-base-300 p-2 space-y-1.5 bg-base-200/40">
      <div className="flex items-center gap-2 flex-wrap">
        <code className="font-mono text-xs bg-base-100 rounded px-1.5 py-0.5">
          {d.follow_up_ticket}
        </code>
        <span className="text-[11px] opacity-60">
          from {d.source_node}
          {d.source_round != null ? ` (round ${d.source_round})` : ""}
        </span>
      </div>
      <div className="text-sm">{d.concern}</div>
      {d.rationale ? (
        <div className="text-xs opacity-80">
          <span className="opacity-60">rationale: </span>
          {d.rationale}
        </div>
      ) : null}
      <div className="flex gap-2 items-center">
        <button
          type="button"
          className="btn btn-xs btn-primary"
          onClick={cut}
          disabled={busy}
          title="Spawn a claude session pre-loaded with this concern; it will run ticket.sh new and edit the new ticket file"
        >
          {busy ? "Spawning…" : "Cut follow-up ticket"}
        </button>
        {err ? <span className="text-error text-xs">{err}</span> : null}
      </div>
    </li>
  );
}
