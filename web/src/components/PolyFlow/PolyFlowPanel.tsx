// Live-engine wrapper around the standalone <PolyFlow> visualizer
// (poly-flow-react bundle, copied to ./components, ./characters, ./flow,
// ./three, ./hooks, ./config, ./types). The bundle is a pure
// yaml-driven, R3F-based renderer with a zustand store; this wrapper
// connects it to the live engine on three axes:
//
//   1. yaml source — fetched once per run from /api/runs/:runId/flow-yaml
//   2. active stage — useFlowStore.getState().jumpById(current_node) on
//      every SSE invalidate. The engine's current_node is the expanded
//      form (plan_review.devils_advocate.1, plan_review.plan_aggregator,
//      etc.) but the bundle's stage ids are macro-collapsed; we
//      normalize before calling jumpById.
//   3. fail-orb — new transitions of event=FAIL/ABORT trigger
//      useFlowStore.getState().fail(), which spawns a red rollback orb.
//
// The bundle's own debug ControlBar (next/back/fail/auto-play/speed) is
// turned OFF — the engine drives advancement, not the user.
//
// Default-export so RunPage's React.lazy() can pick it up cleanly.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchText } from "../../lib/api";
import { useRunGraph } from "../../hooks/useRunSummary";
import type { RunSummary } from "../../types/api";
import "./poly-flow.css";

// Lazy the inner bundle so the three.js + R3F + drei chunk stays out of
// non-run-page bundles. The parent (RunPage) also lazy-loads
// PolyFlowPanel itself, so on top pages neither chunk loads.
const PolyFlowInner = lazy(() =>
  import("./components/PolyFlow").then((m) => ({ default: m.PolyFlow })),
);
const useFlowStorePromise = import("./hooks/useFlowState").then(
  (m) => m.useFlowStore,
);

export interface PolyFlowPanelProps {
  runId: string;
  s: RunSummary;
}

export default function PolyFlowPanel({ runId, s }: PolyFlowPanelProps) {
  const yamlQ = useQuery<string>({
    queryKey: ["flow-yaml", runId],
    queryFn: () => fetchText(`/api/runs/${encodeURIComponent(runId)}/flow-yaml`),
    enabled: !!runId,
    staleTime: 5 * 60_000, // yaml rarely changes mid-run
  });
  const graphQ = useRunGraph(runId);
  const variant = s.variant ?? "full";

  return (
    <div className="card bg-base-100 border border-base-300 shadow-sm overflow-hidden">
      <div className="card-body p-0">
        <div
          className="relative w-full bg-base-200 overflow-hidden"
          style={{ height: "300px" }}
        >
          {yamlQ.isLoading ? (
            <div className="absolute inset-0 grid place-items-center text-xs opacity-60">
              loading flow yaml…
            </div>
          ) : yamlQ.error ? (
            <div className="absolute inset-4">
              <div className="alert alert-warning text-xs">
                flow yaml load failed:{" "}
                {String((yamlQ.error as Error).message ?? yamlQ.error)}
              </div>
            </div>
          ) : yamlQ.data ? (
            <Suspense
              fallback={
                <div className="absolute inset-0 grid place-items-center text-xs opacity-60">
                  loading 3D scene…
                </div>
              }
            >
              <PolyFlowInner
                yamlText={yamlQ.data}
                variant={variant}
                profile="default"
                debugControls={false}
              />
              <LiveBridge
                currentNode={graphQ.data?.current_node ?? null}
                transitions={graphQ.data?.transitions ?? null}
                judgements={graphQ.data?.judgements ?? null}
                gateDecisions={graphQ.data?.gate_decisions ?? null}
              />
            </Suspense>
          ) : null}
        </div>
        {graphQ.error ? (
          <div className="alert alert-warning text-xs m-2">
            graph load failed:{" "}
            {String((graphQ.error as Error).message ?? graphQ.error)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Normalize an engine `current_node` to the bundle's stage id.
// Engine emits expanded ids like `plan_review.devils_advocate.1` or
// `plan_review.plan_aggregator`; the bundle creates stages with ids
// `plan_review` (parallel) and `plan_review__aggregator` (aggregator).
function normalizeNodeId(id: string): string {
  if (!id.includes(".")) return id;
  const head = id.split(".")[0];
  const tail = id.slice(head.length + 1);
  // Aggregator role-suffix (plan_review.plan_aggregator,
  // code_quality_review.code_quality_aggregator) → synthesized
  // aggregator stage.
  if (tail.endsWith("_aggregator")) return `${head}__aggregator`;
  // Parallel reviewer member (.devils_advocate.1, .coding_engineer.1) →
  // collapse to the macro id (the bundle renders all reviewers on one
  // stage).
  return head;
}

interface LiveBridgeProps {
  currentNode: string | null;
  transitions: Array<{
    ts: string;
    from: string | null;
    to: string;
    event: string | null;
    summary?: string;
  }> | null;
  judgements: Array<{
    node_id: string;
    round: number;
  }> | null;
  gateDecisions: Array<{
    node_id: string;
    round?: number;
  }> | null;
}

// Pushes live engine state into the bundle's zustand store. Split from
// the parent so the parent doesn't have to await the store-module
// promise inline.
function LiveBridge({
  currentNode,
  transitions,
  judgements,
  gateDecisions,
}: LiveBridgeProps) {
  const [store, setStore] = useState<Awaited<typeof useFlowStorePromise> | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    useFlowStorePromise.then((s) => {
      if (alive) setStore(() => s);
    });
    return () => {
      alive = false;
    };
  }, []);

  const lastTransitionLenRef = useRef(0);
  const targetId = useMemo(
    () => (currentNode ? normalizeNodeId(currentNode) : null),
    [currentNode],
  );

  // Mirror current_node → store.
  useEffect(() => {
    if (!store || !targetId) return;
    store.getState().jumpById(targetId);
  }, [store, targetId]);

  // Mirror engine round numbers → store.visitCounts. CountBadge over
  // each character reads this; we want it to show the engine's
  // authoritative round (max across each stage's members) so repair
  // loops surface as 2 / 3 / ... For non-parallel stages, the visit
  // count equals the round (= number of times the guardian fired). For
  // the parallel-reviewer macro, judgements live on the aggregator
  // (`<macro>.<role>_aggregator`) and reviewer members don't carry
  // their own judgement — we use the aggregator's max round, which is
  // the same number that applies to every reviewer character on that
  // stage.
  useEffect(() => {
    if (!store) return;
    const rounds: Record<string, number> = {};
    const bump = (rawId: string, round: number) => {
      const id = normalizeNodeId(rawId);
      if (!Number.isFinite(round) || round < 1) return;
      if ((rounds[id] ?? 0) < round) rounds[id] = round;
    };
    for (const j of judgements ?? []) bump(j.node_id, j.round);
    for (const g of gateDecisions ?? []) {
      if (typeof g.round === "number") bump(g.node_id, g.round);
    }
    // Active stage always at least round 1, so the user can see the
    // badge appear the instant the engine enters a node — even before
    // the guardian fires (and a judgement record exists).
    if (targetId && (rounds[targetId] ?? 0) < 1) rounds[targetId] = 1;
    store.getState().setVisitCounts(rounds);
  }, [store, judgements, gateDecisions, targetId]);

  // Fire fail-orb on new FAIL/ABORT transitions.
  useEffect(() => {
    if (!store || !transitions) return;
    const last = lastTransitionLenRef.current;
    if (transitions.length <= last) {
      lastTransitionLenRef.current = transitions.length;
      return;
    }
    const fresh = transitions.slice(last);
    lastTransitionLenRef.current = transitions.length;
    // Skip fail-orb during the first observation (initial page load
    // shouldn't replay every historical FAIL as an orb).
    if (last === 0) return;
    for (const t of fresh) {
      const ev = (t.event ?? "").toUpperCase();
      const sumL = (t.summary ?? "").toLowerCase();
      const isFailLike =
        ev === "FAIL" ||
        ev === "ABORT" ||
        sumL.includes("fail") ||
        sumL.includes("reject");
      if (!isFailLike) continue;
      // Jump store to the "from" node first so .fail()'s rollback
      // computation has the right anchor, then call fail().
      if (t.from) store.getState().jumpById(normalizeNodeId(t.from));
      const r = store.getState().fail();
      // If failPaths doesn't know about it, fall back to a plain
      // jumpById to the destination — the user still sees the move.
      if (!r) store.getState().jumpById(normalizeNodeId(t.to));
    }
  }, [store, transitions]);

  return null;
}
