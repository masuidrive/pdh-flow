import { useCallback, useEffect, useRef, useState } from 'react';
import { Scene } from './Scene';
import { ControlBar } from './ControlBar';
import { Timeline } from './Legend';
import { useFlowStore } from '@poly/hooks/useFlowState';
import { loadFlow } from '@poly/flow/loadFlow';
import { buildFailPaths } from '@poly/flow/failPaths';
import type { OrbController } from '@poly/hooks/useOrbs';
import { AUTO_FAIL_PROBABILITY } from '@poly/config';
import { runStageAnimation } from './runStageAnimation';

interface PolyFlowProps {
  /** Raw pdh-flow.yaml text. */
  yamlText: string;
  /** Variant key (e.g. 'full' | 'light'). Defaults to 'full'. */
  variant?: string;
  /** Provider profile key. Defaults to 'default'. */
  profile?: string;
  /**
   * Whether to render the debug control bar (manual stepping, fail
   * injection, speed slider, auto-play, reset). Defaults to true.
   *
   * Set to `false` when embedding the visualization inside another app —
   * the host app drives flow state externally via `useFlowStore`
   * (`.jumpById()` etc.) and there's no reason to expose manual controls
   * or auto-play to end users. The camera-nav arrows and side timeline
   * still render so users can browse the flow.
   */
  debugControls?: boolean;
}

/**
 * Top-level visualization component. Drop into any React tree:
 *
 *   <PolyFlow yamlText={yaml} variant="full" profile="default" />
 *
 * Production embed (no debug UI):
 *   <PolyFlow yamlText={yaml} debugControls={false} />
 */
export function PolyFlow({
  yamlText,
  variant = 'full',
  profile = 'default',
  debugControls = true,
}: PolyFlowProps) {
  // --- One-time flow load ---------------------------------------------------
  useEffect(() => {
    const { stages, schema } = loadFlow(yamlText, { variant, profile });
    const failPaths = buildFailPaths(schema);
    useFlowStore.getState().setStages(stages, failPaths);
  }, [yamlText, variant, profile]);

  // --- Orb controller (set by Scene after mount) ---------------------------
  const orbCtlRef = useRef<OrbController | null>(null);
  const onOrbReady = useCallback((c: OrbController) => {
    orbCtlRef.current = c;
  }, []);

  const stages = useFlowStore((s) => s.stages);
  const currentIdx = useFlowStore((s) => s.currentIdx);
  const speed = useFlowStore((s) => s.speed);

  // --- Camera-only navigation ----------------------------------------------
  // viewOffset shifts the camera focus relative to currentIdx without
  // advancing the flow. Reset whenever currentIdx changes so the camera
  // snaps back to the action.
  const [viewOffset, setViewOffset] = useState(0);
  useEffect(() => {
    setViewOffset(0);
  }, [currentIdx]);
  const viewIdx = Math.max(
    0,
    Math.min(stages.length - 1, currentIdx + viewOffset),
  );
  const targetZ = stages[viewIdx]?.z ?? 0;

  // Arrow direction matches what the user sees on screen, not flow order.
  // With CAMERA_ANGLE_Y = π/4 the corridor runs upper-left ⇆ lower-right
  // in screen space, so:
  //   ◀ (screen-left arrow) shows the NEXT stage (which appears on the left)
  //   ▶ (screen-right arrow) shows the PREVIOUS stage (which appears right)
  const canViewLeft  = viewIdx < stages.length - 1;
  const canViewRight = viewIdx > 0;
  const shiftViewLeft  = useCallback(() => setViewOffset((v) => v + 1), []);
  const shiftViewRight = useCallback(() => setViewOffset((v) => v - 1), []);
  const resetView      = useCallback(() => setViewOffset(0), []);

  // --- Emit-then-advance ---------------------------------------------------
  // The "next" action is async: trigger the current stage's emission and
  // advance currentIdx only after the last orb arrives. animatingRef
  // guards against re-entry from button mashing / auto-play.
  const animatingRef = useRef(false);
  const playForward = useCallback((): boolean => {
    if (animatingRef.current) return false;
    const state = useFlowStore.getState();
    const idx = state.currentIdx;
    const cur = state.stages[idx];
    const next = state.stages[idx + 1];
    if (!cur || !next) return false;
    const ctl = orbCtlRef.current;
    if (!ctl) {
      state.advance();
      return true;
    }
    animatingRef.current = true;
    runStageAnimation(cur, next, ctl, state.speed, () => {
      useFlowStore.getState().advance();
      useFlowStore.getState().clearEmitting();
      animatingRef.current = false;
    });
    return true;
  }, []);

  // --- Engine-driven animator ----------------------------------------------
  // The live bridge in PolyFlowPanel calls this when the engine moves to a
  // new stage. We try the existing orb-emit-then-advance machinery so any
  // forward move (one step or several — e.g. aggregator skipping repair on
  // pass) shows an orb fly from the current stage to the target. Returns
  // false if the orb controller isn't mounted yet, the move isn't forward,
  // an animation is already in flight, or the stages are out of range —
  // the caller falls back to a teleport in that case.
  useEffect(() => {
    const animator = (targetIdx: number): boolean => {
      if (animatingRef.current) return false;
      const ctl = orbCtlRef.current;
      if (!ctl) return false;
      const state = useFlowStore.getState();
      const cur = state.stages[state.currentIdx];
      const next = state.stages[targetIdx];
      if (!cur || !next) return false;
      if (targetIdx <= state.currentIdx) return false;
      animatingRef.current = true;
      runStageAnimation(cur, next, ctl, state.speed, () => {
        useFlowStore.getState().jump(targetIdx);
        useFlowStore.getState().clearEmitting();
        animatingRef.current = false;
      });
      return true;
    };
    useFlowStore.getState().setAnimator(animator);
    return () => {
      useFlowStore.getState().setAnimator(null);
    };
  }, []);

  // --- Fail handler --------------------------------------------------------
  const runFail = useCallback(() => {
    if (animatingRef.current) return;
    const ctl = orbCtlRef.current;
    if (!ctl) return;
    const result = useFlowStore.getState().fail();
    if (!result) return;
    const { from, to } = result;
    const all = useFlowStore.getState().stages;
    const fromStage = all[from];
    const toStage = all[to];
    if (!fromStage || !toStage) return;
    animatingRef.current = true;
    ctl.spawn({
      from: [fromStage.x, 0.9, fromStage.z],
      to: [toStage.x, 0.9, toStage.z],
      color: '#ff3030',
      duration: 1.5 / useFlowStore.getState().speed,
      arc: 2.4,
      size: 0.22,
      onArrive: () => {
        useFlowStore.getState().jump(to);
        animatingRef.current = false;
      },
    });
  }, []);

  // --- Auto-play loop ------------------------------------------------------
  const isPlaying = useFlowStore((s) => s.isPlaying);
  useEffect(() => {
    if (!isPlaying) return;
    const stage = stages[currentIdx];
    if (!stage) return;
    const failPaths = useFlowStore.getState().failPaths;
    const willFail =
      !!failPaths[stage.id] && Math.random() < AUTO_FAIL_PROBABILITY;
    const tid = window.setTimeout(() => {
      if (!useFlowStore.getState().isPlaying) return;
      if (animatingRef.current) return;
      if (willFail) {
        runFail();
      } else {
        playForward();
      }
    }, 600 / speed);
    return () => window.clearTimeout(tid);
  }, [isPlaying, currentIdx, stages, speed, runFail, playForward]);

  // --- Keyboard shortcuts (only when debug controls enabled) ---------------
  useEffect(() => {
    if (!debugControls) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') {
        useFlowStore.getState().setPlaying(false);
        playForward();
      } else if (e.key === 'ArrowLeft') {
        useFlowStore.getState().setPlaying(false);
        useFlowStore.getState().regress();
      } else if (e.key === ' ') {
        e.preventDefault();
        useFlowStore.getState().setPlaying(!useFlowStore.getState().isPlaying);
      } else if (e.key.toLowerCase() === 'r') {
        useFlowStore.getState().resetFlow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playForward, debugControls]);

  return (
    <div className="poly-flow-root">
      <Scene targetZ={targetZ} onOrbControllerReady={onOrbReady} />
      <Timeline />

      {/* ===== DEBUG-ONLY UI =================================================
       * The block below is gated behind `debugControls`. When embedding the
       * visualization in production, pass debugControls={false} and the
       * entire ControlBar is omitted. The camera-nav buttons below this
       * block stay because they are real user-facing navigation.
       * ================================================================== */}
      {debugControls && <ControlBar onFailRequested={runFail} onNext={playForward} />}

      <div className="cam-nav">
        <button
          className="cam-nav-btn"
          aria-label="Pan camera left (toward later stages)"
          disabled={!canViewLeft}
          onClick={shiftViewLeft}
        >
          ◀
        </button>
        <button
          className="cam-nav-btn cam-nav-now"
          aria-label="Recenter on current stage"
          disabled={viewOffset === 0}
          onClick={resetView}
        >
          ●
        </button>
        <button
          className="cam-nav-btn"
          aria-label="Pan camera right (toward earlier stages)"
          disabled={!canViewRight}
          onClick={shiftViewRight}
        >
          ▶
        </button>
      </div>
    </div>
  );
}
