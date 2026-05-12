import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { del, fetchJson, fetchText, postEmpty, postJson } from "../lib/api";
import type { EvidenceRound, GateDraft } from "../types/api";
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

export function GateCard({
  runId,
  activeGate,
  gateDraft,
}: {
  runId: string;
  activeGate: string | null | undefined;
  gateDraft?: GateDraft | null;
}) {
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
  const draft = gateDraft && gateDraft.node_id === activeGate ? gateDraft : null;
  return <ActiveGateForm runId={runId} nodeId={activeGate} draft={draft} />;
}

function ActiveGateForm({
  runId,
  nodeId,
  draft,
}: {
  runId: string;
  nodeId: string;
  draft: GateDraft | null;
}) {
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<{ msg: string; tone: "ok" | "err" | "neutral" } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const term = useTerminal();
  const qc = useQueryClient();

  function refreshRun() {
    qc.invalidateQueries({ queryKey: ["run", runId] });
  }

  async function submit(decision: Decision, commentOverride?: string) {
    setStatus({ msg: "Submitting…", tone: "neutral" });
    try {
      await postJson(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}`, {
        decision,
        comment: (commentOverride ?? comment).trim() || undefined,
      });
      setStatus({ msg: `${decision} — engine should pick this up within ~1 s.`, tone: "ok" });
      refreshRun();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    }
  }

  async function confirmDraft() {
    setStatus({ msg: "Confirming…", tone: "neutral" });
    try {
      await postEmpty(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}/confirm`);
      setStatus({ msg: "confirmed — engine should pick this up within ~1 s.", tone: "ok" });
      refreshRun();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    }
  }

  async function discardDraft() {
    setStatus({ msg: "Discarding proposal…", tone: "neutral" });
    try {
      await del(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}/draft`);
      setStatus({ msg: "proposal discarded — decide manually below.", tone: "neutral" });
      refreshRun();
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
        <GateEvidence runId={runId} />
        {draft ? (
          <div className="card bg-info/10 border border-info">
            <div className="card-body p-3 gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold">Proposed decision</span>
                <span
                  className={`badge badge-sm ${
                    draft.decision === "approved"
                      ? "badge-success"
                      : draft.decision === "rejected"
                        ? "badge-error"
                        : "badge-ghost"
                  }`}
                >
                  {draft.decision}
                </span>
                {draft.via ? <span className="badge badge-ghost badge-xs">via {draft.via}</span> : null}
                {draft.approver ? (
                  <span className="badge badge-ghost badge-xs">{draft.approver}</span>
                ) : null}
              </div>
              {draft.comment ? (
                <div className="text-sm whitespace-pre-wrap bg-base-100 rounded p-2">{draft.comment}</div>
              ) : (
                <p className="text-xs opacity-60">(no comment)</p>
              )}
              <p className="text-xs opacity-70">
                Submitted via the terminal / wrapper, not yet executed. Review the diff & evidence,
                then confirm — or discard it and decide manually.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmDraft()}>
                  Confirm &amp; execute
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void discardDraft()}>
                  Discard &amp; decide manually
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <label className="form-control">
          <span className="label-text text-xs">Comment (optional)</span>
          <AutosizeTextarea
            value={comment}
            onChange={setComment}
            placeholder="reason / note"
          />
        </label>
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn btn-success btn-sm" onClick={() => submit("approved")}>
            Approve
          </button>
          <button
            type="button"
            className="btn btn-error btn-sm"
            onClick={() => {
              setRejectReason(comment);
              setRejecting(true);
            }}
            title="差し戻し: ノードの outputs.rejected で指定された前段ノードに戻る (例: close_gate → implement)。理由の入力が必須。"
          >
            Reject…
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => submit("cancelled")}
            title="ラン中止: outputs.cancelled の指す終端 (通常 human_intervention) へ抜け、エンジンを needs_human で停止"
          >
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
      {rejecting ? (
        <RejectReasonDialog
          nodeId={nodeId}
          value={rejectReason}
          onChange={setRejectReason}
          onCancel={() => setRejecting(false)}
          onConfirm={() => {
            setRejecting(false);
            void submit("rejected", rejectReason);
          }}
        />
      ) : null}
    </div>
  );
}

function RejectReasonDialog({
  nodeId,
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const canConfirm = value.trim().length > 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="card bg-base-100 shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-body gap-3">
          <h3 className="card-title text-base">
            Reject <span className="font-mono">{nodeId}</span> — reason required
          </h3>
          <p className="text-xs opacity-70">
            This routes the run back for a fix (e.g. close_gate → implement). Say concretely what's
            wrong so the next round knows what to change.
          </p>
          <textarea
            ref={ref}
            className="textarea textarea-bordered textarea-sm w-full resize-none"
            rows={4}
            placeholder="what to fix…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canConfirm) onConfirm();
              if (e.key === "Escape") onCancel();
            }}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-error btn-sm"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              Reject (⌘↵)
            </button>
          </div>
        </div>
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
          <div className="markdown-content text-sm">
            <ReactMarkdown>{data.summary}</ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Evidence captured by `final_verifier` (or any earlier provider that
// stages files under .pdh-flow/runs/<runId>/evidence/round-<N>/). Shown
// as a thumbnail grid for images and as inline links for everything
// else, so the human at close_gate can spot-check the deliverable
// without leaving the page. Only the latest round is shown by default;
// older rounds collapse behind a disclosure for repair-loop runs.
function GateEvidence({ runId }: { runId: string }) {
  const [rounds, setRounds] = useState<EvidenceRound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<EvidenceRound[]>(`/api/runs/${encodeURIComponent(runId)}/evidence`)
      .then((r) => {
        if (!cancelled) setRounds(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (error) {
    return <div className="alert alert-warning text-xs">evidence: {error}</div>;
  }
  if (!rounds || rounds.length === 0) return null;

  const latest = rounds[rounds.length - 1];
  const older = rounds.slice(0, -1);

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body p-3 gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Evidence (round {latest.round})</h3>
          <span className="badge badge-ghost badge-xs">{latest.files.length} files</span>
        </div>
        <EvidenceGrid files={latest.files} onPreview={setPreview} />
        {older.length > 0 ? (
          <details onToggle={(e) => setShowOlder((e.target as HTMLDetailsElement).open)}>
            <summary className="text-xs opacity-70 cursor-pointer">
              {showOlder ? "Hide" : "Show"} earlier rounds ({older.length})
            </summary>
            <div className="mt-2 space-y-3">
              {older.map((r) => (
                <div key={r.round}>
                  <div className="text-xs opacity-70 mb-1">round {r.round}</div>
                  <EvidenceGrid files={r.files} onPreview={setPreview} />
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {preview ? (
          <div
            className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 cursor-zoom-out"
            onClick={() => setPreview(null)}
          >
            <img src={preview.url} alt={preview.filename} className="max-w-full max-h-full" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EvidenceGrid({
  files,
  onPreview,
}: {
  files: EvidenceRound["files"];
  onPreview: (p: { url: string; filename: string }) => void;
}) {
  if (files.length === 0) {
    return <p className="text-xs opacity-60">no files</p>;
  }
  const images = files.filter((f) => f.kind === "image");
  const others = files.filter((f) => f.kind !== "image");
  return (
    <div className="space-y-2">
      {images.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {images.map((f) => (
            <button
              key={f.filename}
              type="button"
              className="card bg-base-200 hover:bg-base-300 cursor-zoom-in p-1"
              onClick={() => onPreview({ url: f.url, filename: f.filename })}
              title={f.filename}
            >
              <img
                src={f.url}
                alt={f.filename}
                loading="lazy"
                className="w-full h-32 object-contain"
              />
              <div className="text-[10px] opacity-70 truncate mt-1">{f.filename}</div>
            </button>
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <ul className="text-xs space-y-1">
          {others.map((f) => (
            <EvidenceFileItem key={f.filename} file={f} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Click to expand inline. Text-like files are fetched and rendered as a
// scrollable <pre>; PDFs / unknown binaries open in a new tab instead
// because inlining them is more annoying than helpful.
function EvidenceFileItem({ file }: { file: EvidenceRound["files"][number] }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inlineable = file.kind === "text";

  function toggle() {
    if (!inlineable) return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (body !== null || loading) return;
    setLoading(true);
    fetchText(file.url)
      .then((t) => setBody(t))
      .catch((e) => setErr(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
  }

  return (
    <li>
      <div className="flex items-center gap-2">
        {inlineable ? (
          <button
            type="button"
            className="link link-hover font-mono"
            onClick={toggle}
            title="click to expand"
          >
            {open ? "▾" : "▸"} {file.filename}
          </button>
        ) : (
          <a className="link font-mono" href={file.url} target="_blank" rel="noopener noreferrer">
            {file.filename}
          </a>
        )}
        <span className="opacity-50">
          {file.kind} · {Math.round(file.size_bytes / 1024)} KB
        </span>
        {inlineable ? (
          <a className="link opacity-50" href={file.url} target="_blank" rel="noopener noreferrer">
            (raw)
          </a>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1 ml-3 border-l-2 border-base-300 pl-2">
          {loading ? (
            <span className="loading loading-spinner loading-xs" />
          ) : err ? (
            <div className="alert alert-error text-xs">{err}</div>
          ) : (
            <pre className="text-[11px] whitespace-pre-wrap break-words max-h-[60dvh] overflow-auto bg-base-200 p-2 rounded">
              {body}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  );
}

// Auto-expanding textarea that grows to fit content up to 80dvh, then
// scrolls. Reset+set scrollHeight on every keystroke so it both grows
// and shrinks. The CSS max-height stops growth at 80dvh; overflow-auto
// kicks in past that.
function AutosizeTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="textarea textarea-bordered textarea-sm resize-none overflow-auto"
      style={{ maxHeight: "80dvh", minHeight: "2.5rem" }}
      rows={2}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
