import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useEpic } from "../hooks/useEpics";
import { startCreationSession } from "../lib/createSession";
import { Markdown } from "../components/Markdown";

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
  // Variant selector: light skips PD-D-2 zero-base review, runs faster.
  // Default to light to keep first-cut UX simple; full requires LLM time
  // for the parallel reviewer fan-out.
  const [variant, setVariant] = useState<"light" | "full">("light");
  // Cancel modal state. Cancel is a peer to close: ticket.sh epic cancel
  // discards impl commits + transplants only the epic body to main with
  // a cancel_reason. Reason is required.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [newTicketRunning, setNewTicketRunning] = useState(false);
  const [newTicketError, setNewTicketError] = useState<string | null>(null);

  async function handleNewTicket() {
    setNewTicketError(null);
    setNewTicketRunning(true);
    try {
      // server resolves worktree from epic slug (findWorktreeForEpic)
      const r = await startCreationSession({ kind: "ticket", epic: slug });
      navigate(`/assist/${encodeURIComponent(r.sessionId)}`);
    } catch (err) {
      setNewTicketError(err instanceof Error ? err.message : String(err));
    } finally {
      setNewTicketRunning(false);
    }
  }

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
        body: JSON.stringify({ variant }),
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

  async function handleCancel() {
    setCancelError(null);
    if (!cancelReason.trim()) {
      setCancelError("Reason is required.");
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch(`/api/epics/${encodeURIComponent(slug ?? "")}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || body.error) {
        throw new Error(body.error || `cancel failed: ${res.status}`);
      }
      // Cancel is synchronous — refetch will pick up status: cancelled.
      setCancelOpen(false);
      setCancelReason("");
      // Trigger React Query to re-fetch by invalidating manually via reload-effect:
      // simplest is to navigate back to /; the SSE invalidate would also fire on next
      // engine event but cancel doesn't go through the engine.
      window.location.reload();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
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
        {!isClosed ? (
          <div className="ml-auto flex items-center gap-2">
            {/* Variant selector. Light skips PD-D-2 zero-base review. */}
            <div className="join" title="Pick PD-D variant">
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
              title="Cancel epic — discards impl commits, only the epic body lands on main"
            >
              Cancel epic
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!e.can_start_close || starting}
              onClick={handleStartClose}
              title={
                !e.can_start_close
                  ? (e.preflight?.blockers ?? []).join("\n") || "Close cycle not available"
                  : `Spawn pdh-d (${variant}) run on this worktree`
              }
            >
              {starting ? "Starting…" : "Start close cycle"}
            </button>
          </div>
        ) : null}
      </header>

      {cancelOpen ? (
        <div className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg">Cancel epic {e.epic_id}</h3>
            <p className="text-sm py-2 opacity-80">
              ticket.sh epic cancel: implementation commits on the epic branch are
              <strong> NOT </strong>
              merged. Only the epic body + cancel_reason land on main. Branch is force-deleted.
            </p>
            <label className="form-control">
              <span className="label-text mb-1">Reason (required)</span>
              <textarea
                className="textarea textarea-bordered text-sm"
                value={cancelReason}
                onChange={(ev) => setCancelReason(ev.target.value)}
                rows={3}
                placeholder="e.g. scope changed; superseded by epic X"
              />
            </label>
            {cancelError ? (
              <div className="alert alert-error mt-3">
                <span className="text-xs">{cancelError}</span>
              </div>
            ) : null}
            <div className="modal-action">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={cancelling}
                onClick={() => {
                  setCancelOpen(false);
                  setCancelError(null);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-warning btn-sm"
                disabled={cancelling || !cancelReason.trim()}
                onClick={handleCancel}
              >
                {cancelling ? "Cancelling…" : "Cancel epic"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
            {!isClosed ? (
              <>
                <button
                  type="button"
                  className="btn btn-xs btn-outline btn-primary mb-2"
                  disabled={newTicketRunning}
                  onClick={handleNewTicket}
                  title="claude を terminal で起動して ticket を切ります"
                >
                  {newTicketRunning ? "Opening…" : "+ New ticket (terminal)"}
                </button>
                {newTicketError ? (
                  <div className="alert alert-error mb-2">
                    <span className="text-xs">{newTicketError}</span>
                  </div>
                ) : null}
              </>
            ) : null}
            {e.linked_tickets.length === 0 ? (
              <p className="text-sm opacity-70">No tickets linked yet.</p>
            ) : (
              <ul className="text-sm font-mono space-y-1">
                {e.linked_tickets.map((t, i) => (
                  <li key={i} className="flex gap-3 items-center">
                    <span
                      className={`badge badge-xs ${
                        t.status === "done" ? "badge-success" : "badge-warning"
                      }`}
                    >
                      {t.status}
                    </span>
                    {t.slug ? (
                      <Link to={`/tickets/${encodeURIComponent(t.slug)}`} className="link">
                        {t.slug}
                      </Link>
                    ) : (
                      <span className="opacity-70">{t.file_location || "-"}</span>
                    )}
                    {t.title && t.title !== t.slug ? (
                      <span className="opacity-70">— {t.title}</span>
                    ) : null}
                    {t.base_branch ? (
                      <span className="opacity-50 text-xs">[{t.base_branch}]</span>
                    ) : null}
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
          <div className="text-sm bg-base-200 p-3 rounded max-h-[600px] overflow-auto">
            <Markdown source={e.epic_body} />
          </div>
        </div>
      </section>
    </>
  );
}
