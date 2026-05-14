import { Link } from "react-router-dom";
import { Markdown } from "./Markdown";

/** Renders `current-note.md` for a run as proper markdown (frontmatter
 *  parsed into a table; fences for mermaid / svg / html rendered as
 *  visuals; file-path code spans + relative links route to the
 *  Viewer pane). The "current-note.md" caption is a Link to the
 *  Viewer so the user can open the canonical file (with the directory
 *  tree on the left) in one click. */
export function NoteView({ note, runId }: { note: string; runId?: string }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg flex items-baseline gap-2">
          <span>note</span>
          {runId ? (
            <Link
              to={`/runs/${encodeURIComponent(runId)}/viewer?path=current-note.md`}
              className="link link-hover text-xs font-mono opacity-60"
              title="Open in Viewer"
            >
              current-note.md
            </Link>
          ) : (
            <span className="text-xs font-mono opacity-60">current-note.md</span>
          )}
        </h2>
        <div className="text-sm bg-base-200 p-3 rounded">
          <Markdown source={note} runId={runId} />
        </div>
      </div>
    </div>
  );
}
