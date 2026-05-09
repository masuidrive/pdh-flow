import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchJson, postJson } from "../lib/api";
import { useTerminal } from "./TerminalModal";

type Decision = "approved" | "rejected" | "cancelled";

interface GateSummaryResponse {
  summary: string;
  cached: boolean;
  generated_at: string;
  has_brief: boolean;
  round: number;
  provider: string;
}

export function GateCard({ runId, activeGate }: { runId: string; activeGate: string | null | undefined }) {
  if (!activeGate) {
    return (
      <div className="card bg-base-100 shadow">
        <div className="card-body">
          <h2 className="card-title text-lg">Active gate</h2>
          <p className="text-sm opacity-70">No human approval pending right now.</p>
        </div>
      </div>
    );
  }
  return <ActiveGateForm runId={runId} nodeId={activeGate} />;
}

function ActiveGateForm({ runId, nodeId }: { runId: string; nodeId: string }) {
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<{ msg: string; tone: "ok" | "err" | "neutral" } | null>(null);
  const term = useTerminal();

  async function submit(decision: Decision) {
    setStatus({ msg: "Submitting…", tone: "neutral" });
    try {
      await postJson(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}`, {
        decision,
        comment: comment.trim() || undefined,
      });
      setStatus({ msg: `${decision} — engine should pick this up within ~1 s.`, tone: "ok" });
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    }
  }

  return (
    <div className="card bg-warning/10 border border-warning shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">
          Approval needed: <span className="font-mono">{nodeId}</span>
        </h2>
        <GateSummary runId={runId} nodeId={nodeId} />
        <label className="form-control">
          <span className="label-text text-xs">Comment (optional)</span>
          <textarea
            className="textarea textarea-bordered textarea-sm"
            rows={2}
            placeholder="reason / note"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn btn-success btn-sm" onClick={() => submit("approved")}>
            Approve
          </button>
          <button type="button" className="btn btn-error btn-sm" onClick={() => submit("rejected")}>
            Reject
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => submit("cancelled")}>
            Cancel run
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => term.open({ runId, nodeId, mode: "fresh" })}
          >
            Open in terminal
          </button>
        </div>
        {status ? (
          <p
            className={`text-xs ${
              status.tone === "ok" ? "text-success" : status.tone === "err" ? "text-error" : "opacity-70"
            }`}
          >
            {status.msg}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// LLM-generated decision-support summary. Auto-loads when the gate
// becomes active; cached server-side so navigating away and back is
// instant. The "regenerate" button forces a fresh LLM call (e.g. after
// the round ticks up or the note changes mid-review).
function GateSummary({ runId, nodeId }: { runId: string; nodeId: string }) {
  const [data, setData] = useState<GateSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(regenerate: boolean) {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}/summary${
        regenerate ? "?regenerate=1" : ""
      }`;
      const r = await fetchJson<GateSummaryResponse>(url);
      setData(r);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, nodeId]);

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body p-3 gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Decision summary</h3>
          <div className="flex items-center gap-1">
            {data ? (
              <>
                <span className="badge badge-ghost badge-xs">round {data.round}</span>
                <span className="badge badge-ghost badge-xs">{data.provider}</span>
                {!data.has_brief ? (
                  <span
                    className="badge badge-warning badge-xs"
                    title="product-brief.md was not found in this worktree"
                  >
                    no brief
                  </span>
                ) : null}
                {data.cached ? <span className="badge badge-ghost badge-xs">cached</span> : null}
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => void load(true)}
              disabled={loading}
              title="regenerate (re-invokes the LLM)"
            >
              {loading ? "…" : "↻"}
            </button>
          </div>
        </div>
        {loading && !data ? (
          <div className="flex items-center gap-2 text-xs opacity-70">
            <span className="loading loading-spinner loading-xs" />
            <span>Generating summary (this may take ~10–30 s)…</span>
          </div>
        ) : null}
        {error ? <div className="alert alert-error text-xs">{error}</div> : null}
        {data ? (
          <div className="prose prose-sm max-w-none text-sm">
            <ReactMarkdown>{data.summary}</ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}
