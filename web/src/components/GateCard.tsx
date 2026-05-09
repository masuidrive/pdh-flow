import { useState } from "react";
import { postJson } from "../lib/api";
import { useTerminal } from "./TerminalModal";

type Decision = "approved" | "rejected" | "cancelled";

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
