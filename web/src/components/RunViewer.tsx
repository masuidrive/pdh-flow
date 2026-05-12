import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRunEvidence, useRunNote } from "../hooks/useRunSummary";
import { fetchText } from "../lib/api";
import { Markdown } from "./Markdown";
import type { EvidenceFile } from "../types/api";

// VSCode-ish 2-pane viewer for a run: left = file/artifact tree
// (current-note.md split into its `## …` sections + the run's
// .pdh-flow/runs/<id>/evidence/round-N/ tree), right = the selected
// item rendered — GFM markdown for notes, inline <img> for images / SVG,
// an <iframe> for PDFs, raw text otherwise.

type Selection =
  | { kind: "note-full"; note: string }
  | { kind: "note-section"; title: string; body: string }
  | { kind: "evidence"; file: EvidenceFile };

interface NoteSection {
  id: string;
  title: string;
  body: string;
}

function parseNoteSections(note: string): NoteSection[] {
  const out: NoteSection[] = [];
  let cur: NoteSection | null = null;
  for (const line of note.split("\n")) {
    const m = /^##\s+(.*\S)\s*$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { id: `s${out.length}`, title: m[1], body: line + "\n" };
    } else if (cur) {
      cur.body += line + "\n";
    } else if (line.trim() !== "") {
      // content before the first `## ` header (frontmatter / preamble)
      cur = { id: "s0", title: "(preamble)", body: line + "\n" };
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function RunViewer({ runId }: { runId: string }) {
  const note = useRunNote(runId);
  const evidence = useRunEvidence(runId);
  const noteText =
    note.data && note.data !== "(note not found)" ? note.data : null;
  const sections = useMemo(
    () => (noteText ? parseNoteSections(noteText) : []),
    [noteText],
  );
  const [sel, setSel] = useState<Selection | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);

  // Default selection: the whole note once it's loaded.
  const effectiveSel: Selection | null =
    sel ?? (noteText ? { kind: "note-full", note: noteText } : null);

  return (
    <div className="flex gap-3 h-[calc(100vh-14rem)] min-h-[28rem]">
      <aside className="w-72 shrink-0 overflow-auto border-r border-base-300 pr-2 text-sm">
        {/* current-note.md */}
        {noteText ? (
          <div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost btn-xs px-1"
                aria-label={notesOpen ? "collapse" : "expand"}
                onClick={() => setNotesOpen((v) => !v)}
              >
                {notesOpen ? "▾" : "▸"}
              </button>
              <button
                type="button"
                className={`text-left flex-1 truncate hover:underline ${
                  effectiveSel?.kind === "note-full" ? "font-semibold" : ""
                }`}
                onClick={() => setSel({ kind: "note-full", note: noteText })}
                title="current-note.md"
              >
                current-note.md
              </button>
            </div>
            {notesOpen ? (
              <ul className="ml-5 border-l border-base-300 pl-2">
                {sections.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`block w-full text-left truncate py-0.5 hover:underline ${
                        effectiveSel?.kind === "note-section" &&
                        effectiveSel.title === s.title
                          ? "font-semibold text-primary"
                          : ""
                      }`}
                      onClick={() =>
                        setSel({ kind: "note-section", title: s.title, body: s.body })
                      }
                      title={s.title}
                    >
                      {s.title}
                    </button>
                  </li>
                ))}
                {sections.length === 0 ? (
                  <li className="opacity-50 py-0.5">(no sections)</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="opacity-50">current-note.md not found</div>
        )}

        {/* evidence/ tree */}
        <div className="mt-3">
          <div className="font-mono opacity-70 px-1">evidence/</div>
          {evidence.data && evidence.data.length > 0 ? (
            <ul className="ml-3 border-l border-base-300 pl-2">
              {evidence.data.map((round) => (
                <li key={round.round}>
                  <div className="font-mono opacity-70">round-{round.round}/</div>
                  <ul className="ml-3 border-l border-base-300 pl-2">
                    {round.files.map((f) => (
                      <li key={f.url}>
                        <button
                          type="button"
                          className={`flex w-full items-center gap-1 text-left py-0.5 hover:underline ${
                            effectiveSel?.kind === "evidence" &&
                            effectiveSel.file.url === f.url
                              ? "font-semibold text-primary"
                              : ""
                          }`}
                          onClick={() => setSel({ kind: "evidence", file: f })}
                          title={f.filename}
                        >
                          <span className="badge badge-ghost badge-xs shrink-0">{f.kind}</span>
                          <span className="truncate font-mono">{f.filename}</span>
                        </button>
                      </li>
                    ))}
                    {round.files.length === 0 ? (
                      <li className="opacity-50 py-0.5">(empty)</li>
                    ) : null}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ml-3 opacity-50 py-0.5">(no evidence yet)</div>
          )}
        </div>
      </aside>

      <div className="flex-1 overflow-auto">
        <ViewerPane sel={effectiveSel} loading={note.isLoading || evidence.isLoading} />
      </div>
    </div>
  );
}

function ViewerPane({ sel, loading }: { sel: Selection | null; loading: boolean }) {
  if (loading && !sel)
    return <div className="loading loading-spinner" aria-label="loading" />;
  if (!sel)
    return <div className="opacity-50 p-4">Select a file or note section on the left.</div>;

  if (sel.kind === "note-full")
    return (
      <div className="bg-base-100 rounded p-4">
        <Markdown source={sel.note} />
      </div>
    );

  if (sel.kind === "note-section")
    return (
      <div className="bg-base-100 rounded p-4">
        <Markdown source={sel.body} />
      </div>
    );

  // evidence file
  const f = sel.file;
  if (f.kind === "image")
    return (
      <div className="p-2">
        <div className="mb-2 font-mono text-xs opacity-70">
          {f.filename} · {(f.size_bytes / 1024).toFixed(1)} KB
        </div>
        {/* <img> renders SVG and raster images alike, and SVG loaded via <img>
            cannot run scripts (XSS-safe). */}
        <img
          src={f.url}
          alt={f.filename}
          className="max-w-full border border-base-300 bg-[repeating-conic-gradient(#0001_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
        />
      </div>
    );

  if (f.kind === "pdf")
    return <iframe title={f.filename} src={f.url} className="w-full h-full min-h-[28rem]" />;

  // text / other → fetch and show. Render .md as GFM markdown, else raw <pre>.
  return <TextEvidence file={f} />;
}

function TextEvidence({ file }: { file: EvidenceFile }) {
  const q = useQuery<string>({
    queryKey: ["evidence-text", file.url],
    queryFn: () => fetchText(file.url),
  });
  const isMd = /\.(md|markdown)$/i.test(file.filename);
  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message)}</span>
      </div>
    );
  const text = q.data ?? "";
  return (
    <div className="bg-base-100 rounded p-4">
      <div className="mb-2 font-mono text-xs opacity-70">{file.filename}</div>
      {isMd ? (
        <Markdown source={text} />
      ) : (
        <pre className="text-xs whitespace-pre-wrap break-words">{text}</pre>
      )}
    </div>
  );
}
