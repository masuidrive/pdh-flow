import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

// Initialize once. `securityLevel: 'strict'` disallows the mermaid source
// from injecting click handlers or HTML — important since we render
// LLM-produced text.
let initDone = false;
function ensureInit() {
  if (initDone) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "strict",
  });
  initDone = true;
}

/** Render a mermaid source block as inline SVG. Used by the Markdown
 *  renderer for `mermaid` fenced code blocks. Falls back to `<pre>` on
 *  parse error so the user still sees the raw text. */
export function MermaidView({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    ensureInit();
    mermaid
      .render(`m-${id}`, source)
      .then(({ svg }) => {
        if (cancelled) return;
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source, id]);

  if (error) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-error">mermaid parse error: {error}</div>
        <pre className="text-xs bg-base-200 p-2 rounded overflow-x-auto">
          {source}
        </pre>
      </div>
    );
  }
  return (
    <div className="mermaid-container overflow-x-auto bg-base-200/60 rounded p-2" ref={containerRef} />
  );
}
