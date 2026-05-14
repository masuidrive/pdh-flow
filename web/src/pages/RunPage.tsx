import { useState } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import { useRunBrief, useRunNote, useRunSummary, useRunTicket } from "../hooks/useRunSummary";
import { Markdown } from "../components/Markdown";
import { BottomBar } from "../components/BottomBar";
import { GateCard } from "../components/GateCard";
import { TurnCardWrap } from "../components/TurnCard";
import { JudgementsList } from "../components/JudgementsList";
import { GateDecisionsList } from "../components/GateDecisionsList";
import { NoteView } from "../components/NoteView";
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
          <CollapsibleCard title="Product brief" subtitle="product-brief.md" defaultOpen={false}>
            <Markdown source={brief} runId={runId} />
          </CollapsibleCard>
        </section>
      ) : null}
      {ticket ? (
        <section className="mb-4">
          <CollapsibleCard title="Ticket" subtitle={s.ticket_id ? `tickets/${s.ticket_id}.md` : "current-ticket.md"} defaultOpen={true}>
            <Markdown source={ticket} runId={runId} />
          </CollapsibleCard>
        </section>
      ) : null}
      <section>
        <NoteView note={note} />
      </section>
    </>
  );
}

/** Card with a header that toggles the body. Used for the Brief (closed
 *  by default — usually read once) and the Ticket (open by default — the
 *  live contract). Persists open/closed state per (runId, title) in
 *  localStorage so a reload doesn't lose the user's pick. */
function CollapsibleCard({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const storageKey = `pdh-collapsible:${title}`;
  const [open, setOpen] = useState<boolean>(() => {
    const v = localStorage.getItem(storageKey);
    return v === null ? defaultOpen : v === "1";
  });
  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem(storageKey, next ? "1" : "0");
  }
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-3">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-2 w-full text-left hover:opacity-80"
          aria-expanded={open}
        >
          <span className="text-xs opacity-50 w-3">{open ? "▾" : "▸"}</span>
          <h2 className="card-title text-base flex-1">{title}</h2>
          {subtitle ? <span className="text-xs opacity-50 font-mono">{subtitle}</span> : null}
        </button>
        {open ? (
          <div className="text-sm bg-base-200 p-3 rounded mt-2">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
