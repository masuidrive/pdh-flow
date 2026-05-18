// Provider step actor — dual-mode (fixture / real).
//
// When `fixtureMeta.node_outputs[nodeId][round-N]` is present, replays the
// recorded note_section + files (used by the test harness). Otherwise the
// actor invokes the real claude/codex CLI: it builds a prompt from
// `promptSpec` + `role` + flow context, captures the assistant's text
// response, appends it to current-note.md as a section keyed by nodeId,
// and commits.

import { fromPromise } from "xstate";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { cliBinaryFor, invokeProvider, type ProviderName } from "../providers/index.ts";
import { renderPrompt } from "../prompts/render.ts";
import { appendEvent } from "../events-log.ts";
import {
  readProviderSession,
  saveProviderSession,
} from "../session-store.ts";
import { assertTicketUnmodified, hashTicket } from "../ticket-guard.ts";
import { tickVerifiedAcs } from "./run-system.ts";
import {
  awaitTurnAnswer,
  clearTurnsDir,
  writeTurnAnswer,
  writeTurnQuestion,
} from "../turn-store.ts";
import { getValidator, SCHEMA_IDS } from "../validate.ts";
import { writeNoteOutput } from "../notes.ts";
import type {
  ProviderStepOutputEnvelope,
  TurnAsk,
  TurnFinal,
} from "../../types/index.ts";
import type { FinalVerifierOutput } from "../../types/generated/final-verifier-output.schema.d.ts";

export interface ProviderActorInput {
  nodeId: string;
  round: number;
  worktreePath: string;
  /** Concrete provider id resolved at compile time from the active
   *  providers profile (`opus`/`sonnet`/`haiku`/`codex`). Carries the model
   *  for claude-family providers. Optional only because fixture-replay
   *  runs may skip the real provider entirely. */
  provider?: ProviderName;
  role?: string;
  promptSpec?: {
    intent?: string;
    note_section?: string;
    note_target?: import("../notes.ts").NoteTarget;
    commit_summary?: string;
    checkpoints?: string[];
    [k: string]: unknown;
  };
  /** When set, fixture mode replays this. Otherwise real provider runs. */
  fixtureMeta?: FixtureMeta;
  /** Engine run id; required for saving provider session ids (F-001). */
  runId?: string;
  /** Ticket id (slug) the run is operating on. Used by the
   *  final_verifier actor to flip `[ ]` → `[x]` on verified AC lines
   *  in `tickets/<ticketId>.md` right after writing the judgement,
   *  so close_gate's diff view shows the ticks. */
  ticketId?: string;
  /**
   * F-001/J4: when set, the actor looks up
   * `runs/<runId>/sessions/<resumeSessionFrom>.json` and, on hit, invokes
   * the provider with --resume so it continues that prior session. On
   * miss, falls back to a fresh invocation with the configured prompt.
   * Populated by the macro expander when review_loop.repair.via=resume.
   */
  resumeSessionFrom?: string;
  /**
   * F-012: opt-in to the in-step turn loop. When true, the actor runs
   * a turn loop where the provider may emit a `request_human_input`
   * envelope instead of a final answer; the engine writes a
   * `turn-NNN-question.json`, polls for the matching answer file, and
   * resumes the provider session with the answer text.
   */
  enableUserInput?: boolean;
}

export interface ProviderActorOutput {
  status: "completed" | "failed";
  nodeId: string;
  round: number;
  summary: string;
  commitSha: string;
  /** True if fixture-replayed; false if real LLM. */
  fromFixture: boolean;
}

export interface FixtureMeta {
  scenario: string;
  node_outputs?: Record<
    string,
    Record<
      string,
      {
        note_section?: string;
        summary?: string;
        guardian_output?: unknown;
        files?: Record<string, string>;
        /**
         * F-012/K3-mini: pre-recorded in-step turns. When present, the
         * fixture replay writes turn-NNN-question.json and
         * turn-NNN-answer.json under runs/<runId>/turns/<nodeId>/ in
         * lockstep, then proceeds to apply note_section / files /
         * summary as the final outcome. Lets a fixture exercise the
         * F-012 turn-file machinery without invoking a real provider.
         */
        turns?: Array<{ question: string; answer: string }>;
      }
    >
  >;
}

export const runProvider = fromPromise<
  ProviderActorOutput,
  ProviderActorInput
>(async ({ input, signal }) => {
  const { nodeId, round, worktreePath } = input;
  const roundKey = `round-${round}`;
  const nodeFixture =
    input.fixtureMeta?.node_outputs?.[nodeId]?.[roundKey];

  // Emit a "started" beacon to events.jsonl so the Web UI's bottom bar
  // can show "running <role> (<provider>) — Xs" while we work, then
  // pair it with a "finished" beacon below in try/finally.
  const startTs = Date.now();
  if (input.runId) {
    appendEvent(worktreePath, input.runId, {
      ts: new Date(startTs).toISOString(),
      node_id: nodeId,
      round,
      kind: "provider_start",
      provider: input.provider,
      role: input.role,
    });
  }

  try {

  ensureGit(worktreePath);

  // F-011/H10-5: capture ticket file hash before provider/fixture work
  // so we can reject any actor that tries to edit it without authorization.
  const ticketPreHash = hashTicket(worktreePath);

  let summary: string;
  let noteSection: string;

  if (nodeFixture) {
    // ── Fixture replay ─────────────────────────────────────────────────
    // F-012/K3-mini: when the fixture declares `turns`, the replay
    // mimics the in-step Q/A loop by writing question + answer files in
    // lockstep. The note-section / files / summary then carry the
    // *final* outcome as a normal fixture entry.
    if (nodeFixture.turns && nodeFixture.turns.length > 0 && input.runId) {
      const now = new Date().toISOString();
      let turnIdx = 0;
      for (const t of nodeFixture.turns) {
        turnIdx += 1;
        writeTurnQuestion({
          worktreePath,
          runId: input.runId,
          question: {
            status: "pending",
            node_id: nodeId,
            round,
            turn: turnIdx,
            asked_at: now,
            ask: { question: t.question },
          },
        });
        writeTurnAnswer({
          worktreePath,
          runId: input.runId,
          answer: {
            status: "completed",
            node_id: nodeId,
            round,
            turn: turnIdx,
            answered_at: now,
            answer: { text: t.answer },
            via: "cli",
          },
        });
      }
    }

    summary = nodeFixture.summary ?? `${nodeId} ${roundKey}`;
    noteSection = nodeFixture.note_section ?? "";

    // Apply file overrides (e.g. repair patches a source file).
    if (nodeFixture.files) {
      for (const [relPath, content] of Object.entries(nodeFixture.files)) {
        const full = join(worktreePath, relPath);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
  } else if (input.enableUserInput) {
    // ── F-012/K2: real-mode in-step turn loop ─────────────────────────
    if (!input.provider) {
      throw new Error(
        `provider actor: enable_user_input requires real provider (no fixture for ${nodeId} ${roundKey})`,
      );
    }
    if (!input.runId) {
      throw new Error(
        `provider actor: enable_user_input requires runId (cannot persist turn files without it)`,
      );
    }
    const result = await runTurnLoop({
      input,
      signal,
      worktreePath,
      ticketPreHash,
    });
    summary = result.summary;
    noteSection = result.noteSection;
  } else {
    // ── Real provider invocation ───────────────────────────────────────
    if (!input.provider) {
      throw new Error(
        `provider actor: no fixture for ${nodeId} ${roundKey} and no real provider configured`,
      );
    }
    const prompt = buildPromptForProvider({
      nodeId,
      round,
      role: input.role ?? "reviewer",
      promptSpec: input.promptSpec ?? {},
      runId: input.runId,
      worktreePath,
    });
    const editable = roleNeedsEdit(input.role ?? "reviewer", nodeId);
    // F-001/J4: if this node is configured to resume an upstream node's
    // session, look it up and pass --resume to the provider. On miss we
    // silently fall back to a fresh invocation; on a CLI rejection we
    // surface the error (caller can decide whether to retry).
    let resumeSessionId: string | undefined;
    if (input.resumeSessionFrom && input.runId) {
      const rec = readProviderSession({
        worktreePath,
        runId: input.runId,
        nodeId: input.resumeSessionFrom,
      });
      // Match the CLI binary, not the model id — `opus`/`sonnet`/`haiku`
      // all resume through the same `claude --resume` and are compatible
      // with each other. `codex` resumes only against codex sessions.
      const inputCli = cliBinaryFor(input.provider);
      if (rec && rec.provider === inputCli) {
        resumeSessionId = rec.sessionId;
      } else if (rec && rec.provider !== inputCli) {
        process.stderr.write(
          `[run-provider] ${nodeId}: cannot resume — recorded session for ${input.resumeSessionFrom} is cli=${rec.provider}, but this node is provider=${input.provider} (cli=${inputCli}). Falling back to fresh.\n`,
        );
      }
    }
    // final_verifier emits a structured JSON object so close_gate can read
    // the AC verdict directly from `ac_verification[]` instead of parsing
    // the markdown table back out of current-note.md. Other roles still
    // run as free-prose providers.
    const useStructuredOutput = input.role === "final_verifier";
    const result = await invokeProvider(input.provider, {
      prompt,
      cwd: worktreePath,
      signal,
      editable,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(useStructuredOutput
        ? { jsonSchema: inlineFinalVerifierSchema() }
        : {}),
      // `model` is set by the dispatcher in providers/index.ts from
      // `provider`; ProviderInvocation requires it, but callers no longer
      // pass it manually.
      model: input.provider,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${input.provider} ${nodeId} ${roundKey} failed (exit=${result.exitCode}, timedOut=${result.timedOut}): ${result.stderrTail.slice(-500)}`,
      );
    }
    if (useStructuredOutput) {
      // Validated against the canonical schema (defense in depth — the CLI
      // already enforced the inline copy). On success we use summary_md
      // as the note body and persist the whole envelope to a judgement
      // sidecar so close_gate's countUnverified... reader can find it.
      //
      // OpenAI structured-output requires every property to appear in
      // `required`; we model "optional" string fields via a
      // [string, null] union in the inline schema we send to codex.
      // Canonical schema (Ajv-side) keeps the fields strictly optional,
      // so strip null-valued evidence_path / note before re-validating.
      const stripped = stripNullOptionals(result.jsonOutput);
      const validated = getValidator().validate<FinalVerifierOutput>(
        SCHEMA_IDS.finalVerifierOutput,
        stripped,
      );
      if (validated.ok === false) {
        throw new Error(
          `${input.provider} ${nodeId} ${roundKey}: final_verifier output failed schema validation: ` +
            validated.errors.map((e) => `${e.instancePath} ${e.message}`).join("; "),
        );
      }
      summary = extractSummary(
        validated.data.summary_md,
        `${nodeId} ${roundKey}`,
      );
      noteSection = `## ${nodeId} (round ${round})\n\n${validated.data.summary_md}\n`;
      if (input.runId) {
        saveFinalVerifierJudgement({
          worktreePath,
          runId: input.runId,
          nodeId,
          round,
          output: validated.data,
        });
      }
    } else {
      const text = result.text.trim();
      if (text.length === 0) {
        throw new Error(
          `${input.provider} ${nodeId} ${roundKey} produced empty output`,
        );
      }
      summary = extractSummary(text, `${nodeId} ${roundKey}`);
      noteSection = `## ${nodeId} (round ${round})\n\n${text}\n`;
    }

    // F-001/J3: persist the provider session id (when the CLI surfaced
    // one) so a later node can `--resume` this conversation. Best-effort:
    // if runId is missing or the file write fails, the worst case is a
    // resume-configured downstream falls back to a fresh invocation.
    if (input.runId && result.sessionId) {
      try {
        saveProviderSession({
          worktreePath,
          runId: input.runId,
          nodeId,
          round,
          provider: cliBinaryFor(input.provider),
          sessionId: result.sessionId,
        });
      } catch (e) {
        process.stderr.write(
          `[run-provider] failed to save session id for ${nodeId} ${roundKey}: ${(e as Error).message}\n`,
        );
      }
    }
  }

  // F-011/H10-5: providers (reviewer / implement / repair / assist /
  // planner) MUST NOT modify the ticket. Catch any LLM-tool-use slip
  // before we stage / commit so the violation surfaces clearly.
  assertTicketUnmodified({
    worktreePath,
    preHash: ticketPreHash,
    actor: { kind: "provider", nodeId, role: input.role },
  });

  // ── Append note + (maybe) commit ──────────────────────────────────────
  // Honour the node's `note_target` if configured:
  //   - replace: own a set of `## <header>` sections that get overwritten
  //     each round (PD-C dashboard slots).
  //   - archive: append under `## audit log` as a `### nodeId (round N)`
  //     sub-section (reviewer history etc.).
  //   - unset: fall back to the legacy `## nodeId (round N)` append.
  if (noteSection) {
    const stripped = stripLeadingNodeHeader(noteSection, nodeId, round);
    writeNoteOutput({
      notePath: join(worktreePath, "current-note.md"),
      nodeId,
      round,
      body: stripped,
      target: input.promptSpec?.note_target ?? null,
    });
  }

  // final_verifier-only: flip `- [ ] **AC<N>** ...` to `- [x] **AC<N>** ...`
  // in the ticket for each verified AC. Runs AFTER assertTicketUnmodified
  // so the LLM-vs-engine boundary stays intact (the assertion covers LLM
  // mutations only; engine is allowed to write the ticket post-assert).
  // Doing this here, not in close_finalize, means close_gate's diff view
  // already shows the ticks — humans review with full information.
  // close_finalize still calls the same helper as defense-in-depth;
  // re-running is idempotent.
  if (input.role === "final_verifier" && input.runId && input.ticketId) {
    try {
      const ticketPath = join(
        worktreePath,
        "tickets",
        `${input.ticketId}.md`,
      );
      if (existsSync(ticketPath)) {
        tickVerifiedAcs(worktreePath, input.runId, ticketPath);
      }
    } catch (err) {
      process.stderr.write(
        `[run-provider] AC checkbox tick skipped for ${nodeId} ${roundKey}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  run("git", ["add", "-A"], worktreePath);

  // F-011/H10-3: drop D-003. Reviewer nodes inside a review_loop
  // parallel_group only stage their note diff; the next aggregator
  // (or repair) commit picks them up. Net effect: a clean run produces
  // ~8 commits instead of ~16 — bisect granularity is preserved at
  // the meaningful-step level (assist / investigate_plan / plan_review
  // aggregate / plan_gate / implement / code_quality_review aggregate /
  // final_verification + close), and reviewer audit lives in the note's
  // section headers (which the aggregator commit folds in).
  const skipCommit = isReviewerInLoop(nodeId);
  let sha: string;
  if (skipCommit) {
    sha = run("git", ["rev-parse", "HEAD"], worktreePath).stdout.trim();
  } else {
    const subject = `[${nodeId}/${roundKey}] ${summary}`;
    const commitResult = run(
      "git",
      [
        "-c",
        "user.email=engine@pdh-flow.local",
        "-c",
        "user.name=pdh-flow-engine",
        "commit",
        "-m",
        subject,
        "--allow-empty",
      ],
      worktreePath,
    );
    if (commitResult.status !== 0) {
      throw new Error(
        `provider actor: git commit failed for ${nodeId} ${roundKey}: ${commitResult.stderr}`,
      );
    }
    sha = run("git", ["rev-parse", "HEAD"], worktreePath).stdout.trim();
  }

  if (input.runId) {
    appendEvent(worktreePath, input.runId, {
      ts: new Date().toISOString(),
      node_id: nodeId,
      round,
      kind: "provider_finish",
      provider: input.provider,
      role: input.role,
      outcome: nodeFixture ? "fixture" : "ok",
      duration_ms: Date.now() - startTs,
    });
  }
  return {
    status: "completed",
    nodeId,
    round,
    summary,
    commitSha: sha,
    fromFixture: !!nodeFixture,
  };
  } catch (e) {
    if (input.runId) {
      appendEvent(worktreePath, input.runId, {
        ts: new Date().toISOString(),
        node_id: nodeId,
        round,
        kind: "provider_finish",
        provider: input.provider,
        role: input.role,
        outcome: "error",
        duration_ms: Date.now() - startTs,
        error: e instanceof Error ? e.message.slice(0, 400) : String(e).slice(0, 400),
      });
    }
    throw e;
  }
});

interface PromptBuilderInput {
  nodeId: string;
  round: number;
  role: string;
  promptSpec: { intent?: string; checkpoints?: string[]; note_section?: string };
  /** Run id, used by roles that need to write per-round artifacts under
   *  `<worktree>/.pdh-flow/runs/<runId>/...` (e.g. final_verifier
   *  evidence capture). Optional — not every prompt needs it. */
  runId?: string;
  /** Worktree root. Used by builders that read durable state (e.g. the
   *  implementer checks the latest qa judgement to detect qa_repair mode). */
  worktreePath?: string;
}

/**
 * True when this provider_step is a reviewer member of a review_loop's
 * parallel_group. F-011/H10-3: such nodes stage their note diff instead
 * of producing their own commit; the aggregator's commit folds them in.
 *
 * Reviewer ids follow the macro-expanded pattern `<parent>.<role>_<i>`,
 * e.g. `plan_review.devils_advocate_1`. Aggregator (`.aggregate`) and
 * repair (`.repair`) deliberately don't match — they keep committing.
 */
function isReviewerInLoop(nodeId: string): boolean {
  return /\.[a-z][a-z0-9_]*_\d+$/.test(nodeId);
}

/** True when the role / node implies file edits (implementer + repair). */
function roleNeedsEdit(role: string, nodeId: string): boolean {
  const r = role.toLowerCase();
  if (
    r === "implementer" ||
    r === "implement" ||
    r === "repair" ||
    r.endsWith("_repair") ||
    // final_verifier drives the deliverable in its real runtime
    // (dev server, browser automation, evidence capture) and writes
    // screenshots / logs to .pdh-flow/runs/<runId>/evidence/round-N/.
    r === "final_verifier" ||
    // purpose_validator reads source + Status logs and may need git log
    // via Bash. Needs bypassPermissions to use tools in claude `-p` mode
    // without prompts.
    r === "purpose_validator"
  ) return true;
  // Naming convention: any node id ending in `.repair` is a repair node.
  if (nodeId.toLowerCase().endsWith(".repair")) return true;
  return false;
}

/**
 * Role-driven prompt selection.
 *
 * Roles map to authoring patterns:
 *   - assist: pick up the ticket, write Status section. No code edits.
 *   - planner / investigate_plan: investigate + plan, write to note. No code edits.
 *   - implementer / repair: edit source + tests. Heavy tool use.
 *   - reviewer-style (devils_advocate / code_reviewer / critical / etc.): read + review,
 *     end with VERDICT line. No edits.
 *   - aggregator: handled by guardian actor (separate file).
 *   - final_verifier: editable provider that drives the deliverable
 *     end-to-end and stages evidence files for close_gate review.
 */
function buildPromptForProvider(p: PromptBuilderInput): string {
  const role = p.role.toLowerCase();
  if (role === "assist") return buildAssistPrompt(p);
  // pdh-d epic-cycle roles: dedicated templates (Exit Criteria
  // verification / user-case test). They take intent + checkpoints
  // from the flow YAML like the other role builders.
  if (role === "epic_verifier") return buildEpicCyclePrompt("epic-verifier", p);
  if (role === "ucs_tester") return buildEpicCyclePrompt("ucs-tester", p);
  if (role === "planner" || role === "investigate" || role === "investigator") {
    return buildPlannerPrompt(p);
  }
  if (
    role === "implementer" ||
    role === "implement" ||
    role === "repair" ||
    role.endsWith("_repair")
  ) {
    return buildImplementerPrompt(p);
  }
  if (role === "final_verifier") return buildFinalVerifierPrompt(p);
  // purpose_validator (PdM, claude opus) audits
  // the final_verification table for unverified ACs and the diff for
  // "should-have-been-built but wasn't" gaps. Reject path returns to
  // implement.
  if (role === "purpose_validator") return buildEpicCyclePrompt("purpose-validator", p);
  // F-012/K6: dedicated role for the turn-loop smoke. Its template is
  // explicit about asking exactly one clarifying question, which makes
  // the smoke deterministic enough to verify the loop without having
  // to coax a generic role into asking.
  if (role === "turn_smoke") {
    return renderPrompt("turn-smoke", {
      nodeId: p.nodeId,
      intent: p.promptSpec.intent,
    });
  }
  // Default: reviewer pattern (works for any review-shaped role).
  return buildReviewerPrompt(p);
}

function buildAssistPrompt(p: PromptBuilderInput): string {
  return renderPrompt("assist", {
    nodeId: p.nodeId,
    intent: p.promptSpec.intent,
  });
}

function buildEpicCyclePrompt(template: string, p: PromptBuilderInput): string {
  return renderPrompt(template, {
    nodeId: p.nodeId,
    round: p.round,
    intent: p.promptSpec.intent,
    checkpoints: p.promptSpec.checkpoints ?? [],
  });
}

function buildPlannerPrompt(p: PromptBuilderInput): string {
  return renderPrompt("planner", {
    nodeId: p.nodeId,
    round: p.round,
    checkpoints: p.promptSpec.checkpoints ?? [],
  });
}

function implementerMode(
  role: string,
  nodeId: string,
  ctx?: { worktreePath?: string; runId?: string },
): "plan_repair" | "code_repair" | "qa_repair" | "gate_fix" | "default" {
  const r = role.toLowerCase();
  const lc = nodeId.toLowerCase();
  // plan_review.repair: address findings against the PLAN artifact, not code.
  // The repair node loops back into plan_review, so source edits here would
  // jump ahead of the implement node and pollute the plan stage.
  if (r === "plan_repair" || (lc.startsWith("plan_review.") && lc.includes("repair"))) {
    return "plan_repair";
  }
  if (r.includes("repair") || lc.includes("repair")) return "code_repair";
  // gate_fix: the most recent close_gate decision was `rejected` and at
  // least one concern was triaged as `fix_in_this_ticket`. Highest
  // priority among "why are we re-entering implement" because it carries
  // an explicit PdM instruction list. Check this BEFORE qa_repair so a
  // gate-driven re-entry isn't confused with a qa-driven one.
  if (ctx?.worktreePath && ctx.runId && hasRejectedFixActions(ctx.worktreePath, ctx.runId)) {
    return "gate_fix";
  }
  // qa_repair: the latest qa judgement for any node is a FAIL. The engine
  // routes qa.on_failure back to implement; the implementer should focus on
  // fixing the failing tests, not re-implementing. Signal-only — the prompt
  // tells the LLM to read `## qa` from the note for the actual failures.
  if (ctx?.worktreePath && ctx.runId && hasLatestQaFailure(ctx.worktreePath, ctx.runId)) {
    return "qa_repair";
  }
  return "default";
}

/** True when the latest close_gate decision is `rejected` AND its
 *  concern_triage contains at least one fix_in_this_ticket entry. The
 *  PdM has explicitly asked the implementer to address concerns in this
 *  ticket before close can be retried.
 *
 *  Prefers the consumed-archive path (`close_gate__consumed.json`) since
 *  the active slot is moved aside immediately after the engine consumes
 *  a decision. Falls back to the active path for forward compatibility
 *  with mid-update runs.
 */
function hasRejectedFixActions(worktreePath: string, runId: string): boolean {
  const gatesDir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  for (const filename of ["close_gate__consumed.json", "close_gate.json"]) {
    try {
      const path = join(gatesDir, filename);
      if (!existsSync(path)) continue;
      const obj = JSON.parse(readFileSync(path, "utf8")) as {
        decision?: string;
        concern_triage?: Array<{ action?: string }>;
      };
      if (obj.decision !== "rejected") return false;
      return (obj.concern_triage ?? []).some(
        (t) => t?.action === "fix_in_this_ticket",
      );
    } catch {
      // try next filename
    }
  }
  return false;
}

/** True when the most recent qa judgement file for this run is a FAIL.
 *  Returns false on any read error or when no qa judgement exists yet. */
function hasLatestQaFailure(worktreePath: string, runId: string): boolean {
  try {
    const judgeDir = join(
      worktreePath,
      ".pdh-flow",
      "runs",
      runId,
      "judgements",
    );
    if (!existsSync(judgeDir)) return false;
    // qa system_step writes `qa__round-N.json`. Sort by round suffix to find
    // the latest (N is monotonically increasing per node).
    const files = readdirSync(judgeDir)
      .filter((f) => /^qa__round-\d+\.json$/.test(f))
      .sort((a, b) => {
        const ra = parseInt(a.match(/round-(\d+)/)?.[1] ?? "0", 10);
        const rb = parseInt(b.match(/round-(\d+)/)?.[1] ?? "0", 10);
        return rb - ra;
      });
    if (files.length === 0) return false;
    const latest = JSON.parse(
      readFileSync(join(judgeDir, files[0]), "utf8"),
    ) as { exit_code?: number | null; kind?: string };
    return latest.kind === "qa_script" && latest.exit_code !== 0;
  } catch {
    return false;
  }
}

function buildImplementerPrompt(p: PromptBuilderInput): string {
  return renderPrompt("implementer", {
    nodeId: p.nodeId,
    round: p.round,
    mode: implementerMode(p.role, p.nodeId, {
      worktreePath: p.worktreePath,
      runId: p.runId,
    }),
    checkpoints: p.promptSpec.checkpoints ?? [],
  });
}

function buildFinalVerifierPrompt(p: PromptBuilderInput): string {
  // Evidence dir is relative to worktree (the provider's cwd) so the
  // agent can write there with plain relative paths. Absent runId we
  // still render — the agent will at least know the convention.
  const evidenceDir = p.runId
    ? `.pdh-flow/runs/${p.runId}/evidence/round-${p.round}`
    : `.pdh-flow/runs/<run>/evidence/round-${p.round}`;
  return renderPrompt("final-verifier", {
    nodeId: p.nodeId,
    round: p.round,
    evidenceDir,
  });
}

function buildReviewerPrompt(p: PromptBuilderInput): string {
  // Naming convention: any node id under `plan_review.*` is a plan reviewer
  // (reviews the plan artifact, not the source diff).
  const mode = p.nodeId.toLowerCase().startsWith("plan_review.")
    ? "plan"
    : "default";
  return renderPrompt("reviewer", {
    nodeId: p.nodeId,
    round: p.round,
    role: p.role,
    mode,
    intent: p.promptSpec.intent,
    checkpoints: p.promptSpec.checkpoints ?? [],
  });
}

function extractSummary(text: string, fallback: string): string {
  // Find the verdict line and use it as a summary; otherwise truncate the
  // first non-empty line.
  const verdictMatch = text.match(/VERDICT:\s*([^\n]+)/i);
  if (verdictMatch) return `Verdict: ${verdictMatch[1].trim()}`.slice(0, 280);
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (firstLine) return firstLine.trim().slice(0, 280);
  return fallback;
}

function run(cmd: string, args: string[], cwd: string): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function ensureGit(worktreePath: string): void {
  if (!existsSync(join(worktreePath, ".git"))) {
    throw new Error(`worktree is not a git repo: ${worktreePath}`);
  }
}

// ─── F-012/K2: in-step turn loop helpers ─────────────────────────────────

const TURN_LOOP_MAX_TURNS = 10;

const ENVELOPE_INSTRUCTION = `

## How to end your turn

How you end your turn depends on whether a human is chatting with you
right now. Probe once, pick exactly one path — never combine.

\`\`\`
test -f ./.pdh-flow/bin/turn-respond
\`\`\`

### If the probe SUCCEEDS — relay the human's reply via the wrapper

A human is chatting with you in an assist terminal. The engine
suspended after your earlier \`kind:"ask"\` and is waiting for the
human's reply to that question. Your job in this session is **just to
relay what the human typed back to the engine** — not to produce any
final analytical output yourself. (After you relay, the engine resumes
the original session in a separate turn, and that's where the
long-form \`kind:"final"\` output is generated.)

Run the wrapper via the Bash tool with the human's reply, distilled
into a short string. Do NOT put your own analysis, paragraph, or
reasoning into \`--text\` — only the human's literal answer.

\`\`\`
./.pdh-flow/bin/turn-respond --option <0-based index>
./.pdh-flow/bin/turn-respond --text "<short verbatim of what the human said>"
./.pdh-flow/bin/turn-respond --text "..." --comment "<extra note the human added>"
\`\`\`

- Use \`--option N\` whenever the human picked one of the listed
  options. \`N\` is the 0-based index into the question's \`options\`
  array.
- Use \`--text\` only for free-form answers; keep it as short as the
  human's actual reply (e.g. one word, one phrase, one sentence). If
  the human picked an option AND added an aside, use
  \`--option N --comment "<aside>"\`.
- \`--comment\` is for short side-notes the human attached to their
  reply. It is not a place for your own commentary.

The wrapper writes a draft; the human confirms via a banner. If they
pick No and ask you to revise the relay, re-run the wrapper with new
args (the draft is overwritten, the banner re-shows). When the
wrapper exits with \`{"ok": true, ...}\` your turn is done — emit no
envelope and no further prose; close out quietly. The engine takes
over from here.

### If the probe FAILS — emit the envelope

The engine is calling you directly, no human in the loop. Reply with
exactly one JSON object on stdout — the entire response is the JSON,
no surrounding prose, no wrapper exec.

\`\`\`
{ "kind": "final" | "ask",
  "final": { "summary": string, "details"?: string },
  "ask":   { "question": string, "options"?: [{ "label": string, "description"?: string }], "context"?: string } }
\`\`\`

- \`kind: "final"\` when you have everything you need. \`final.summary\`
  is one line; \`final.details\` is the full markdown body that goes
  into the note (no Q/A — that's logged separately).
- \`kind: "ask"\` only when a specific decision genuinely requires a
  human. The question must be answerable in one turn. Provide
  \`options\` when there's a small enumerable set of answers;
  otherwise omit and accept free-form text.`;

function envelopeJsonSchema(): Record<string, unknown> {
  // Inline schema (no $refs) so the CLI's --json-schema / --output-schema
  // flag can accept it as a single payload. Mirrors
  // schemas/provider-step-output.schema.json but with $defs flattened.
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: ["final", "ask"] },
      final: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 280 },
          details: { type: "string", maxLength: 16000 },
        },
      },
      ask: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2000 },
          options: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label"],
              properties: {
                label: { type: "string", minLength: 1, maxLength: 200 },
                description: { type: "string", maxLength: 2000 },
              },
            },
          },
          context: { type: "string", maxLength: 4000 },
        },
      },
    },
  };
}

function parseEnvelope(
  text: string,
  jsonOutput: unknown,
): ProviderStepOutputEnvelope | null {
  // Schema-constrained CLI runs surface the parsed object directly; we
  // validate it with Ajv (defense in depth) and accept on hit.
  const v = getValidator();
  const tryAccept = (candidate: unknown) => {
    if (candidate === undefined || candidate === null) return null;
    const r = v.validate<ProviderStepOutputEnvelope>(
      SCHEMA_IDS.providerStepOutput,
      candidate,
    );
    return r.ok === true ? r.data : null;
  };
  const fromJson = tryAccept(jsonOutput);
  if (fromJson) return fromJson;
  // Fallback for resumed turns where the CLI couldn't enforce a schema:
  // try to parse the assistant text as JSON, optionally pulling out the
  // first {...} block when there's stray prose.
  if (!text) return null;
  const trimmed = text.trim();
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(trimmed)); } catch { /* fall through */ }
  // Match a fenced block: ```json ... ``` or just first {...}.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { candidates.push(JSON.parse(fenced[1].trim())); } catch { /* */ }
  }
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try { candidates.push(JSON.parse(brace[0])); } catch { /* */ }
  }
  for (const c of candidates) {
    const accepted = tryAccept(c);
    if (accepted) return accepted;
  }
  return null;
}

interface TurnLoopArgs {
  input: ProviderActorInput;
  signal: AbortSignal | undefined;
  worktreePath: string;
  ticketPreHash: string | null;
}

interface TurnLoopResult {
  summary: string;
  noteSection: string;
}

async function runTurnLoop(args: TurnLoopArgs): Promise<TurnLoopResult> {
  const { input, signal, worktreePath } = args;
  const { nodeId, round } = input;
  const runId = input.runId!;
  const provider = input.provider!;
  const role = input.role ?? "implementer";
  const editable = roleNeedsEdit(role, nodeId);
  const schema = envelopeJsonSchema();

  // Initial prompt = role prompt + envelope instruction.
  const basePrompt = buildPromptForProvider({
    nodeId,
    round,
    role,
    promptSpec: input.promptSpec ?? {},
    runId: input.runId,
  });
  let prompt = basePrompt + ENVELOPE_INSTRUCTION;
  let resumeSessionId: string | undefined;

  // Optional cross-step resume (F-001): when this node also has
  // resume_session_from set, start by resuming that node's session.
  if (input.resumeSessionFrom) {
    const rec = readProviderSession({
      worktreePath,
      runId,
      nodeId: input.resumeSessionFrom,
    });
    if (rec && rec.provider === cliBinaryFor(provider)) {
      resumeSessionId = rec.sessionId;
    }
  }

  let final: TurnFinal | null = null;
  const turnsLog: Array<{ ask: TurnAsk; answer: string }> = [];

  for (let turnIdx = 1; turnIdx <= TURN_LOOP_MAX_TURNS; turnIdx++) {
    if (signal?.aborted) {
      throw new Error(
        `[run-provider] aborted in turn loop for ${nodeId} round-${round} turn=${turnIdx}`,
      );
    }
    const isInitial = turnIdx === 1 && resumeSessionId === undefined;
    const result = await invokeProvider(provider, {
      prompt,
      cwd: worktreePath,
      signal,
      editable,
      // codex `exec resume` doesn't accept --output-schema, so only
      // attach the schema on the first un-resumed call. Subsequent
      // turns rely on the LLM remembering the envelope (with
      // graceful-fallback parsing if it doesn't).
      ...(isInitial ? { jsonSchema: schema } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      model: provider,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(
        `${provider} ${nodeId} round-${round} turn=${turnIdx} failed (exit=${result.exitCode}, timedOut=${result.timedOut}): ${result.stderrTail.slice(-500)}`,
      );
    }

    // Update session id for this node (claude returns a new id per call;
    // codex returns a stable id — both are handled by overwrite).
    if (result.sessionId) {
      saveProviderSession({
        worktreePath,
        runId,
        nodeId,
        round,
        provider: cliBinaryFor(provider),
        sessionId: result.sessionId,
      });
      resumeSessionId = result.sessionId;
    }

    const envelope = parseEnvelope(result.text, result.jsonOutput);
    if (!envelope) {
      // Graceful degradation: treat the raw text as a final answer.
      const text = result.text.trim() || `(empty response from ${provider})`;
      final = {
        summary: extractSummary(text, `${nodeId} round-${round}`),
        details: text,
      };
      process.stderr.write(
        `[run-provider] turn=${turnIdx} ${provider} did not return envelope; treating raw output as final\n`,
      );
      break;
    }
    if (envelope.kind === "final" && envelope.final) {
      final = envelope.final;
      break;
    }
    if (envelope.kind === "ask" && envelope.ask) {
      writeTurnQuestion({
        worktreePath,
        runId,
        question: {
          status: "pending",
          node_id: nodeId,
          round,
          turn: turnIdx,
          asked_at: new Date().toISOString(),
          ...(resumeSessionId ? { session_id: resumeSessionId } : {}),
          ask: envelope.ask,
        },
      });
      const answer = await awaitTurnAnswer({
        worktreePath,
        runId,
        nodeId,
        turn: turnIdx,
        signal,
      });
      const answerText = answer.answer.text;
      const answerComment = answer.answer.comment?.trim();
      turnsLog.push({
        ask: envelope.ask,
        answer: answerComment ? `${answerText} (comment: ${answerComment})` : answerText,
      });
      // Next loop: prompt is the user answer (plus comment when present).
      // resumeSessionId is already set so the provider continues the same
      // conversation.
      prompt = answerComment
        ? `${answerText}\n\n[user comment: ${answerComment}]`
        : answerText;
      continue;
    }
    // Envelope parsed but the kind/body combination is malformed.
    throw new Error(
      `${provider} ${nodeId} round-${round} turn=${turnIdx}: envelope parsed but missing matching body for kind=${envelope.kind}`,
    );
  }

  if (!final) {
    throw new Error(
      `[run-provider] ${nodeId} round-${round}: turn loop exceeded ${TURN_LOOP_MAX_TURNS} turns without a final answer`,
    );
  }

  // Build the note section: final body + any Q/A logs underneath. Keeps
  // the audit visible without bloating the commit (questions+answers
  // also persist under runs/.../turns/ during the step).
  const lines: string[] = [];
  lines.push(`## ${nodeId} (round ${round})`, "");
  if (final.details) {
    lines.push(final.details, "");
  } else {
    lines.push(final.summary, "");
  }
  for (let i = 0; i < turnsLog.length; i++) {
    const t = turnsLog[i];
    lines.push(`### Turn ${i + 1} — asked`, "", t.ask.question, "");
    lines.push(`**User answered:** ${t.answer}`, "");
  }

  // Cleanup turn files now that the step's outcome is durable in note.
  // Best-effort; the .pdh-flow/ tree is ephemeral anyway.
  clearTurnsDir({ worktreePath, runId, nodeId });

  return {
    summary: final.summary,
    noteSection: lines.join("\n"),
  };
}

/** Inline slim schema passed to the provider CLI's --json-schema flag for
 *  final_verifier. Cross-file $refs aren't safe through the CLI bridge,
 *  so we hand-roll a flat version matching `final-verifier-output.schema.json`.
 *  The full schema is re-validated on our side after the call. */
function inlineFinalVerifierSchema(): Record<string, unknown> {
  // OpenAI structured-output requires every `properties` key to also be
  // in `required` (no true optionals). For "optional" string fields we
  // use a `["string", "null"]` union so the model can emit null to mean
  // "absent". Codex CLI passes this schema through to the OpenAI API
  // verbatim, so the constraint propagates here even though our own
  // Ajv-side schema is more permissive (we re-validate post-call and
  // tolerate the null form).
  const acRow = {
    type: "object",
    additionalProperties: false,
    required: ["ac_id", "ac_item", "class", "status", "evidence_path", "note"],
    properties: {
      ac_id: { type: "string", pattern: "^AC[0-9]+$" },
      ac_item: { type: "string", minLength: 1, maxLength: 500 },
      class: {
        type: "string",
        enum: ["unit-test-sufficient", "integration-required", "real-env-required"],
      },
      status: {
        type: "string",
        enum: ["verified", "unverified", "user_accepted"],
      },
      evidence_path: { type: ["string", "null"], maxLength: 500 },
      note: { type: ["string", "null"], maxLength: 1000 },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["ac_verification", "summary_md"],
    properties: {
      ac_verification: { type: "array", maxItems: 50, items: acRow },
      summary_md: { type: "string", minLength: 1, maxLength: 16000 },
    },
  };
}

/** Strip null values from the optional fields the inline schema models
 *  as `[string, null]` (evidence_path, note). The canonical Ajv schema
 *  has them as plain-optional `string`, which rejects null — so we
 *  delete the null entries before re-validation. Mutation-free: returns
 *  a shallow copy. */
function stripNullOptionals(jsonOutput: unknown): unknown {
  if (!jsonOutput || typeof jsonOutput !== "object") return jsonOutput;
  const obj = jsonOutput as Record<string, unknown>;
  const rows = obj.ac_verification;
  if (!Array.isArray(rows)) return obj;
  const cleanedRows = rows.map((r) => {
    if (!r || typeof r !== "object") return r;
    const row = { ...(r as Record<string, unknown>) };
    if (row.evidence_path === null) delete row.evidence_path;
    if (row.note === null) delete row.note;
    return row;
  });
  return { ...obj, ac_verification: cleanedRows };
}

/** Persist the validated final_verifier output to
 *  `.pdh-flow/runs/<runId>/judgements/<nodeId>__round-N.json`. close_gate
 *  reads `ac_verification[].status` from this file to decide whether the
 *  PdM must submit `deferral_approvals`. Failing to write is logged but
 *  non-fatal — the engine continues and close_gate falls back to "no
 *  deferral required" (matches the volatile-cache stance elsewhere). */
function saveFinalVerifierJudgement(p: {
  worktreePath: string;
  runId: string;
  nodeId: string;
  round: number;
  output: FinalVerifierOutput;
}): void {
  try {
    const dir = join(p.worktreePath, ".pdh-flow", "runs", p.runId, "judgements");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${p.nodeId}__round-${p.round}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          node_id: p.nodeId,
          round: p.round,
          kind: "final_verifier",
          ...p.output,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    process.stderr.write(
      `[run-provider] failed to save final_verifier judgement for ${p.nodeId} round-${p.round}: ${(err as Error).message}\n`,
    );
  }
}

/** Drop the legacy `## <nodeId> (round N)` header from a note section
 *  string when the caller is delegating to the new `writeNoteOutput`
 *  helper. Older call sites build the body with that header inline
 *  (so a plain `appendFileSync` would yield a section); the new helper
 *  decides whether to wrap in `## <nodeId> (round N)`, `## PD-C-N`, or
 *  `### nodeId (round N)` (audit log) based on `note_target`. Returning
 *  just the body keeps the helper's framing consistent. Falls back to
 *  the original string when no recognisable header is found. */
function stripLeadingNodeHeader(
  noteSection: string,
  nodeId: string,
  round: number,
): string {
  const escNode = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escNode}\\s*\\(round\\s*${round}\\)\\s*\\r?\\n+`, "m");
  return noteSection.replace(re, "").trimStart();
}
