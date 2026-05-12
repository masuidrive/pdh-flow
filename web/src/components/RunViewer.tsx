import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRunEvidence, useRunNote } from "../hooks/useRunSummary";
import { fetchText } from "../lib/api";
import { Markdown } from "./Markdown";
import type { EvidenceFile } from "../types/api";

// VSCode-ish 2-pane viewer for a run: left = a plain file tree
// (current-note.md + the run's .pdh-flow/runs/<id>/evidence/round-N/ tree),
// right = the selected file rendered — GFM markdown for .md, inline <img>
// for images / SVG, an <iframe> for PDFs, raw <pre> otherwise.

type FileKind = "markdown" | "image" | "pdf" | "text" | "other";

interface FileLeaf {
  type: "file";
  name: string;
  /** URL to GET: fetched as text for markdown/text, used as src for image/pdf. */
  url: string;
  kind: FileKind;
  sizeBytes?: number;
}
interface DirNode {
  type: "dir";
  name: string;
  children: TreeNode[];
}
type TreeNode = FileLeaf | DirNode;

function fileKind(filename: string, evidenceKind: EvidenceFile["kind"]): FileKind {
  if (/\.(md|markdown)$/i.test(filename)) return "markdown";
  if (evidenceKind === "image") return "image";
  if (evidenceKind === "pdf") return "pdf";
  if (evidenceKind === "text") return "text";
  return "other";
}

function firstFile(nodes: TreeNode[]): FileLeaf | null {
  for (const n of nodes) {
    if (n.type === "file") return n;
    const f = firstFile(n.children);
    if (f) return f;
  }
  return null;
}

export function RunViewer({ runId }: { runId: string }) {
  const note = useRunNote(runId);
  const evidence = useRunEvidence(runId);
  const noteExists = !!note.data && note.data !== "(note not found)";

  const tree = useMemo<TreeNode[]>(() => {
    const out: TreeNode[] = [];
    if (noteExists) {
      out.push({
        type: "file",
        name: "current-note.md",
        url: `/api/runs/${encodeURIComponent(runId)}/note`,
        kind: "markdown",
      });
    }
    const rounds = evidence.data ?? [];
    if (rounds.length > 0) {
      out.push({
        type: "dir",
        name: "evidence",
        children: rounds.map((r) => ({
          type: "dir" as const,
          name: `round-${r.round}`,
          children: r.files.map((f) => ({
            type: "file" as const,
            name: f.filename,
            url: f.url,
            kind: fileKind(f.filename, f.kind),
            sizeBytes: f.size_bytes,
          })),
        })),
      });
    }
    return out;
  }, [runId, noteExists, evidence.data]);

  const [selUrl, setSelUrl] = useState<string | null>(null);
  const selected: FileLeaf | null = useMemo(() => {
    const find = (nodes: TreeNode[]): FileLeaf | null => {
      for (const n of nodes) {
        if (n.type === "file") {
          if (n.url === selUrl) return n;
        } else {
          const f = find(n.children);
          if (f) return f;
        }
      }
      return null;
    };
    return (selUrl ? find(tree) : null) ?? firstFile(tree);
  }, [tree, selUrl]);

  return (
    <div className="flex gap-3 h-[calc(100vh-14rem)] min-h-[28rem]">
      <aside className="w-72 shrink-0 overflow-auto border-r border-base-300 pr-2 text-sm">
        {tree.length === 0 ? (
          <div className="opacity-50 p-2">(no files yet)</div>
        ) : (
          <ul>
            {tree.map((n, i) => (
              <TreeItem
                key={i}
                node={n}
                depth={0}
                selectedUrl={selected?.url ?? null}
                onSelect={setSelUrl}
              />
            ))}
          </ul>
        )}
      </aside>
      <div className="flex-1 overflow-auto">
        <ViewerPane file={selected} loading={note.isLoading || evidence.isLoading} />
      </div>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  selectedUrl,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${depth * 0.85 + 0.25}rem` };
  if (node.type === "dir") {
    return (
      <li>
        <button
          type="button"
          className="flex w-full items-center gap-1 py-0.5 hover:bg-base-200 rounded"
          style={pad}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="opacity-60 w-3 text-center">{open ? "▾" : "▸"}</span>
          <span className="font-mono opacity-80 truncate">{node.name}/</span>
        </button>
        {open ? (
          <ul>
            {node.children.map((c, i) => (
              <TreeItem
                key={i}
                node={c}
                depth={depth + 1}
                selectedUrl={selectedUrl}
                onSelect={onSelect}
              />
            ))}
            {node.children.length === 0 ? (
              <li
                className="opacity-50 py-0.5"
                style={{ paddingLeft: `${(depth + 1) * 0.85 + 1.25}rem` }}
              >
                (empty)
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }
  const active = node.url === selectedUrl;
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center gap-1 py-0.5 rounded text-left ${
          active ? "bg-primary/15 text-primary font-semibold" : "hover:bg-base-200"
        }`}
        style={pad}
        onClick={() => onSelect(node.url)}
        title={node.name}
      >
        <span className="w-3 shrink-0" />
        {node.kind !== "markdown" ? (
          <span className="badge badge-ghost badge-xs shrink-0">{node.kind}</span>
        ) : null}
        <span className="truncate font-mono">{node.name}</span>
      </button>
    </li>
  );
}

function ViewerPane({ file, loading }: { file: FileLeaf | null; loading: boolean }) {
  if (loading && !file)
    return <div className="loading loading-spinner" aria-label="loading" />;
  if (!file)
    return <div className="opacity-50 p-4">Select a file on the left.</div>;

  if (file.kind === "image")
    return (
      <div className="p-2">
        <div className="mb-2 font-mono text-xs opacity-70">
          {file.name}
          {typeof file.sizeBytes === "number"
            ? ` · ${(file.sizeBytes / 1024).toFixed(1)} KB`
            : ""}
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

  // markdown / text → fetch and render
  return <TextFile file={file} />;
}

function TextFile({ file }: { file: FileLeaf }) {
  const q = useQuery<string>({
    queryKey: ["file-text", file.url],
    queryFn: () => fetchText(file.url),
  });
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
      <div className="mb-2 font-mono text-xs opacity-70">{file.name}</div>
      {file.kind === "markdown" ? (
        <Markdown source={text} />
      ) : (
        <pre className="text-xs whitespace-pre-wrap break-words">{text}</pre>
      )}
    </div>
  );
}
