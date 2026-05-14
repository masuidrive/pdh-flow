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

