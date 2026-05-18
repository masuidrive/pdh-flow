import { create } from 'zustand';
import type {
  FlowRuntimeState,
  Stage,
} from '@poly/types';

// =============================================================================
// Runtime state store.
//
// The store is intentionally minimal — it stores the abstract state machine,
// not the visual presentation. The rendering layer reads `currentIdx`,
// `visitCounts`, and `failingStageId` to decide what to show.
//
// Side-effects that involve TIME (orb arrivals, auto-play timers) live in
// the components that own them (Scene + ControlBar), not in this store.
// =============================================================================

export interface FlowStore extends FlowRuntimeState {
  stages: Stage[];
  failPaths: Record<string, string>;

  /**
   * The stage whose workers are currently emitting orbs to the *next*
   * stage. While set, the stage stays at active-wash (overriding any
   * other wash logic) so the emission feels anchored to a clear source.
   * Individual workers inside this stage fade to past-wash as soon as
   * their own orb has left (see `emittingDoneIdx`).
   *
   * When the last orb arrives at the destination, the animation system
   * clears this and advances `currentIdx`.
   */
  emittingStageId: string | null;
  /** Worker indices in the emitting stage whose orbs have left. */
  emittingDoneIdx: number[];

  /** Engine node ids of individual workers (today: parallel reviewers)
   *  whose latest provider event is `provider_finish` — i.e. their work
   *  for the current visit is done. StationGroup looks this up by the
   *  worker's `engineId` to force `done` status and stop the typing /
   *  bounce animation while peers keep working. Stored as a record for
   *  O(1) lookup; LiveBridge replaces it wholesale on every events
   *  update. */
  workerDoneIds: Record<string, true>;

  // mutations
  setStages(stages: Stage[], failPaths: Record<string, string>): void;
  setCurrentIdx(idx: number): void;
  setScrubbing(s: boolean): void;
  setPlaying(p: boolean): void;
  setSpeed(n: number): void;
  /**
   * Overwrite per-stage counters (rendered as sprite badges over each
   * character). The standalone bundle bumps these via `recordVisit`,
   * but when driven by an external engine we mirror the engine's
   * authoritative round number directly so repair loops surface as
   * round 2 / 3 / ... even when the engine re-enters a parallel
   * reviewer the bundle treats as a single stage.
   */
  setVisitCounts(map: Record<string, number>): void;
  /** Replace the set of finished worker ids. Caller is the engine event
   *  bridge — pass the list it computed from events.jsonl on every
   *  events update. */
  setWorkerDoneIds(ids: readonly string[]): void;

  /** Animated advance to a specific stage index. Returns true when the
   *  animation actually started; false means the caller should fall
   *  back to a teleport (`jumpById`). The function is registered by
   *  the <PolyFlow> component once its orb controller mounts; the
   *  engine bridge calls it on every engine transition so forward
   *  moves get an orb flying from the current stage to the target.
   *  Null when no controller is registered yet. */
  animator: ((targetIdx: number) => boolean) | null;
  setAnimator(fn: ((targetIdx: number) => boolean) | null): void;

  recordVisit(idx: number): void;
  advance(): boolean;            // returns false if at the end
  regress(): void;
  jump(idx: number): void;
  jumpById(id: string): void;
  fail(): { from: number; to: number } | null;
  resetFlow(): void;

  // transient
  setFailingStageId(id: string | null): void;
  setEmitting(stageId: string): void;
  markEmittingDone(workerIdx: number): void;
  clearEmitting(): void;
}

const initialRuntime: FlowRuntimeState = {
  currentIdx: 0,
  visitCounts: {},
  scrubbing: false,
  isPlaying: false,
  speed: 1.0,
  failingStageId: null,
};

export const useFlowStore = create<FlowStore>((set, get) => ({
  ...initialRuntime,
  stages: [],
  failPaths: {},
  emittingStageId: null,
  emittingDoneIdx: [],
  workerDoneIds: {},
  animator: null,

  setStages(stages, failPaths) {
    const visitCounts: Record<string, number> = {};
    stages.forEach((s) => {
      visitCounts[s.id] = 0;
    });
    if (stages[0]) visitCounts[stages[0].id] = 1;
    set({
      stages,
      failPaths,
      currentIdx: 0,
      visitCounts,
      emittingStageId: null,
      emittingDoneIdx: [],
    });
  },

  setCurrentIdx(idx) {
    set({ currentIdx: idx });
  },

  setScrubbing(s) {
    set({ scrubbing: s });
  },

  setPlaying(p) {
    set({ isPlaying: p });
  },

  setSpeed(n) {
    set({ speed: n });
  },

  setVisitCounts(map) {
    // Replace, don't merge — caller is the source of truth (engine
    // judgements / transitions). Merging would let stale rounds linger
    // after a reset.
    set({ visitCounts: { ...map } });
  },

  setWorkerDoneIds(ids) {
    const next: Record<string, true> = {};
    for (const id of ids) next[id] = true;
    set({ workerDoneIds: next });
  },

  setAnimator(fn) {
    set({ animator: fn });
  },

  recordVisit(idx) {
    const { stages, visitCounts } = get();
    const s = stages[idx];
    if (!s) return;
    // Note: we do NOT clear emittingStageId here. The animation system
    // (runStageAnimation, invoked from PolyFlow's effect) sets the new
    // emitting stage immediately after this update lands, so clearing
    // here would cause a 1-frame flicker.
    set({
      currentIdx: idx,
      visitCounts: { ...visitCounts, [s.id]: (visitCounts[s.id] ?? 0) + 1 },
      failingStageId: null,
    });
  },

  advance() {
    const { currentIdx, stages, recordVisit } = get();
    if (currentIdx >= stages.length - 1) {
      set({ isPlaying: false });
      return false;
    }
    recordVisit(currentIdx + 1);
    return true;
  },

  regress() {
    const { currentIdx } = get();
    if (currentIdx <= 0) return;
    set({
      currentIdx: currentIdx - 1,
      failingStageId: null,
      emittingStageId: null,
      emittingDoneIdx: [],
    });
  },

  jump(idx) {
    const { stages, recordVisit } = get();
    const clamped = Math.max(0, Math.min(idx, stages.length - 1));
    recordVisit(clamped);
  },

  jumpById(id) {
    const { stages, recordVisit } = get();
    const idx = stages.findIndex((s) => s.id === id);
    if (idx >= 0) recordVisit(idx);
  },

  fail() {
    const { currentIdx, stages, failPaths } = get();
    const cur = stages[currentIdx];
    if (!cur) return null;
    const targetId = failPaths[cur.id];
    if (!targetId) return null;
    const targetIdx = stages.findIndex((s) => s.id === targetId);
    if (targetIdx < 0 || targetIdx >= currentIdx) return null;
    set({ failingStageId: cur.id });
    return { from: currentIdx, to: targetIdx };
  },

  setFailingStageId(id) {
    set({ failingStageId: id });
  },

  setEmitting(stageId) {
    set({ emittingStageId: stageId, emittingDoneIdx: [] });
  },

  markEmittingDone(workerIdx) {
    const cur = get().emittingDoneIdx;
    if (cur.includes(workerIdx)) return;
    set({ emittingDoneIdx: [...cur, workerIdx] });
  },

  clearEmitting() {
    set({ emittingStageId: null, emittingDoneIdx: [] });
  },

  resetFlow() {
    const { stages } = get();
    const visitCounts: Record<string, number> = {};
    stages.forEach((s) => {
      visitCounts[s.id] = 0;
    });
    if (stages[0]) visitCounts[stages[0].id] = 1;
    set({
      currentIdx: 0,
      visitCounts,
      isPlaying: false,
      failingStageId: null,
      emittingStageId: null,
      emittingDoneIdx: [],
    });
  },
}));
