import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";

// Shared Markdown renderer. Wraps react-markdown in the `.markdown-content`
// class (see app.css — Tailwind's preflight flattens headings, this class
// restores a modest hierarchy that fits inside compact cards). remark-gfm
// adds tables / strikethrough / task lists. No rehype-raw — raw HTML in the
// source is NOT rendered (XSS-safe by default).
//
// Pass `runId` to enable file-path linking: inline `code` spans whose text
// looks like a file path (with a recognised extension, optionally suffixed
// `:LINE`) render as links to /runs/<runId>/viewer?path=…, so reviewers can
// jump straight from a Decision summary / note section into the Viewer pane.
export function Markdown({
  source,
  className,
  runId,
}: {
  source: string;
  className?: string;
  runId?: string;
}) {
  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={runId ? makeFileLinkingComponents(runId) : undefined}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Recognise extensions we know how to render (or at least to open) in the
// Viewer pane. Keep this loose: a false-positive only means the link 404s
// when clicked; the Viewer shows "not found", no crash.
const FILE_EXT_RE =
  /\.(md|markdown|txt|log|json|jsonc|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|css|scss|less|html?|xml|csv|sql|graphql|gql|j2|jinja2|njk|diff|patch|lock|mod|sum|png|jpe?g|webp|gif|bmp|ico|avif|svg|pdf)$/i;

function looksLikeFilePath(s: string): { path: string; line?: number } | null {
  if (!s) return null;
  // Reject anything with whitespace — file paths don't have it (and we'd
  // rather miss the rare quoted-with-spaces path than link random prose).
  if (/\s/.test(s)) return null;
  // Strip a trailing :LINE[:COL] (file.ts:42 or file.ts:42:7).
  const m = s.match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
  if (!m) return null;
  const path = m[1];
  const line = m[2] ? Number(m[2]) : undefined;
  if (!FILE_EXT_RE.test(path)) return null;
  return { path, line };
}

function makeFileLinkingComponents(runId: string) {
  const viewerHref = (path: string) =>
    `/runs/${encodeURIComponent(runId)}/viewer?path=${encodeURIComponent(path)}`;

  return {
    code(props: { className?: string; children?: unknown }) {
      // Block code (fenced ```ts … ``` etc.) has a language-* className —
      // never link those; only link single-line inline `code` spans.
      const cls = props.className ?? "";
      const text = childrenToString(props.children);
      if (cls.startsWith("language-") || text.includes("\n")) {
        return <code className={cls}>{props.children as React.ReactNode}</code>;
      }
      const hit = looksLikeFilePath(text);
      if (!hit) return <code className={cls}>{props.children as React.ReactNode}</code>;
      return (
        <Link
          to={viewerHref(hit.path)}
          className="link link-hover font-mono"
          title={`Open ${hit.path} in the Viewer pane`}
        >
          {props.children as React.ReactNode}
        </Link>
      );
    },
  };
}

function childrenToString(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.map((c) => (typeof c === "string" ? c : "")).join("");
  return "";
}
