import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";

/** Subscribe to an SSE stream while the component is mounted. The handler
 *  fires on every named event matching `eventName` ("change" by default).
 *
 *  EventSource per WHATWG closes permanently when the initial response is
 *  non-200 or `Content-Type` is not `text/event-stream`. The run page hits
 *  this whenever the user opens it before the engine has created the run
 *  dir — the SSE endpoint 404s, EventSource gives up, and auto-update is
 *  silently broken for the rest of the page's life. We work around it by
 *  closing on any error and manually reconnecting with capped exponential
 *  backoff. `onopen` resets the counter so a healthy session doesn't grow
 *  retry delays. */
export function useEventSource(
  url: string | null,
  onChange: () => void,
  eventName: string = "change",
): void {
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const handler = () => onChange();

    const connect = (): void => {
      if (cancelled) return;
      const isReconnect = attempt > 0;
      es = new EventSource(url);
      es.addEventListener(eventName, handler);
      es.onopen = () => {
        attempt = 0;
        // On a successful (re-)connect after a prior failure, force one
        // refetch immediately. The SSE stream itself doesn't replay
        // events that fired while we were offline, so if the engine
        // made progress and then went idle (e.g. hit a gate) we'd be
        // stuck on stale data until the next file change. This single
        // catch-up invalidate closes that gap. The initial connect
        // skips it — React Query already fetched as part of mount.
        if (isReconnect) onChange();
      };
      es.onerror = () => {
        if (cancelled) return;
        es?.close();
        es = null;
        attempt += 1;
        const delay = Math.min(30_000, 500 * 2 ** (attempt - 1));
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
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
