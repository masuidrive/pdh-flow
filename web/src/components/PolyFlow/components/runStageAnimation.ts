import type { Stage } from '@poly/types';
import type { OrbController } from '@poly/hooks/useOrbs';
import { CHAR_ORB_COLOR } from '@poly/characters';
import { useFlowStore } from '@poly/hooks/useFlowState';

/**
 * Drive the "this stage is finishing its work" animation. Orbs fly from
 * `from` (the stage we're currently on) to `to` (the next stage). When
 * the last orb arrives, `onAllArrived` is called — the caller advances
 * the flow there.
 *
 * Per-stage emission policy:
 *   work / aggregate / gate : 1 worker emits 1 orb
 *   parallel                : N workers emit N orbs, staggered
 *   system                  : the machine emits 1 orb (no per-worker)
 *   terminal                : no orbs; onAllArrived fires immediately
 */
export function runStageAnimation(
  from: Stage,
  to: Stage,
  orbs: OrbController,
  speed: number,
  onAllArrived: () => void,
): void {
  const orbDur = 0.9 / speed;
  const baseDur = 0.4 / speed; // shorter pre-roll: user clicked, react fast
  const store = useFlowStore.getState();

  store.setEmitting(from.id);

  const total =
    from.type === 'parallel' ? from.workers.length :
    from.type === 'system'   ? 1 :
    from.type === 'terminal' ? 0 :
    1;

  if (total === 0) {
    // Nothing to emit (terminal). Just clear and bubble up.
    store.clearEmitting();
    onAllArrived();
    return;
  }

  let arrived = 0;
  const onArrive = () => {
    arrived++;
    if (arrived >= total) {
      // Note: do NOT clear emitting here — clear it AFTER the caller's
      // advance so the "from" stage stays vibrant for one frame past the
      // currentIdx flip. The caller handles the clear.
      onAllArrived();
    }
  };

  switch (from.type) {
    case 'work':
    case 'aggregate':
    case 'gate': {
      const w = from.workers[0];
      if (!w) {
        store.clearEmitting();
        onAllArrived();
        return;
      }
      const color =
        from.type === 'aggregate' ? CHAR_ORB_COLOR.aggregator :
        from.type === 'gate'      ? '#3ec06a' :
        CHAR_ORB_COLOR[w.char];
      window.setTimeout(() => {
        useFlowStore.getState().markEmittingDone(0);
        orbs.spawn({
          from: [w.x, 0.9, w.z],
          to: [to.x, 0.9, to.z],
          color,
          duration: orbDur,
          arc: 1.0,
          size: 0.16,
          onArrive,
        });
      }, baseDur * 1000);
      break;
    }

    case 'parallel': {
      // All reviewers throw to the aggregator at staggered times.
      const toPos: [number, number, number] = [to.x, 0.7, to.z];
      from.workers.forEach((w, wi) => {
        const delay = baseDur * 1000 + wi * 220 / speed;
        window.setTimeout(() => {
          useFlowStore.getState().markEmittingDone(wi);
          orbs.spawn({
            from: [w.x, 0.9, w.z],
            to: toPos,
            color: CHAR_ORB_COLOR[w.char],
            duration: orbDur,
            arc: 1.0,
            size: 0.16,
            onArrive,
          });
        }, delay);
      });
      break;
    }

    case 'system': {
      window.setTimeout(() => {
        orbs.spawn({
          from: [from.x, 0.9, from.z],
          to: [to.x, 0.9, to.z],
          color: '#3ec06a',
          duration: orbDur,
          arc: 1.0,
          size: 0.2,
          onArrive,
        });
      }, baseDur * 1000);
      break;
    }

    case 'terminal':
      // Already handled by the total === 0 branch above.
      break;
  }
}
