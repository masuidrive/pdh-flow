import { NavLink, Route, Routes, useParams } from "react-router-dom";
import { CollapsibleCard } from "../components/CollapsibleCard";
import { useRunBrief, useRunNote, useRunSummary, useRunTicket } from "../hooks/useRunSummary";
import { Markdown } from "../components/Markdown";
import { BottomBar } from "../components/BottomBar";
import { GateCard } from "../components/GateCard";
import { TurnCardWrap } from "../components/TurnCard";
import { JudgementsList } from "../components/JudgementsList";
import { GateDecisionsList } from "../components/GateDecisionsList";
import { FlowGraph } from "../components/Graph/FlowGraph";
import { useTerminal } from "../components/TerminalModal";
import { RunViewer } from "../components/RunViewer";
import { isTerminalState, stateBadgeClass, stateLabel } from "../lib/runState";

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const summary = useRunSummary(runId);
  const note = useRunNote(runId);
  const ticket = useRunTicket(runId);
  const brief = useRunBrief(runId);

  if (!runId) return <p>missing run id</p>;
  if (summary.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (summary.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((summary.error as Error).message ?? summary.error)}</span>
      </div>
    );
  const s = summary.data;
  if (!s) return <p>run not found</p>;

  const summaryPath = `/runs/${encodeURIComponent(runId)}`;
  const graphPath = `${summaryPath}/graph`;
  const viewerPath = `${summaryPath}/viewer`;

  return (
    <>
      <header className="mb-4 flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold font-mono">
          {s.ticket_id ?? runId}
        </h1>
        {s.ticket_id ? (
          <span className="text-xs opacity-60 font-mono" title="run id">
            {runId}
          </span>
        ) : null}
        {s.current_state ? (
          isTerminalState(s.current_state) ? (
            <span className={`badge ${stateBadgeClass(stateLabel(s.current_state).tone)}`}>
              {stateLabel(s.current_state).text}
            </span>
          ) : (
            <span className="badge badge-warning font-mono">{s.current_state}</span>
          )
        ) : null}
        {s.closed ? <span className="badge badge-success">closed</span> : null}
        <div role="tablist" className="tabs tabs-boxed ml-auto">
          <NavLink
            end
            to={summaryPath}
            className={({ isActive }) => `tab ${isActive ? "tab-active" : ""}`}
          >
            Summary
          </NavLink>
          <NavLink
            to={graphPath}
            className={({ isActive }) => `tab ${isActive ? "tab-active" : ""}`}
          >
            Graph
          </NavLink>
          <NavLink
            to={viewerPath}
            className={({ isActive }) => `tab ${isActive ? "tab-active" : ""}`}
          >
            Viewer
          </NavLink>
        </div>
      </header>

      <div className="pb-16">
        <Routes>
          <Route
            index
            element={
              <SummaryView
                runId={runId}
                s={s}
                note={note.data ?? "(loading note…)"}
                ticket={ticket.data ?? null}
                brief={brief.data ?? null}
              />
            }
          />
          <Route
            path="graph"
            element={<FlowGraph runId={runId} currentState={s.current_state ?? null} />}
          />
          <Route path="viewer" element={<RunViewer runId={runId} />} />
        </Routes>
      </div>

      <BottomBar runId={runId} s={s} />
    </>
  );
}

function SummaryView({
  runId,
  s,
  note,
  ticket,
  brief,
}: {
  runId: string;
  s: import("../types/api").RunSummary;
  note: string;
  ticket: string | null;
  brief: string | null;
}) {
  return (
    <>
      {s.current_state === "__failed__" ? (
        <section className="mb-4">
          <FailureCard runId={runId} s={s} />
        </section>
      ) : null}
      <section className="mb-4">
        <GateCard runId={runId} activeGate={s.active_gate} gateDraft={s.gate_draft} />
      </section>
      <section className="mb-4">
        <TurnCardWrap runId={runId} s={s} />
      </section>
      <section className="mb-4">
        <JudgementsList s={s} />
      </section>
      <section className="mb-4">
        <GateDecisionsList s={s} />
      </section>
      {brief ? (
        <section className="mb-4">
          <CollapsibleCard
            title="Product brief"
            subtitle="product-brief.md"
            subtitleHref={`/runs/${encodeURIComponent(runId)}/viewer?path=product-brief.md`}
            defaultOpen={false}
          >
            <Markdown source={brief} runId={runId} />
          </CollapsibleCard>
        </section>
      ) : null}
      {ticket ? (
        <section className="mb-4">
          <CollapsibleCard
            title="Ticket"
            subtitle={s.ticket_id ? `tickets/${s.ticket_id}.md` : "current-ticket.md"}
            subtitleHref={`/runs/${encodeURIComponent(runId)}/viewer?path=${encodeURIComponent(
              s.ticket_id ? `tickets/${s.ticket_id}.md` : "current-ticket.md",
            )}`}
            defaultOpen={true}
          >
            <Markdown source={ticket} runId={runId} />
          </CollapsibleCard>
        </section>
      ) : null}
      <section>
        <CollapsibleCard
          title="Note"
          subtitle="current-note.md"
          subtitleHref={`/runs/${encodeURIComponent(runId)}/viewer?path=current-note.md`}
          defaultOpen={true}
        >
          <Markdown source={note} runId={runId} />
        </CollapsibleCard>
      </section>
    </>
  );
}

/** Shown at the top of SummaryView when current_state is `__failed__`.
 *  Surfaces the engine's last error string so the human knows why the
 *  run died without diving into snapshot.json, and offers a terminal
 *  attached to the run's worktree (last known node) so they can poke
 *  at the state to recover or salvage. */
function FailureCard({
  runId,
  s,
}: {
  runId: string;
  s: import("../types/api").RunSummary;
}) {
  const term = useTerminal();
  const message =
    s.last_error?.trim() ||
    "Engine entered the failed terminal state but did not record an error message.";
  // The run no longer has an active node, but every commit + the run
  // dir still exist on disk. Reuse the assist-open path with the last
  // known step the engine remembers (snapshot's run-level fields) so
  // the spawned terminal lands in the right worktree.
  const lastNode =
    s.judgements.length > 0
      ? s.judgements[s.judgements.length - 1].node_id
      : "__failed__";
  return (
    <div className="card bg-base-100 border border-error/60 shadow">
      <div className="card-body p-4 gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="card-title text-base text-error">Run failed</h2>
          <span className="badge badge-error badge-sm">__failed__</span>
        </div>
        <pre className="text-xs whitespace-pre-wrap break-words bg-base-200 rounded p-3 max-h-60 overflow-auto">
          {message}
        </pre>
        <div className="card-actions justify-end">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => term.open({ runId, nodeId: lastNode, mode: "fresh" })}
            title="failed run の worktree でターミナルを開いて調査する"
          >
            Open in terminal
          </button>
        </div>
      </div>
    </div>
  );
}

