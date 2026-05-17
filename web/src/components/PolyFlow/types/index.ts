// =============================================================================
// Yaml schema (subset relevant to the visualization layer)
// =============================================================================

/** Built-in character kinds the visualization knows how to render. */
export type CharacterKind =
  | 'pm'
  | 'planner'
  | 'devils_advocate'
  | 'engineer'
  | 'code_reviewer'
  | 'critical'
  | 'aggregator'
  | 'door';

/**
 * Maps each yaml role (or special key like `pdm`) to a character kind.
 * If a role isn't listed, the visualization falls back to {@link DEFAULT_CHARACTER}.
 */
export type CharactersMap = Partial<Record<string, CharacterKind>>;

/** Count that may vary by variant — yaml `count: { full: 2, light: 1 }`. */
export type CountSpec = number | Record<string, number>;

export interface ReviewerSpec {
  role: string;
  count: CountSpec;
  focus?: string[];
}

export interface ProvidersProfile {
  label?: string;
  description?: string;
  default: string;
  /** Override by node-id or by role. Lookup priority: node-id > role > default. */
  [override: string]: string | undefined;
}

export interface VariantSpec {
  initial: string;
  label?: string;
  description?: string;
}

export type FlowNode =
  | ProviderStepNode
  | SystemStepNode
  | GateStepNode
  | ReviewLoopMacroNode
  | TerminalNode;

interface NodeBase {
  label?: string;
  summary?: string;
}

export interface ProviderStepNode extends NodeBase {
  type: 'provider_step';
  role: string;
  prompt?: unknown;
  on_done: string | Record<string, string>;
  on_failure?: string;
}

export interface SystemStepNode extends NodeBase {
  type: 'system_step';
  action: string;
  params?: Record<string, unknown>;
  on_done: string;
  on_failure?: string;
}

export interface GateStepNode extends NodeBase {
  type: 'gate_step';
  approver_role: string;
  show?: string[];
  outputs: Record<string, string>;
  form?: unknown[];
}

export interface ReviewLoopMacroNode extends NodeBase {
  macro: 'review_loop';
  reviewers: ReviewerSpec[];
  aggregator: { role: string };
  repair: { role: string };
  max_rounds?: number;
  on_pass: string;
  on_aborted: string;
}

export interface TerminalNode {
  type: 'terminal';
  outcome: string;
  reason?: string;
}

export interface FlowSchema {
  flow: string;
  version: number;
  defaults?: Record<string, unknown>;
  providers: Record<string, ProvidersProfile>;
  variants: Record<string, VariantSpec>;
  /** NEW (added for the visualization). Maps yaml roles → character kinds. */
  characters?: CharactersMap;
  nodes: Record<string, FlowNode>;
}

// =============================================================================
// Stage — the visualization's unit of work, derived from yaml nodes.
// =============================================================================

export type StageType =
  | 'work'       // single character on a normal pad
  | 'parallel'   // N reviewers on a wide pad
  | 'aggregate'  // aggregator robot
  | 'gate'       // human gate (door)
  | 'system'     // server-rack machine, no character
  | 'terminal';  // finish flag, no character

export type StationKind =
  | 'normal'
  | 'review'
  | 'aggregator'
  | 'gate'
  | 'system'
  | 'terminal';

export interface Worker {
  char: CharacterKind;
  /** Display label (defaults to the yaml role). */
  label: string;
  /** Local x offset within the station. */
  x: number;
  /** World z (corridor axis). */
  z: number;
}

export interface Stage {
  /** Yaml node id, or synthesized id for macro-internal nodes. */
  id: string;
  /** Yaml `label`, empty string for synthesized stages. */
  label: string;
  /** Yaml `summary` verbatim, empty string for synthesized stages. */
  sub: string;
  /** "<role> · <model>" formatted for the active info card. */
  role: string;
  type: StageType;
  stationKind: StationKind;
  workers: Worker[];
  /** Station center, world coords. */
  x: number;
  z: number;
  /** Pad radius (auto-sized to fit workers). */
  radius: number;
}

// =============================================================================
// Per-stage runtime state
// =============================================================================

export type WorkerStatus = 'idle' | 'work' | 'done' | 'fail';

export interface FlowRuntimeState {
  /** Index into the stages array. */
  currentIdx: number;
  /** Visit count by stage id; incremented on real entries only. */
  visitCounts: Record<string, number>;
  /** True while the user is dragging to scrub. */
  scrubbing: boolean;
  /** True if auto-play is on. */
  isPlaying: boolean;
  /** Auto-play speed multiplier. */
  speed: number;
  /** Brief override for a stage that just failed (red ✗ badge). */
  failingStageId: string | null;
}

// =============================================================================
// Orb particles (data/decision flow between stations)
// =============================================================================

import type { Vector3Tuple } from 'three';

export interface OrbSpec {
  id: string;
  from: Vector3Tuple;
  to: Vector3Tuple;
  color: string;
  duration: number;     // seconds
  arc: number;          // peak height
  size: number;
  spawnedAt: number;    // performance.now() / 1000
  /** What to do when the orb reaches its target. */
  onArrive?: () => void;
}

// =============================================================================
// Public API exposed by the hook
// =============================================================================

export interface FlowApi {
  state: FlowRuntimeState;
  stages: Stage[];

  advance(): void;
  regress(): void;
  jump(idx: number): void;
  jumpById(id: string): void;
  fail(): boolean;          // returns false if current stage has no rollback
  reset(): void;

  setPlaying(p: boolean): void;
  setSpeed(n: number): void;
  setScrubbing(s: boolean): void;
  setCurrentIdx(idx: number): void;  // used during scrub previews
}
