import { useState } from "react";
import { Link } from "react-router-dom";
import { useRuns, useTickets } from "../hooks/useTickets";
import { StateBadge } from "../components/Badges";
import { WorktreeFilter } from "../components/WorktreeFilter";

export function TopPage() {
  const tickets = useTickets();
  const runs = useRuns();
  const [filterWt, setFilterWt] = useState<string | null>(null);

  if (tickets.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (tickets.error) return <ErrorBanner message={String((tickets.error as Error).message ?? tickets.error)} />;

  // Show the per-row worktree column when tickets actually come from
  // more than one worktree — avoids cluttering single-tenant deployments.
  const allTickets = tickets.data ?? [];
  const worktreeSet = Array.from(
    new Set(allTickets.map((t) => t.worktree_path).filter((p): p is string => !!p)),
  );
  const showTicketWorktreeCol = worktreeSet.length > 1;
  const filtered = filterWt
    ? allTickets.filter((t) => t.worktree_path === filterWt)
    : allTickets;

  if (allTickets.length === 0) {
    return <RunsTable runsLoading={runs.isLoading} runs={runs.data ?? []} />;
  }
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="card-title text-lg">
            Tickets ({filtered.length}
            {filterWt ? ` of ${allTickets.length}` : ""})
          </h2>
          {showTicketWorktreeCol ? (
            <WorktreeFilter
              worktrees={worktreeSet}
              value={filterWt}
              onChange={setFilterWt}
            />
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="table table-zebra table-sm">
            <thead>
              <tr>
                <th>Slug</th>
                <th>Title</th>
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
