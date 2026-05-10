import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEpics } from "../hooks/useEpics";

// Modal: create a new ticket via POST /api/tickets. Required: slug.
// Optional: title (becomes ticket frontmatter title), epic (links via
// --epic), worktree. On success navigate to /tickets/<slug>.
export function NewTicketModal({
  open,
  onClose,
  worktrees,
  defaultWorktree,
  defaultEpic,
}: {
  open: boolean;
  onClose: () => void;
  worktrees: string[];
  defaultWorktree?: string;
  /** When the modal is opened from EpicPage, pre-select that epic. */
  defaultEpic?: string;
}) {
  const navigate = useNavigate();
  const epicsQ = useEpics();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [epic, setEpic] = useState<string>(defaultEpic ?? "");
  const [worktree, setWorktree] = useState<string>(defaultWorktree ?? worktrees[0] ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEpic(defaultEpic ?? "");
      setWorktree(defaultWorktree ?? worktrees[0] ?? "");
    }
  }, [open, defaultEpic, defaultWorktree, worktrees]);

  if (!open) return null;

  const epics = (epicsQ.data ?? []).filter((e) => e.status !== "closed" && e.status !== "cancelled");

  async function handleCreate() {
    setError(null);
    if (!slug.trim()) {
      setError("slug is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          title: title.trim() || undefined,
          epic: epic || undefined,
          worktree: worktree || undefined,
        }),
      });
      const body = (await res.json()) as { error?: string; slug?: string };
      if (!res.ok || body.error) throw new Error(body.error || `create failed: ${res.status}`);
      onClose();
      setSlug("");
      setTitle("");
      navigate(`/tickets/${encodeURIComponent(body.slug ?? slug.trim())}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">New ticket</h3>
        <p className="text-sm opacity-70 py-1">
          Shells <span className="font-mono">ticket.sh new</span>. With{" "}
          <span className="font-mono">--epic</span>, ticket frontmatter gets{" "}
          <span className="font-mono">epic_id</span> + <span className="font-mono">base_branch</span> set.
        </p>
        <label className="form-control mt-2">
          <span className="label-text mb-1">Slug (required)</span>
          <input
            className="input input-bordered input-sm font-mono"
            value={slug}
            onChange={(ev) => setSlug(ev.target.value)}
            placeholder="e.g. login-form"
            autoFocus
          />
        </label>
        <label className="form-control mt-2">
          <span className="label-text mb-1">Title</span>
          <input
            className="input input-bordered input-sm"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
          />
        </label>
        <label className="form-control mt-2">
          <span className="label-text mb-1">Epic (optional)</span>
          <select
            className="select select-bordered select-sm font-mono"
            value={epic}
            onChange={(ev) => setEpic(ev.target.value)}
          >
            <option value="">(no epic)</option>
            {epics.map((e) => (
              <option key={e.epic_id} value={e.epic_id}>
                {e.epic_id}
              </option>
            ))}
          </select>
        </label>
        {worktrees.length > 1 ? (
          <label className="form-control mt-2">
            <span className="label-text mb-1">Worktree</span>
            <select
              className="select select-bordered select-sm font-mono"
              value={worktree}
              onChange={(ev) => setWorktree(ev.target.value)}
            >
              {worktrees.map((w) => (
                <option key={w} value={w}>
                  {w.split("/").pop()}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? (
          <div className="alert alert-error mt-3">
            <span className="text-xs">{error}</span>
          </div>
        ) : null}
        <div className="modal-action">
          <button type="button" className="btn btn-ghost btn-sm" disabled={submitting} onClick={onClose}>
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={submitting || !slug.trim()}
            onClick={handleCreate}
          >
            {submitting ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </div>
    </div>
  );
}
