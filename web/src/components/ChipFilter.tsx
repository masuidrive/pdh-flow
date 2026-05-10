// Generic chip filter — "All" + one chip per option. Used by tables that
// need a quick categorical filter (worktree, epic, future: status, role).
//
// Keep dumb on purpose: parent owns the option list (already de-duplicated)
// and the active value. Renders nothing when there's only one option,
// matching the "no filter needed for single-tenant" rule the WorktreeFilter
// originally had inline.
export function ChipFilter({
  options,
  value,
  onChange,
  ariaLabel,
  allTitle,
  formatLabel,
  formatTitle,
  hideWhenSingle = true,
}: {
  options: string[];
  /** Selected value; null = "All". */
  value: string | null;
  onChange: (next: string | null) => void;
  ariaLabel: string;
  allTitle: string;
  /** How to render each chip's label. Default: as-is. */
  formatLabel?: (opt: string) => string;
  /** Hover tooltip per chip. Default: the raw option string. */
  formatTitle?: (opt: string) => string;
  /** Default true — hide the filter entirely when only one option exists. */
  hideWhenSingle?: boolean;
}) {
  if (options.length === 0) return null;
  if (hideWhenSingle && options.length <= 1) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap" role="tablist" aria-label={ariaLabel}>
      <button
        type="button"
        className={`btn btn-xs ${value === null ? "btn-primary" : "btn-ghost"}`}
        onClick={() => onChange(null)}
        title={allTitle}
      >
        All
      </button>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            type="button"
            className={`btn btn-xs ${active ? "btn-primary" : "btn-ghost"} font-mono`}
            onClick={() => onChange(active ? null : opt)}
            title={formatTitle ? formatTitle(opt) : opt}
          >
            {formatLabel ? formatLabel(opt) : opt}
          </button>
        );
      })}
    </div>
  );
}
