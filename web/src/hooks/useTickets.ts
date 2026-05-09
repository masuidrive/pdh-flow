import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "../lib/api";
import { useEventSource } from "../lib/sse";
import type { TicketSummary, TicketDetail, RunListItem } from "../types/api";

const TICKETS_KEY = ["tickets"] as const;
const RUNS_KEY = ["runs"] as const;

export function useTickets() {
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: TICKETS_KEY });
    qc.invalidateQueries({ queryKey: RUNS_KEY });
  }, [qc]);
  useEventSource("/api/runs-events", invalidate);
  return useQuery<TicketSummary[]>({
    queryKey: TICKETS_KEY,
    queryFn: () => fetchJson<TicketSummary[]>("/api/tickets"),
  });
}

export function useRuns() {
  return useQuery<RunListItem[]>({
    queryKey: RUNS_KEY,
    queryFn: () => fetchJson<RunListItem[]>("/api/runs"),
  });
}

export function useTicket(slug: string | undefined) {
  return useQuery<TicketDetail>({
    queryKey: ["ticket", slug],
    queryFn: () => fetchJson<TicketDetail>(`/api/tickets/${encodeURIComponent(slug ?? "")}`),
    enabled: !!slug,
  });
}
