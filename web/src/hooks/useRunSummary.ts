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
    qc.invalidateQueries({ queryKey: ["graph", runId] });
    qc.invalidateQueries({ queryKey: ["events", runId] });
    qc.invalidateQueries({ queryKey: ["evidence", runId] });
    qc.invalidateQueries({ queryKey: ["wtdir", runId] });
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
