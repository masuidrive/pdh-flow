import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRunGraph } from "../../hooks/useRunSummary";
import { layoutGraph } from "./layout";
import { NODE_TYPES, type FlowNodeData } from "./nodeTypes";
import { Timeline } from "./Timeline";
import type { TransitionEntry } from "../../types/api";

export function FlowGraph({ runId, currentState }: { runId: string; currentState: string | null }) {
  void currentState;
  const q = useRunGraph(runId);

  if (q.isLoading) return <div className="loading loading-spinner" aria-label="loading graph" />;
  if (q.error)
    return (
      <div className="alert alert-error">
        <span className="font-mono text-xs">{String((q.error as Error).message ?? q.error)}</span>
      </div>
    );
  const g = q.data;
  if (!g) return <p className="text-sm opacity-70">no graph</p>;

  return (
    <ReactFlowProvider>
      <FlowGraphInner
        nodes={g.nodes}
        edges={g.edges}
        currentNode={g.current_node ?? null}
        visitedIds={g.visited_node_ids}
        decisions={g.judgement_decisions}
        transitions={g.transitions ?? []}
        judgements={g.judgements ?? []}
        gateDecisions={g.gate_decisions ?? []}
      />
    </ReactFlowProvider>
  );
}

function FlowGraphInner({
  nodes: graphNodes,
  edges: graphEdges,
  currentNode,
  visitedIds,
  decisions,
  transitions,
  judgements,
  gateDecisions,
}: {
  nodes: import("../../types/api").GraphNode[];
  edges: import("../../types/api").GraphEdge[];
  currentNode: string | null;
  visitedIds: string[];
  decisions: Record<string, string>;
  transitions: TransitionEntry[];
  judgements: import("../../types/api").JudgementEntry[];
  gateDecisions: import("../../types/api").GateDecisionEntry[];
}) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const rf = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    layoutGraph(graphNodes, graphEdges)
      .then((res) => {
        if (!cancelled) {
          setLayout(res);
          requestAnimationFrame(() => {
            try {
              rf.fitView({ padding: 0.15, duration: 0 });
            } catch {
              /* ignore */
            }
          });
        }
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[FlowGraph] layout failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [graphNodes, graphEdges, rf]);

  // Visit order: first-time-seen index per node id (1-based).
  // When a transition lands on a parallel_group, all its members are
  // implicitly active at the same step — propagate the same number to
  // every member so the reviewer boxes get numbered too.
  const visitOrder = useMemo(() => {
    const m = new Map<string, number>();
    const groupMembers = new Map<string, string[]>();
    for (const n of graphNodes) {
      if (n.group) {
        const list = groupMembers.get(n.group) ?? [];
        list.push(n.id);
        groupMembers.set(n.group, list);
      }
    }
    let i = 1;
    for (const t of transitions) {
      if (m.has(t.to)) continue;
      m.set(t.to, i);
      const members = groupMembers.get(t.to);
      if (members) {
        for (const mid of members) {
          if (!m.has(mid)) m.set(mid, i);
        }
      }
      i++;
    }
    return m;
  }, [transitions, graphNodes]);

  // Traversed edges: every (from→to) pair the engine actually took.
  const traversed = useMemo(() => {
    const s = new Set<string>();
    for (const t of transitions) {
      if (t.from) s.add(`${t.from}→${t.to}`);
    }
    return s;
  }, [transitions]);

  // Inject current/visited/decision/visitOrder flags into node data.
  const nodes = useMemo<Node[]>(() => {
    if (!layout) return [];
    const visitedSet = new Set(visitedIds);
    return layout.nodes.map((n) => {
      const data = n.data as FlowNodeData;
      const next: FlowNodeData = {
        ...data,
        current: n.id === currentNode,
        visited: visitedSet.has(n.id),
        decision: decisions[n.id],
        visitOrder: visitOrder.get(n.id),
      };
      return { ...n, data: next };
    });
  }, [layout, currentNode, visitedIds, decisions, visitOrder]);

  // Cached graph bounding box (flow units). Used by the snap-back handler
  // to detect "user has panned/zoomed so that NO node is on screen" and
  // pull the viewport back. We can't rely on `translateExtent` alone —
  // at low `minZoom` the visible flow region exceeds any reasonable extent
  // and panning effectively becomes unlimited.
  const graphBounds = useMemo<{ x0: number; y0: number; x1: number; y1: number } | null>(() => {
    if (!layout || layout.nodes.length === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of layout.nodes) {
      const w = Number(n.style?.width ?? 200);
      const h = Number(n.style?.height ?? 64);
      if (n.position.x < x0) x0 = n.position.x;
      if (n.position.y < y0) y0 = n.position.y;
      if (n.position.x + w > x1) x1 = n.position.x + w;
      if (n.position.y + h > y1) y1 = n.position.y + h;
    }
    return { x0, y0, x1, y1 };
  }, [layout]);

  const containerRef = useRef<HTMLDivElement>(null);
  const handleMoveEnd = useCallback(() => {
    if (!containerRef.current || !graphBounds) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const tl = rf.screenToFlowPosition({ x: rect.left, y: rect.top });
    const br = rf.screenToFlowPosition({ x: rect.right, y: rect.bottom });
    // True if the visible viewport rect overlaps the graph bounding box.
    const overlaps =
      tl.x < graphBounds.x1 &&
      br.x > graphBounds.x0 &&
      tl.y < graphBounds.y1 &&
      br.y > graphBounds.y0;
    if (!overlaps) {
      try {
        rf.fitView({ padding: 0.15, duration: 300 });
      } catch {
        /* ignore */
      }
    }
  }, [rf, graphBounds]);

  // Decorate traversed edges with a thicker green stroke so the actual
  // path the engine took stands out from the unused alternative branches.
  const edges = useMemo<Edge[]>(() => {
    if (!layout) return [];
    return layout.edges.map((e) => {
      const wasTaken = traversed.has(`${e.source}→${e.target}`);
      if (!wasTaken) return e;
      return {
        ...e,
        style: { ...e.style, stroke: "#16a34a", strokeWidth: 3, opacity: 1 },
        zIndex: 10,
      };
    });
  }, [layout, traversed]);

  if (!layout) {
    return <div className="loading loading-spinner" aria-label="laying out graph" />;
  }
  return (
    // Layout: phones stack Timeline-on-top / Flow-below; tablets+ swap
    // to Flow-left / Timeline-right via md:order. Heights scale with
    // viewport so neither panel collapses to zero.
    <div
      className="flex flex-col md:flex-row gap-3"
      style={{ height: "calc(100vh - 180px)" }}
    >
      <aside className="h-[40vh] md:h-full md:w-80 md:order-2 md:shrink-0">
        <Timeline
          transitions={transitions}
          currentNode={currentNode}
          graphNodes={graphNodes}
          judgements={judgements}
          gateDecisions={gateDecisions}
        />
      </aside>
      <div
        ref={containerRef}
        className="card bg-base-100 shadow flex-1 min-w-0 min-h-0 md:order-1"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.1}
          maxZoom={2}
          onMoveEnd={handleMoveEnd}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
