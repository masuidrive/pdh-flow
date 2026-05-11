import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Shared Markdown renderer. Wraps react-markdown in the `.markdown-content`
// class (see app.css — Tailwind's preflight flattens headings, this class
// restores a modest hierarchy that fits inside compact cards). remark-gfm
// adds tables / strikethrough / task lists. No rehype-raw — raw HTML in the
// source is NOT rendered (XSS-safe by default).
export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
