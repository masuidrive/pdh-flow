import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "../lib/api";
import { useEventSource } from "../lib/sse";
import type { EpicSummary, EpicDetail } from "../types/api";

const EPICS_KEY = ["epics"] as const;

// `useEpics` and `useEpic` both invalidate on /api/runs-events because a
// new pdh-d run (epic close cycle) changes the epic's "active close run"
// + can_start_close fields. Tickets close changing the open/closed counts
// also surface here, so we don't need a separate invalidation channel.
export function useEpics() {
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: EPICS_KEY });
    qc.invalidateQueries({ queryKey: ["epic"] });
  }, [qc]);
  useEventSource("/api/runs-events", invalidate);
  return useQuery<EpicSummary[]>({
    queryKey: EPICS_KEY,
    queryFn: () => fetchJson<EpicSummary[]>("/api/epics"),
  });
}

export function useEpic(slug: string | undefined) {
  return useQuery<EpicDetail>({
    queryKey: ["epic", slug],
    queryFn: () => fetchJson<EpicDetail>(`/api/epics/${encodeURIComponent(slug ?? "")}`),
    enabled: !!slug,
  });
}
