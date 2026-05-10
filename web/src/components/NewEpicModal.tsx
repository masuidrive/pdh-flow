import { useState } from "react";
import { useNavigate } from "react-router-dom";

// Modal: create a new epic via POST /api/epics. Required: slug. Optional:
// title, branch policy (epic/<slug> default; main-direct toggle), worktree
// (when multi-tenant). On success, navigate to the new epic's detail page.
export function NewEpicModal({
  open,
  onClose,
  worktrees,
  defaultWorktree,
}: {
  open: boolean;
  onClose: () => void;
  worktrees: string[];
  defaultWorktree?: string;
}) {
  const navigate = useNavigate();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [mainDirect, setMainDirect] = useState(false);
  const [worktree, setWorktree] = useState<string>(defaultWorktree ?? worktrees[0] ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleCreate() {
    setError(null);
    if (!slug.trim()) {
      setError("slug is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/epics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: slug.trim(),
          title: title.trim() || undefined,
          main_direct: mainDirect,
          worktree: worktree || undefined,
        }),
      });
      const body = (await res.json()) as { error?: string; slug?: string; stderr?: string };
      if (!res.ok || body.error) throw new Error(body.error || `create failed: ${res.status}`);
      onClose();
      setSlug("");
      setTitle("");
      navigate(`/epics/${encodeURIComponent(body.slug ?? slug.trim())}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg">New epic</h3>
        <p className="text-sm opacity-70 py-1">
          Shells <span className="font-mono">ticket.sh epic new</span>. Drops a template
          file at <span className="font-mono">epics/&lt;slug&gt;.md</span> and (default) creates the{" "}
          <span className="font-mono">epic/&lt;slug&gt;</span> branch.
        </p>
        <label className="form-control mt-2">
          <span className="label-text mb-1">Slug (required)</span>
          <input
            className="input input-bordered input-sm font-mono"
            value={slug}
            onChange={(ev) => setSlug(ev.target.value)}
            placeholder="e.g. calc-web"
            autoFocus
          />
        </label>
        <label className="form-control mt-2">
          <span className="label-text mb-1">Title</span>
          <input
            className="input input-bordered input-sm"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            placeholder="Short human title"
          />
        </label>
        <label className="cursor-pointer label justify-start gap-3 mt-2">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={mainDirect}
            onChange={(ev) => setMainDirect(ev.target.checked)}
          />
          <span className="label-text">main-direct (no epic branch; edits land on main)</span>
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
            {submitting ? "Creating…" : "Create epic"}
          </button>
        </div>
      </div>
    </div>
  );
}
