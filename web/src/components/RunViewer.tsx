import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  useRunEvidence,
  useRunNote,
  useWorktreeDir,
} from "../hooks/useRunSummary";
import { fetchText } from "../lib/api";
import { Markdown } from "./Markdown";
import type { EvidenceFile } from "../types/api";

// VSCode-ish 2-pane viewer for a run: left = a file tree, right = the
// selected file rendered. The tree has three roots:
//   - current-note.md
//   - evidence/  (static, from /api/runs/:id/evidence)
//   - repo/      (the run's worktree — lazily browsed via /tree, files
//     streamed via /blob; this is where engine-generated source lives)
// Right pane: GFM markdown for .md, inline <img> for images / SVG, an
// <iframe> for PDFs, raw <pre> otherwise, a download link for binaries.

type FileKind = "markdown" | "image" | "pdf" | "text" | "other";

interface SelFile {
  name: string;
  url: string;
  kind: FileKind;
  sizeBytes?: number;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|ico|avif|svg)$/i;
const MD_EXT = /\.(md|markdown)$/i;
const TEXT_EXT =
  /\.(txt|log|json|jsonc|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|css|scss|less|html?|xml|csv|sql|graphql|gql|j2|jinja2|njk|diff|patch|lock|mod|sum)$/i;
const TEXT_BASENAME =
  /^(\.gitignore|\.npmignore|\.editorconfig|\.dockerignore|\.prettierrc|\.eslintrc|dockerfile|makefile|license|readme|changelog)$/i;

function kindFromName(name: string, evidenceKind?: EvidenceFile["kind"]): FileKind {
  if (MD_EXT.test(name)) return "markdown";
  if (IMAGE_EXT.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (evidenceKind === "image") return "image";
  if (evidenceKind === "pdf") return "pdf";
  if (TEXT_EXT.test(name) || TEXT_BASENAME.test(name) || evidenceKind === "text") return "text";
  return "other";
}

export function RunViewer({ runId }: { runId: string }) {
  const note = useRunNote(runId);
  const evidence = useRunEvidence(runId);
  const noteExists = !!note.data && note.data !== "(note not found)";

  const [sel, setSel] = useState<SelFile | null>(null);
  const noteSel: SelFile = {
    name: "current-note.md",
    url: `/api/runs/${encodeURIComponent(runId)}/note`,
    kind: "markdown",
  };

  // ?path=<worktree-relative-path> — used by Markdown's file-link feature
  // (e.g. clicking a file path in a Decision summary navigates here). When
  // present, drive the selection from it. Pure user clicks on the tree also
  // update `sel`; they take precedence until the URL changes again.
  // ?line=<N> piggybacks on the path: when present TextFile scrolls to that
  // line and highlights it.
  const [searchParams] = useSearchParams();
  const urlPath = searchParams.get("path");
  const urlLineRaw = searchParams.get("line");
  const urlLine = urlLineRaw ? Number(urlLineRaw) : null;
  const targetLine = Number.isFinite(urlLine) && urlLine && urlLine > 0 ? urlLine : null;
  useEffect(() => {
    if (!urlPath) return;
    const name = urlPath.split("/").pop() || urlPath;
    setSel({
      name,
      url: `/api/runs/${encodeURIComponent(runId)}/blob?path=${encodeURIComponent(urlPath)}`,
      kind: kindFromName(name),
    });
  }, [urlPath, runId]);

  const effectiveSel = sel ?? (noteExists ? noteSel : null);

  // Resizable split: left tree pane width in px, persisted.
  const LW_MIN = 160;
  const LW_MAX = 720;
  const [leftW, setLeftW] = useState(() => {
    const v = Number(localStorage.getItem("pdh-viewer-leftW"));
    return Number.isFinite(v) && v >= LW_MIN && v <= LW_MAX ? v : 288;
  });
  useEffect(() => {
    localStorage.setItem("pdh-viewer-leftW", String(leftW));
  }, [leftW]);
  // Pointer events unify mouse / touch / pen; setPointerCapture keeps the
  // drag alive even if the finger/cursor leaves the thin handle.
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  function endDrag() {
    drag.current = null;
    document.body.style.userSelect = "";
  }

  return (
    <div className="flex h-[calc(100vh-14rem)] min-h-[28rem]">
      <aside
        className="shrink-0 overflow-auto pr-2 text-sm"
        style={{ width: leftW }}
      >
        <ul>
          {/* current-note.md */}
          {noteExists ? (
            <FileRow
              name="current-note.md"
              depth={0}
              kind="markdown"
              active={effectiveSel?.url === noteSel.url}
              onSelect={() => setSel(noteSel)}
            />
          ) : null}

          {/* evidence/ — static tree */}
          {evidence.data && evidence.data.length > 0 ? (
            <CollapsibleDir name="evidence" depth={0}>
              {evidence.data.map((round) => (
                <CollapsibleDir key={round.round} name={`round-${round.round}`} depth={1}>
                  {round.files.length === 0 ? (
                    <li className="opacity-50 py-0.5" style={pad(3)}>(empty)</li>
                  ) : (
                    round.files.map((f) => {
                      const k = kindFromName(f.filename, f.kind);
                      return (
                        <FileRow
                          key={f.url}
                          name={f.filename}
                          depth={2}
                          kind={k}
                          active={effectiveSel?.url === f.url}
                          onSelect={() =>
                            setSel({ name: f.filename, url: f.url, kind: k, sizeBytes: f.size_bytes })
                          }
                        />
                      );
                    })
                  )}
                </CollapsibleDir>
              ))}
            </CollapsibleDir>
          ) : null}

          {/* repo/ — the run's worktree, browsed lazily. `targetRepoPath`
              auto-expands the chain of dirs leading to the URL-selected file
              so it's visible in the tree, not just rendered on the right. */}
          <WorktreeDirRow
            runId={runId}
            name="repo"
            relPath=""
            depth={0}
            selectedUrl={effectiveSel?.url ?? null}
            onSelectFile={setSel}
            targetPath={
              urlPath && urlPath !== "current-note.md" && !urlPath.startsWith("evidence/")
                ? urlPath
                : undefined
            }
          />
        </ul>
      </aside>
      {/* Splitter — wide enough to grab on touch; touch-none stops the
          page from scrolling while you drag it. */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize (double-tap to reset)"
        className="w-3 mx-0.5 shrink-0 cursor-col-resize touch-none rounded bg-base-300 hover:bg-primary/60 active:bg-primary"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { startX: e.clientX, startW: leftW };
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const next = drag.current.startW + (e.clientX - drag.current.startX);
          setLeftW(Math.max(LW_MIN, Math.min(LW_MAX, next)));
        }}
        onPointerUp={() => endDrag()}
        onPointerCancel={() => endDrag()}
        onDoubleClick={() => setLeftW(288)}
      />
      <div className="flex-1 overflow-auto pl-1">
        <ViewerPane
          runId={runId}
          file={effectiveSel}
          loading={note.isLoading || evidence.isLoading}
          targetLine={targetLine}
        />
      </div>
    </div>
  );
}

function pad(depth: number): CSSProperties {
  return { paddingLeft: `${depth * 0.85 + 0.25}rem` };
}

/** Worktree-relative directory of a file given its viewer-side URL, so the
 *  Markdown renderer can resolve relative `[a](path)` links against the right
 *  base. Handles the three URL shapes the viewer hands to <Markdown>:
 *    /api/runs/<id>/blob?path=<urlencoded-worktree-path>
 *    /api/runs/<id>/note                                 → worktree root
 *    /api/runs/<id>/evidence/round-N/<file>              → that round's dir  */
function deriveBasePath(url: string): string {
  try {
    const u = new URL(url, "https://_");
    if (u.pathname.endsWith("/blob")) {
      const p = u.searchParams.get("path") ?? "";
      const idx = p.lastIndexOf("/");
      return idx >= 0 ? p.slice(0, idx) : "";
    }
    const m = u.pathname.match(/^\/api\/runs\/[^/]+\/(.+)$/);
    if (!m) return "";
    const rest = decodeURIComponent(m[1]);
    if (rest === "note") return "";
    const idx = rest.lastIndexOf("/");
    return idx >= 0 ? rest.slice(0, idx) : "";
  } catch {
    return "";
  }
}

function FileRow({
  name,
  depth,
  kind,
  active,
  onSelect,
}: {
  name: string;
  depth: number;
  kind: FileKind;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center gap-1 py-0.5 rounded text-left ${
          active ? "bg-primary/15 text-primary font-semibold" : "hover:bg-base-200"
        }`}
        style={pad(depth)}
        onClick={onSelect}
        title={name}
      >
        <span className="w-3 shrink-0" />
        {kind !== "markdown" && kind !== "text" ? (
          <span className="badge badge-ghost badge-xs shrink-0">{kind}</span>
        ) : null}
        <span className="truncate font-mono">{name}</span>
      </button>
    </li>
  );
}

function CollapsibleDir({
  name,
  depth,
  children,
}: {
  name: string;
  depth: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-1 py-0.5 hover:bg-base-200 rounded"
        style={pad(depth)}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="opacity-60 w-3 text-center">{open ? "▾" : "▸"}</span>
        <span className="font-mono opacity-80 truncate">{name}/</span>
      </button>
      {open ? <ul>{children}</ul> : null}
    </li>
  );
}

function WorktreeDirRow({
  runId,
  name,
  relPath,
  depth,
  selectedUrl,
  onSelectFile,
  targetPath,
}: {
  runId: string;
  name: string;
  relPath: string;
  depth: number;
  selectedUrl: string | null;
  onSelectFile: (f: SelFile) => void;
  /** Worktree-relative path of the file we should reveal. When set and the
   *  target lives under this dir, the row opens automatically (recursively,
   *  via each level pre-setting `open=true`). */
  targetPath?: string;
}) {
  // True when the URL-targeted file lives under (or is) this dir.
  const onTargetPath =
    !!targetPath &&
    (relPath === "" || targetPath === relPath || targetPath.startsWith(`${relPath}/`));
  // root ("repo/") starts collapsed so we don't fetch on every page open;
  // subdirs start collapsed too (lazy). Override to open when on the target
  // path so the lazy fetch fires and the next level can do the same.
  const [open, setOpen] = useState(onTargetPath);
  useEffect(() => {
    if (onTargetPath) setOpen(true);
  }, [onTargetPath]);
  const dir = useWorktreeDir(runId, relPath, open);
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-1 py-0.5 hover:bg-base-200 rounded"
        style={pad(depth)}
        onClick={() => setOpen((v) => !v)}
        title={relPath || "(worktree root)"}
      >
        <span className="opacity-60 w-3 text-center">{open ? "▾" : "▸"}</span>
        <span className="font-mono opacity-80 truncate">{name}/</span>
      </button>
      {open ? (
        <ul>
          {dir.isLoading ? (
            <li className="opacity-50 py-0.5" style={pad(depth + 1)}>loading…</li>
          ) : dir.error ? (
            <li className="text-error py-0.5 font-mono text-xs" style={pad(depth + 1)}>
              {String((dir.error as Error).message)}
            </li>
          ) : dir.data && dir.data.entries.length > 0 ? (
            dir.data.entries.map((e) => {
              const childPath = relPath ? `${relPath}/${e.name}` : e.name;
              if (e.type === "dir") {
                return (
                  <WorktreeDirRow
                    key={e.name}
                    runId={runId}
                    name={e.name}
                    relPath={childPath}
                    depth={depth + 1}
                    selectedUrl={selectedUrl}
                    onSelectFile={onSelectFile}
                    targetPath={targetPath}
                  />
                );
              }
              const k = kindFromName(e.name);
              const url = `/api/runs/${encodeURIComponent(runId)}/blob?path=${encodeURIComponent(childPath)}`;
              return (
                <FileRow
                  key={e.name}
                  name={e.name}
                  depth={depth + 1}
                  kind={k}
                  active={selectedUrl === url}
                  onSelect={() => onSelectFile({ name: e.name, url, kind: k, sizeBytes: e.size_bytes })}
                />
              );
            })
          ) : (
            <li className="opacity-50 py-0.5" style={pad(depth + 1)}>(empty)</li>
          )}
        </ul>
      ) : null}
    </li>
  );
}

function ViewerPane({
  runId,
  file,
  loading,
  targetLine,
}: {
  runId: string;
  file: SelFile | null;
  loading: boolean;
  /** When set, TextFile renders the file with line numbers and scrolls
   *  this 1-based line into view with a highlighted background. Ignored
   *  for markdown / image / pdf renders. */
  targetLine: number | null;
}) {
  if (loading && !file)
    return <div className="loading loading-spinner" aria-label="loading" />;
  if (!file)
    return <div className="opacity-50 p-4">Select a file on the left.</div>;

  if (file.kind === "image")
    return (
      <div className="p-2">
        <div className="mb-2 font-mono text-xs opacity-70">
          {file.name}
          {typeof file.sizeBytes === "number" ? ` · ${(file.sizeBytes / 1024).toFixed(1)} KB` : ""}
        </div>
        {/* <img> renders SVG and raster images alike; SVG loaded via <img>
            cannot run scripts (XSS-safe). */}
        <img
          src={file.url}
          alt={file.name}
          className="max-w-full border border-base-300 bg-[repeating-conic-gradient(#0001_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
        />
      </div>
    );

  if (file.kind === "pdf")
    return <iframe title={file.name} src={file.url} className="w-full h-full min-h-[28rem]" />;

  if (file.kind === "other")
    return (
      <div className="p-4">
        <div className="mb-2 font-mono text-xs opacity-70">{file.name}</div>
        <a href={file.url} download className="link link-primary">
          Download {file.name}
        </a>
      </div>
    );

  return <TextFile runId={runId} file={file} targetLine={targetLine} />;
}

function TextFile({
  runId,
  file,
  targetLine,
}: {
  runId: string;
  file: SelFile;
  targetLine: number | null;
}) {
  const q = useQuery<string>({
    queryKey: ["file-text", file.url],
    queryFn: () => fetchText(file.url),
  });
  // Markdown files get a Rendered / Source toggle. Default to source when
  // the link arrived with a `&line=N` target (the user wants to see THAT
  // specific line, line numbers belong here); otherwise rendered. The
  // current selection persists while the user navigates inside the same
  // file but resets when the file URL changes.
  const isMarkdown = file.kind === "markdown";
  const [view, setView] = useState<"rendered" | "source">(
    isMarkdown && targetLine ? "source" : "rendered",
  );
  useEffect(() => {
    setView(isMarkdown && targetLine ? "source" : isMarkdown ? "rendered" : "source");
  }, [file.url, isMarkdown, targetLine]);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message)}</span>
      </div>
    );
  const text = q.data ?? "";
  const showRendered = isMarkdown && view === "rendered";
  return (
    <div className="bg-base-100 rounded p-4">
      <div className="mb-2 flex items-center gap-2 font-mono text-xs">
        <span className="opacity-70">{file.name}</span>
        {targetLine ? (
          <span className="opacity-70">· line {targetLine}</span>
        ) : null}
        {isMarkdown ? (
          <div className="ml-auto join">
            <button
              type="button"
              className={`btn btn-xs join-item ${
                view === "rendered" ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setView("rendered")}
              title="Rendered markdown"
            >
              rendered
            </button>
            <button
              type="button"
              className={`btn btn-xs join-item ${
                view === "source" ? "btn-primary" : "btn-ghost"
              }`}
              onClick={() => setView("source")}
              title="Raw source with line numbers"
            >
              source
            </button>
          </div>
        ) : null}
      </div>
      {showRendered ? (
        <Markdown source={text} runId={runId} basePath={deriveBasePath(file.url)} />
      ) : (
        <TextWithLineNumbers text={text} highlightLine={targetLine} />
      )}
    </div>
  );
}

/** Render plain text as a numbered listing: each line gets its own row
 *  with a right-aligned line-number gutter and the source content on
 *  the right. `highlightLine` (1-based) paints that row with a warning-
 *  tinted background and scrolls it into view on first render. The
 *  gutter width auto-fits the total line count so even 1000-line files
 *  stay aligned. */
function TextWithLineNumbers({
  text,
  highlightLine,
}: {
  text: string;
  highlightLine: number | null;
}) {
  const lines = text.split(/\r?\n/);
  // Trailing newline produces a trailing empty element; drop it so the
  // last visible row matches the actual last line of content.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const highlightRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!highlightLine) return;
    const node = highlightRef.current;
    if (!node) return;
    // Defer to next frame so the layout pass has placed the row.
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center", behavior: "auto" });
    });
  }, [highlightLine, text]);
  const gutterCh = String(Math.max(1, lines.length)).length;
  return (
    <div className="font-mono text-xs leading-5">
      {lines.map((ln, i) => {
        const n = i + 1;
        const active = n === highlightLine;
        return (
          <div
            key={i}
            id={`L${n}`}
            ref={active ? highlightRef : undefined}
            className={`flex ${
              active
                ? "bg-warning/30 ring-1 ring-warning/40 rounded"
                : ""
            }`}
          >
            <a
              href={`#L${n}`}
              className="shrink-0 select-none pr-3 text-right opacity-50 hover:opacity-100"
              style={{ width: `calc(${gutterCh}ch + 0.5rem)` }}
              title={`Line ${n}`}
            >
              {n}
            </a>
            <span className="whitespace-pre-wrap break-words">
              {ln === "" ? " " : ln}
            </span>
          </div>
        );
      })}
    </div>
  );
}
