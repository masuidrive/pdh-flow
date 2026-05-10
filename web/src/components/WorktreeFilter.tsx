// Worktree filter chip row. Thin wrapper over the generic <ChipFilter>
// — it just supplies the basename-as-label transform so the chips read
// e.g. `pdh-flow--test-multi-demo` instead of the full /tmp path.
import { ChipFilter } from "./ChipFilter";

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
  return (
    <ChipFilter
      options={worktrees}
      value={value}
      onChange={onChange}
      ariaLabel="Filter by worktree"
      allTitle="Show rows from every worktree"
      formatLabel={(wt) => wt.split("/").pop() ?? wt}
      formatTitle={(wt) => wt}
      hideWhenSingle={false}
    />
  );
}
