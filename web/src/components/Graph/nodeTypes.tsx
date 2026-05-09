import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNode } from "../../types/api";

const HIDDEN_HANDLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  border: 0,
  background: "transparent",
};

function SideHandles() {
  // Hidden handles on the left and right of each node so back-edges can
  // be routed via curl-arounds (sourceHandle="r", targetHandle="l")
  // instead of forcing every edge through the top/bottom dock points.
  return (
    <>
      <Handle id="r" type="source" position={Position.Right} style={HIDDEN_HANDLE} />
      <Handle id="l" type="target" position={Position.Left} style={HIDDEN_HANDLE} />
    </>
  );
}

export interface FlowNodeData {
  graphNode: GraphNode;
  current: boolean;
  visited: boolean;
  decision?: string;
  /** First-visit step number from transitions.jsonl (1-based). When the
   *  engine entered this node multiple times across rounds, only the
   *  first index is shown — repair loop visits show as a re-entry edge
   *  highlight rather than a renumber. */
  visitOrder?: number;
  [key: string]: unknown;
}

function VisitBadge({ n }: { n?: number }) {
  if (n === undefined) return null;
  return (
    <span className="absolute -top-2 -right-2 badge badge-primary badge-xs font-semibold">{n}</span>
  );
}

function NodeShell({
  children,
  variant,
  current,
  visited,
}: {
  children: React.ReactNode;
  variant: "blue" | "yellow" | "orange" | "gray" | "container" | "green" | "red";
  current: boolean;
  visited: boolean;
}) {
  const palette: Record<string, string> = {
    blue: "bg-info/20 border-info text-info-content",
    yellow: "bg-warning/20 border-warning text-warning-content",
    orange: "bg-orange-200/40 border-orange-400 text-orange-900",
    gray: "bg-base-200 border-base-300 text-base-content",
    container: "bg-transparent border-dashed border-indigo-300 text-base-content",
    green: "bg-success/20 border-success text-success-content",
    red: "bg-error/20 border-error text-error-content",
  };
  const opacity = !current && !visited ? "opacity-50" : "";
  const ring = current ? "ring-2 ring-offset-1 ring-primary animate-pulse" : "";
  return (
    <div
      className={`rounded-lg border ${palette[variant]} ${opacity} ${ring} px-3 py-2 text-xs w-full h-full flex flex-col`}
    >
      {children}
    </div>
  );
}

function pickVariant(kind: GraphNode["kind"], outcome?: string) {
  switch (kind) {
    case "provider":
      return "blue" as const;
    case "guardian":
      return "yellow" as const;
    case "gate":
      return "orange" as const;
    case "system":
      return "gray" as const;
    case "parallel_group":
      return "container" as const;
    case "terminal":
      return outcome === "success" ? ("green" as const) : ("red" as const);
  }
}

export function ProviderNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeShell variant={pickVariant("provider")} current={d.current} visited={d.visited}>
        <div className="font-semibold truncate">{n.label}</div>
        <div className="text-[10px] opacity-70 truncate">
          {n.meta?.role ?? ""} · {n.meta?.provider ?? ""}
        </div>
      </NodeShell>
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <VisitBadge n={d.visitOrder} />
    </>
  );
}

export function GuardianNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeShell variant={pickVariant("guardian")} current={d.current} visited={d.visited}>
        <div className="font-semibold truncate">{n.label}</div>
        <div className="text-[10px] opacity-70 truncate">guardian · {n.meta?.role ?? ""}</div>
        {d.decision ? (
          <span className="badge badge-xs badge-outline mt-1 self-start">{d.decision}</span>
        ) : null}
      </NodeShell>
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <VisitBadge n={d.visitOrder} />
    </>
  );
}

export function GateNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeShell variant={pickVariant("gate")} current={d.current} visited={d.visited}>
        <div className="font-semibold truncate">{n.label}</div>
        <div className="text-[10px] opacity-70 truncate">gate · {n.meta?.approver_role ?? "human"}</div>
        {d.decision ? (
          <span className="badge badge-xs badge-outline mt-1 self-start">{d.decision}</span>
        ) : null}
      </NodeShell>
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <VisitBadge n={d.visitOrder} />
    </>
  );
}

export function SystemNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeShell variant={pickVariant("system")} current={d.current} visited={d.visited}>
        <div className="font-semibold truncate">{n.label}</div>
        <div className="text-[10px] opacity-70 truncate">{n.meta?.action ?? "system"}</div>
      </NodeShell>
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <VisitBadge n={d.visitOrder} />
    </>
  );
}

export function ParallelGroupNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  return (
    <div className="w-full h-full">
      <Handle type="target" position={Position.Top} />
      <div className="absolute -top-3 left-3 px-2 py-0.5 text-[10px] bg-indigo-200 text-indigo-900 rounded">
        {n.label} · parallel ({n.meta?.members ?? "?"})
      </div>
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <VisitBadge n={d.visitOrder} />
    </div>
  );
}

export function TerminalNode({ data }: NodeProps) {
  const d = data as FlowNodeData;
  const n = d.graphNode;
  const outcome = n.meta?.outcome ?? "?";
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <NodeShell variant={pickVariant("terminal", outcome)} current={d.current} visited={d.visited}>
        <div className="font-semibold truncate">{n.label}</div>
        <div className="text-[10px] opacity-70 truncate">terminal · {outcome}</div>
        {n.meta?.reason ? <div className="text-[10px] opacity-60 truncate">{n.meta.reason}</div> : null}
      </NodeShell>
      <VisitBadge n={d.visitOrder} />
    </>
  );
}

export const NODE_TYPES = {
  provider: ProviderNode,
  guardian: GuardianNode,
  gate: GateNode,
  system: SystemNode,
  parallel_group: ParallelGroupNode,
  terminal: TerminalNode,
};
