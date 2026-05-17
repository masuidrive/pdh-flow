import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, fetchText } from "../lib/api";
import { useEventSource } from "../lib/sse";
import type { EvidenceRound, RunEvent, RunGraph, RunSummary } from "../types/api";

export function useRunSummary(runId: string | undefined) {
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    if (!runId) return;
    qc.invalidateQueries({ queryKey: ["run", runId] });
    qc.invalidateQueries({ queryKey: ["note", runId] });
    qc.invalidateQueries({ queryKey: ["ticket-text", runId] });
    qc.invalidateQueries({ queryKey: ["brief-text", runId] });
    qc.invalidateQueries({ queryKey: ["graph", runId] });
    qc.invalidateQueries({ queryKey: ["events", runId] });
    qc.invalidateQueries({ queryKey: ["evidence", runId] });
    qc.invalidateQueries({ queryKey: ["wtdir", runId] });
    qc.invalidateQueries({ queryKey: ["engine-status", runId] });
  }, [qc, runId]);
  useEventSource(runId ? `/api/runs/${encodeURIComponent(runId)}/events` : null, invalidate);
  return useQuery<RunSummary>({
    queryKey: ["run", runId],
    queryFn: () => fetchJson<RunSummary>(`/api/runs/${encodeURIComponent(runId ?? "")}`),
    enabled: !!runId,
  });
}

export function useRunEvents(runId: string | undefined) {
  return useQuery<RunEvent[]>({
    queryKey: ["events", runId],
    queryFn: () =>
      fetchJson<RunEvent[]>(`/api/runs/${encodeURIComponent(runId ?? "")}/events.json`),
    enabled: !!runId,
  });
}

export function useRunNote(runId: string | undefined) {
  return useQuery<string>({
    queryKey: ["note", runId],
    queryFn: async () => {
      try {
        return await fetchText(`/api/runs/${encodeURIComponent(runId ?? "")}/note`);
      } catch {
        return "(note not found)";
      }
    },
    enabled: !!runId,
  });
}

/** Raw current-ticket.md text (resolved via the worktree's symlink).
 *  Returns null when the file doesn't exist (caller hides the card). */
export function useRunTicket(runId: string | undefined) {
  return useQuery<string | null>({
    queryKey: ["ticket-text", runId],
    queryFn: async () => {
      try {
        return await fetchText(`/api/runs/${encodeURIComponent(runId ?? "")}/ticket`);
      } catch {
        return null;
      }
    },
    enabled: !!runId,
  });
}

/** Raw product-brief.md text. Optional — most worktrees have one, some
 *  don't. Returns null when absent (the card hides itself). */
export function useRunBrief(runId: string | undefined) {
  return useQuery<string | null>({
    queryKey: ["brief-text", runId],
    queryFn: async () => {
      try {
        return await fetchText(`/api/runs/${encodeURIComponent(runId ?? "")}/brief`);
      } catch {
        return null;
      }
    },
    enabled: !!runId,
  });
}

export function useRunEvidence(runId: string | undefined) {
  return useQuery<EvidenceRound[]>({
    queryKey: ["evidence", runId],
    queryFn: async () => {
      try {
        return await fetchJson<EvidenceRound[]>(
          `/api/runs/${encodeURIComponent(runId ?? "")}/evidence`,
        );
      } catch {
        return [];
      }
    },
    enabled: !!runId,
  });
}

export interface WorktreeDir {
  path: string;
  entries: Array<{ name: string; type: "file" | "dir"; size_bytes?: number }>;
}

export function useWorktreeDir(
  runId: string | undefined,
  dirPath: string,
  enabled: boolean,
) {
  return useQuery<WorktreeDir>({
    queryKey: ["wtdir", runId, dirPath],
    queryFn: () =>
      fetchJson<WorktreeDir>(
        `/api/runs/${encodeURIComponent(runId ?? "")}/tree?path=${encodeURIComponent(dirPath)}`,
      ),
    enabled: !!runId && enabled,
  });
}

export function useRunGraph(runId: string | undefined) {
  return useQuery<RunGraph>({
    queryKey: ["graph", runId],
    queryFn: () => fetchJson<RunGraph>(`/api/runs/${encodeURIComponent(runId ?? "")}/graph`),
    enabled: !!runId,
    staleTime: 60_000, // graph topology is static; only current_node animates
  });
}

export interface EngineStatusResponse {
  alive: boolean;
  pid: number | null;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  state: string | null;
  kind:
    | "running"
    | "waiting-gate"
    | "waiting-turn"
    | "processing-answer"
    | "stuck"
    | "crashed"
    | "finished"
    | "needs-human"
    | "stopped"
    | "failed"
    | "unknown";
  last_transition_at: string | null;
  same_state_seconds: number | null;
  last_error: string | null;
  recommended_actions: Array<{
    kind:
      | "restart"
      | "restart-fresh"
      | "open-terminal"
      | "approve-gate"
      | "answer-turn"
      | "none";
    label: string;
    description: string;
    primary?: boolean;
  }>;
  message: string;
}

// Polls every 5s while the run is in a "could be running" state, and
// shares cache key with SSE invalidations from useRunSummary so manual
// actions force a refresh.
export function useEngineStatus(runId: string | undefined) {
  return useQuery<EngineStatusResponse>({
    queryKey: ["engine-status", runId],
    queryFn: () =>
      fetchJson<EngineStatusResponse>(
        `/api/runs/${encodeURIComponent(runId ?? "")}/engine-status`,
      ),
    enabled: !!runId,
    refetchInterval: (q) => {
      // While the engine might be alive, refresh every 5s so the
      // heartbeat age and kind stay current. Terminal/idle states
      // don't need polling — SSE-driven invalidations + manual
      // refreshes cover them.
      const d = q.state.data;
      if (!d) return 5_000;
      if (
        d.kind === "running" ||
        d.kind === "processing-answer" ||
        d.kind === "stuck" ||
        d.kind === "unknown"
      ) {
        return 5_000;
      }
      return false;
    },
  });
}
