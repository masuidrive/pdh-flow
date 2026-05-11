import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTicket, useRuns } from "../hooks/useTickets";
import { Markdown } from "../components/Markdown";

export function TicketPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useTicket(slug);
  const runs = useRuns();
  const navigate = useNavigate();
  const [variant, setVariant] = useState<"light" | "full">("full");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );
  const t = q.data;
  if (!t) return <p className="text-sm">ticket not found</p>;

  const ticketStatus = (t.ticket_frontmatter as { status?: string })?.status ?? "open";
  const isClosed = ticketStatus === "done" || ticketStatus === "cancelled";

  async function handleStart() {
    setStartError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(slug ?? "")}/start-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow: "pdh-c-v2", variant }),
      });
      const body = (await res.json()) as { ok?: boolean; run_id?: string; error?: string };
      if (!res.ok || body.error) throw new Error(body.error || `start-run failed: ${res.status}`);
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

  async function handleCancel() {
    setCancelError(null);
    if (!cancelReason.trim()) {
      setCancelError("Reason is required.");
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(slug ?? "")}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.error) throw new Error(body.error || `cancel failed: ${res.status}`);
      setCancelOpen(false);
      window.location.reload();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

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
        <span className={`badge badge-sm ${
          ticketStatus === "done" ? "badge-success"
            : ticketStatus === "cancelled" ? "badge-warning"
              : ticketStatus === "in_progress" ? "badge-info"
                : "badge-ghost"
        }`}>{ticketStatus}</span>
        {t.latest_run ? (
          <Link
            to={`/runs/${encodeURIComponent(t.latest_run.run_id)}`}
            className="btn btn-sm"
          >
            Open latest run
          </Link>
        ) : null}
        {!isClosed ? (
          <div className="ml-auto flex items-center gap-2">
            <div className="join" title="Pick PD-C variant">
              <button
                type="button"
                className={`btn btn-xs join-item ${variant === "light" ? "btn-active" : ""}`}
                onClick={() => setVariant("light")}
              >
                light
              </button>
              <button
                type="button"
                className={`btn btn-xs join-item ${variant === "full" ? "btn-active" : ""}`}
                onClick={() => setVariant("full")}
              >
                full
              </button>
            </div>
            <button
              type="button"
              className="btn btn-warning btn-sm"
              disabled={cancelling}
              onClick={() => setCancelOpen(true)}
              title="Cancel ticket via ticket.sh cancel — discards uncommitted work + branch"
            >
              Cancel ticket
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={starting}
              onClick={handleStart}
              title={`Spawn pdh-c-v2 (${variant}) on this ticket's worktree`}
            >
              {starting ? "Starting…" : "Start engine"}
            </button>
          </div>
        ) : null}
      </header>
      {startError ? (
        <div className="alert alert-error mb-4">
          <span className="font-mono text-xs">{startError}</span>
        </div>
      ) : null}
      {cancelOpen ? (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Cancel ticket {t.slug}</h3>
            <p className="text-sm py-2 opacity-80">
              Shells <span className="font-mono">ticket.sh cancel -f</span>. Force-cancels
              the ticket — uncommitted work is lost, the feature branch is force-deleted.
            </p>
            <label className="form-control">
              <span className="label-text mb-1">Reason (required, recorded for audit)</span>
              <textarea
                className="textarea textarea-bordered text-sm"
                value={cancelReason}
                onChange={(ev) => setCancelReason(ev.target.value)}
                rows={3}
                placeholder="e.g. duplicate of #123; superseded"
              />
            </label>
            {cancelError ? (
              <div className="alert alert-error mt-3">
                <span className="text-xs">{cancelError}</span>
              </div>
            ) : null}
            <div className="modal-action">
              <button type="button" className="btn btn-ghost btn-sm" disabled={cancelling}
                onClick={() => { setCancelOpen(false); setCancelError(null); }}>
                Back
              </button>
              <button type="button" className="btn btn-warning btn-sm"
                disabled={cancelling || !cancelReason.trim()} onClick={handleCancel}>
                {cancelling ? "Cancelling…" : "Cancel ticket"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
            <div className="text-sm bg-base-200 p-3 rounded max-h-[400px] overflow-auto">
              <Markdown source={t.ticket_body} />
            </div>
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
            <div className="text-sm bg-base-200 p-3 rounded max-h-[600px] overflow-auto">
              <Markdown source={t.note_body} />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
