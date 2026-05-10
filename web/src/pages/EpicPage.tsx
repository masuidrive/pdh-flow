import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useEpic } from "../hooks/useEpics";

// EpicPage — /epics/:slug. Reads ticket.sh epic show <slug> --json via
// the server's /api/epics/:slug endpoint. Surfaces:
//   - Epic body (rendered as plain markdown text; same approach the
//     TicketPage takes for ticket_body)
//   - Linked tickets list (count + status rollup)
//   - Branch state (when branch != main)
//   - Preflight blockers from ticket.sh
//   - "Start close cycle" button — disabled when can_start_close is
//     false; on click, POSTs /api/epics/:slug/start-close and
//     navigates to the new run page.
export function EpicPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useEpic(slug);
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );
  const e = q.data;
  if (!e) return <p className="text-sm">epic not found</p>;

  const wtName = e.worktree_path.split("/").pop() ?? e.worktree_path;
  const isClosed = e.status === "closed" || e.status === "cancelled";

  async function handleStartClose() {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/epics/${encodeURIComponent(slug ?? "")}/start-close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "light" }),
      });
      if (!res.ok) throw new Error(`start-close failed: ${res.status}`);
      const body = (await res.json()) as { run_id?: string; error?: string };
      if (body.error) throw new Error(body.error);
      if (body.run_id) {
        navigate(`/runs/${encodeURIComponent(body.run_id)}`);
        return;
      }
      throw new Error("server did not return a run_id");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <header className="mb-6 flex items-center gap-3 flex-wrap">
        <Link to="/" className="btn btn-ghost btn-sm">
          ← Tickets
        </Link>
        <h1 className="text-xl font-semibold font-mono">{e.epic_id}</h1>
        {e.title ? <span className="opacity-70">{e.title}</span> : null}
        <span
          className={`badge badge-sm ${
            e.status === "closed"
              ? "badge-success"
              : e.status === "cancelled"
                ? "badge-warning"
                : e.status === "in_progress"
                  ? "badge-info"
                  : "badge-ghost"
          }`}
        >
          {e.status ?? "unknown"}
        </span>
        {e.active_close_run_id ? (
          <Link
            to={`/runs/${encodeURIComponent(e.active_close_run_id)}`}
            className="btn btn-warning btn-sm"
          >
            Resume active close run
          </Link>
        ) : null}
        <button
          type="button"
          className="btn btn-primary btn-sm ml-auto"
          disabled={!e.can_start_close || starting || isClosed}
          onClick={handleStartClose}
          title={
            !e.can_start_close
              ? (e.preflight?.blockers ?? []).join("\n") || "Close cycle not available"
              : "Spawn pdh-d run on this worktree"
          }
        >
          {starting ? "Starting…" : "Start close cycle"}
        </button>
      </header>

      {startError ? (
        <div className="alert alert-error mb-4">
          <span className="font-mono text-xs">{startError}</span>
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3 mb-4">
        <div className="card bg-base-100 shadow md:col-span-1">
          <div className="card-body">
            <h2 className="card-title text-lg">Meta</h2>
            <dl className="text-sm grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
              <dt className="opacity-70">Branch</dt>
              <dd className="font-mono">{e.branch ?? "-"}</dd>
              <dt className="opacity-70">Worktree</dt>
              <dd className="font-mono text-xs" title={e.worktree_path}>
                {wtName}
              </dd>
              <dt className="opacity-70">Created</dt>
              <dd className="text-xs">{e.created_at ?? "-"}</dd>
              {e.closed_at ? (
                <>
                  <dt className="opacity-70">Closed</dt>
                  <dd className="text-xs">{e.closed_at}</dd>
                </>
              ) : null}
              {e.cancelled_at ? (
                <>
                  <dt className="opacity-70">Cancelled</dt>
                  <dd className="text-xs">{e.cancelled_at}</dd>
                </>
              ) : null}
              {e.cancel_reason ? (
                <>
                  <dt className="opacity-70">Reason</dt>
                  <dd className="text-xs">{e.cancel_reason}</dd>
                </>
              ) : null}
              {e.branch_state ? (
                <>
                  <dt className="opacity-70">HEAD</dt>
                  <dd className="font-mono text-xs">
                    {e.branch_state.head_sha ?? "-"}
                    {typeof e.branch_state.ahead_of_main === "number"
                      ? ` (+${e.branch_state.ahead_of_main} from main)`
                      : ""}
                  </dd>
                </>
              ) : null}
            </dl>
          </div>
        </div>
        <div className="card bg-base-100 shadow md:col-span-2">
          <div className="card-body">
            <h2 className="card-title text-lg">
              Linked tickets ({e.closed_ticket_count}/{e.ticket_count} done)
            </h2>
            {e.linked_tickets.length === 0 ? (
              <p className="text-sm opacity-70">No tickets linked yet.</p>
            ) : (
              <ul className="text-sm font-mono">
                {e.linked_tickets.map((t, i) => (
                  <li key={i} className="flex gap-3 items-center">
                    <span
                      className={`badge badge-xs ${
                        t.status === "done" ? "badge-success" : "badge-warning"
                      }`}
                    >
                      {t.status}
                    </span>
                    <span>{t.location}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {e.preflight && !e.preflight.ok ? (
        <div className="alert alert-warning mb-4">
          <div>
            <h3 className="font-bold">Preflight blockers</h3>
            <ul className="list-disc ml-5 text-xs">
              {e.preflight.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <section className="card bg-base-100 shadow">
        <div className="card-body">
          <h2 className="card-title text-lg">Body</h2>
          <pre className="pre-wrap text-xs bg-base-200 p-3 rounded max-h-[600px] overflow-auto">
            {e.epic_body}
          </pre>
        </div>
      </section>
    </>
  );
}
