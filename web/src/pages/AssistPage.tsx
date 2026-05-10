import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

// /assist/:sessionId — full-page xterm wired to /api/assist/ws.
// Used by + New epic (terminal) / + New ticket (terminal) buttons →
// server's openCreationSession spawns claude with a skill prompt and
// returns sessionId, the UI navigates here to chat.
const TERM_QUICK_KEYS: { label: string; seq: string; tone?: "primary"; title?: string }[] = [
  { label: "Enter", seq: "\r", tone: "primary" },
  { label: "Esc", seq: "" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "[A" },
  { label: "↓", seq: "[B" },
  { label: "←", seq: "[D" },
  { label: "→", seq: "[C" },
  { label: "y", seq: "y" },
  { label: "n", seq: "n" },
];

export function AssistPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    if (!sessionId) return;
    cancelledRef.current = false;
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: true,
      theme: { background: "#1f1d18", foreground: "#f5e6c8" },
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try { term.loadAddon(new WebLinksAddon()); } catch {}
    term.open(host);
    try { fit.fit(); } catch {}
    termRef.current = term;
    fitRef.current = fit;

    let attempt = 0;
    const connect = () => {
      if (cancelledRef.current) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/assist/ws?session=${encodeURIComponent(sessionId)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        attempt = 0;
        setStatus("running");
        if (term.cols && term.rows) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
        term.focus();
      });
      ws.addEventListener("message", (event) => {
        let payload: { type?: string; [k: string]: unknown };
        try { payload = JSON.parse(event.data); } catch { return; }
        if (!payload) return;
        if (payload.type === "snapshot") {
          if (typeof payload.status === "string") setStatus(payload.status);
          if (typeof payload.data === "string") term.write(payload.data);
        } else if (payload.type === "output" && typeof payload.data === "string") {
          term.write(payload.data);
        } else if (payload.type === "exit") {
          setStatus("exited");
          term.writeln("");
          term.writeln(`[assist session exited code=${payload.exitCode ?? "?"}]`);
        } else if (payload.type === "error") {
          term.writeln("");
          term.writeln(`[assist error] ${payload.message ?? "unknown"}`);
        }
      });
      ws.addEventListener("close", () => {
        if (cancelledRef.current) return;
        if (status !== "exited") setStatus("reconnecting");
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        attempt += 1;
        if (attempt === 1) {
          term.writeln("");
          term.writeln("[connection lost — reconnecting...]");
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (!cancelledRef.current) connect();
        }, delay);
      });
      ws.addEventListener("error", () => { /* close handler will reconnect */ });
    };
    connect();

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      if (wsRef.current?.readyState === WebSocket.OPEN && term.cols && term.rows) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(host);

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try { wsRef.current?.close(); } catch {}
      try { ro.disconnect(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendKey = (seq: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && seq) {
      wsRef.current.send(JSON.stringify({ type: "input", data: seq }));
      termRef.current?.focus();
    }
  };

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      <div className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Link to="/" className="btn btn-ghost btn-sm">← Tickets</Link>
          <h1 className="font-bold truncate font-mono text-sm">{sessionId}</h1>
          <span className={`badge badge-sm ${
            status === "running" ? "badge-info"
              : status === "exited" ? "badge-neutral"
                : status === "failed" ? "badge-error"
                  : status === "reconnecting" ? "badge-warning"
                    : "badge-ghost"
          }`}>{status}</span>
        </div>
      </div>
      <div ref={hostRef} className="flex-1 bg-[#1f1d18]" />
      <div className="flex flex-wrap items-center gap-1 pt-2">
        {TERM_QUICK_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className={`btn btn-xs ${k.tone === "primary" ? "btn-primary" : "btn-outline"}`}
            title={k.title}
            onClick={() => sendKey(k.seq)}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
