// Reusable worktree filter — one chip per known worktree, plus an "All"
// option. Only meaningful when the parent table mixes rows from
// multiple worktrees; the parent decides when to render this.
//
// Display the basename of the worktree path because the full path is
// long and the basename is the disambiguator a human cares about
// (e.g. `pdh-fullrun-clamp-HdI22a` vs `pdh-flow--test-multi-demo`).
export function WorktreeFilter({
  worktrees,
  value,
  onChange,
}: {
  worktrees: string[];
  /** Selected worktree path; null = "All". */
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  if (worktrees.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap" role="tablist" aria-label="Filter by worktree">
      <button
        type="button"
        className={`btn btn-xs ${value === null ? "btn-primary" : "btn-ghost"}`}
        onClick={() => onChange(null)}
        title="Show rows from every worktree"
      >
        All
      </button>
      {worktrees.map((wt) => {
        const name = wt.split("/").pop() ?? wt;
        const active = value === wt;
        return (
          <button
            key={wt}
            type="button"
            className={`btn btn-xs ${active ? "btn-primary" : "btn-ghost"} font-mono`}
            onClick={() => onChange(active ? null : wt)}
            title={wt}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
