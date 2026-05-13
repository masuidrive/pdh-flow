import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRuns, useTickets } from "../hooks/useTickets";
import { StateBadge } from "../components/Badges";
import { WorktreeFilter } from "../components/WorktreeFilter";
import { ChipFilter } from "../components/ChipFilter";
import {
  applyBootstrap,
  getBootstrapStatus,
  startCreationSession,
  type BootstrapStatus,
} from "../lib/createSession";

export function TopPage() {
  const tickets = useTickets();
  const runs = useRuns();
  const navigate = useNavigate();
  const [filterWt, setFilterWt] = useState<string | null>(null);
  const [filterEpic, setFilterEpic] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function openTerminal() {
    setCreateError(null);
    setCreating(true);
    try {
      const r = await startCreationSession({ kind: "general" });
      navigate(`/assist/${encodeURIComponent(r.sessionId)}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const openTerminalBtn = (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={creating}
      onClick={() => void openTerminal()}
      title="claude を terminal で起動。docs/product-delivery-hierarchy.md と product-brief.md を読んでから、epic / ticket どちらを作るか聞いてきます"
    >
      {creating ? "Opening…" : "Open terminal (epic / ticket)"}
    </button>
  );

  if (tickets.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (tickets.error)
    return (
      <>
        <BootstrapGate />
        <ErrorBanner message={String((tickets.error as Error).message ?? tickets.error)} />
      </>
    );

  // Show the per-row worktree column when tickets actually come from
  // more than one worktree — avoids cluttering single-tenant deployments.
  const allTickets = tickets.data ?? [];
  const worktreeSet = Array.from(
    new Set(allTickets.map((t) => t.worktree_path).filter((p): p is string => !!p)),
  );
  const showTicketWorktreeCol = worktreeSet.length > 1;
  // Mirror the worktree pattern for epics: only render the column /
  // filter when an actual epic is in play, so non-epic deployments
  // don't pay the visual tax.
  const epicSet = Array.from(
    new Set(allTickets.map((t) => t.epic_id).filter((e): e is string => !!e)),
  );
  const showEpicCol = epicSet.length > 0;
  const filtered = allTickets.filter((t) => {
    if (filterWt && t.worktree_path !== filterWt) return false;
    if (filterEpic && t.epic_id !== filterEpic) return false;
    return true;
  });

  if (allTickets.length === 0) {
    return (
      <>
        <BootstrapGate />
        {createError ? (
          <div className="alert alert-error mb-3">
            <span className="font-mono text-xs">{createError}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-lg font-semibold">No tickets yet</h2>
          {openTerminalBtn}
        </div>
        <p className="text-sm opacity-70 mb-3">
          This worktree has no tickets. Use <span className="font-mono">Open terminal</span> — claude
          reads <span className="font-mono">docs/product-delivery-hierarchy.md</span> +{" "}
          <span className="font-mono">product-brief.md</span> and helps you cut an epic or a ticket.
          Engine runs (if any) are listed below.
        </p>
        <RunsTable runsLoading={runs.isLoading} runs={runs.data ?? []} />
      </>
    );
  }
  return (
    <>
      <BootstrapGate />
      {createError ? (
        <div className="alert alert-error mb-3">
          <span className="font-mono text-xs">{createError}</span>
        </div>
      ) : null}
      <div className="card bg-base-100 shadow">
        <div className="card-body">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="card-title text-lg">
            Tickets ({filtered.length}
            {filterWt || filterEpic ? ` of ${allTickets.length}` : ""})
          </h2>
          <div className="flex items-center gap-3 flex-wrap">
            {showEpicCol ? (
              <ChipFilter
                options={epicSet}
                value={filterEpic}
                onChange={setFilterEpic}
                ariaLabel="Filter by epic"
                allTitle="Show tickets across every epic"
              />
            ) : null}
            {showTicketWorktreeCol ? (
              <WorktreeFilter
                worktrees={worktreeSet}
                value={filterWt}
                onChange={setFilterWt}
              />
            ) : null}
            {openTerminalBtn}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Title</th>
                {showEpicCol ? <th>Epic</th> : null}
                {showTicketWorktreeCol ? <th>Worktree</th> : null}
                <th>Status</th>
                <th>Run state</th>
                <th>Opened</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const target = t.latest_run_id
                  ? `/runs/${encodeURIComponent(t.latest_run_id)}`
                  : `/tickets/${encodeURIComponent(t.slug)}`;
                const wtName = t.worktree_path ? t.worktree_path.split("/").pop() : null;
                return (
                  <tr key={`${t.worktree_path ?? "_"}::${t.slug}`}>
                    <td className="font-mono text-xs">{t.slug}</td>
                    <td className="text-xs">{t.title ?? "-"}</td>
                    {showEpicCol ? (
                      <td className="font-mono text-xs opacity-70">
                        {t.epic_id ? (
                          <Link to={`/epics/${encodeURIComponent(t.epic_id)}`} className="link">
                            {t.epic_id}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                    ) : null}
                    {showTicketWorktreeCol ? (
                      <td className="font-mono text-xs opacity-70" title={t.worktree_path ?? ""}>
                        {wtName ?? "-"}
                      </td>
                    ) : null}
                    <td className="text-xs">
                      {t.status ? (
                        <span
                          className={`badge badge-sm ${
                            t.status === "done"
                              ? "badge-success"
                              : t.status === "in_progress"
                                ? "badge-info"
                                : "badge-ghost"
                          }`}
                        >
                          {t.status}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-xs">
                      <StateBadge state={t.latest_run_state ?? null} />
                    </td>
                    <td className="text-xs opacity-70">{t.opened_at ?? "-"}</td>
                    <td>
                      <Link to={target} className="btn btn-xs">
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </>
  );
}

// Checks the worktree for ticket.sh / .ticket-config.yaml /
// docs/product-delivery-hierarchy.md on mount; if any are missing it pops a
// blocking modal offering to install them (copied from pdh-flow's bundled
// templates; the config via `ticket.sh init`). Renders nothing once the
// worktree is set up (or if the user dismisses it).
function BootstrapGate() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBootstrapStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* non-fatal — the top page still works without the bootstrap check */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || !status || status.missing.length === 0) return null;

  async function runSetup() {
    setBusy(true);
    setError(null);
    try {
      const r = await applyBootstrap();
      setStatus(r);
      if (r.error) {
        setError(r.error);
      } else if (r.missing.length === 0) {
        setDismissed(true);
        // Tickets / epics may now resolve (ticket.sh init created tickets/).
        qc.invalidateQueries({ queryKey: ["tickets"] });
        qc.invalidateQueries({ queryKey: ["epics"] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card bg-base-100 shadow-xl w-full max-w-lg">
        <div className="card-body gap-3">
          <h3 className="card-title text-base">Worktree setup needed</h3>
          <p className="text-sm opacity-80">
            This worktree (<span className="font-mono">{status.worktree}</span>) is missing the files
            the ticket/epic flow needs. Install them now?
          </p>
          <ul className="text-sm font-mono bg-base-200 rounded p-2 space-y-0.5">
            {status.missing.map((m) => (
              <li key={m}>· {m}</li>
            ))}
          </ul>
          <p className="text-xs opacity-60">
            <span className="font-mono">ticket.sh</span> and{" "}
            <span className="font-mono">docs/product-delivery-hierarchy.md</span> are copied from
            pdh-flow's bundled templates; <span className="font-mono">.ticket-config.yaml</span> is
            generated by <span className="font-mono">ticket.sh init</span>.
          </p>
          {!status.templates_available ? (
            <div className="alert alert-warning text-xs">
              This pdh-flow build doesn't ship the template sources — install the files manually.
            </div>
          ) : null}
          {error ? <div className="alert alert-error text-xs font-mono">{error}</div> : null}
          <div className="flex justify-end gap-2 flex-wrap">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setDismissed(true)}
            >
              Not now
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !status.templates_available}
              onClick={() => void runSetup()}
            >
              {busy ? "Setting up…" : "Set up worktree"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunsTable({ runs, runsLoading }: { runs: import("../types/api").RunListItem[]; runsLoading: boolean }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">Runs</h2>
        {runsLoading ? (
          <p className="text-sm opacity-70">loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm opacity-70">No tickets yet. Start the engine on a worktree, then come back.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Ticket</th>
                  <th>State</th>
                  <th>Saved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id}>
                    <td className="font-mono text-xs">{r.run_id}</td>
                    <td className="font-mono text-xs">{r.ticket_id ?? "-"}</td>
                    <td className="text-xs">
                      <StateBadge state={r.current_state} />
                    </td>
                    <td className="text-xs opacity-70">{r.saved_at ?? "-"}</td>
                    <td>
                      <Link to={`/runs/${encodeURIComponent(r.run_id)}`} className="btn btn-xs">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="alert alert-error">
      <span className="font-mono text-xs">{message}</span>
    </div>
  );
}
