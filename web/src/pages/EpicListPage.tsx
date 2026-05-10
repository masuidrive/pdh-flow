import { useState } from "react";
import { Link } from "react-router-dom";
import { useEpics } from "../hooks/useEpics";
import { ChipFilter } from "../components/ChipFilter";
import { NewEpicModal } from "../components/NewEpicModal";

// /epics — list page across worktrees. Mirrors TopPage shape but
// scoped to epics. Status filter chips + worktree filter.
export function EpicListPage() {
  const q = useEpics();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [wtFilter, setWtFilter] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );

  const all = q.data ?? [];
  const wtSet = Array.from(
    new Set(all.map((e) => e.worktree_path).filter((p): p is string => !!p)),
  );
  const showWorktreeCol = wtSet.length > 1;
  const statuses = ["open", "in_progress", "closed", "cancelled"];

  const filtered = all.filter((e) => {
    if (statusFilter && e.status !== statusFilter) return false;
    if (wtFilter && e.worktree_path !== wtFilter) return false;
    return true;
  });

  return (
    <>
      <NewEpicModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        worktrees={wtSet}
        defaultWorktree={wtSet[0]}
      />
      <div className="card bg-base-100 shadow">
        <div className="card-body">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="card-title text-lg">
              Epics ({filtered.length}
              {statusFilter || wtFilter ? ` of ${all.length}` : ""})
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <ChipFilter
                options={statuses}
                value={statusFilter}
                onChange={setStatusFilter}
                ariaLabel="Filter by status"
                allTitle="Show every status"
                hideWhenSingle={false}
              />
              {showWorktreeCol ? (
                <ChipFilter
                  options={wtSet}
                  value={wtFilter}
                  onChange={setWtFilter}
                  ariaLabel="Filter by worktree"
                  allTitle="Show every worktree"
                  formatLabel={(wt) => wt.split("/").pop() ?? wt}
                  formatTitle={(wt) => wt}
                  hideWhenSingle={false}
                />
              ) : null}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setNewOpen(true)}>
                + New epic
              </button>
            </div>
          </div>
          {filtered.length === 0 ? (
            <p className="text-sm opacity-70 mt-3">No epics yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-zebra table-sm">
                <thead>
                  <tr>
                    <th>Slug</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Branch</th>
                    {showWorktreeCol ? <th>Worktree</th> : null}
                    <th>Tickets</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={`${e.worktree_path}::${e.epic_id}`}>
                      <td className="font-mono text-xs">
                        <Link to={`/epics/${encodeURIComponent(e.epic_id)}`} className="link">
                          {e.epic_id}
                        </Link>
                      </td>
                      <td className="text-xs">{e.title ?? "-"}</td>
                      <td className="text-xs">
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
                          {e.status ?? "?"}
                        </span>
                      </td>
                      <td className="font-mono text-xs opacity-70">{e.branch ?? "-"}</td>
                      {showWorktreeCol ? (
                        <td className="font-mono text-xs opacity-70" title={e.worktree_path}>
                          {e.worktree_path.split("/").pop()}
                        </td>
                      ) : null}
                      <td className="text-xs">
                        {e.closed_ticket_count}/{e.ticket_count}
                      </td>
                      <td className="text-xs opacity-70">{e.created_at ?? "-"}</td>
                      <td>
                        <Link to={`/epics/${encodeURIComponent(e.epic_id)}`} className="btn btn-xs">
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
    </>
  );
}
