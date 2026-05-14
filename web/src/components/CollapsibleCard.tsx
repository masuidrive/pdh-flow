import { useState, type ReactNode, type MouseEvent } from "react";
import { Link } from "react-router-dom";

/** Card with a header that toggles the body. Used for the Brief / Ticket /
 *  Note panes on both the RunPage and TicketPage so they have a single
 *  consistent shape (chevron + title + optional clickable filename → Viewer).
 *  Open/closed state persists per (title) in localStorage so a reload doesn't
 *  lose the user's pick. */
export function CollapsibleCard({
  title,
  subtitle,
  subtitleHref,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When set, the subtitle renders as a Link to this URL (typically the
   *  Viewer with `?path=…`). Clicking does NOT toggle the card — only the
   *  chevron + title button does. */
  subtitleHref?: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const storageKey = `pdh-collapsible:${title}`;
  const [open, setOpen] = useState<boolean>(() => {
    const v = localStorage.getItem(storageKey);
    return v === null ? defaultOpen : v === "1";
  });
  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem(storageKey, next ? "1" : "0");
  }
  const renderSubtitle = () => {
    if (!subtitle) return null;
    if (subtitleHref) {
      return (
        <Link
          to={subtitleHref}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          className="text-xs opacity-60 hover:opacity-100 hover:underline font-mono"
          title={`Open ${subtitle} in the Viewer`}
        >
          {subtitle}
        </Link>
      );
    }
    return <span className="text-xs opacity-50 font-mono">{subtitle}</span>;
  };
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body p-3">
        <div className="flex items-center gap-2 w-full">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-2 flex-1 text-left hover:opacity-80"
            aria-expanded={open}
          >
            <span className="text-xs opacity-50 w-3">{open ? "▾" : "▸"}</span>
            <h2 className="card-title text-base">{title}</h2>
          </button>
          {renderSubtitle()}
        </div>
        {open ? (
          <div className="text-sm bg-base-200 p-3 rounded mt-2">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}
