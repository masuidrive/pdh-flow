import { Link, useParams } from "react-router-dom";
import { useTicket } from "../hooks/useTickets";

export function TicketPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useTicket(slug);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );
  const t = q.data;
  if (!t) return <p className="text-sm">ticket not found</p>;

  return (
    <>
      <header className="mb-6 flex items-center gap-3 flex-wrap">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← Tickets
        </Link>
        <h1 className="text-xl font-semibold font-mono">{t.slug}</h1>
        {t.latest_run_id ? (
          <Link to={`/runs/${encodeURIComponent(t.latest_run_id)}`} className="btn btn-primary btn-sm ml-auto">
            Open latest run
          </Link>
        ) : null}
      </header>
      <section className="grid gap-4 md:grid-cols-2 mb-4">
        <div className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Frontmatter</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded">
              {JSON.stringify(t.frontmatter, null, 2)}
            </pre>
          </div>
        </div>
        <div className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Body</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[400px] overflow-auto">
              {t.body}
            </pre>
          </div>
        </div>
      </section>
      {t.note ? (
        <section className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title text-lg">Note</h2>
            <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[600px] overflow-auto">
              {t.note}
            </pre>
          </div>
        </section>
      ) : null}
    </>
  );
}
