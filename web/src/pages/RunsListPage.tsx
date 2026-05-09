import { Link } from "react-router-dom";
import { useRuns } from "../hooks/useTickets";
import { StateBadge } from "../components/Badges";
import type { RunListItem } from "../types/api";

// Standalone "all runs" view — the Top page is ticket-centric, but a
// run can exist without a matching ticket (synthetic ticket_id from
// engine fallback, fixture replays, archived tickets) so we always
// expose this as a primary nav target. Mirrors v1's /runs page.
export function RunsListPage() {
  const runs = useRuns();
  const items: RunListItem[] = runs.data ?? [];
  const showWorktreeCol =
    new Set(items.map((r) => r.worktree_path).filter(Boolean)).size > 1;

  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">Runs ({items.length})</h2>
        {runs.isLoading ? (
          <p className="text-sm opacity-70">loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm opacity-70">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Ticket</th>
                  {showWorktreeCol ? <th>Worktree</th> : null}
                  <th>State</th>
                  <th>Saved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const wtName = r.worktree_path ? r.worktree_path.split("/").pop() : null;
                  return (
                    <tr key={r.run_id}>
                      <td className="font-mono text-xs">{r.run_id}</td>
                      <td className="font-mono text-xs">{r.ticket_id ?? "-"}</td>
                      {showWorktreeCol ? (
                        <td
                          className="font-mono text-xs opacity-70"
                          title={r.worktree_path ?? ""}
                        >
                          {wtName ?? "-"}
                        </td>
                      ) : null}
                      <td className="text-xs">
                        <StateBadge state={r.current_state ?? null} />
                      </td>
                      <td className="text-xs opacity-70">{r.saved_at ?? "-"}</td>
                      <td>
                        <Link
                          to={`/runs/${encodeURIComponent(r.run_id)}`}
                          className="btn btn-xs"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
