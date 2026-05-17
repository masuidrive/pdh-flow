import { useState } from "react";
import { postJson } from "../lib/api";
import type { ActiveTurn, RunSummary } from "../types/api";
import { useTerminal } from "./TerminalModal";
import { scrollToTop } from "../lib/scroll";

/** Wraps the active-turn / processing-answer states and renders nothing
 *  when neither applies. The parent feeds RunSummary directly. */
export function TurnCardWrap({ runId, s }: { runId: string; s: RunSummary }) {
  if (s.active_turn) return <ActiveTurnForm runId={runId} turn={s.active_turn} />;
  if (s.processing_answer) return <ProcessingAnswerBanner />;
  return null;
}

function ProcessingAnswerBanner() {
  return (
    <div className="card bg-warning/10 border border-warning shadow">
      <div className="card-body py-3">
        <div className="flex items-center gap-3">
          <span className="loading loading-spinner loading-sm text-warning" />
          <div className="text-sm">
            <div className="font-medium">Engine is generating its response…</div>
            <div className="text-xs opacity-70">
              Your answer was accepted. The provider is now resuming and writing the final output. This usually
              takes a few seconds.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActiveTurnForm({ runId, turn: t }: { runId: string; turn: ActiveTurn }) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<{ msg: string; tone: "ok" | "err" | "neutral" } | null>(null);
  const term = useTerminal();
  const hasOptions = (t.options ?? []).length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ msg: "Submitting…", tone: "neutral" });
    try {
      let finalText = text.trim();
      const body: { text: string; selected_option?: number } = { text: "" };
      if (selected !== null) body.selected_option = selected;
      if (!finalText && selected !== null) {
        finalText = (t.options?.[selected]?.label ?? "").trim();
      }
      if (!finalText) {
        throw new Error("pick an option or supply an answer");
      }
      body.text = finalText;
      await postJson(
        `/api/runs/${encodeURIComponent(runId)}/turns/${encodeURIComponent(t.node_id)}/${encodeURIComponent(
          String(t.turn),
        )}`,
        body,
      );
      setStatus({ msg: "answer submitted — engine will resume the provider within ~1 s.", tone: "ok" });
      scrollToTop();
    } catch (err) {
      setStatus({ msg: String((err as Error).message ?? err), tone: "err" });
    }
  }

  return (
    <div className="card bg-info/10 border border-info shadow">
      <div className="card-body">
        <h2 className="card-title text-lg">
          In-step question — <span className="font-mono text-sm">{t.node_id}</span> turn {t.turn}
        </h2>
        <p className="text-sm whitespace-pre-wrap">{t.question}</p>
        {t.context ? (
          <details className="text-xs opacity-70">
            <summary>Context</summary>
            <pre className="pre-wrap mt-1">{t.context}</pre>
          </details>
        ) : null}
        <form onSubmit={submit} className="space-y-2 mt-2">
          {hasOptions ? (
            <div className="space-y-1">
              {(t.options ?? []).map((o, i) => (
                <label key={i} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="turn-option"
                    className="radio radio-sm mt-1"
                    checked={selected === i}
                    onChange={() => setSelected(i)}
                  />
                  <span className="text-sm">
                    <span className="font-medium">{o.label}</span>{" "}
                    {o.description ? <span className="opacity-70 text-xs">— {o.description}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          <label className="form-control">
            <span className="label-text text-xs">
              Answer {hasOptions ? "(optional — defaults to the selected option's label)" : "(required)"}
            </span>
            <textarea
              className="textarea textarea-bordered textarea-sm"
              rows={3}
              placeholder={hasOptions ? "extra detail or override the option" : "your answer"}
              required={!hasOptions}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-info btn-sm">
              Submit answer
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => term.open({ runId, nodeId: t.node_id })}
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
        </form>
      </div>
    </div>
  );
}
