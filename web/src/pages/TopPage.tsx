import { Link } from "react-router-dom";
import { useRuns, useTickets, useWorktrees } from "../hooks/useTickets";
import { StateBadge } from "../components/Badges";
import type { WorktreeInfo } from "../types/api";

export function TopPage() {
  const tickets = useTickets();
  const runs = useRuns();
  const worktrees = useWorktrees();

  if (tickets.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (tickets.error) return <ErrorBanner message={String((tickets.error as Error).message ?? tickets.error)} />;

  const wtList = worktrees.data ?? [];
  const showWorktreesPanel = wtList.length > 1;

  if ((tickets.data ?? []).length === 0) {
    return (
      <>
        {showWorktreesPanel ? <WorktreesPanel worktrees={wtList} /> : null}
        <RunsTable runsLoading={runs.isLoading} runs={runs.data ?? []} />
      </>
    );
  }
  return (
    <>
      {showWorktreesPanel ? <WorktreesPanel worktrees={wtList} /> : null}
      <div className="card bg-base-100 shadow">
        <div className="card-body">
          <h2 className="card-title text-lg">Tickets</h2>
          <div className="overflow-x-auto">
            <table className="table table-zebra table-sm">
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Run state</th>
                  <th>Opened</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(tickets.data ?? []).map((t) => {
                  const target = t.latest_run_id
                    ? `/runs/${encodeURIComponent(t.latest_run_id)}`
                    : `/tickets/${encodeURIComponent(t.slug)}`;
                  return (
                    <tr key={t.slug}>
                      <td className="font-mono text-xs">{t.slug}</td>
                      <td className="text-xs">{t.title ?? "-"}</td>
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
    <>
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
    </>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="alert alert-error">
      <span className="font-mono text-xs">{message}</span>
    </div>
  );
}

// Discovery panel showing every git worktree this server's repo knows
// about. Combined with `pdh-flow ticket new`, this answers "what other
// tickets do I have in flight?". The current `serve` is bound to ONE
// worktree (the highlighted row); to inspect a sibling, the user runs a
// second `pdh-flow serve --worktree <path> --port <free>` and opens that
// port. Aggregating runs across worktrees on a single port is future
// work — see ticket-new.ts and CLAUDE.md "Single-machine assumption".
function WorktreesPanel({ worktrees }: { worktrees: WorktreeInfo[] }) {
  return (
    <div className="card bg-base-100 shadow mb-4">
      <div className="card-body">
        <h2 className="card-title text-lg">Worktrees ({worktrees.length})</h2>
        <p className="text-xs opacity-70">
          Discovered via <code>git worktree list</code>. Each row is a separate checkout — `pdh-flow serve` is currently bound to the highlighted one. Start a second `serve` on a different port to inspect another.
        </p>
        <div className="overflow-x-auto">
          <table className="table table-zebra table-xs">
            <thead>
              <tr>
                <th>Branch</th>
                <th>Path</th>
                <th className="text-right">Tickets</th>
                <th className="text-right">Runs</th>
                <th>Last run</th>
              </tr>
            </thead>
            <tbody>
              {worktrees.map((w) => (
                <tr key={w.path} className={w.is_current ? "font-semibold" : ""}>
                  <td className="text-xs">
                    {w.branch ? (
                      <span className="font-mono">{w.branch}</span>
                    ) : (
                      <span className="opacity-50 italic">detached</span>
                    )}
                    {w.is_current ? (
                      <span className="badge badge-primary badge-xs ml-2">current</span>
                    ) : null}
                  </td>
                  <td className="font-mono text-xs opacity-70 truncate max-w-md" title={w.path}>
                    {w.path}
                  </td>
                  <td className="text-right text-xs">{w.ticket_count}</td>
                  <td className="text-right text-xs">{w.run_count}</td>
                  <td className="text-xs opacity-70">{w.last_run_at ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
