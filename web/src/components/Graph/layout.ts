import ELK, { type ElkExtendedEdge, type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "../../types/api";

const elk = new ELK();

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const MEMBER_WIDTH = 168;
const MEMBER_HEIGHT = 60;
const MEMBER_GAP_X = 16;
const GROUP_HEADER = 28;
const GROUP_PAD = 12;

const ELK_OPTS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "100",
  "elk.spacing.nodeNode": "80",
  "elk.spacing.edgeNode": "30",
  "elk.spacing.edgeEdge": "20",
  "elk.layered.spacing.edgeNodeBetweenLayers": "30",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.semiInteractive": "true",
  "elk.edgeRouting": "ORTHOGONAL",
};

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

/** Lay out the graph as a "skeleton" (top-level nodes only, no parallel
 *  members and no structural fanout / loop-back edges) so ELK produces a
 *  clean DAG flowing top-to-bottom. After ELK runs, parallel_group members
 *  are positioned manually as a horizontal row inside their group's
 *  bounding box. Loop-back edges still render (orange dashed) to show
 *  review-loop semantics; fanout group→member edges are dropped from
 *  rendering since the visual containment makes them redundant. */
export async function layoutGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
): Promise<LayoutResult> {
  const nodeMap = new Map(graphNodes.map((n) => [n.id, n]));
  const validEdges = graphEdges.filter(
    (e) => nodeMap.has(e.from) && nodeMap.has(e.to),
  );

  // Members of each parallel_group (in original flow order).
  const membersByGroup = new Map<string, GraphNode[]>();
  for (const n of graphNodes) {
    if (n.group) {
      const list = membersByGroup.get(n.group) ?? [];
      list.push(n);
      membersByGroup.set(n.group, list);
    }
  }

  const isFanout = (e: GraphEdge) => {
    const src = nodeMap.get(e.from);
    const dst = nodeMap.get(e.to);
    return src?.kind === "parallel_group" && dst?.group === src.id;
  };

  // ── ELK input: top-level nodes only, layout-friendly edges only.
  //    `on_done` / `on_pass` form the main spine. `on_aborted` always
  //    converges on a terminal node so it's safe forward. `on_repair`
  //    is forward only when it targets a sibling repair node inside a
  //    review_loop (e.g. `code_quality_review.aggregate → ...repair`);
  //    final_verification → implement is also `on_repair` but goes
  //    backwards, so we exclude it by requiring `.repair` suffix on
  //    the target. The remaining cycle-makers — `loop_back`,
  //    `escalate`, `on_failure` — are excluded entirely. ──────────────
  const isLayoutEdge = (e: GraphEdge): boolean => {
    if (isFanout(e)) return false;
    if (e.kind === "on_done" || e.kind === "on_pass" || e.kind === "on_aborted") return true;
    if (e.kind === "on_repair") return e.to.endsWith(".repair");
    return false;
  };
  const topLevel = graphNodes.filter((n) => !n.group);
  const skeletonEdges = validEdges.filter(isLayoutEdge);

  const groupSize = (n: GraphNode) => {
    if (n.kind !== "parallel_group") return { w: NODE_WIDTH, h: NODE_HEIGHT };
    const members = membersByGroup.get(n.id) ?? [];
    const memberRow =
      members.length === 0
        ? 0
        : members.length * MEMBER_WIDTH + (members.length - 1) * MEMBER_GAP_X;
    const w = Math.max(NODE_WIDTH, memberRow + 2 * GROUP_PAD);
    const h = GROUP_HEADER + MEMBER_HEIGHT + 2 * GROUP_PAD;
    return { w, h };
  };

  // ELK trips on dotted IDs in some paths (interprets them as a
  // hierarchy separator). Sanitize on the way in, restore on the way out.
  const enc = (id: string) => id.replaceAll(".", "__");
  const dec = (id: string) => id.replaceAll("__", ".");

  const elkRoot: ElkNode = {
    id: "root",
    layoutOptions: ELK_OPTS,
    children: topLevel.map<ElkNode>((n) => {
      const { w, h } = groupSize(n);
      return { id: enc(n.id), width: w, height: h };
    }),
    edges: skeletonEdges.map<ElkExtendedEdge>((e) => ({
      id: enc(e.id),
      sources: [enc(e.from)],
      targets: [enc(e.to)],
    })),
  };

  const laid = await elk.layout(elkRoot);

  const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const c of laid.children ?? []) {
    positions.set(dec(c.id), {
      x: c.x ?? 0,
      y: c.y ?? 0,
      w: c.width ?? NODE_WIDTH,
      h: c.height ?? NODE_HEIGHT,
    });
  }

  // ── Position members horizontally inside their group ────────────────
  for (const n of graphNodes) {
    if (n.kind !== "parallel_group") continue;
    const gp = positions.get(n.id);
    if (!gp) continue;
    const members = membersByGroup.get(n.id) ?? [];
    if (members.length === 0) continue;
    const rowWidth = members.length * MEMBER_WIDTH + (members.length - 1) * MEMBER_GAP_X;
    const startX = gp.x + (gp.w - rowWidth) / 2;
    const memberY = gp.y + GROUP_HEADER + GROUP_PAD;
    members.forEach((m, i) => {
      positions.set(m.id, {
        x: startX + i * (MEMBER_WIDTH + MEMBER_GAP_X),
        y: memberY,
        w: MEMBER_WIDTH,
        h: MEMBER_HEIGHT,
      });
    });
  }

  // ── Build react-flow nodes. Parallel groups go FIRST so they render
  //    behind their members (react-flow's node order = z-stack). ────────
  const ordered = [
    ...graphNodes.filter((n) => n.kind === "parallel_group"),
    ...graphNodes.filter((n) => n.kind !== "parallel_group"),
  ];
  const nodes: Node[] = ordered.map((n) => {
    const p = positions.get(n.id) ?? { x: 0, y: 0, w: NODE_WIDTH, h: NODE_HEIGHT };
    return {
      id: n.id,
      position: { x: p.x, y: p.y },
      data: { graphNode: n },
      type: n.kind,
      ...(n.kind === "parallel_group" ? { zIndex: -1 } : {}),
      style:
        n.kind === "parallel_group"
          ? {
              width: p.w,
              height: p.h,
              background: "rgba(99, 102, 241, 0.06)",
              border: "1px dashed rgba(99, 102, 241, 0.5)",
              borderRadius: 12,
            }
          : { width: p.w, height: p.h },
    };
  });

  // Drop fanout edges from rendering (the dashed group container conveys
  // membership). Keep loop_back so the review-loop is still legible.
  const renderEdges = validEdges.filter((e) => !isFanout(e));
  // Forward edges (the main spine) get clean orthogonal routing.
  // Back-edges (loop_back / escalate / on_failure / non-local on_repair)
  // use bezier so they curve out to the side of the main flow instead
  // of cutting across it. This dramatically reduces visual overlap on
  // pdh-c-v2 where there are 8+ back-edges all converging on earlier
  // nodes.
  const edges: Edge[] = renderEdges.map((e) => {
    const forward = isLayoutEdge(e);
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      // Route forward edges through top/bottom (default), back-edges
      // through right→left so they curl around the side of the graph.
      ...(forward ? {} : { sourceHandle: "r", targetHandle: "l" }),
      type: forward ? "smoothstep" : "default",
      animated: false,
      data: { kind: e.kind },
      style: edgeStyleFor(e.kind, forward),
      labelStyle: { fontSize: 10, fill: "#52525b" },
      labelBgStyle: { fill: "rgba(255,255,255,0.85)" },
      labelBgPadding: [4, 2] as [number, number],
    };
  });

  return { nodes, edges };
}

function edgeStyleFor(kind: GraphEdge["kind"], forward: boolean): React.CSSProperties {
  // Back-edges get a slightly lower opacity so they sit visually behind
  // the main spine rather than fighting it for attention.
  const opacity = forward ? 1 : 0.55;
  switch (kind) {
    case "on_pass":
    case "on_done":
      return { stroke: "#0284c7", strokeWidth: 2, opacity };
    case "on_repair":
    case "loop_back":
      return { stroke: "#d97706", strokeWidth: 2, strokeDasharray: "6 4", opacity };
    case "escalate":
      return { stroke: "#ea580c", strokeWidth: 2, strokeDasharray: "2 4", opacity };
    case "on_failure":
    case "on_aborted":
      return { stroke: "#dc2626", strokeWidth: 2, strokeDasharray: "2 4", opacity };
    default:
      return { stroke: "#6b7280", strokeWidth: 1.5, opacity };
  }
}
