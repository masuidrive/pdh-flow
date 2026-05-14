// Gate decision-support summary.
//
// When a gate is active, the PdM (or whoever is approving) needs to read
// ticket + note + product-brief to make a call. This module asks an LLM
// to distil all three into:
//   - `summary_md` — ≤30 lines of decision-support markdown (rendered as-is).
//   - `concerns[]` — structured array the FE uses to drive the per-concern
//     triage panel. The FE NEVER re-parses summary_md to find concerns —
//     the LLM commits to keeping the two in sync inside a single call.
//   - `recommendation` — top-level approve / reject hint.
//
// Output is enforced via the provider's --json-schema / --output-schema
// flag (Ajv on our side as a second wall). Cached on disk per
// (run, node, round); regenerate=1 re-invokes.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { invokeProvider, type ProviderName } from "../engine/providers/index.ts";
import { renderPrompt } from "../engine/prompts/render.ts";
import { getValidator, SCHEMA_IDS } from "../engine/validate.ts";
import type { GateSummaryOutput, Concern } from "../types/generated/gate-summary-output.schema.d.ts";

export interface GateSummary {
  /** Human-facing markdown rendered as-is in the decision panel. */
  summary_md: string;
  /** Machine-readable concerns list — drives the triage UI. Always
   *  present (possibly empty); the FE never parses summary_md. */
  concerns: Concern[];
  /** LLM's top-level read. The PdM may override; this is recorded as the
   *  call's opinion at generation time. */
  recommendation: "approve" | "reject" | "other";
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

/** Inline slim schema passed to the provider CLI's --json-schema flag.
 *  The CLI can't follow cross-file $refs in our canonical schema, so we
 *  hand-roll a flat version that matches gate-summary-output.schema.json's
 *  shape. The full schema is enforced again on our side via Ajv after
 *  the provider returns, so any drift between the two surfaces here. */
function inlineGateSummarySchema(): Record<string, unknown> {
  const concern = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 1000 },
      severity: { type: "string", enum: ["minor", "major", "critical"] },
      status: {
        type: "string",
        enum: ["accepted", "deferred", "noted", "new"],
      },
      source_node: { type: "string", maxLength: 80 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary_md", "concerns", "recommendation"],
    properties: {
      summary_md: { type: "string", minLength: 1, maxLength: 8000 },
      concerns: { type: "array", maxItems: 20, items: concern },
      recommendation: {
        type: "string",
        enum: ["approve", "reject", "other"],
      },
    },
  };
}

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
      const obj = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<GateSummary>;
      // Stale cache from the pre-structured-output era only has
      // `summary` (markdown string), no `concerns[]`. Treat that as a
      // miss so the next read regenerates against the new schema.
      if (
        typeof obj.summary_md === "string" &&
        Array.isArray(obj.concerns) &&
        typeof obj.recommendation === "string"
      ) {
        return { ...(obj as GateSummary), cached: true };
      }
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
    jsonSchema: inlineGateSummarySchema(),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `gate-summary provider failed (exit ${result.exitCode}): ${result.stderrTail.slice(0, 400)}`,
    );
  }
  if (result.jsonOutput === undefined) {
    throw new Error(
      "gate-summary provider returned no JSON output (jsonSchema enforcement failed)",
    );
  }
  // Second wall: validate against the canonical schema. The provider CLI
  // only enforces the slim inline copy; this catches anything the inline
  // copy was too permissive about.
  const validated = getValidator().validate<GateSummaryOutput>(
    SCHEMA_IDS.gateSummaryOutput,
    result.jsonOutput,
  );
  if (validated.ok === false) {
    throw new Error(
      `gate-summary output failed schema validation: ${validated.errors
        .map((e) => `${e.instancePath} ${e.message}`)
        .join("; ")}`,
    );
  }

  const out: GateSummary = {
    summary_md: validated.data.summary_md,
    concerns: validated.data.concerns as Concern[],
    recommendation: validated.data.recommendation,
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
