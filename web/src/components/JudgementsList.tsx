import type { RunSummary } from "../types/api";
import { DecisionBadge } from "./Badges";

export function JudgementsList({ s }: { s: RunSummary }) {
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">Judgements ({s.judgements.length})</h2>
        {s.judgements.length === 0 ? (
          <p className="text-sm opacity-70">No frozen judgements yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Round</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {s.judgements.map((j, i) => (
                  <tr key={`${j.node_id}-${j.round}-${i}`}>
                    <td className="font-mono text-xs">{j.node_id}</td>
                    <td>{j.round}</td>
                    <td>
                      <DecisionBadge decision={j.decision} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
