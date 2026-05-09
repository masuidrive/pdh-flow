// Build a graph view of a compiled flat-flow for the web UI.
//
// Output shape mirrors what /api/runs/<id>/graph returns. The frontend
// (web/src/components/Graph/FlowGraph.tsx) feeds this directly into
// @xyflow/react after running it through ELK for layout.
//
// Edge kinds:
//   on_done       ← provider/system/gate "approved" (the happy path)
//   on_pass       ← guardian decision: pass
//   on_repair     ← guardian decision: repair_needed → repair node
//   on_failure    ← provider/system on_failure, gate "rejected"/"cancelled"
//   on_aborted    ← guardian decision: abort, terminal-bound
//   escalate      ← guardian repair_needed.max_round_escalation OR guardian
//                   decision: escalate_human
//   loop_back     ← repair node's on_done points back to its origin macro's
//                   parent (review_loop fan-back)
//
// Nodes carry their flat-node-type (provider, guardian, gate, system,
// parallel_group, terminal) plus a small meta blob the frontend uses for
// labels (role, provider, action, outcome). Parallel_group children carry
// `group: <parentId>` so the layout engine can render them inside a
// compound subgraph; the parent's `members[]` order also drives the
// fanout edges from the group.

import type {
  CompiledFlatFlow,
  FlowYAML,
  GateStepNode,
  GuardianStepNode,
  ParallelGroup,
  ProviderStepNode,
  SystemStepNode,
  TerminalNode,
  Transition,
} from "../types/index.ts";
import { expandFlow } from "./expand-macro.ts";
import { loadFlow } from "./load-flow.ts";

export type FlatNodeKind =
  | "provider"
  | "guardian"
  | "gate"
  | "system"
  | "parallel_group"
  | "terminal";

export type FlatEdgeKind =
  | "on_done"
  | "on_pass"
  | "on_repair"
  | "on_failure"
  | "on_aborted"
  | "escalate"
  | "loop_back";

export interface GraphNode {
  id: string;
  kind: FlatNodeKind;
  label: string;
  /** When the node belongs to a parallel_group (i.e. macro_origins maps
   *  it to that group), this is the group's id. The frontend uses it to
   *  render the node inside a compound subgraph. */
  group?: string;
  meta?: Record<string, string | undefined>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: FlatEdgeKind;
  label?: string;
}

export interface BuildGraphOptions {
  /** pdh-flow repo root (where flows/ lives). */
  repoPath: string;
  /** Flow id (e.g. "pdh-c-v2", "pdh-turn-smoke"). */
  flowId: string;
  /** Variant ("full" / "light" / etc.). Used to resolve variant-keyed
   *  Transitions to a single edge target. */
  variant: string;
}

export interface BuildGraphResult {
  flow: string;
  variant: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraph(opts: BuildGraphOptions): BuildGraphResult {
  const flowYaml: FlowYAML = loadFlow({ repoPath: opts.repoPath, flowId: opts.flowId });
  const flat: CompiledFlatFlow = expandFlow(flowYaml);
  return graphFromFlat(flat, opts.variant);
}

export function graphFromFlat(flat: CompiledFlatFlow, variant: string): BuildGraphResult {
  const macroOrigins = flat.macro_origins ?? {};
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let edgeSeq = 0;
  const addEdge = (from: string, to: string, kind: FlatEdgeKind, label?: string) => {
    edges.push({ id: `e${edgeSeq++}_${from}_${to}_${kind}`, from, to, kind, ...(label ? { label } : {}) });
  };

  // Authoritative group membership: walk parallel_group nodes once and
  // map each member's id back to its group. macro_origins is too coarse
  // — it labels aggregate/repair as having the same origin as members.
  const memberOfGroup = new Map<string, string>();
  for (const [id, node] of Object.entries(flat.nodes)) {
    if ((node as { type?: string }).type === "parallel_group") {
      const g = node as ParallelGroup;
      for (const m of g.members) memberOfGroup.set(m, id);
    }
  }

  for (const [id, node] of Object.entries(flat.nodes)) {
    const origin = macroOrigins[id];
    const groupOf = memberOfGroup.get(id);

    switch (node.type) {
      case "provider_step": {
        const p = node as ProviderStepNode;
        nodes.push({
          id,
          kind: "provider",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: {
            role: p.role,
            provider: p.provider,
            prompt_intent: typeof p.prompt?.intent === "string" ? p.prompt.intent : undefined,
          },
        });
        // Members of a parallel_group MUST NOT carry on_done; the group's
        // on_all_done fires for them. Skip emitting on_done if this node
        // has a group AND lacks on_done — that's the parallel_group case.
        if (p.on_done) {
          const tgt = resolveTransition(p.on_done, variant);
          if (tgt) {
            // Detect loop_back: repair node whose on_done equals its macro
            // origin (the parent parallel_group).
            const kind: FlatEdgeKind = origin && tgt === origin ? "loop_back" : "on_done";
            addEdge(id, tgt, kind);
          }
        }
        if (p.on_failure) {
          const tgt = resolveTransition(p.on_failure, variant);
          if (tgt) addEdge(id, tgt, "on_failure");
        }
        break;
      }
      case "guardian_step": {
        const g = node as GuardianStepNode;
        nodes.push({
          id,
          kind: "guardian",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: {
            role: g.role,
            provider: g.provider,
          },
        });
        const passTgt = resolveTransition(g.outputs.pass, variant);
        if (passTgt) addEdge(id, passTgt, "on_pass");
        if (g.outputs.repair_needed) {
          addEdge(id, g.outputs.repair_needed.next, "on_repair");
          if (g.outputs.repair_needed.max_round_escalation) {
            addEdge(id, g.outputs.repair_needed.max_round_escalation, "escalate", "max_rounds");
          }
        }
        if (g.outputs.abort) {
          const tgt = resolveTransition(g.outputs.abort, variant);
          if (tgt) addEdge(id, tgt, "on_aborted");
        }
        if (g.outputs.escalate_human) {
          const tgt = resolveTransition(g.outputs.escalate_human, variant);
          if (tgt) addEdge(id, tgt, "escalate");
        }
        break;
      }
      case "gate_step": {
        const ga = node as GateStepNode;
        nodes.push({
          id,
          kind: "gate",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: { approver_role: ga.approver_role },
        });
        if (ga.outputs.approved) {
          const tgt = resolveTransition(ga.outputs.approved, variant);
          if (tgt) addEdge(id, tgt, "on_done", "approved");
        }
        if (ga.outputs.rejected) {
          const tgt = resolveTransition(ga.outputs.rejected, variant);
          if (tgt) addEdge(id, tgt, "on_failure", "rejected");
        }
        if (ga.outputs.cancelled) {
          const tgt = resolveTransition(ga.outputs.cancelled, variant);
          if (tgt) addEdge(id, tgt, "on_aborted", "cancelled");
        }
        break;
      }
      case "system_step": {
        const s = node as SystemStepNode;
        nodes.push({
          id,
          kind: "system",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: { action: s.action },
        });
        const onDone = resolveTransition(s.on_done, variant);
        if (onDone) addEdge(id, onDone, "on_done");
        if (s.on_failure) {
          const tgt = resolveTransition(s.on_failure, variant);
          if (tgt) addEdge(id, tgt, "on_failure");
        }
        break;
      }
      case "parallel_group": {
        const g = node as ParallelGroup;
        nodes.push({
          id,
          kind: "parallel_group",
          label: g.label ?? idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: { members: String(g.members.length) },
        });
        // Members are rendered as separate nodes (their entries in the
        // loop above emit them with `group: id`). The group itself emits:
        //   - one fanout edge to each member (on_done semantically — the
        //     group "starts" each member),
        //   - one on_all_done edge to the group's terminal target.
        for (const member of g.members) {
          addEdge(id, member, "on_done");
        }
        const tgt = resolveTransition(g.on_all_done, variant);
        if (tgt) addEdge(id, tgt, "on_pass", "all done");
        break;
      }
      case "terminal": {
        const t = node as TerminalNode;
        nodes.push({
          id,
          kind: "terminal",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: { outcome: t.outcome, reason: t.reason },
        });
        break;
      }
      default: {
        // Unknown node type — render as system with the type as action.
        const t = node as { type?: string };
        nodes.push({
          id,
          kind: "system",
          label: idToLabel(id),
          ...(groupOf ? { group: groupOf } : {}),
          meta: { action: t.type ?? "unknown" },
        });
      }
    }
  }

  return {
    flow: flat.flow,
    variant,
    nodes,
    edges,
  };
}

function resolveTransition(t: Transition, variant: string): string | null {
  if (!t) return null;
  if (typeof t === "string") return t;
  // Variant-keyed map.
  const m = t as Record<string, string>;
  return m[variant] ?? m.full ?? Object.values(m)[0] ?? null;
}

function idToLabel(id: string): string {
  const tail = id.split(".").pop() ?? id;
  return tail.replace(/_/g, " ");
}
