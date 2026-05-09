import { Fragment, useState } from "react";
import type { RunSummary } from "../types/api";
import { DecisionBadge } from "./Badges";

export function JudgementsList({ s }: { s: RunSummary }) {
  const [expanded, setExpanded] = useState<number | null>(null);
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
                  <th className="w-4"></th>
                  <th>Node</th>
                  <th>Round</th>
                  <th>Decision</th>
                  <th>Findings</th>
                </tr>
              </thead>
              <tbody>
                {s.judgements.map((j, i) => {
                  const isOpen = expanded === i;
                  const hasDetail = !!(j.reasoning || (j.blocking_findings_count ?? 0) > 0);
                  return (
                    <Fragment key={`${j.node_id}-${j.round}-${i}`}>
                      <tr
                        className={hasDetail ? "cursor-pointer hover" : ""}
                        onClick={() => hasDetail && setExpanded(isOpen ? null : i)}
                      >
                        <td className="opacity-50">{hasDetail ? (isOpen ? "▾" : "▸") : ""}</td>
                        <td className="font-mono text-xs">{j.node_id}</td>
                        <td>{j.round}</td>
                        <td>
                          <DecisionBadge decision={j.decision} />
                        </td>
                        <td>
                          {(j.blocking_findings_count ?? 0) > 0 ? (
                            <span className="badge badge-error badge-sm">
                              {j.blocking_findings_count}
                            </span>
                          ) : (
                            <span className="opacity-40">—</span>
                          )}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="bg-base-200">
                          <td></td>
                          <td colSpan={4} className="text-xs">
                            {j.reasoning ? (
                              <div className="whitespace-pre-wrap py-1">{j.reasoning}</div>
                            ) : (
                              <div className="opacity-60 py-1">No reasoning recorded.</div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
