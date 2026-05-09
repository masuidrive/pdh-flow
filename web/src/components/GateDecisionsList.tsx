import { Fragment, useState } from "react";
import type { GateDecisionEntry, RunSummary } from "../types/api";
import { DecisionBadge } from "./Badges";

export function GateDecisionsList({ s }: { s: RunSummary }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="card bg-base-100 shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">Gate decisions ({s.gate_decisions.length})</h2>
        {s.gate_decisions.length === 0 ? (
          <p className="text-sm opacity-70">No gate decisions yet.</p>
        ) : (
          <table className="table table-xs">
            <thead>
              <tr>
                <th className="w-4"></th>
                <th>Node</th>
                <th>Decision</th>
                <th>Round</th>
                <th>Decided at</th>
              </tr>
            </thead>
            <tbody>
              {s.gate_decisions.map((g, i) => {
                const key = `${g.node_id}-${i}`;
                const isOpen = !!open[key];
                const hasDetail = !!(g.comment || g.approver || g.via);
                return (
                  <Fragment key={key}>
                    <tr
                      className={hasDetail ? "cursor-pointer hover" : ""}
                      onClick={() =>
                        hasDetail &&
                        setOpen((m) => ({ ...m, [key]: !m[key] }))
                      }
                    >
                      <td className="opacity-50">
                        {hasDetail ? (isOpen ? "▾" : "▸") : ""}
                      </td>
                      <td className="font-mono text-xs">{g.node_id}</td>
                      <td>
                        <DecisionBadge decision={g.decision} />
                      </td>
                      <td className="opacity-70 text-xs">
                        {typeof g.round === "number" ? g.round : ""}
                      </td>
                      <td className="opacity-60 text-xs">{g.decided_at}</td>
                    </tr>
                    {isOpen ? (
                      <tr className="bg-base-200">
                        <td></td>
                        <td colSpan={4}>
                          <GateDecisionDetail g={g} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function GateDecisionDetail({ g }: { g: GateDecisionEntry }) {
  return (
    <dl className="text-xs grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 py-1">
      {g.approver ? (
        <>
          <dt className="opacity-60">approver</dt>
          <dd className="font-mono">{g.approver}</dd>
        </>
      ) : null}
      {g.via ? (
        <>
          <dt className="opacity-60">via</dt>
          <dd className="font-mono">{g.via}</dd>
        </>
      ) : null}
      {g.comment ? (
        <>
          <dt className="opacity-60 self-start">comment</dt>
          <dd className="whitespace-pre-wrap break-words">{g.comment}</dd>
        </>
      ) : null}
      {!g.approver && !g.via && !g.comment ? (
        <dd className="col-span-2 italic opacity-60">No additional detail recorded.</dd>
      ) : null}
    </dl>
  );
}
