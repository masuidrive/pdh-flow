import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { useRunNote, useRunSummary } from "../hooks/useRunSummary";
import { StateCard } from "../components/StateCard";
import { GateCard } from "../components/GateCard";
import { TurnCardWrap } from "../components/TurnCard";
import { JudgementsList } from "../components/JudgementsList";
import { GateDecisionsList } from "../components/GateDecisionsList";
import { NoteView } from "../components/NoteView";
import { FlowGraph } from "../components/Graph/FlowGraph";

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const summary = useRunSummary(runId);
  const note = useRunNote(runId);

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

  return (
    <>
      <header className="mb-4 flex items-center gap-3 flex-wrap">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← Runs
        </Link>
        <h1 className="text-xl font-semibold font-mono">{runId}</h1>
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
        </div>
      </header>

      <Routes>
        <Route
          index
          element={
            <SummaryView runId={runId} s={s} note={note.data ?? "(loading note…)"} />
          }
        />
        <Route
          path="graph"
          element={<FlowGraph runId={runId} currentState={s.current_state ?? null} />}
        />
      </Routes>
    </>
  );
}

function SummaryView({
  runId,
  s,
  note,
}: {
  runId: string;
  s: import("../types/api").RunSummary;
  note: string;
}) {
  return (
    <>
      <section className="grid gap-4 md:grid-cols-2 mb-4">
        <StateCard s={s} />
        <GateCard runId={runId} activeGate={s.active_gate} />
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
      <section>
        <NoteView note={note} />
      </section>
    </>
  );
}
