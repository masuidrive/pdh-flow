import { useState } from "react";
import type {
  GateDecisionEntry,
  GraphNode,
  JudgementEntry,
  TransitionEntry,
} from "../../types/api";

/** Chronological list of state transitions. Renders in a side panel
 *  next to the FlowGraph. Each entry shows time-of-day, the from→to
 *  hop, and the XState event that triggered it. When the destination
 *  is a parallel_group, its members (independent provider sub-agents
 *  that fork at this step) are listed indented under the entry.
 *  Clicking an entry expands an inline detail panel with what we know
 *  about that node — role/provider, judgement reasoning, gate decision
 *  metadata, terminal outcome, etc. */
export function Timeline({
  transitions,
  currentNode,
  graphNodes,
  judgements,
  gateDecisions,
}: {
  transitions: TransitionEntry[];
  currentNode: string | null;
  graphNodes: GraphNode[];
  judgements: JudgementEntry[];
  gateDecisions: GateDecisionEntry[];
}) {
  const [expanded, setExpanded] = useState<number | null>(null);

  const membersByGroup = new Map<string, GraphNode[]>();
  for (const n of graphNodes) {
    if (n.group) {
      const list = membersByGroup.get(n.group) ?? [];
      list.push(n);
      membersByGroup.set(n.group, list);
    }
  }
  const nodeById = new Map<string, GraphNode>(graphNodes.map((n) => [n.id, n]));
  // Latest judgement / gate decision for a given node id.
  const latestJudgement = (nodeId: string): JudgementEntry | undefined => {
    let best: JudgementEntry | undefined;
    for (const j of judgements) {
      if (j.node_id !== nodeId) continue;
      if (!best || j.round >= best.round) best = j;
    }
    return best;
  };
  const latestGate = (nodeId: string): GateDecisionEntry | undefined => {
    let best: GateDecisionEntry | undefined;
    for (const g of gateDecisions) {
      if (g.node_id !== nodeId) continue;
      if (!best || g.decided_at >= best.decided_at) best = g;
    }
    return best;
  };

  if (transitions.length === 0) {
    return (
      <div className="card bg-base-100 shadow h-full">
        <div className="card-body p-3">
          <h3 className="text-sm font-semibold">Timeline</h3>
          <p className="text-xs opacity-60">
            No transitions logged yet. Run the engine to populate this list.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow h-full overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-base-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Timeline</h3>
        <span className="badge badge-ghost badge-sm">{transitions.length}</span>
      </div>
      <ol className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
        {transitions.map((t, i) => {
          const isCurrent = t.to === currentNode && i === transitions.length - 1;
          const isOpen = expanded === i;
          const members = membersByGroup.get(t.to) ?? [];
          const next = transitions[i + 1];
          const elapsedMs = next ? Date.parse(next.ts) - Date.parse(t.ts) : null;
          const toNode = nodeById.get(t.to);
          const provider = toNode?.meta?.provider;
          return (
            <li
              key={`${t.ts}-${i}`}
              className={`flex flex-col gap-0.5 px-2 py-1 rounded cursor-pointer ${
                isCurrent
                  ? "bg-primary/10 border border-primary/40"
                  : isOpen
                    ? "bg-base-200 border border-base-300"
                    : "hover:bg-base-200 border border-transparent"
              }`}
              onClick={() => setExpanded(isOpen ? null : i)}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono opacity-60 shrink-0">{i + 1}.</span>
                <span className="font-mono font-medium truncate">{t.to}</span>
                {provider ? (
                  <span className="badge badge-ghost badge-xs shrink-0">{provider}</span>
                ) : null}
                {isCurrent ? <span className="badge badge-primary badge-xs">now</span> : null}
                <span className="ml-auto opacity-50 shrink-0">
                  {isOpen ? "▾" : "▸"}
                </span>
              </div>
              {t.from ? (
                <div className="pl-5 opacity-60 truncate">
                  ← from <span className="font-mono">{t.from}</span>
                </div>
              ) : (
                <div className="pl-5 opacity-60">← start</div>
              )}
              {t.summary ? (
                <div
                  className="pl-5 italic opacity-80 line-clamp-2"
                  title={t.summary}
                >
                  {t.summary}
                </div>
              ) : null}
              <div className="pl-5 flex items-center gap-1 opacity-60">
                <span className="font-mono">{formatTime(t.ts)}</span>
                {elapsedMs !== null ? (
                  <span className="font-mono">· lasted {formatDuration(elapsedMs)}</span>
                ) : null}
                {t.event ? <span className="font-mono truncate">· {t.event}</span> : null}
              </div>
              {members.length > 0 ? (
                <ul className="pl-5 mt-1 space-y-0.5 border-l border-indigo-300/60">
                  {members.map((m) => (
                    <li
                      key={m.id}
                      className="pl-2 flex items-center gap-1.5 min-w-0"
                    >
                      <span className="opacity-50 shrink-0">↳</span>
                      <span className="font-mono truncate">
                        {memberShortLabel(m, t.to)}
                      </span>
                      {m.meta?.provider ? (
                        <span className="badge badge-ghost badge-xs shrink-0">
                          {m.meta.provider}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {isOpen ? (
                <Details
                  node={nodeById.get(t.to)}
                  judgement={latestJudgement(t.to)}
                  gate={latestGate(t.to)}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Details({
  node,
  judgement,
  gate,
}: {
  node: GraphNode | undefined;
  judgement?: JudgementEntry;
  gate?: GateDecisionEntry;
}) {
  if (!node) {
    return <div className="pl-5 mt-2 text-[11px] opacity-60">No metadata.</div>;
  }
  return (
    <div className="pl-5 mt-2 space-y-1.5 text-[11px] border-t border-base-300 pt-1.5">
      <div className="flex items-center gap-1">
        <span className="badge badge-outline badge-xs">{node.kind}</span>
        {node.meta?.role ? (
          <span className="opacity-70">role: <span className="font-mono">{node.meta.role}</span></span>
        ) : null}
        {node.meta?.provider ? (
          <span className="badge badge-ghost badge-xs">{node.meta.provider}</span>
        ) : null}
      </div>
      {node.kind === "provider" && node.meta?.prompt_intent ? (
        <div>
          <div className="opacity-60">intent</div>
          <div className="pl-2 italic whitespace-pre-wrap">{node.meta.prompt_intent}</div>
        </div>
      ) : null}
      {node.kind === "guardian" && judgement ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <span className="opacity-60">decision</span>
            <span className={`badge badge-xs ${decisionClass(judgement.decision)}`}>
              {judgement.decision}
            </span>
            <span className="opacity-60">round {judgement.round}</span>
            {(judgement.blocking_findings_count ?? 0) > 0 ? (
              <span className="badge badge-error badge-xs">
                {judgement.blocking_findings_count} findings
              </span>
            ) : null}
          </div>
          {judgement.reasoning ? (
            <div>
              <div className="opacity-60">reasoning</div>
              <div className="pl-2 whitespace-pre-wrap line-clamp-6">{judgement.reasoning}</div>
            </div>
          ) : null}
        </div>
      ) : null}
      {node.kind === "gate" ? (
        gate ? (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="opacity-60">decision</span>
              <span className={`badge badge-xs ${decisionClass(gate.decision)}`}>{gate.decision}</span>
            </div>
            {gate.comment ? (
              <div>
                <div className="opacity-60">comment</div>
                <div className="pl-2 italic whitespace-pre-wrap">{gate.comment}</div>
              </div>
            ) : null}
            <div className="opacity-60 flex gap-2">
              <span>{formatTime(gate.decided_at)}</span>
            </div>
          </div>
        ) : (
          <div className="opacity-60">awaiting human approval</div>
        )
      ) : null}
      {node.kind === "system" ? (
        <div className="flex items-center gap-1">
          <span className="opacity-60">action</span>
          <span className="font-mono">{node.meta?.action ?? "?"}</span>
        </div>
      ) : null}
      {node.kind === "terminal" ? (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1">
            <span className="opacity-60">outcome</span>
            <span className={`badge badge-xs ${outcomeClass(node.meta?.outcome)}`}>
              {node.meta?.outcome ?? "?"}
            </span>
          </div>
          {node.meta?.reason ? (
            <div>
              <div className="opacity-60">reason</div>
              <div className="pl-2 italic whitespace-pre-wrap">{node.meta.reason}</div>
            </div>
          ) : null}
        </div>
      ) : null}
      {node.kind === "parallel_group" ? (
        <div className="opacity-70">
          parallel fork — {node.meta?.members ?? "?"} concurrent provider invocations
        </div>
      ) : null}
    </div>
  );
}

function decisionClass(d: string): string {
  return (
    {
      pass: "badge-success",
      approved: "badge-success",
      repair_needed: "badge-warning",
      rejected: "badge-error",
      cancelled: "badge-ghost",
      abort: "badge-error",
      escalate_human: "badge-error",
    }[d] ?? "badge-info"
  );
}

function outcomeClass(o: string | undefined): string {
  if (o === "success") return "badge-success";
  if (o === "needs_human" || o === "aborted") return "badge-error";
  return "badge-info";
}

function memberShortLabel(m: GraphNode, groupId: string): string {
  if (m.id.startsWith(`${groupId}.`)) return m.id.slice(groupId.length + 1);
  return m.id;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r > 0 ? `${r}s` : ""}`;
}
