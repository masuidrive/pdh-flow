import type { TransitionEntry } from "../../types/api";

/** Chronological list of state transitions. Renders in a side panel
 *  next to the FlowGraph. Each entry shows time-of-day, the from→to
 *  hop, and the XState event that triggered it. */
export function Timeline({
  transitions,
  currentNode,
}: {
  transitions: TransitionEntry[];
  currentNode: string | null;
}) {
  if (transitions.length === 0) {
    return (
      <div className="card bg-base-100 shadow h-full">
        <div className="card-body p-3">
          <h3 className="text-sm font-semibold">Timeline</h3>
          <p className="text-xs opacity-60">
            No transitions logged yet. Run the engine to populate this list.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="card bg-base-100 shadow h-full overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-base-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Timeline</h3>
        <span className="badge badge-ghost badge-sm">{transitions.length}</span>
      </div>
      <ol className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
        {transitions.map((t, i) => {
          const isCurrent = t.to === currentNode && i === transitions.length - 1;
          return (
            <li
              key={`${t.ts}-${i}`}
              className={`flex flex-col gap-0.5 px-2 py-1 rounded ${
                isCurrent ? "bg-primary/10 border border-primary/40" : "hover:bg-base-200"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono opacity-60 shrink-0">
                  {i + 1}.
                </span>
                <span className="font-mono font-medium truncate">{t.to}</span>
                {isCurrent ? <span className="badge badge-primary badge-xs">now</span> : null}
              </div>
              {t.from ? (
                <div className="pl-5 opacity-60 truncate">
                  ← from <span className="font-mono">{t.from}</span>
                </div>
              ) : (
                <div className="pl-5 opacity-60">← start</div>
              )}
              <div className="pl-5 flex items-center gap-1 opacity-60">
                <span className="font-mono">{formatTime(t.ts)}</span>
                {t.event ? <span className="font-mono truncate">· {t.event}</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}
