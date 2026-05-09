import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";

/** Subscribe to an SSE stream while the component is mounted. The handler
 *  fires on every named event matching `eventName` ("change" by default). */
export function useEventSource(
  url: string | null,
  onChange: () => void,
  eventName: string = "change",
): void {
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    const handler = () => onChange();
    es.addEventListener(eventName, handler);
    return () => {
      es.removeEventListener(eventName, handler);
      es.close();
    };
  }, [url, eventName, onChange]);
}

/** Fan-out helper: invalidate a list of React Query keys whenever the SSE
 *  fires. Useful for the run page where one stream feeds summary + note +
 *  graph queries simultaneously. */
export function invalidateMany(client: QueryClient, keys: readonly (readonly unknown[])[]): void {
  for (const k of keys) {
    client.invalidateQueries({ queryKey: k });
  }
}
