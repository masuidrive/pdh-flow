// Helper: open a claude terminal session for working on epics/tickets.
// kind=general → top-page "Open terminal" (claude reads the PDH doc +
// product-brief, then asks whether to cut a ticket or an epic).
// kind=ticket|epic → contextual (e.g. cut a ticket under a given epic).
// POSTs /api/assist/create, returns the sessionId (navigate to
// /assist/<sessionId>).
export async function startCreationSession(opts: {
  kind: "epic" | "ticket" | "general";
  epic?: string;
  worktree?: string;
}): Promise<{ sessionId: string }> {
  const res = await fetch("/api/assist/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const body = (await res.json()) as { sessionId?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error || `assist/create failed: ${res.status}`);
  if (!body.sessionId) throw new Error("server did not return a sessionId");
  return { sessionId: body.sessionId };
}

export interface BootstrapStatus {
  worktree: string;
  missing: string[];
  templates_available: boolean;
}

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error(`bootstrap status failed: ${res.status}`);
  return (await res.json()) as BootstrapStatus;
}

export async function applyBootstrap(): Promise<BootstrapStatus & { applied: string[]; error?: string }> {
  const res = await fetch("/api/bootstrap", { method: "POST" });
  const body = (await res.json()) as BootstrapStatus & { applied?: string[]; error?: string };
  if (!res.ok) throw new Error(body.error || `bootstrap apply failed: ${res.status}`);
  return { ...body, applied: body.applied ?? [] };
}
