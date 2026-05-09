import { Link, useParams } from "react-router-dom";
import { useTicket, useRuns } from "../hooks/useTickets";

export function TicketPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useTicket(slug);
  const runs = useRuns();

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );
  const t = q.data;
  if (!t) return <p className="text-sm">ticket not found</p>;

  // Runs whose snapshot ticket_id matches this slug. The engine's
  // deriveTicketId() reads from current-note.md frontmatter, which can
  // diverge from the tickets/<slug>.md filename (e.g. ticket-new
  // worktrees that haven't yet symlinked current-note.md, or fixture
  // replays). When no exact match, fall back to all runs in the same
  // worktree so the user still has a path to a run page.
  const allRuns = runs.data ?? [];
  const matchingRuns = allRuns.filter((r) => r.ticket_id === slug);
  const fallbackRuns =
    matchingRuns.length === 0
      ? allRuns // any run in any worktree the server aggregates from
      : [];

  return (
    <>
      <header className="mb-6 flex items-center gap-3 flex-wrap">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← Tickets
        </Link>
        <h1 className="text-xl font-semibold font-mono">{t.slug}</h1>
        {t.latest_run ? (
          <Link
            to={`/runs/${encodeURIComponent(t.latest_run.run_id)}`}
            className="btn btn-primary btn-sm ml-auto"
          >
            Open latest run
          </Link>
        ) : null}
      </header>
      <section className="grid gap-4 md:grid-cols-2 mb-4">
        <div className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Frontmatter</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded">
              {JSON.stringify(t.ticket_frontmatter, null, 2)}
            </pre>
          </div>
        </div>
        <div className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Body</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[400px] overflow-auto">
              {t.ticket_body}
            </pre>
          </div>
        </div>
      </section>
      {(matchingRuns.length > 0 || fallbackRuns.length > 0) ? (
        <section className="card bg-base-100 shadow mb-4">
          <div className="card-body">
            <h2 className="card-title text-lg">
              {matchingRuns.length > 0
                ? `Runs for this ticket (${matchingRuns.length})`
                : `Recent runs in this server (${fallbackRuns.length})`}
            </h2>
            {matchingRuns.length === 0 ? (
              <p className="text-xs opacity-70">
                No run snapshot has <code>ticket_id={slug}</code>. The engine derives
                ticket_id from <code>current-note.md</code> frontmatter; runs below
                may belong to this ticket under a derived id.
              </p>
            ) : null}
            <ul className="text-sm space-y-1">
              {(matchingRuns.length > 0 ? matchingRuns : fallbackRuns).map((r) => (
                <li key={r.run_id} className="flex gap-3 items-center flex-wrap">
                  <Link
                    to={`/runs/${encodeURIComponent(r.run_id)}`}
                    className="font-mono text-xs link link-primary"
                  >
                    {r.run_id}
                  </Link>
                  <span className="opacity-70 text-xs">{r.current_state ?? "-"}</span>
                  <span className="opacity-50 text-xs">{r.saved_at ?? "-"}</span>
                  {r.ticket_id && r.ticket_id !== slug ? (
                    <span className="badge badge-ghost badge-xs font-mono">
                      ticket_id={r.ticket_id}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
      {t.note_body ? (
        <section className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Note</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[600px] overflow-auto">
              {t.note_body}
            </pre>
          </div>
        </section>
      ) : null}
    </>
  );
}
