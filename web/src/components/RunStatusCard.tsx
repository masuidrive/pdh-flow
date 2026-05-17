// Unified engine-status card. Always present on the run page, this
// card is the single answer to "what's the engine doing right now and
// what should I do about it" (product brief Goal 5: "The Web UI
// explains what the user should look at and which CLI command to run
// next").
//
// It absorbs:
//   - FailureCard (state=__failed__)
//   - IdleRecoveryCard (process dead, state non-terminal)
// and adds the missing cases:
//   - state=human_intervention (close-step failed)
//   - state=__stopped__ (engine stopped without reaching terminal)
//   - state=alive-but-stuck (heartbeat fresh, but same node > N sec)
//   - state=unknown (no liveness signal at all)
//
// For "running" / "waiting-gate" / "waiting-turn" / "processing-answer"
// the card collapses to a thin status strip — the user's primary
// attention belongs to the GateCard / TurnCard surface below.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useEngineStatus,
  type EngineStatusResponse,
} from "../hooks/useRunSummary";
import { openRunTerminal, restartRun } from "../lib/createSession";
import { scrollToTop } from "../lib/scroll";

export function RunStatusCard({ runId }: { runId: string }) {
  const q = useEngineStatus(runId);
  // Render nothing while loading — the card is a "problem surface" and
  // most runs are healthy, so a transient loading skeleton would just
  // be visual noise on first paint.
  if (q.isLoading || !q.data) return null;
  return <Card status={q.data} runId={runId} />;
}

function Card({ status, runId }: { status: EngineStatusResponse; runId: string }) {
  // Auto-hide when the engine is in a healthy / expected state. The
  // PolyFlow panel above already shows the current state; the GateCard /
  // TurnCard surface incoming user-input prompts; and "finished" runs
  // already carry their own closed-state header. So this card only
  // renders when there's a problem the user must act on (stuck /
  // crashed / needs-human / stopped / failed / unknown) — when that
  // condition clears, the card disappears.
  const benign =
    status.kind === "running" ||
    status.kind === "waiting-gate" ||
    status.kind === "waiting-turn" ||
    status.kind === "processing-answer" ||
    status.kind === "finished";
  if (benign) return null;
  return <FullStatusCard status={status} runId={runId} />;
}

function FullStatusCard({
  status,
  runId,
}: {
  status: EngineStatusResponse;
  runId: string;
}) {
  const tone = TONE[status.kind] ?? "neutral";
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);

  async function fire(actionKind: string) {
    setBusy(actionKind);
    setError(null);
    setCompleted(null);
    try {
      if (actionKind === "restart") {
        scrollToTop();
        await restartRun(runId);
        setCompleted("Engine re-spawned from snapshot.");
      } else if (actionKind === "restart-fresh") {
        if (
          !confirm(
            "Move snapshot.json aside and walk forward from the variant's initial node? Frozen judgements skip already-completed nodes. Use this when normal Restart doesn't make progress.",
          )
        ) {
          setBusy(null);
          return;
        }
        scrollToTop();
        await restartRun(runId, { fresh: true });
        setCompleted("Engine re-spawned fresh — walking forward from initial.");
      } else if (actionKind === "open-terminal") {
        const { sessionId } = await openRunTerminal(runId);
        navigate(`/assist/${encodeURIComponent(sessionId)}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`card border-2 shadow ${BORDER[tone]} ${BG[tone]}`}>
      <div className="card-body p-4 gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className={`card-title text-sm ${TEXT[tone]}`}>
            {KIND_HEADING[status.kind]}
          </h2>
          <span className={`badge ${BADGE[tone]} badge-sm`}>
            {KIND_LABEL[status.kind]}
          </span>
          {status.state ? (
            <span className="badge badge-ghost badge-sm font-mono">
              {status.state}
            </span>
          ) : null}
          {status.pid !== null ? (
            <span className="text-[10px] opacity-60 font-mono">
              pid {status.pid} {status.alive ? "(alive)" : "(dead)"}
            </span>
          ) : null}
        </div>
        <p className="text-sm">{status.message}</p>
        {status.last_error ? (
          <pre className="text-xs whitespace-pre-wrap break-words bg-base-200 rounded p-3 max-h-40 overflow-auto">
            {status.last_error}
          </pre>
        ) : null}
        {completed ? (
          <div className="alert alert-success text-xs py-2">{completed}</div>
        ) : null}
        {error ? (
          <div className="alert alert-error text-xs py-2 whitespace-pre-wrap break-words">
            {error}
          </div>
        ) : null}
        {status.recommended_actions.length > 0 ? (
          <div className="card-actions justify-end">
            {status.recommended_actions.map((a, i) =>
              a.kind === "none" ? null : a.kind === "approve-gate" ||
                a.kind === "answer-turn" ? (
                <button
                  key={i}
                  type="button"
                  className={`btn btn-sm ${a.primary ? "btn-primary" : "btn-outline"}`}
                  onClick={() => scrollToBelowCard()}
                  title={a.description}
                >
                  {a.label}
                </button>
              ) : (
                <button
                  key={i}
                  type="button"
                  className={`btn btn-sm ${a.primary ? "btn-primary" : ""}`}
                  onClick={() => void fire(a.kind)}
                  disabled={busy !== null}
                  title={a.description}
                >
                  {busy === a.kind ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : null}
                  {a.label}
                </button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function scrollToBelowCard() {
  // Approve-gate / answer-turn actions are "go look at the card below";
  // smooth-scroll the user down 200px from the top so the GateCard /
  // TurnCard becomes visible right under the PolyFlow panel.
  try {
    window.scrollTo({ top: 320, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 320);
  }
}

type Tone = "good" | "info" | "warn" | "danger" | "neutral";

const TONE: Record<EngineStatusResponse["kind"], Tone> = {
  running: "good",
  "waiting-gate": "info",
  "waiting-turn": "info",
  "processing-answer": "info",
  stuck: "warn",
  crashed: "warn",
  finished: "good",
  "needs-human": "warn",
  stopped: "warn",
  failed: "danger",
  unknown: "neutral",
};

const KIND_LABEL: Record<EngineStatusResponse["kind"], string> = {
  running: "running",
  "waiting-gate": "awaiting gate",
  "waiting-turn": "awaiting answer",
  "processing-answer": "answering…",
  stuck: "stuck",
  crashed: "crashed",
  finished: "finished",
  "needs-human": "needs human",
  stopped: "stopped",
  failed: "failed",
  unknown: "unknown",
};

const KIND_HEADING: Record<EngineStatusResponse["kind"], string> = {
  running: "Engine running",
  "waiting-gate": "Awaiting gate decision",
  "waiting-turn": "Awaiting your answer",
  "processing-answer": "Engine processing your answer",
  stuck: "Engine appears stuck",
  crashed: "Engine process exited unexpectedly",
  finished: "Run completed",
  "needs-human": "Engine needs human takeover",
  stopped: "Engine stopped",
  failed: "Engine failed",
  unknown: "Engine status unknown",
};

const BORDER: Record<Tone, string> = {
  good: "border-success/50",
  info: "border-info/50",
  warn: "border-warning/70",
  danger: "border-error/70",
  neutral: "border-base-300",
};
const BG: Record<Tone, string> = {
  good: "bg-success/10",
  info: "bg-info/10",
  warn: "bg-warning/10",
  danger: "bg-error/10",
  neutral: "bg-base-100",
};
const BADGE: Record<Tone, string> = {
  good: "badge-success",
  info: "badge-info",
  warn: "badge-warning",
  danger: "badge-error",
  neutral: "badge-ghost",
};
const TEXT: Record<Tone, string> = {
  good: "text-success",
  info: "text-info",
  warn: "text-warning",
  danger: "text-error",
  neutral: "",
};
