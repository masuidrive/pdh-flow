import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useRuns, useTickets } from "../hooks/useTickets";
import { StateBadge } from "../components/Badges";
import { WorktreeFilter } from "../components/WorktreeFilter";
import { ChipFilter } from "../components/ChipFilter";
import { startCreationSession } from "../lib/createSession";

export function TopPage() {
  const tickets = useTickets();
  const runs = useRuns();
  const navigate = useNavigate();
  const [filterWt, setFilterWt] = useState<string | null>(null);
  const [filterEpic, setFilterEpic] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleNewTicket() {
    setCreateError(null);
    setCreating(true);
    try {
      const r = await startCreationSession({ kind: "ticket" });
      navigate(`/assist/${encodeURIComponent(r.sessionId)}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  if (tickets.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (tickets.error) return <ErrorBanner message={String((tickets.error as Error).message ?? tickets.error)} />;

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
    return <RunsTable runsLoading={runs.isLoading} runs={runs.data ?? []} />;
  }
  return (
    <>
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
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={creating}
              onClick={handleNewTicket}
              title="claude を terminal で起動して epic-creator skill が PD-B フェーズで ticket を切ります"
            >
              {creating ? "Opening…" : "+ New ticket (terminal)"}
            </button>
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
