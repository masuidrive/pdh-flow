// Mirror of pdh-flow/src/web/server.ts response shapes.
// Kept narrow on purpose — only the fields the frontend reads.

export interface TicketSummary {
  slug: string;
  title?: string;
  status?: string;
  opened_at?: string;
  latest_run_id?: string | null;
  latest_run_state?: string | null;
  /** Worktree path the ticket lives in. Always present from server side
   *  when the serve aggregates across worktrees; older single-tenant
   *  builds may omit it, hence optional in the type. */
  worktree_path?: string;
  /** Epic slug from ticket frontmatter; null when the ticket isn't
   *  linked to an epic. Surfaced so the Top page can group/filter
   *  by epic without re-reading frontmatter client-side. */
  epic_id?: string | null;
}

export interface EpicSummary {
  epic_id: string;
  title: string | null;
  status: string | null;
  branch: string | null;
  worktree_path: string;
  open_ticket_count: number;
  closed_ticket_count: number;
  ticket_count: number;
  created_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
}

export interface EpicDetail extends EpicSummary {
  epic_frontmatter: Record<string, unknown>;
  epic_body: string;
  cancel_reason: string | null;
  linked_tickets: Array<{
    slug: string;
    title: string | null;
    status: string;
    file_location: string;
    base_branch: string | null;
  }>;
  branch_state: { ahead_of_main?: number; head_sha?: string; behind_main?: number } | null;
  preflight: { ok: boolean; blockers: string[] } | null;
  active_close_run_id: string | null;
  can_start_close: boolean;
}

export interface TicketDetail {
  slug: string;
  ticket_frontmatter: Record<string, unknown>;
  ticket_body: string;
  note_body: string | null;
  /** Full latest-run summary (or null when no run matches the ticket
   *  by ticket_id). Frontend reads `.run_id` from this for the
   *  "Open latest run" button; renderable run state, judgements, and
   *  gate decisions also come from here when present. */
  latest_run: RunSummary | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  is_current: boolean;
  has_runs: boolean;
  ticket_count: number;
  run_count: number;
  last_run_at: string | null;
}

export interface RunListItem {
  run_id: string;
  ticket_id?: string | null;
  current_state?: string | null;
  saved_at?: string | null;
  worktree_path?: string;
}

export interface JudgementEntry {
  node_id: string;
  round: number;
  decision: string;
  reasoning?: string;
  blocking_findings_count?: number;
}

export interface GateDecisionEntry {
  node_id: string;
  decision: string;
  decided_at: string;
  approver?: string;
  comment?: string;
  via?: string;
  round?: number;
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

export interface GateDraft {
  node_id: string;
  decision: string;
  comment?: string;
  approver?: string;
  decided_at?: string;
  via?: string;
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
  /** A decision proposed via the gate-respond wrapper (e.g. from an "open in
   *  terminal" session) awaiting human confirmation. */
  gate_draft?: GateDraft | null;
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

export interface TransitionEntry {
  ts: string;
  from: string | null;
  to: string;
  event: string | null;
}

export type RunEventKind =
  | "provider_start"
  | "provider_finish"
  | "guardian_start"
  | "guardian_finish"
  | "system_start"
  | "system_finish";

export interface RunEvent {
  ts: string;
  node_id: string;
  round: number;
  kind: RunEventKind;
  provider?: "claude" | "codex";
  role?: string;
  action?: string;
  outcome?: "ok" | "error" | "fixture";
  duration_ms?: number;
  error?: string;
}

export interface EvidenceFile {
  filename: string;
  url: string;
  kind: "image" | "pdf" | "text" | "other";
  size_bytes: number;
  modified_at: string;
}

export interface EvidenceRound {
  round: number;
  files: EvidenceFile[];
}

export interface RunGraph {
  flow: string;
  variant: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  current_node?: string | null;
  visited_node_ids: string[];
  judgement_decisions: Record<string, string>;
  judgements: JudgementEntry[];
  gate_decisions: GateDecisionEntry[];
  transitions: TransitionEntry[];
}
