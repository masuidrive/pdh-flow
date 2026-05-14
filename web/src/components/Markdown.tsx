import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { MermaidView } from "./MermaidView";

// Shared Markdown renderer. Wraps react-markdown in the `.markdown-content`
// class (see app.css — Tailwind's preflight flattens headings, this class
// restores a modest hierarchy that fits inside compact cards). remark-gfm
// adds tables / strikethrough / task lists. No rehype-raw — raw HTML in the
// source is NOT rendered (XSS-safe by default).
//
// Pass `runId` to enable file-path linking:
//   - inline `code` spans whose text looks like a file path (with a recognised
//     extension, optionally suffixed `:LINE`) render as links to
//     /runs/<runId>/viewer?path=…
//   - relative-path `<a>` links ([title](relative/path)) resolve against
//     `basePath` (the dirname of the file being rendered, or "" for the
//     worktree root) and route to /runs/<runId>/viewer?path=…
// External / absolute / anchor links pass through unchanged.
export function Markdown({
  source,
  className,
  runId,
  basePath,
}: {
  source: string;
  className?: string;
  runId?: string;
  basePath?: string;
}) {
  // Split off a leading YAML frontmatter block (`---\n…\n---`) so it can
  // render as a compact key/value table instead of getting flattened into
  // body text. The body is what ReactMarkdown processes after.
  const { frontmatter, body } = splitFrontmatter(source);

  const components = runId
    ? makeFileLinkingComponents(runId, basePath ?? "")
    : ({} as Record<string, unknown>);
  // Always intercept fenced code blocks so we can render `mermaid`,
  // `svg`, and `html` fences as visuals. `pre` wraps the entire fence
  // (we override here); `code` keeps the inline-file-link behaviour
  // from the linker.
  const preOverride = {
    pre(props: { children?: unknown }) {
      const inner = extractCodeBlock(props.children);
      if (inner) {
        if (inner.lang === "mermaid" || inner.lang === "mmd") {
          return <MermaidView source={inner.code} />;
        }
        if (inner.lang === "svg") {
          return <RawSvg source={inner.code} />;
        }
        if (inner.lang === "html" || inner.lang === "htm") {
          return <HtmlBlock source={inner.code} />;
        }
      }
      return <pre>{props.children as React.ReactNode}</pre>;
    },
  };
  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      {frontmatter ? <FrontmatterTable raw={frontmatter} /> : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ ...components, ...preOverride }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** Strip a leading YAML frontmatter block. The opening `---` must be on
 *  the first line; the closing `---` is the next standalone `---` line.
 *  Returns the captured frontmatter text (minus delimiters) and the
 *  remaining body. When no frontmatter is present, frontmatter is null
 *  and body === source. */
function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: null, body: source };
  return { frontmatter: m[1], body: source.slice(m[0].length) };
}

/** Render a YAML frontmatter block as a compact key/value table. Parses
 *  the simple `key: value` shape; anything fancier (nested mappings,
 *  arrays spanning lines) falls back to a `<pre>` of the raw text so
 *  the user can at least read it. */
function FrontmatterTable({ raw }: { raw: string }) {
  const rows: Array<{ key: string; value: string }> = [];
  let canParse = true;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) { canParse = false; break; }
    rows.push({ key: m[1], value: m[2].trim() });
  }
  if (!canParse || rows.length === 0) {
    return (
      <pre className="text-[11px] bg-base-200/60 p-2 rounded mb-3 overflow-x-auto">{raw}</pre>
    );
  }
  return (
    <div className="frontmatter mb-3 bg-base-200/60 rounded p-2 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="contents">
            <dt className="font-mono opacity-70 truncate">{r.key}</dt>
            <dd className="font-mono break-words">{r.value || <span className="opacity-40">(empty)</span>}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Inline-render an HTML fenced block in a sandboxed iframe so LLM-
 *  generated mockups can show their actual look without escaping the
 *  surrounding UI. Uses `srcdoc` so we don't need a server-side route. */
function HtmlBlock({ source }: { source: string }) {
  return (
    <iframe
      title="html preview"
      sandbox=""
      srcDoc={source}
      className="w-full min-h-[20rem] bg-base-100 rounded border border-base-300"
    />
  );
}

/** Inline-render an SVG string produced by the LLM. Wrapped in a sandboxed
 *  container; react-markdown's default already strips raw HTML, so this only
 *  fires when the SVG arrived inside a fenced ```svg block (which the
 *  renderer overrides explicitly). Falls back to <pre> on empty input. */
function RawSvg({ source }: { source: string }) {
  const trimmed = source.trim();
  if (!trimmed.startsWith("<svg")) {
    return <pre className="text-xs bg-base-200 p-2 rounded">{source}</pre>;
  }
  // dangerouslySetInnerHTML is acceptable here because the SVG source came
  // from the engine's own LLM output via the worktree files — same trust
  // boundary as the rest of the markdown. We do NOT support raw HTML
  // elsewhere (no rehype-raw); this is a narrow escape hatch for the
  // ` ```svg ` fence convention used by the planner's Mockup section.
  return (
    <div
      className="svg-container overflow-x-auto bg-base-200/60 rounded p-2 [&_svg]:max-w-full"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: trimmed }}
    />
  );
}

/** Pull `{lang, code}` out of react-markdown's `pre > code` AST node so we
 *  can re-route fenced blocks of known langs to a visual renderer. Returns
 *  null when the children don't match the canonical shape. */
function extractCodeBlock(
  children: unknown,
): { lang: string; code: string } | null {
  // react-markdown wraps fenced blocks as <pre><code class="language-X">…</code></pre>.
  // The `children` prop is a single element (or array containing one).
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const el = c as {
      type?: unknown;
      props?: { className?: string; children?: unknown };
    };
    if (el.type !== "code" && (el.type as { displayName?: string })?.displayName !== "code") {
      // react-markdown components register as functions; we can't compare to
      // the `code` string. Instead detect by the className shape.
    }
    const className = el.props?.className ?? "";
    const m = /^language-([a-zA-Z0-9_+-]+)$/.exec(className);
    if (!m) continue;
    const code = childrenToString(el.props?.children);
    return { lang: m[1].toLowerCase(), code };
  }
  return null;
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

function makeFileLinkingComponents(runId: string, basePath: string) {
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
    a(props: { href?: string; children?: unknown; title?: string }) {
      const href = props.href ?? "";
      const resolved = resolveWorktreeRelHref(href, basePath);
      if (resolved !== null) {
        return (
          <Link to={viewerHref(resolved)} className="link" title={props.title ?? resolved}>
            {props.children as React.ReactNode}
          </Link>
        );
      }
      // External / anchor / unparseable — render plain <a>, open externals in
      // a new tab to keep the viewer context.
      const external = /^[a-z][a-z0-9+.-]*:\/\//i.test(href);
      return (
        <a
          href={href}
          title={props.title}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          className="link"
        >
          {props.children as React.ReactNode}
        </a>
      );
    },
  };
}

/** Returns the worktree-relative path if `href` is a relative or worktree-
 *  absolute file reference we can route into the Viewer; null for external /
 *  anchor / unparseable inputs. `basePath` is the dirname of the file being
 *  rendered (no leading or trailing slash); empty means worktree root. */
function resolveWorktreeRelHref(href: string, basePath: string): string | null {
  if (!href) return null;
  // Anchor — keep as in-page anchor.
  if (href.startsWith("#")) return null;
  // Scheme (http://, https://, mailto:, file://, ...) — external.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  // Protocol-relative — external.
  if (href.startsWith("//")) return null;
  // Drop any anchor / query suffix from the file portion before resolving.
  const hashIdx = href.indexOf("#");
  const qIdx = href.indexOf("?");
  let cut = href.length;
  if (hashIdx >= 0) cut = Math.min(cut, hashIdx);
  if (qIdx >= 0) cut = Math.min(cut, qIdx);
  const filePart = href.slice(0, cut);
  // Worktree-absolute path (`/foo`) — strip the leading slash.
  if (filePart.startsWith("/")) {
    return filePart.replace(/^\/+/, "");
  }
  // Relative — resolve against basePath using URL semantics.
  try {
    const dir = basePath ? (basePath.endsWith("/") ? basePath : `${basePath}/`) : "";
    const u = new URL(filePart, `https://x/${dir}`);
    const resolved = u.pathname.replace(/^\/+/, "");
    if (!resolved) return null;
    return resolved;
  } catch {
    return null;
  }
}

function childrenToString(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.map((c) => (typeof c === "string" ? c : "")).join("");
  return "";
}
