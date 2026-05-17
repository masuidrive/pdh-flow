import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, fetchJson, fetchText, postEmpty, postJson } from "../lib/api";
import type { EvidenceRound, GateDraft } from "../types/api";
import { Markdown } from "./Markdown";
import { MermaidView } from "./MermaidView";
import { useRunNote } from "../hooks/useRunSummary";
import { useTerminal } from "./TerminalModal";
import { scrollToTop } from "../lib/scroll";

type Decision = "approved" | "rejected" | "cancelled";

interface ConcernItem {
  /** Plain-text body of the concern (no source-tag suffix, no marker). */
  text: string;
  severity?: "minor" | "major" | "critical";
  status?: "accepted" | "deferred" | "noted" | "new";
  source_node?: string;
}

interface GateSummaryResponse {
  /** Human-facing markdown — rendered as-is, never parsed for data. */
  summary_md: string;
  /** Structured concerns surfaced by the LLM. Drives the triage panel. */
  concerns: ConcernItem[];
  /** LLM's top-level recommendation. */
  recommendation: "approve" | "reject" | "other";
  cached: boolean;
  generated_at: string;
  has_brief: boolean;
  round: number;
  provider: string;
}

type TriageAction = "fix_in_this_ticket" | "accept" | "defer" | "dismiss";

interface ConcernTriageEntry {
  concern: string;
  action: TriageAction;
  rationale: string;
  follow_up_ticket?: string;
}

/** Prefix used to mark a triage entry as auto-pre-filled at a non-close
 *  gate (Minor concern → auto-accept). Render code checks this prefix
 *  to show the "事前セット済み" hint; any user edit changes the rationale
 *  away from the prefix, removing the hint naturally. */
const AUTO_RATIONALE_PREFIX = "(自動: ";

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
  // Concerns surfaced by gate-summary; PdM must triage each before approve.
  // Comes from the LLM's structured `concerns` array (NOT parsed back out
  // of summary_md). Map keyed by concern text — unique within a gate by
  // schema contract.
  const [concerns, setConcerns] = useState<ConcernItem[]>([]);
  const [triage, setTriage] = useState<Map<string, ConcernTriageEntry>>(new Map());
  // Auto-pop a confirm modal when a *new* proposal (draft) arrives — like
  // v1's "claude proposed → ConfirmModal pops". Identity key = decided_at
  // (each wrapper write bumps it).
  const [showProposalModal, setShowProposalModal] = useState(false);
  const lastShownDraft = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const term = useTerminal();
  const qc = useQueryClient();

  useEffect(() => {
    if (draft) {
      const key = draft.decided_at ?? `${draft.decision}:${draft.comment ?? ""}`;
      if (lastShownDraft.current !== key) {
        lastShownDraft.current = key;
        setShowProposalModal(true);
      }
    } else {
      lastShownDraft.current = null;
      setShowProposalModal(false);
    }
  }, [draft]);

  // Pre-fill at non-close gates: Minor concerns surface here only as
  // confirmation rows — the aggregator already decided "accepted, not
  // blocking" and recorded it in the note. Auto-set action=accept with
  // an audit-friendly rationale so the PdM can just hit Approve. The
  // PdM can still override the action for any row by clicking another
  // button (which clears the auto rationale prefix → "事前セット済み"
  // badge disappears). close_gate is intentionally excluded: residual
  // minor risks deserve active acknowledgment at the final approval.
  useEffect(() => {
    if (nodeId === "close_gate") return;
    if (concerns.length === 0) return;
    setTriage((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const c of concerns) {
        if (next.has(c.text)) continue;
        // Minor + accepted: aggregator already decided "leave as-is".
        // Pre-fill action=accept; PdM can override.
        if (c.severity === "minor" && c.status === "accepted") {
          next.set(c.text, {
            concern: c.text,
            action: "accept",
            rationale:
              AUTO_RATIONALE_PREFIX + "minor — aggregate で accepted 済みのため残置)",
          });
          changed = true;
          continue;
        }
        // Anything aggregator marked `deferred`: action is already decided
        // (= "defer to a follow-up ticket"), but the follow_up_ticket slug
        // still needs human input. Pre-fill action + rationale so the
        // PdM only has to fill the slug field, instead of clicking three
        // buttons + writing a rationale from scratch every time.
        if (c.status === "deferred") {
          next.set(c.text, {
            concern: c.text,
            action: "defer",
            rationale:
              AUTO_RATIONALE_PREFIX +
              "aggregate が defer 判定済み。follow-up ticket slug は任意 (入れると追跡可))",
          });
          changed = true;
          continue;
        }
      }
      return changed ? next : prev;
    });
  }, [concerns, nodeId]);

  function refreshRun() {
    qc.invalidateQueries({ queryKey: ["run", runId] });
  }

  async function submit(decision: Decision, commentOverride?: string) {
    // Approve requires every surfaced concern to be triaged AND none of
    // them marked fix_in_this_ticket (those force a reject). Reject /
    // cancel skip the check — those flows are about saying "no" to the
    // approval, not about resolving each concern.
    if (decision === "approved" && concerns.length > 0) {
      const untriaged = concerns.filter((c) => !triage.get(c.text)?.action);
      if (untriaged.length > 0) {
        setStatus({
          msg: `${untriaged.length} 件の concern が未分類です。各 concern に action を選んでください。`,
          tone: "err",
        });
        return;
      }
      const noRationale = concerns.filter((c) => {
        const t = triage.get(c.text);
        return t?.action && !t.rationale.trim();
      });
      if (noRationale.length > 0) {
        setStatus({
          msg: `${noRationale.length} 件の理由欄が空です。rationale を入力してください。`,
          tone: "err",
        });
        return;
      }
      // defer の follow_up_ticket slug は推奨だがブロックしない。
      // audit trail (concern text + rationale) で後追いできるため。
      const fixers = concerns.filter((c) => triage.get(c.text)?.action === "fix_in_this_ticket");
      if (fixers.length > 0) {
        setStatus({
          msg:
            `${fixers.length} 件が「このチケットで直す」指定です。Approve はブロックされます。Reject を押して implementer に戻すか、accept / defer / dismiss に再分類してください。`,
          tone: "err",
        });
        return;
      }
    }
    setStatus({ msg: "Submitting…", tone: "neutral" });
    try {
      // Include concern_triage on approve AND reject when any concern has
      // a partial triage. The reject path uses fix_in_this_ticket entries
      // (and any other classifications the human committed to) as a
      // structured fix list the implementer reads from the note.
      const triagedConcerns = concerns.filter((c) => {
        const t = triage.get(c.text);
        return !!t && !!t.rationale.trim();
      });
      const concern_triage: ConcernTriageEntry[] | undefined =
        triagedConcerns.length > 0
          ? triagedConcerns.map((c) => {
              const t = triage.get(c.text)!;
              return {
                concern: c.text,
                action: t.action,
                rationale: t.rationale.trim(),
                ...(t.action === "defer" && t.follow_up_ticket
                  ? { follow_up_ticket: t.follow_up_ticket.trim() }
                  : {}),
              };
            })
          : undefined;
      await postJson(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}`, {
        decision,
        comment: (commentOverride ?? comment).trim() || undefined,
        ...(concern_triage ? { concern_triage } : {}),
      });
      setStatus({ msg: `${decision} — engine should pick this up within ~1 s.`, tone: "ok" });
      refreshRun();
      scrollToTop();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    }
  }

  async function confirmDraft() {
    setBusy(true);
    setStatus({ msg: "Confirming…", tone: "neutral" });
    try {
      await postEmpty(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}/confirm`);
      setStatus({ msg: "confirmed — engine should pick this up within ~1 s.", tone: "ok" });
      setShowProposalModal(false);
      refreshRun();
      scrollToTop();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function discardDraft() {
    setBusy(true);
    setStatus({ msg: "Discarding proposal…", tone: "neutral" });
    try {
      await del(`/api/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(nodeId)}/draft`);
      setStatus({ msg: "proposal discarded — decide manually below.", tone: "neutral" });
      setShowProposalModal(false);
      refreshRun();
      scrollToTop();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card bg-warning/10 border border-warning shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">
          Approval needed: <span className="font-mono">{nodeId}</span>
        </h2>
        <GateSummary runId={runId} nodeId={nodeId} onConcerns={setConcerns} />
        {nodeId === "plan_gate" ? <MockupView runId={runId} /> : null}
        <GateEvidence runId={runId} />
        {concerns.length > 0 ? (
          <ConcernTriagePanel
            concerns={concerns}
            triage={triage}
            onChange={setTriage}
          />
        ) : null}
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
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => { scrollToTop(); void confirmDraft(); }}
                >
                  Confirm &amp; execute
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { scrollToTop(); void discardDraft(); }}
                >
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
          {(() => {
            // Re-derive the same checks that `submit("approved")` uses,
            // but at render time so the button can show its disabled
            // state up-front instead of failing on click. Split by
            // *what's missing* so the tooltip + on-click message tells
            // the human exactly which field to fill, rather than the
            // vague "未 triage" we used to show.
            const untriaged = concerns.filter((c) => !triage.get(c.text)?.action);
            const noRationale = concerns.filter((c) => {
              const t = triage.get(c.text);
              return t?.action && !t.rationale.trim();
            });
            const fixers = concerns.filter(
              (c) => triage.get(c.text)?.action === "fix_in_this_ticket",
            );
            let blockReason = "";
            if (untriaged.length > 0) {
              blockReason = `Approve 不可: ${untriaged.length} 件の concern が未分類 (action を選んでください)。`;
            } else if (noRationale.length > 0) {
              blockReason = `Approve 不可: ${noRationale.length} 件の理由欄が空 (rationale を入力してください)。`;
            } else if (fixers.length > 0) {
              blockReason = `Approve 不可: ${fixers.length} 件が「このチケットで直す」指定。Reject を押して implementer に戻すか、accept / defer / dismiss に再分類してください。`;
            }
            const approveDisabled = blockReason.length > 0;
            return (
              <button
                type="button"
                className="btn btn-success btn-sm"
                onClick={() => { scrollToTop(); void submit("approved"); }}
                disabled={approveDisabled}
                title={blockReason || "Approve — gate を通過させる"}
              >
                Approve
              </button>
            );
          })()}
          <button
            type="button"
            className="btn btn-error btn-sm"
            onClick={() => {
              setRejectReason(comment);
              setRejecting(true);
            }}
            title="差し戻し: ノードの outputs.rejected で指定された前段ノードに戻る (例: close_gate → implement)。"
          >
            Reject…
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { scrollToTop(); void submit("cancelled"); }}
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
          fixActionCount={
            concerns.filter((c) => triage.get(c.text)?.action === "fix_in_this_ticket").length
          }
          onCancel={() => setRejecting(false)}
          onConfirm={() => {
            setRejecting(false);
            scrollToTop();
            void submit("rejected", rejectReason);
          }}
        />
      ) : null}
      {showProposalModal && draft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="card bg-base-100 shadow-xl w-full max-w-md">
            <div className="card-body gap-3">
              <h3 className="card-title text-base">
                A decision was proposed for <span className="font-mono">{nodeId}</span>
              </h3>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`badge ${
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
                <div className="text-sm whitespace-pre-wrap bg-base-200 rounded p-2 max-h-56 overflow-auto">
                  {draft.comment}
                </div>
              ) : (
                <p className="text-xs opacity-60">(no comment)</p>
              )}
              <p className="text-xs opacity-70">
                Not executed yet. Confirm to apply it (the engine continues), discard it and decide
                manually, or dismiss this dialog and review the diff / evidence first (the proposal
                stays available below).
              </p>
              <div className="flex justify-end gap-2 flex-wrap">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setShowProposalModal(false)}
                >
                  Review first
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-error btn-sm"
                  disabled={busy}
                  onClick={() => void discardDraft()}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void confirmDraft()}
                >
                  {busy ? "…" : "Confirm & execute"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RejectReasonDialog({
  nodeId,
  value,
  onChange,
  fixActionCount,
  onCancel,
  onConfirm,
}: {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  /** Number of concerns triaged as fix_in_this_ticket. When > 0 the
   *  implementer already has structured instructions from the triage
   *  panel, so this dialog's free-text reason becomes optional. */
  fixActionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const reasonOptional = fixActionCount > 0;
  const canConfirm = reasonOptional || value.trim().length > 0;
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
            Reject <span className="font-mono">{nodeId}</span>
            {reasonOptional ? (
              <span className="ml-1 text-xs font-normal opacity-70"> — additional reason (optional)</span>
            ) : (
              <span className="ml-1 text-xs font-normal opacity-70"> — reason required</span>
            )}
          </h3>
          {reasonOptional ? (
            <p className="text-xs opacity-70">
              {fixActionCount} 件の <b>「このチケットで直す」</b> 指示が implementer に渡されます。追加で伝えたい全体方針があればここに書いてください(空でも reject 可)。
            </p>
          ) : (
            <p className="text-xs opacity-70">
              This routes the run back for a fix (e.g. close_gate → implement). Say concretely what's
              wrong so the next round knows what to change.
            </p>
          )}
          <textarea
            ref={ref}
            className="textarea textarea-bordered textarea-sm w-full resize-none"
            rows={4}
            placeholder={reasonOptional ? "(optional) extra context for implementer" : "what to fix…"}
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
function GateSummary({
  runId,
  nodeId,
  onConcerns,
}: {
  runId: string;
  nodeId: string;
  onConcerns?: (c: ConcernItem[]) => void;
}) {
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

  // Surface the LLM's structured concerns array to the parent so it can
  // render the triage panel. The data comes straight from the gate-
  // summary JSON (schema-validated on the server); we no longer parse
  // anything out of summary_md — that string is presentation only.
  useEffect(() => {
    if (!onConcerns) return;
    onConcerns(data?.concerns ?? []);
  }, [data?.concerns, onConcerns]);

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
        {data ? <Markdown source={data.summary_md} className="text-sm" runId={runId} /> : null}
      </div>
    </div>
  );
}

/** Visual hint that a concern was already triaged at an earlier stage —
 *  helps the PdM skim "is this new vs. already-known?" at a glance. The
 *  data comes from the gate-summary's structured `concerns[]` array; we
 *  do NOT parse it back out of the markdown. */
function ConcernSourceBadge({ concern }: { concern: ConcernItem }) {
  const parts: string[] = [];
  if (concern.source_node) parts.push(concern.source_node);
  if (concern.severity) parts.push(concern.severity);
  if (concern.status) parts.push(concern.status);
  if (parts.length === 0) return null;
  const tone =
    concern.status === "accepted"
      ? "badge-ghost"
      : concern.status === "deferred"
        ? "badge-info"
        : "badge-ghost";
  return (
    <span
      className={`badge badge-sm font-mono whitespace-nowrap ${tone}`}
      title="Concern carried over from an earlier review aggregate"
    >
      {parts.join(" · ")}
    </span>
  );
}

/** Per-concern triage panel — required at every gate that surfaces
 *  concerns. The PdM must classify each: accept (consciously left as-is),
 *  defer (will fix in follow-up — needs ticket pointer), or dismiss (not
 *  a real concern / false positive). Approval is blocked client-side
 *  until every concern has an action + rationale. */
function ConcernTriagePanel({
  concerns,
  triage,
  onChange,
}: {
  concerns: ConcernItem[];
  triage: Map<string, ConcernTriageEntry>;
  onChange: (m: Map<string, ConcernTriageEntry>) => void;
}) {
  function update(key: string, patch: Partial<ConcernTriageEntry>) {
    const next = new Map(triage);
    const prev = next.get(key) ?? { concern: key, action: "accept" as const, rationale: "" };
    let merged = { ...prev, ...patch, concern: key };
    // When the user explicitly picks a different action, clear the auto
    // rationale so the "事前セット済み" hint disappears and the input is
    // empty for them to write a real reason.
    if (
      patch.action &&
      patch.action !== prev.action &&
      prev.rationale.startsWith(AUTO_RATIONALE_PREFIX)
    ) {
      merged = { ...merged, rationale: "" };
    }
    next.set(key, merged);
    onChange(next);
  }
  return (
    <div className="card bg-base-100 border border-warning/60">
      <div className="card-body p-3 gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Concern triage <span className="opacity-60 font-normal">— required to approve</span>
          </h3>
          <span className="badge badge-warning badge-sm">{concerns.length}</span>
        </div>
        <p className="text-xs opacity-70">
          Each concern raised in the summary must be classified before this gate can be approved.
          Reject / Cancel do not require triage.
        </p>
        <ul className="space-y-2">
          {concerns.map((c, i) => {
            const t = triage.get(c.text);
            const action = t?.action ?? null;
            const hasSource = !!(c.source_node || c.severity || c.status);
            return (
              <li key={i} className="rounded border border-base-300 p-2 space-y-1.5 bg-base-200/40">
                <div className="text-sm">{c.text}</div>
                {t?.rationale.startsWith(AUTO_RATIONALE_PREFIX) || hasSource ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    {t?.rationale.startsWith(AUTO_RATIONALE_PREFIX) ? (
                      <span
                        className="badge badge-xs badge-success whitespace-nowrap"
                        title="aggregate で accepted 済みのため自動で accept に pre-fill されました。別アクションを選ぶと解除されます。"
                      >
                        事前セット済み
                      </span>
                    ) : null}
                    {hasSource ? <ConcernSourceBadge concern={c} /> : null}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {(["fix_in_this_ticket", "accept", "defer", "dismiss"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={`btn btn-xs ${
                        action === a ? actionButtonClass(a) : "btn-ghost"
                      }`}
                      onClick={() => update(c.text, { action: a })}
                      title={actionTooltip(a)}
                    >
                      {actionLabel(a)}
                    </button>
                  ))}
                </div>
                {action ? (
                  <>
                    <input
                      type="text"
                      className="input input-bordered input-xs w-full"
                      placeholder={actionPlaceholder(action)}
                      value={t?.rationale ?? ""}
                      onChange={(e) => update(c.text, { rationale: e.target.value })}
                    />
                    {action === "defer" ? (
                      <DeferSlugInput
                        value={t?.follow_up_ticket ?? ""}
                        onChange={(slug) => update(c.text, { follow_up_ticket: slug })}
                      />
                    ) : null}
                    {action === "fix_in_this_ticket" ? (
                      <div className="text-[11px] text-warning-content/80 bg-warning/20 rounded px-2 py-1">
                        Approve はブロックされます。理由欄を埋めて <b>Reject</b> を押すと implementer が受け取ります。
                      </div>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Slug input for the `defer` triage action. Debounce-pings
 *  `/api/tickets/:slug` to tell the user whether the ticket already
 *  exists (show its title) or doesn't (offer a one-click create). The
 *  create button POSTs to `/api/tickets` with the slug — the engine's
 *  create route shells `ticket.sh new <slug>` and we surface the result
 *  inline so the human doesn't context-switch out of the gate. */
function DeferSlugInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (slug: string) => void;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "exists"; title: string }
    | { kind: "missing" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const slug = value.trim();
    if (!slug) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "checking" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/tickets/${encodeURIComponent(slug)}`, {
          signal: ctrl.signal,
        });
        if (r.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        if (!r.ok) {
          setState({ kind: "error", message: `lookup failed (${r.status})` });
          return;
        }
        const body = (await r.json()) as { ticket_frontmatter?: { title?: string }; title?: string };
        const title =
          body.ticket_frontmatter?.title ??
          body.title ??
          "(no title)";
        setState({ kind: "exists", title });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setState({ kind: "error", message: String((err as Error).message ?? err) });
      }
    }, 400);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [value]);

  async function handleCreate() {
    const slug = value.trim();
    if (!slug) return;
    setCreating(true);
    try {
      const r = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || body.error) {
        setState({ kind: "error", message: body.error ?? `create failed (${r.status})` });
      } else {
        setState({ kind: "exists", title: "(just created)" });
      }
    } catch (err) {
      setState({ kind: "error", message: String((err as Error).message ?? err) });
    } finally {
      setCreating(false);
    }
  }

  const isEmpty = value.trim().length === 0;
  return (
    <div className="space-y-1">
      <input
        type="text"
        className={`input input-xs w-full font-mono ${
          isEmpty
            ? "input-bordered border-warning focus:border-warning"
            : "input-bordered"
        }`}
        placeholder="follow-up ticket slug (例: 260601-100000-test-all-multilang) — 推奨"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {isEmpty ? (
        <div className="text-[11px] text-warning">
          推奨: follow-up ticket slug を入れると defer が追跡可能になります (空でも Approve は可)
        </div>
      ) : state.kind === "checking" ? (
        <div className="text-[11px] opacity-60">checking…</div>
      ) : state.kind === "exists" ? (
        <div className="text-[11px] text-success">
          ✓ exists — <span className="font-medium">{state.title}</span>
        </div>
      ) : state.kind === "missing" ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-warning">⚠ not found</span>
          <button
            type="button"
            className="btn btn-warning btn-xs"
            disabled={creating}
            onClick={() => void handleCreate()}
          >
            {creating ? "creating…" : `+ create ticket`}
          </button>
        </div>
      ) : state.kind === "error" ? (
        <div className="text-[11px] text-error">{state.message}</div>
      ) : null}
    </div>
  );
}

function actionLabel(a: TriageAction): string {
  if (a === "fix_in_this_ticket") return "このチケットで直す";
  if (a === "accept") return "残置 (Out of scope)";
  if (a === "defer") return "別チケットで対応";
  return "誤検知として棄却";
}

function actionTooltip(a: TriageAction): string {
  if (a === "fix_in_this_ticket")
    return "真の懸念。今この ticket の implementer に戻して直させる (gate は reject 扱い)";
  if (a === "accept") return "真の懸念だが許容する。ticket の Out of scope に追記";
  if (a === "defer") return "真の懸念。別 ticket で対応する。slug を入力";
  return "LLM の誤検知 / 解釈違い。何もしない";
}

function actionPlaceholder(a: TriageAction): string {
  if (a === "fix_in_this_ticket") return "implementer に何をしてほしいか (1 行)";
  if (a === "accept") return "なぜ Out of scope として許容するか (1 行)";
  if (a === "defer") return "なぜ別 ticket で対応するか (1 行)";
  return "なぜ誤検知と判断したか (1 行)";
}

function actionButtonClass(a: TriageAction): string {
  if (a === "fix_in_this_ticket") return "btn-error";
  if (a === "accept") return "btn-warning";
  if (a === "defer") return "btn-info";
  return "btn-ghost border border-base-300";
}

/** Pulls the most recent `## Mockup` block out of the note and renders it
 *  for the human at plan_gate. The planner is instructed to write this
 *  block — fenced as ```html / ```mermaid / ```svg / ```cli / ```ts etc.
 *  so the human sees the shape of the deliverable BEFORE approving the
 *  plan. Markdown component renders mermaid + svg fences as visuals. */
function MockupView({ runId }: { runId: string }) {
  const note = useRunNote(runId);
  const mockup = note.data ? extractMockupSection(note.data) : null;
  if (!mockup) return null;
  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body p-3 gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Mockup preview</h3>
          <span className="badge badge-ghost badge-xs">from plan</span>
        </div>
        <Markdown source={mockup} className="text-sm" runId={runId} />
      </div>
    </div>
  );
}

/** Find the latest `## Mockup` (case-insensitive) section in the note and
 *  return its body up to the next `## ` heading. Returns null if none. */
function extractMockupSection(note: string): string | null {
  // Match every `## Mockup` heading; return the body of the LAST one (the
  // most recent round wins if the planner re-rendered).
  const re = /^##[ \t]+Mockup\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|\Z)/gim;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(note)) !== null) {
    last = m[1].trim();
  }
  return last && last.length > 0 ? last : null;
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
  const mermaids = files.filter((f) => f.kind === "mermaid");
  const htmls = files.filter((f) => f.kind === "html");
  const others = files.filter(
    (f) => f.kind !== "image" && f.kind !== "mermaid" && f.kind !== "html",
  );
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
      {mermaids.map((f) => (
        <MermaidEvidence key={f.filename} file={f} />
      ))}
      {htmls.map((f) => (
        <HtmlEvidence key={f.filename} file={f} />
      ))}
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

/** Fetch a `.mmd` evidence file and render its mermaid source as inline SVG. */
function MermaidEvidence({ file }: { file: EvidenceRound["files"][number] }) {
  const [source, setSource] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchText(file.url)
      .then((t) => {
        if (!cancelled) setSource(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(String((e as Error).message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [file.url]);
  return (
    <div className="card bg-base-200">
      <div className="card-body p-2 gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono">{file.filename}</span>
          <a className="link opacity-60" href={file.url} target="_blank" rel="noopener noreferrer">
            raw
          </a>
        </div>
        {err ? (
          <div className="alert alert-warning text-xs">{err}</div>
        ) : source === null ? (
          <span className="loading loading-spinner loading-xs" />
        ) : (
          <MermaidView source={source} />
        )}
      </div>
    </div>
  );
}

/** Render an `.html` evidence file in a sandboxed iframe. The sandbox keeps
 *  scripts and forms disabled so an LLM-generated mock can't escape into
 *  the surrounding UI. */
function HtmlEvidence({ file }: { file: EvidenceRound["files"][number] }) {
  return (
    <div className="card bg-base-200">
      <div className="card-body p-2 gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono">{file.filename}</span>
          <a className="link opacity-60" href={file.url} target="_blank" rel="noopener noreferrer">
            open in tab
          </a>
        </div>
        <iframe
          src={file.url}
          title={file.filename}
          sandbox=""
          className="w-full h-64 bg-base-100 rounded border border-base-300"
        />
      </div>
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
