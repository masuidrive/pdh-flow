import { useEffect, useMemo, useState } from "react";
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

export function FlowGraph({ runId, currentState }: { runId: string; currentState: string | null }) {
  void currentState; // currentState is read from the graph payload; param kept for parity
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
}: {
  nodes: import("../../types/api").GraphNode[];
  edges: import("../../types/api").GraphEdge[];
  currentNode: string | null;
  visitedIds: string[];
  decisions: Record<string, string>;
}) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const rf = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    layoutGraph(graphNodes, graphEdges)
      .then((res) => {
        if (!cancelled) {
          setLayout(res);
          // ELK is async; the initial `fitView` prop only ran on the
          // empty placeholder. Re-fit once we have positions.
          requestAnimationFrame(() => {
            try {
              rf.fitView({ padding: 0.15, duration: 0 });
            } catch {
              /* ignore — React Flow not ready yet */
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

  // Inject current/visited/decision flags into node data without re-laying-out.
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
      };
      return { ...n, data: next };
    });
  }, [layout, currentNode, visitedIds, decisions]);

  if (!layout) {
    return <div className="loading loading-spinner" aria-label="laying out graph" />;
  }
  return (
    <div className="card bg-base-100 shadow" style={{ height: "calc(100vh - 180px)" }}>
      <ReactFlow
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
