import { useFlowStore } from '@poly/hooks/useFlowState';

export function Timeline() {
  const stages = useFlowStore((s) => s.stages);
  const currentIdx = useFlowStore((s) => s.currentIdx);
  const jump = useFlowStore((s) => s.jump);

  return (
    <div className="hud-left">
      <ul className="step-list">
        {stages.map((stage, i) => {
          const cls = [
            i === currentIdx ? 'active' : '',
            i < currentIdx ? 'done' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const label = stage.type === 'gate' ? `${stage.id} 🚪` : stage.id;
          return (
            <li key={stage.id} className={cls} onClick={() => jump(i)}>
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              <span className="ind" />
              <span>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Legend() {
  const items: Array<{ color: string; label: string }> = [
    { color: '#3a5fa5', label: 'Engineer（実装・修復）' },
    { color: '#b8302e', label: "Devil's Advocate" },
    { color: '#f5c84f', label: 'Aggregator（集約ボット）' },
    { color: '#3d4655', label: 'PM（AI のアシスト）' },
    { color: '#7c5a35', label: '承認ゲート（扉）' },
    { color: '#6b3fa0', label: 'Code Reviewer / 計画者' },
    { color: '#e07a2a', label: 'Critical（小型批評家）' },
  ];
  return (
    <div className="hud-right">
      <h3>キャラ凡例</h3>
      {items.map((it) => (
        <div className="legend-row" key={it.label}>
          <span className="swatch" style={{ background: it.color }} />
          {it.label}
        </div>
      ))}
      <div className="tip">
        オーブの色 = 出力した役割。左の timeline をクリックでジャンプ。
      </div>
    </div>
  );
}
