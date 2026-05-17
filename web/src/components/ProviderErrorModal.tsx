// Pops up when a recent provider / guardian / system step finishes with
// outcome="error". Surfaces the error message + a hint about likely
// causes (auth, API rate limit, schema mismatch) and offers a quick
// path to recovery: dismiss, open terminal in the worktree, or copy
// the error.
//
// Dedup: each error event is keyed by its `ts` (ISO). Once dismissed,
// the same event won't pop again — but a NEW error (different ts)
// will. We persist the dismiss set in component state, so a page
// reload re-shows whichever errors are still "latest".

import { useEffect, useMemo, useState } from "react";
import type { RunEvent } from "../types/api";
import { useRunEvents } from "../hooks/useRunSummary";
import { openRunTerminal } from "../lib/createSession";
import { scrollToTop } from "../lib/scroll";

interface ErrorBeacon {
  ts: string;
  nodeId: string;
  round: number;
  provider?: string;
  role?: string;
  message: string;
}

const RECENT_WINDOW_MS = 10 * 60 * 1000;

function latestError(events: RunEvent[]): ErrorBeacon | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.outcome !== "error") continue;
    return {
      ts: e.ts,
      nodeId: e.node_id,
      round: e.round,
      provider: e.provider,
      role: e.role,
      message: e.error ?? "(no error message)",
    };
  }
  return null;
}

function classifyError(msg: string): { hint: string; tone: "auth" | "api" | "schema" | "other" } {
  const m = msg.toLowerCase();
  if (
    m.includes("login") ||
    m.includes("authenticat") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("403")
  ) {
    return {
      tone: "auth",
      hint:
        "Looks like an auth issue. Run `codex login` (or `claude /login`) in a terminal in the worktree, then click Restart.",
    };
  }
  if (
    m.includes("rate limit") ||
    m.includes("429") ||
    m.includes("quota") ||
    m.includes("usage limit")
  ) {
    return {
      tone: "api",
      hint:
        "API rate limit or quota hit. Wait a few minutes, then click Restart.",
    };
  }
  if (
    m.includes("schema") ||
    m.includes("validation") ||
    m.includes("invalid_request") ||
    m.includes("ajv")
  ) {
    return {
      tone: "schema",
      hint:
        "Provider output didn't match the expected schema. Check the engine log; this is usually a model regression.",
    };
  }
  if (m.includes("reading additional input from stdin")) {
    return {
      tone: "other",
      hint:
        "codex exited early after only printing its stdin banner. Often an auth/login issue or a bad CLI flag. Try `codex exec --json \"hello\"` in a terminal to confirm codex is healthy.",
    };
  }
  return {
    tone: "other",
    hint: "Open a terminal in the worktree to investigate, then click Restart on the idle card.",
  };
}

export function ProviderErrorModal({ runId }: { runId: string }) {
  const events = useRunEvents(runId).data ?? [];
  const beacon = useMemo(() => latestError(events), [events]);
  const [dismissedTs, setDismissedTs] = useState<Set<string>>(new Set());
  const [openingTerm, setOpeningTerm] = useState(false);
  const [termErr, setTermErr] = useState<string | null>(null);

  // Only show if the latest error is recent (within window) AND not yet
  // dismissed. Old historical errors from a previous engine run stay
  // hidden so reloading a run page doesn't pop a modal for ancient
  // failures.
  const show = useMemo(() => {
    if (!beacon) return false;
    if (dismissedTs.has(beacon.ts)) return false;
    const age = Date.now() - Date.parse(beacon.ts);
    if (!Number.isFinite(age)) return false;
    return age < RECENT_WINDOW_MS;
  }, [beacon, dismissedTs]);

  // Reset terminal-open error when a new beacon arrives.
  useEffect(() => {
    setTermErr(null);
    setOpeningTerm(false);
  }, [beacon?.ts]);

  if (!show || !beacon) return null;

  const cls = classifyError(beacon.message);

  async function onOpenTerminal() {
    setOpeningTerm(true);
    setTermErr(null);
    try {
      const { sessionId } = await openRunTerminal(runId);
      window.open(`/assist/${encodeURIComponent(sessionId)}`, "_blank");
    } catch (e) {
      setTermErr(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningTerm(false);
    }
  }

  function onCopy() {
    void navigator.clipboard?.writeText(beacon!.message);
  }

  function onDismiss() {
    setDismissedTs((s) => {
      const next = new Set(s);
      next.add(beacon!.ts);
      return next;
    });
    scrollToTop();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="card bg-base-100 border border-error/70 shadow-xl max-w-2xl w-full">
        <div className="card-body p-5 gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="card-title text-base text-error">Provider failed</h2>
            <span className="badge badge-error badge-sm font-mono">
              {beacon.provider ?? "?"}
            </span>
            <span className="badge badge-outline badge-sm font-mono">
              {beacon.role ?? beacon.nodeId}
            </span>
            <span className="badge badge-ghost badge-sm font-mono">
              round {beacon.round}
            </span>
            <span className="ml-auto text-xs opacity-60 font-mono">
              {new Date(beacon.ts).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-xs opacity-80">
            on <code>{beacon.nodeId}</code>
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words bg-base-200 rounded p-3 max-h-48 overflow-auto">
            {beacon.message}
          </pre>
          <div className="alert alert-warning text-xs py-2">
            <span>{cls.hint}</span>
          </div>
          {termErr ? (
            <div className="alert alert-error text-xs py-2 whitespace-pre-wrap break-words">
              {termErr}
            </div>
          ) : null}
          <div className="card-actions justify-end">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onCopy}
              title="Copy the error message to clipboard"
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onOpenTerminal}
              disabled={openingTerm}
            >
              {openingTerm ? (
                <span className="loading loading-spinner loading-xs" />
              ) : null}
              Open terminal
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
