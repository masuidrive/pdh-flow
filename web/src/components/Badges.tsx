import { stateLabel, isTerminalState, stateBadgeClass } from "../lib/runState";

export function StateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="badge badge-ghost">unknown</span>;
  // Sink/terminal states get the human-friendly label from stateLabel
  // ("failed", "finished", "needs human", "stopped") instead of the raw
  // XState id (e.g. "__failed__"). Non-terminal states keep the raw
  // node id since "code_quality_review.aggregate" is already a useful
  // label; we only swap the cosmetic class.
  if (isTerminalState(state)) {
    const { text, tone } = stateLabel(state);
    return <span className={`badge ${stateBadgeClass(tone)}`}>{text}</span>;
  }
  const cls =
    state.endsWith("_gate") || state === "review_gate"
      ? "badge-warning"
      : "badge-info";
  return <span className={`badge ${cls}`}>{state}</span>;
}

const DECISION_CLASS: Record<string, string> = {
  pass: "badge-success",
  approved: "badge-success",
  repair_needed: "badge-warning",
  rejected: "badge-error",
  fail: "badge-error",
  cancelled: "badge-ghost",
  abort: "badge-error",
  escalate_human: "badge-error",
};

export function DecisionBadge({ decision }: { decision: string }) {
  const cls = DECISION_CLASS[decision] ?? "badge-info";
  return <span className={`badge ${cls}`}>{decision}</span>;
}
