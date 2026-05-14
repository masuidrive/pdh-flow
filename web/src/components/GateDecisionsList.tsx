import { Fragment, useState } from "react";
import type { GateConcernTriageEntry, GateDecisionEntry, RunSummary } from "../types/api";
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
                const hasDetail = !!(
                  g.comment ||
                  (g.concern_triage && g.concern_triage.length > 0) ||
                  (g.deferral_approvals && g.deferral_approvals.length > 0)
                );
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
  const hasTriage = !!(g.concern_triage && g.concern_triage.length > 0);
  const hasDeferral = !!(g.deferral_approvals && g.deferral_approvals.length > 0);
  return (
    <div className="text-xs space-y-3 py-1">
      {g.comment ? (
        <div>
          <div className="opacity-60 mb-1">comment</div>
          <div className="whitespace-pre-wrap break-words">{g.comment}</div>
        </div>
      ) : null}
      {hasTriage ? (
        <div>
          <div className="opacity-60 mb-1">
            concern triage ({g.concern_triage!.length})
          </div>
          <ul className="space-y-2">
            {g.concern_triage!.map((t, idx) => (
              <li
                key={idx}
                className="rounded border border-base-300 bg-base-100 p-2 space-y-1"
              >
                <div className="flex items-start gap-2 flex-wrap">
                  <span
                    className={`badge badge-xs whitespace-nowrap ${triageBadgeClass(
                      t.action,
                    )}`}
                  >
                    {triageLabel(t.action)}
                  </span>
                  <span className="flex-1 min-w-0 break-words">{t.concern}</span>
                </div>
                <div className="opacity-70 break-words">{t.rationale}</div>
                {t.follow_up_ticket ? (
                  <div className="opacity-70">
                    follow-up:{" "}
                    <code className="text-[10px]">{t.follow_up_ticket}</code>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hasDeferral ? (
        <div>
          <div className="opacity-60 mb-1">
            deferral approvals ({g.deferral_approvals!.length})
          </div>
          <ul className="space-y-2">
            {g.deferral_approvals!.map((d, idx) => (
              <li
                key={idx}
                className="rounded border border-base-300 bg-base-100 p-2 space-y-1"
              >
                <div className="break-words">{d.ac_item}</div>
                <div className="opacity-70">
                  follow-up:{" "}
                  <code className="text-[10px]">{d.follow_up_ticket}</code>
                </div>
                <div className="opacity-70 break-words">{d.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!g.comment && !hasTriage && !hasDeferral ? (
        <div className="italic opacity-60">No additional detail recorded.</div>
      ) : null}
    </div>
  );
}

function triageLabel(a: GateConcernTriageEntry["action"]): string {
  switch (a) {
    case "fix_in_this_ticket": return "このチケットで直す";
    case "accept": return "残置";
    case "defer": return "別チケット";
    case "dismiss": return "誤検知";
  }
}

function triageBadgeClass(a: GateConcernTriageEntry["action"]): string {
  switch (a) {
    case "fix_in_this_ticket": return "badge-warning";
    case "accept": return "badge-ghost";
    case "defer": return "badge-info";
    case "dismiss": return "badge-ghost";
  }
}
