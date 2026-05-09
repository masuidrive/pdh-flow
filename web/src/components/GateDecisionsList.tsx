import type { RunSummary } from "../types/api";
import { DecisionBadge } from "./Badges";

export function GateDecisionsList({ s }: { s: RunSummary }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">Gate decisions ({s.gate_decisions.length})</h2>
        {s.gate_decisions.length === 0 ? (
          <p className="text-sm opacity-70">No gate decisions yet.</p>
        ) : (
          <ul className="text-sm space-y-1">
            {s.gate_decisions.map((g, i) => (
              <li key={`${g.node_id}-${i}`} className="flex gap-3 items-center">
                <span className="font-mono text-xs">{g.node_id}</span>
                <DecisionBadge decision={g.decision} />
                <span className="opacity-60 text-xs">{g.decided_at}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
