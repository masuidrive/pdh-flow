export function StateBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="badge badge-ghost">unknown</span>;
  const cls = state === "terminal" || state === "__success__"
    ? "badge-success"
    : state === "__failed__" || state.includes("human_intervention")
      ? "badge-error"
      : state.endsWith("_gate") || state === "review_gate"
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
