import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { postEmpty, postJson } from "../lib/api";

// ─── Imperative open API via context ──────────────────────────────────────

interface OpenArgs {
  runId: string;
  nodeId: string;
  mode?: "fresh" | "resume";
}

interface TerminalCtx {
  open(args: OpenArgs): void;
}

const Ctx = createContext<TerminalCtx | null>(null);

export function useTerminal() {
  const c = useContext(Ctx);
  if (!c) throw new Error("TerminalProvider missing");
  return c;
}

interface ActiveSession extends OpenArgs {
  sessionId: string;
}

const TERM_QUICK_KEYS: { label: string; seq: string; tone?: "primary"; title?: string }[] = [
  { label: "Enter", seq: "\r", tone: "primary" },
  { label: "Esc", seq: "" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "[A" },
  { label: "↓", seq: "[B" },
  { label: "←", seq: "[D" },
  { label: "→", seq: "[C" },
  { label: "y", seq: "y" },
  { label: "n", seq: "n" },
  { label: "^C", seq: "", title: "send SIGINT" },
  { label: "^D", seq: "", title: "EOF" },
];

interface SubmittedBanner {
  kind: "turn" | "gate";
  turn?: number;
  message: string;
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const open = useCallback(async (args: OpenArgs) => {
    setOpenError(null);
    try {
      const r = await postJson<{ sessionId: string; title?: string }>("/api/assist/open", {
        run_id: args.runId,
        node_id: args.nodeId,
        mode: args.mode ?? "resume",
      });
      setActive({ ...args, sessionId: r.sessionId });
    } catch (e) {
      setOpenError(String((e as Error).message ?? e));
    }
  }, []);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {active ? <TerminalDialog session={active} onClose={() => setActive(null)} /> : null}
      {openError ? (
        <div className="toast">
          <div className="alert alert-error">
            <span className="text-xs font-mono">{openError}</span>
            <button className="btn btn-ghost btn-xs" onClick={() => setOpenError(null)}>
              ×
            </button>
          </div>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────

function TerminalDialog({ session, onClose }: { session: ActiveSession; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState("connecting");
  const [banner, setBanner] = useState<SubmittedBanner | null>(null);

  // Mount xterm + WS lifecycle.
  useEffect(() => {
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
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* ignore */
    }
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    termRef.current = term;
    fitRef.current = fit;

    let attempt = 0;
    const connect = () => {
      if (cancelledRef.current) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/assist/ws?session=${encodeURIComponent(
        session.sessionId,
      )}`;
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
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!payload) return;
        if (payload.type === "snapshot") {
          if (typeof payload.status === "string") setStatus(payload.status);
          if (typeof payload.data === "string") term.write(payload.data);
        } else if (payload.type === "output" && typeof payload.data === "string") {
          term.write(payload.data);
        } else if (payload.type === "submitted") {
          const kind = (payload.kind as "turn" | "gate") ?? "turn";
          setBanner({
            kind,
            turn: typeof payload.turn === "number" ? payload.turn : undefined,
            message: kind === "gate" ? "Gate decision drafted. Confirm and close?" : "Answer drafted. Confirm and close?",
          });
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
      ws.addEventListener("error", () => {
        /* close handler will run reconnect */
      });
    };
    connect();

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      if (wsRef.current?.readyState === WebSocket.OPEN && term.cols && term.rows) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(host);

    return () => {
      cancelledRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      try {
        ro.disconnect();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [session.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendKey = (seq: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && seq) {
      wsRef.current.send(JSON.stringify({ type: "input", data: seq }));
      termRef.current?.focus();
    }
  };

  const confirmAndClose = async () => {
    if (!banner) return;
    try {
      const url =
        banner.kind === "gate"
          ? `/api/runs/${encodeURIComponent(session.runId)}/gates/${encodeURIComponent(session.nodeId)}/confirm`
          : `/api/runs/${encodeURIComponent(session.runId)}/turns/${encodeURIComponent(session.nodeId)}/${encodeURIComponent(String(banner.turn ?? 0))}/confirm`;
      await postEmpty(url);
      onClose();
    } catch (e) {
      setBanner({ ...banner, message: `confirm failed: ${(e as Error).message}` });
    }
  };

  return (
    <dialog className="modal modal-open">
      <div className="modal-box max-w-5xl w-11/12 p-3 sm:p-4 flex flex-col" style={{ height: "min(90vh,720px)" }}>
        <div className="flex items-center justify-between gap-3 pb-2">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-bold truncate">
              {session.nodeId} · {session.runId}
            </h3>
            <span
              className={`badge badge-sm ${
                status === "running"
                  ? "badge-info"
                  : status === "exited"
                    ? "badge-neutral"
                    : status === "failed"
                      ? "badge-error"
                      : status === "reconnecting"
                        ? "badge-warning"
                        : "badge-ghost"
              }`}
            >
              {status}
            </span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {banner ? (
          <div className="alert alert-success py-2 mb-2">
            <span className="flex-1 text-sm">{banner.message}</span>
            <button className="btn btn-sm btn-success" onClick={confirmAndClose}>
              Yes, close
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setBanner(null)}>
              No, stay
            </button>
          </div>
        ) : null}
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
      <button className="modal-backdrop" onClick={onClose}>
        close
      </button>
    </dialog>
  );
}
