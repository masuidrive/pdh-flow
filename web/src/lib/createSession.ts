// Helper: kick off a "+ New epic" / "+ New ticket" creation session.
// POSTs /api/assist/create, navigates to /assist/<sessionId> on success.
// The modal-based form approach was dropped because the interview Claude
// needs to drive (Outcome / Exit Criteria / Acceptance Criteria) doesn't
// fit a static form — see commit context for #21.
export async function startCreationSession(opts: {
  kind: "epic" | "ticket";
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
