import { useFlowStore } from '@poly/hooks/useFlowState';

interface ControlBarProps {
  onFailRequested(): void;
  /** Triggers the current stage's emission and advances when complete. */
  onNext(): void;
}

export function ControlBar({ onFailRequested, onNext }: ControlBarProps) {
  const isPlaying = useFlowStore((s) => s.isPlaying);
  const speed = useFlowStore((s) => s.speed);
  const stages = useFlowStore((s) => s.stages);
  const currentIdx = useFlowStore((s) => s.currentIdx);
  const failPaths = useFlowStore((s) => s.failPaths);

  const regress = useFlowStore((s) => s.regress);
  const resetFlow = useFlowStore((s) => s.resetFlow);
  const setPlaying = useFlowStore((s) => s.setPlaying);
  const setSpeed = useFlowStore((s) => s.setSpeed);

  const currentStage = stages[currentIdx];
  const canFail = currentStage ? !!failPaths[currentStage.id] : false;

  return (
    <div className="hud-bottom">
      <button
        className="btn"
        onClick={() => {
          setPlaying(false);
          regress();
        }}
      >
        ◀
      </button>
      <button
        className="btn primary"
        onClick={() => {
          setPlaying(false);
          onNext();
        }}
      >
        ▶ 次へ
      </button>
      <button
        className="btn danger"
        disabled={!canFail}
        style={{ opacity: canFail ? 1 : 0.35, cursor: canFail ? 'pointer' : 'default' }}
        onClick={() => {
          setPlaying(false);
          onFailRequested();
        }}
      >
        ✕ 失敗
      </button>
      <button
        className="btn primary"
        onClick={() => setPlaying(!isPlaying)}
      >
        {isPlaying ? '⏸ 停止' : '⏵ 自動'}
      </button>
      <button className="btn danger" onClick={resetFlow}>
        ↺ Reset
      </button>
      <div className="speed-wrap">
        速度
        <input
          type="range"
          min={0.4}
          max={2.5}
          step={0.1}
          value={speed}
          onChange={(e) => setSpeed(parseFloat(e.target.value))}
        />
      </div>
    </div>
  );
}
