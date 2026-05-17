import type { Stage, WorkerStatus } from '@poly/types';
import {
  WASH_ACTIVE,
  WASH_FUTURE,
  WASH_PAST,
} from '@poly/config';
import { Station } from './Station';
import { Nameplate } from './Nameplate';
import { Worker } from './Worker';
import { Machine } from './Machine';
import { FinishFlag } from './FinishFlag';
import { useFlowStore } from '@poly/hooks/useFlowState';

interface StationGroupProps {
  stage: Stage;
  idx: number;
  isActive: boolean;
  isPast: boolean;
  visitCount: number;
  failingStageId: string | null;
}

/**
 * Renders one stage's full visual: station pad, nameplate, workers, and any
 * stage-type-specific prop (machine for system_step, flag for terminal).
 *
 * The wash level is computed from `isActive` / `isPast` and propagated down.
 * On a parallel stage, individual reviewers fade as they hand off their orb
 * to the aggregator (driven by `parallelDoneIdx` in the store).
 */
export function StationGroup({
  stage,
  idx,
  isActive,
  isPast,
  visitCount,
  failingStageId,
}: StationGroupProps) {
  const failingHere = failingStageId === stage.id;

  // The "emitting" stage is the previous stage (after a forward advance)
  // whose workers are still throwing orbs to the current stage. While
  // that's happening, override its wash so it stays vibrant — and fade
  // individual workers as they emit.
  const emittingStageId = useFlowStore((s) => s.emittingStageId);
  const emittingDoneIdx = useFlowStore((s) => s.emittingDoneIdx);
  const isEmittingHere = emittingStageId === stage.id;

  const baseStageWash = isActive
    ? WASH_ACTIVE
    : isPast
      ? WASH_PAST
      : WASH_FUTURE;
  const stageWash = isEmittingHere ? WASH_ACTIVE : baseStageWash;

  return (
    <group position={[stage.x, 0, stage.z]}>
      <Station
        kind={stage.stationKind}
        radius={stage.radius}
        active={isActive || isEmittingHere}
        wash={stageWash}
      />
      <Nameplate stage={stage} active={isActive} />

      {stage.workers.map((w, i) => {
        const workerEmitted = isEmittingHere && emittingDoneIdx.includes(i);
        const status: WorkerStatus = workerEmitted
          ? 'done'
          : workerStatus(isActive || isEmittingHere, isPast && !isEmittingHere, failingHere);
        const wash = workerEmitted ? WASH_PAST : stageWash;
        return (
          <group key={i} position={[w.x - stage.x, 0, w.z - stage.z]}>
            <Worker
              data={w}
              status={status}
              wash={wash}
              count={visitCount}
              failing={failingHere}
              phase={i * 0.7 + idx * 0.3}
              showRoleOnHover={stage.type === 'parallel'}
            />
          </group>
        );
      })}

      {stage.type === 'system' && <Machine active={isActive || isEmittingHere} wash={stageWash} />}
      {stage.type === 'terminal' && <FinishFlag wash={stageWash} />}
    </group>
  );
}

function workerStatus(
  isActive: boolean,
  isPast: boolean,
  failing: boolean,
): WorkerStatus {
  if (failing) return 'fail';
  if (isActive) return 'work';
  if (isPast) return 'done';
  return 'idle';
}
