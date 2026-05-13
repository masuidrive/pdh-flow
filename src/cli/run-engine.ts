// `pdh-flow run-engine` — drive the v2 engine end-to-end on a worktree.
//
// With `--fixture <dir>` the engine replays recorded node outputs (the
// deterministic test path). Without `--fixture` each provider / guardian
// step invokes the real claude / codex CLI in the worktree.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSubcommandArgs } from "./index.ts";
import { runEngine } from "../engine/run.ts";
import type { FixtureMeta } from "../engine/actors/run-provider.ts";

export async function cmdRunEngine(argv: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(argv, {
    ticket: { type: "string" },
    epic: { type: "string" },
    flow: { type: "string" },
    variant: { type: "string" },
    repo: { type: "string" },
    worktree: { type: "string" },
    "start-at": { type: "string" },
    "stop-at": { type: "string" },
    fixture: { type: "string" },
    "run-id": { type: "string" },
    "timeout-ms": { type: "string" },
    providers: { type: "string" },
  });

  const ticket = values.ticket as string | undefined;
  const epic = values.epic as string | undefined;
  const flowId = values.flow as string | undefined;
  const variant = (values.variant as string | undefined) ?? "full";
  const repoPath = (values.repo as string | undefined)
    ? resolve(values.repo as string)
    : process.cwd();
  const worktreePath = (values.worktree as string | undefined)
    ? resolve(values.worktree as string)
    : repoPath;
  const fixtureDir = values.fixture as string | undefined;
  const runId =
    (values["run-id"] as string | undefined) ??
    `run-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-cli`;

  // Either --ticket OR --epic; --epic is for pdh-d (epic close cycle),
  // --ticket is for pdh-flow / pdh-turn-smoke (ticket dev). Both are
  // accepted simultaneously only as a sanity tag — engine uses --epic
  // for close_epic system_step and --ticket for everything else.
  if (!ticket && !epic) throw new Error("--ticket <id> or --epic <slug> is required");
  if (!flowId) throw new Error("--flow <id> is required");

  let fixtureMeta: FixtureMeta | undefined;
  if (fixtureDir) {
    const path = resolve(fixtureDir, "meta.json");
    fixtureMeta = JSON.parse(readFileSync(path, "utf8"));
  }

  const timeoutMsRaw = values["timeout-ms"] as string | undefined;
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : undefined;
  if (timeoutMsRaw !== undefined && (!Number.isFinite(timeoutMs!) || timeoutMs! <= 0)) {
    throw new Error(`--timeout-ms must be a positive number; got ${timeoutMsRaw}`);
  }

  const result = await runEngine({
    repoPath,
    flowId,
    variant,
    worktreePath,
    runId,
    ticketId: ticket,
    epicId: epic,
    fixtureMeta,
    startAtNodeId: values["start-at"] as string | undefined,
    stopAtNodeId: values["stop-at"] as string | undefined,
    timeoutMs,
    providersProfile: values.providers as string | undefined,
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        ticket: ticket ?? null,
        epic: epic ?? null,
        flow: flowId,
        variant,
        run_id: runId,
        final_state: result.finalState,
        stopped_at: result.stoppedAt ?? null,
        round: result.context.round,
        last_guardian_decision: result.context.lastGuardianDecision ?? null,
      },
      null,
      2,
    ) + "\n",
  );
}
