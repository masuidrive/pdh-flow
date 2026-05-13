// Gate decision-support summary.
//
// When a gate is active, the PdM (or whoever is approving) needs to read
// ticket + note + product-brief to make a call. This module asks an LLM
// to distil all three into ≤30 lines of decision-support markdown so the
// approver gets a fast read instead of scrolling through three files.
//
// The result is cached on disk per (run, node, round). Approving the same
// gate twice or refreshing the page returns the cached text — only an
// explicit `regenerate=1` re-invokes the provider.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { invokeProvider, type ProviderName } from "../engine/providers/index.ts";
import { renderPrompt } from "../engine/prompts/render.ts";

export interface GateSummary {
  summary: string;
  cached: boolean;
  generated_at: string;
  has_brief: boolean;
  round: number;
  provider: ProviderName;
}

// Gate-summary defaults to opus for nuanced product reasoning. Override
// with `PDHFLOW_GATE_SUMMARY_PROVIDER=codex` (or sonnet/haiku) to swap
// model without touching the call site.
const DEFAULT_PROVIDER: ProviderName = (() => {
  const v = process.env.PDHFLOW_GATE_SUMMARY_PROVIDER;
  if (v === "codex" || v === "opus" || v === "sonnet" || v === "haiku") return v;
  return "opus";
})();

// Hard wall-clock cap for the LLM call. The summary is short and
// non-interactive, so 2 minutes is plenty.
const TIMEOUT_MS = 120_000;

export async function getGateSummary(opts: {
  worktreePath: string;
  runId: string;
  nodeId: string;
  regenerate?: boolean;
}): Promise<GateSummary> {
  const round = readRound(opts.worktreePath, opts.runId);
  const cacheDir = join(
    opts.worktreePath,
    ".pdh-flow",
    "runs",
    opts.runId,
    "gate-summaries",
  );
  const cachePath = join(cacheDir, `${opts.nodeId}__round-${round}.json`);

  if (!opts.regenerate && existsSync(cachePath)) {
    try {
      const obj = JSON.parse(readFileSync(cachePath, "utf8")) as GateSummary;
      return { ...obj, cached: true };
    } catch {
      // fall through and regenerate on parse error
    }
  }

  const ticket = readIfExists(join(opts.worktreePath, "current-ticket.md"));
  const note = readIfExists(join(opts.worktreePath, "current-note.md"));
  const brief = readIfExists(join(opts.worktreePath, "product-brief.md"));

  // Pick a gate-specific template when one exists; fall back to the
  // generic gate-summary template otherwise. The per-gate templates
  // narrow scope (e.g. environment_gate only asks about real-env AC
  // readiness, not plan quality) so the summary doesn't drift into
  // plan-level discussion.
  const template = pickGateTemplate(opts.nodeId);

  const prompt = renderPrompt(template, {
    nodeId: opts.nodeId,
    round,
    ticket,
    note,
    brief,
  });

  const result = await invokeProvider(DEFAULT_PROVIDER, {
    prompt,
    cwd: opts.worktreePath,
    editable: false,
    timeoutMs: TIMEOUT_MS,
    model: DEFAULT_PROVIDER,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `gate-summary provider failed (exit ${result.exitCode}): ${result.stderrTail.slice(0, 400)}`,
    );
  }
  const summary = (result.text ?? "").trim();
  if (!summary) {
    throw new Error("gate-summary provider returned empty text");
  }

  const out: GateSummary = {
    summary,
    cached: false,
    generated_at: new Date().toISOString(),
    has_brief: brief !== null,
    round,
    provider: DEFAULT_PROVIDER,
  };
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(out, null, 2));
  return out;
}

function readRound(worktreePath: string, runId: string): number {
  const snapPath = join(worktreePath, ".pdh-flow", "runs", runId, "snapshot.json");
  if (!existsSync(snapPath)) return 0;
  try {
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
      xstate_snapshot?: { context?: { round?: number } };
    };
    const r = snap.xstate_snapshot?.context?.round;
    return typeof r === "number" ? r : 0;
  } catch {
    return 0;
  }
}

/** Pick the prompt template for a given gate node id. Per-gate templates
 *  narrow scope (environment_gate only checks real-env readiness; plan_gate
 *  only checks plan quality; etc.) so the summary stays focused. Unknown
 *  gates fall back to the generic `gate-summary` template. */
function pickGateTemplate(nodeId: string): string {
  switch (nodeId) {
    case "plan_gate":
      return "gate-summary-plan";
    case "verification_gate":
      return "gate-summary-verification";
    case "close_gate":
      return "gate-summary-close";
    default:
      return "gate-summary";
  }
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

