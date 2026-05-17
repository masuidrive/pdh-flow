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

// Open a fresh claude session focused on triaging uncommitted changes in
// the worktree. Used by UncommittedChangesModal when Start-engine is
// blocked. Returns the sessionId so the caller can open the embedded
// TerminalModal.
export async function startCleanupSession(opts: {
  slug: string;
}): Promise<{ sessionId: string }> {
  const res = await fetch("/api/assist/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const body = (await res.json()) as { sessionId?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error || `assist/cleanup failed: ${res.status}`);
  if (!body.sessionId) throw new Error("server did not return a sessionId");
  return { sessionId: body.sessionId };
}

export interface BootstrapStatus {
  worktree: string;
  missing: string[];
  templates_available: boolean;
}

// Re-spawn `pdh-flow run-engine` on an existing run-id. The engine
// loads the saved snapshot, skips frozen judgements, and continues
// from wherever the snapshot stopped. Used by IdleRecoveryCard.
export async function restartRun(
  runId: string,
  opts: { fresh?: boolean } = {},
): Promise<{
  pid: number | null;
  run_id: string;
}> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/restart`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fresh: !!opts.fresh }),
    },
  );
  const body = (await res.json()) as {
    pid?: number | null;
    run_id?: string;
    error?: string;
    detail?: string;
  };
  if (!res.ok || body.error) {
    throw new Error(body.detail || body.error || `restart failed: ${res.status}`);
  }
  return { pid: body.pid ?? null, run_id: body.run_id ?? runId };
}

// Open a plain bash terminal in an idle run's worktree, with the
// resume command pre-printed in the banner. Returns the assist
// sessionId so the caller can navigate to /assist/<sessionId>.
export async function openRunTerminal(runId: string): Promise<{ sessionId: string }> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/open-terminal`,
    { method: "POST" },
  );
  const body = (await res.json()) as { sessionId?: string; error?: string };
  if (!res.ok || body.error) {
    throw new Error(body.error || `open-terminal failed: ${res.status}`);
  }
  if (!body.sessionId) throw new Error("server did not return a sessionId");
  return { sessionId: body.sessionId };
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
