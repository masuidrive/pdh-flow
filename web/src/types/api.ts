// Mirror of pdh-flow/src/web/server.ts response shapes.
// Kept narrow on purpose — only the fields the frontend reads.

export interface TicketSummary {
  slug: string;
  title?: string;
  status?: string;
  opened_at?: string;
  latest_run_id?: string | null;
  latest_run_state?: string | null;
}

export interface TicketDetail {
  slug: string;
  frontmatter: Record<string, unknown>;
  body: string;
  note?: string;
  latest_run_id?: string | null;
}

export interface RunListItem {
  run_id: string;
  ticket_id?: string | null;
  current_state?: string | null;
  saved_at?: string | null;
}

export interface JudgementEntry {
  node_id: string;
  round: number;
  decision: string;
}

export interface GateDecisionEntry {
  node_id: string;
  decision: string;
  decided_at: string;
  comment?: string;
}

export interface ActiveTurn {
  node_id: string;
  turn: number;
  round: number;
  asked_at: string;
  question: string;
  options?: { label: string; description?: string }[];
  context?: string;
}

export interface RunSummary {
  run_id: string;
  ticket_id?: string | null;
  flow?: string | null;
  variant?: string | null;
  saved_at?: string | null;
  current_state?: string | null;
  round: number;
  last_guardian_decision?: string | null;
  active_gate?: string | null;
  active_turn?: ActiveTurn | null;
  processing_answer: boolean;
  judgements: JudgementEntry[];
  gate_decisions: GateDecisionEntry[];
  closed: boolean;
}

// ── Graph endpoint ─────────────────────────────────────────────────────────

export type FlatNodeKind =
  | "provider"
  | "guardian"
  | "gate"
  | "system"
  | "parallel_group"
  | "terminal";

export type FlatEdgeKind =
  | "on_done"
  | "on_pass"
  | "on_repair"
  | "on_failure"
  | "on_aborted"
  | "escalate"
  | "loop_back";

export interface GraphNode {
  id: string;
  kind: FlatNodeKind;
  label: string;
  group?: string;
  meta?: Record<string, string | undefined>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: FlatEdgeKind;
  label?: string;
}

export interface RunGraph {
  flow: string;
  variant: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  current_node?: string | null;
  visited_node_ids: string[];
  judgement_decisions: Record<string, string>;
}
