// Helpers for interpreting an XState run's `current_state`.
//
// The compiled machine ends in one of a few sink ("terminal-kind") states:
//   terminal           — flow completed normally (e.g. gate approved → close)
//   human_intervention — flow routed to manual takeover (e.g. gate cancelled)
//   __failed__         — engine hit an unrecoverable error
//   __stopped__        — engine stopped (e.g. budget / interrupt)
// In any of these the engine has exited; there is no "active process".

export const TERMINAL_STATES = new Set([
  "terminal",
  "human_intervention",
  "__failed__",
  "__stopped__",
]);

export function isTerminalState(s: string | null | undefined): boolean {
  return !!s && TERMINAL_STATES.has(s);
}

export type StateTone = "success" | "warning" | "error" | "neutral" | "info";

/** A human-friendly label + daisyUI tone for a run state. Sink states get a
 *  plain-English name; everything else is the raw node id (an in-flight node
 *  name like `code_quality_review.aggregate` is already meaningful). */
export function stateLabel(s: string | null | undefined): { text: string; tone: StateTone } {
  switch (s) {
    case "terminal":
      return { text: "finished", tone: "success" };
    case "human_intervention":
      return { text: "needs human", tone: "warning" };
    case "__failed__":
      return { text: "failed", tone: "error" };
    case "__stopped__":
      return { text: "stopped", tone: "neutral" };
    default:
      return { text: s ?? "?", tone: "info" };
  }
}

const TONE_BADGE: Record<StateTone, string> = {
  success: "badge-success",
  warning: "badge-warning",
  error: "badge-error",
  neutral: "badge-neutral",
  info: "badge-warning",
};

export function stateBadgeClass(tone: StateTone): string {
  return TONE_BADGE[tone];
}
