// Minimal HTTP server for the v2 Web UI MVP.
//
// Reads engine state from `<worktreePath>/.pdh-flow/runs/<runId>/` (snapshot
// + frozen judgements + gate decisions) and exposes:
//
//   GET  /api/runs                     → list runs (run-id + saved_at + ticket)
//   GET  /api/runs/:runId              → snapshot summary + judgement list +
//                                         active-gate hint
//   GET  /api/runs/:runId/note         → raw current-note.md
//   POST /api/runs/:runId/gates/:node  → write gate decision file (the
//                                         engine's await-gate actor polls this)
//   GET  /                             → static frontend (web/index.html etc.)
//
// No external deps. Polling-driven on the frontend; no SSE/WebSocket.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync as fsRenameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistManager, type AssistManager } from "./assist-terminal.ts";
import { promoteTurnDraft } from "../engine/turn-store.ts";
import { getValidator, SCHEMA_IDS, formatErrors } from "../engine/validate.ts";
import { buildGraph, type BuildGraphResult } from "../engine/build-graph.ts";
import { loadFlow } from "../engine/load-flow.ts";
import { validateBusinessRules } from "../engine/actors/await-gate.ts";
import type { GateStepOutput } from "../types/index.ts";
import { readTransitions, type TransitionEntry } from "../engine/transitions-log.ts";
import { readEvents, type RunEvent } from "../engine/events-log.ts";
import { getGateSummary } from "./gate-summary.ts";

export interface ServeOptions {
  /** Primary worktree the serve was launched from. SSE for the home page
   *  watches this one's runs/ dir. Always present in the resolved worktree
   *  list (first slot). */
  worktreePath: string;
  /** Additional worktrees to aggregate runs / tickets from. Typically
   *  populated by the CLI from `git worktree list` so a single `serve`
   *  surfaces every parallel ticket without the user starting one server
   *  per worktree. RunIds are unique-per-machine (timestamp-suffixed),
   *  so first match wins on resolution. */
  extraWorktrees?: string[];
  port: number;
  /**
   * Bind address. Default `127.0.0.1` (loopback only). Pass `0.0.0.0`
   * (or `::`) to accept connections from other machines on the LAN.
   */
  host?: string;
  /** Path to static frontend assets. Defaults to ../../web relative to this file. */
  staticDir?: string;
}

// Internal: deduped, primary-first list of worktree paths the server
// aggregates across. Constructed once at startup; the top-page worktrees
// panel reflects the *current* git worktree list (which may diverge if
// the user adds a worktree mid-session — they'd need to restart serve).
function resolveWorktreesList(opts: ServeOptions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string): void => {
    const r = resolve(p);
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  push(opts.worktreePath);
  for (const extra of opts.extraWorktrees ?? []) push(extra);
  return out;
}

// First worktree that owns this runId. RunIds are
// `<flow>-<variant>-<ticket>-<UTC-timestamp>` so collisions across
// worktrees on the same machine are essentially impossible; if they do
// happen, deterministic-first-wins matches the user's mental model
// (the worktree they started serve in is checked first).
function findWorktreeForRun(runId: string, worktrees: string[]): string | null {
  for (const wt of worktrees) {
    if (existsSync(join(wt, ".pdh-flow", "runs", runId))) return wt;
  }
  return null;
}

function findWorktreeForTicket(slug: string, worktrees: string[]): string | null {
  for (const wt of worktrees) {
    if (existsSync(join(wt, "tickets", `${slug}.md`))) return wt;
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// During the React migration the live UI lives at web/dist/ (Vite build output).
// If that hasn't been built yet, fall back to web-legacy/ so a fresh checkout
// still serves the previous vanilla app. After Phase 6 cutover we drop the
// fallback entirely.
function resolveDefaultStaticDir(): string {
  const builtDir = resolve(__dirname, "..", "..", "web", "dist");
  if (existsSync(builtDir)) return builtDir;
  const legacyDir = resolve(__dirname, "..", "..", "web-legacy");
  if (existsSync(legacyDir)) {
    process.stderr.write(
      "[web] web/dist/ not found — falling back to web-legacy/. Run `npm run web:build` to use the new UI.\n",
    );
    return legacyDir;
  }
  return builtDir;
}

export function startWebServer(opts: ServeOptions): Server {
  const staticDir = opts.staticDir ?? resolveDefaultStaticDir();
  const worktrees = resolveWorktreesList(opts);
  // One AssistManager per worktree — they spawn `claude` with a worktree-
  // scoped cwd and write wrapper scripts under `<wt>/.pdh-flow/bin/`, so
  // mixing worktrees inside a single manager would corrupt those scripts.
  // WS upgrade rotates through them until one accepts the session ID.
  const assists = new Map<string, AssistManager>();
  for (const wt of worktrees) {
    assists.set(wt, createAssistManager({ worktreePath: wt }));
  }
  const ctx: ServeContext = {
    worktrees,
    primaryWorktree: worktrees[0],
    staticDir,
    assists,
  };
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      process.stderr.write(`[web] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  // Wire WS upgrade for /api/assist/ws — try each worktree's manager
  // until one claims the session. Sessions are UUIDs so at most one
  // manager will match; first-true semantics mean the rest are no-ops.
  server.on("upgrade", (req, socket, head) => {
    for (const a of assists.values()) {
      if (a.handleUpgrade(req, socket, head)) return;
    }
    socket.destroy();
  });
  server.on("close", () => {
    for (const a of assists.values()) a.closeAll();
  });
  const host = opts.host ?? "127.0.0.1";
  server.listen(opts.port, host, () => {
    const display = host === "0.0.0.0" || host === "::"
      ? `http://0.0.0.0:${opts.port} (reachable from any interface)`
      : `http://${host}:${opts.port}`;
    const wtSummary = worktrees.length === 1
      ? `worktree=${worktrees[0]}`
      : `worktrees=${worktrees.length} (primary=${worktrees[0]})`;
    process.stderr.write(`[web] listening on ${display} (${wtSummary})\n`);
  });
  return server;
}

interface ServeContext {
  /** Resolved worktree paths, primary first. */
  worktrees: string[];
  /** Convenience alias for worktrees[0] — the host page that the user
   *  bookmarked and SSE for the home page anchors against. */
  primaryWorktree: string;
  staticDir: string;
  assists: Map<string, AssistManager>;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServeContext,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  // Per-runId helper: resolve the owning worktree once per request.
  // Returns null + 404 already written when no worktree owns the runId.
  const resolveRunWorktree = (runId: string): string | null => {
    const wt = findWorktreeForRun(runId, ctx.worktrees);
    if (!wt) {
      sendJson(res, 404, { error: "run not found in any known worktree", run_id: runId });
      return null;
    }
    return wt;
  };

  // ── API ───────────────────────────────────────────────────────────────
  // F-011/H10-8: ticket-centric primary view. /api/tickets lists from
  // tickets/<slug>.md across every known worktree (durable). /api/runs
  // is kept for engine-internal debugging.
  if (path === "/api/tickets" && req.method === "GET") {
    return sendJson(res, 200, listTicketsAggregated(ctx.worktrees));
  }

  if (path === "/api/tickets" && req.method === "POST") {
    return createTicket(req, res, ctx.worktrees);
  }

  // Sibling worktree discovery — purely topology, doesn't aggregate runs.
  // Top page renders this in the "Worktrees" panel so the user can see
  // every checkout that this server is now also aggregating from.
  if (path === "/api/worktrees" && req.method === "GET") {
    return sendJson(res, 200, listAggregatedWorktrees(ctx.worktrees, ctx.primaryWorktree));
  }

  // GET /api/flows/:flowId → variant + provider profile metadata.
  // Used by the TicketPage's pre-start card to dynamically enumerate
  // what the user can pick (and explain each choice via the YAML's
  // `label` / `description` fields). Falls back to the key name when
  // those aren't set so older flows still render.
  let m = path.match(/^\/api\/flows\/([^/]+)$/);
  if (m && req.method === "GET") {
    return sendJson(res, 200, getFlowMeta(m[1]));
  }

  m = path.match(/^\/api\/tickets\/([^/]+)$/);
  if (m && req.method === "GET") {
    const wt = findWorktreeForTicket(m[1], ctx.worktrees);
    if (!wt) return sendJson(res, 404, { error: "ticket not found" });
    const detail = getTicketDetail(wt, m[1]);
    if (!detail) return sendJson(res, 404, { error: "ticket not found" });
    return sendJson(res, 200, detail);
  }

  m = path.match(/^\/api\/tickets\/([^/]+)\/start-run$/);
  if (m && req.method === "POST") {
    return startTicketRun(req, res, ctx.worktrees, m[1]);
  }

  m = path.match(/^\/api\/tickets\/([^/]+)\/cancel$/);
  if (m && req.method === "POST") {
    return cancelTicketViaTicketSh(req, res, ctx.worktrees, m[1]);
  }

  if (path === "/api/runs" && req.method === "GET") {
    return sendJson(res, 200, listRunsAggregated(ctx.worktrees));
  }

  // ── Epic surfaces (Phase 3 of the rethink) ──────────────────────────
  // Each call shells to ticket.sh epic list/show --json per worktree.
  // Aggregating server-side keeps the UI ignorant of multi-worktree
  // layout, mirroring the /api/tickets pattern.
  if (path === "/api/epics" && req.method === "GET") {
    return sendJson(res, 200, listEpicsAggregated(ctx.worktrees));
  }

  if (path === "/api/epics" && req.method === "POST") {
    return createEpic(req, res, ctx.worktrees);
  }

  m = path.match(/^\/api\/epics\/([^/]+)$/);
  if (m && req.method === "GET") {
    const detail = getEpicDetail(ctx.worktrees, m[1]);
    if (!detail) return sendJson(res, 404, { error: "epic not found", slug: m[1] });
    return sendJson(res, 200, detail);
  }

  m = path.match(/^\/api\/epics\/([^/]+)\/start-close$/);
  if (m && req.method === "POST") {
    return startEpicCloseRun(req, res, ctx.worktrees, m[1]);
  }

  m = path.match(/^\/api\/epics\/([^/]+)\/cancel$/);
  if (m && req.method === "POST") {
    return cancelEpicViaTicketSh(req, res, ctx.worktrees, m[1]);
  }

  m = path.match(/^\/api\/runs\/([^/]+)$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const summary = getRunSummary(wt, m[1]);
    if (!summary) return sendJson(res, 404, { error: "run not found" });
    return sendJson(res, 200, summary);
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/note$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const note = readNote(wt);
    if (note === null) return sendJson(res, 404, { error: "current-note.md not found" });
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(note);
    return;
  }

  // GET /api/runs/<id>/engine-status — single source of truth for "is
  // the engine alive / idle / exited" so the UI can always show the
  // user what to do next (product brief Goal 5). Combines:
  //   - engine.pid + kill -0 → process aliveness
  //   - heartbeat.json freshness → liveness vs stuck
  //   - snapshot.value → terminal kind (failed / stopped / human / success)
  //   - active_gate / active_turn / processing_answer → waiting kinds
  m = path.match(/^\/api\/runs\/([^/]+)\/engine-status$/);
  if (m && req.method === "GET") {
    const runId = m[1];
    const wt = resolveRunWorktree(runId);
    if (!wt) return;
    return sendJson(res, 200, computeEngineStatus(wt, runId));
  }

  // POST /api/runs/<id>/restart — re-spawn `pdh-flow run-engine` on an
  // idle run (state non-terminal but no engine process running). Reads
  // ticket / flow / variant from snapshot.json so the spawn matches the
  // original run's parameters. Detached, returns the pid so the UI can
  // show "spawned" feedback.
  m = path.match(/^\/api\/runs\/([^/]+)\/restart$/);
  if (m && req.method === "POST") {
    return restartRun(req, res, ctx.worktrees, m[1]);
  }

  // POST /api/runs/<id>/open-terminal — open a bash PTY in the run's
  // worktree with the resume command pre-printed in the banner. Used
  // by the IdleRecoveryCard "Open terminal" button.
  m = path.match(/^\/api\/runs\/([^/]+)\/open-terminal$/);
  if (m && req.method === "POST") {
    const runId = m[1];
    const wt = resolveRunWorktree(runId);
    if (!wt) return;
    const snap = readSnapshot(wt, runId);
    if (!snap) return sendJson(res, 404, { error: "snapshot not found", run_id: runId });
    const ticketId = typeof snap.ticket_id === "string" ? snap.ticket_id : "";
    const flowId = typeof snap.flow === "string" ? snap.flow : "pdh-flow";
    const variant = typeof snap.variant === "string" ? snap.variant : "full";
    if (!ticketId) {
      return sendJson(res, 400, { error: "snapshot has no ticket_id", run_id: runId });
    }
    const assist = ctx.assists.get(wt);
    if (!assist) {
      return sendJson(res, 500, { error: "no assist manager for worktree", worktree: wt });
    }
    const r = assist.openResumeSession({ runId, ticketId, flowId, variant });
    return sendJson(res, 200, { ...r, worktree_path: wt });
  }

  // GET /api/runs/<id>/ticket → raw current-ticket.md (resolved through
  // the worktree's symlink). Used by the run page to surface the ticket
  // contract above the note so the human can re-read it without leaving
  // the page. 404 if the symlink target is missing.
  m = path.match(/^\/api\/runs\/([^/]+)\/ticket$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const ticket = readWorktreeFile(wt, "current-ticket.md");
    if (ticket === null) return sendJson(res, 404, { error: "current-ticket.md not found" });
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(ticket);
    return;
  }

  // GET /api/runs/<id>/brief → raw product-brief.md. Optional file; the
  // run page renders it collapsed at the top of the Summary tab. 404 when
  // the worktree has no product-brief (the UI then just hides the card).
  m = path.match(/^\/api\/runs\/([^/]+)\/brief$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const brief = readWorktreeFile(wt, "product-brief.md");
    if (brief === null) return sendJson(res, 404, { error: "product-brief.md not found" });
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(brief);
    return;
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/graph$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const graph = getRunGraph(wt, m[1]);
    if (!graph) return sendJson(res, 404, { error: "run/flow not found" });
    return sendJson(res, 200, graph);
  }

  // GET /api/runs/<id>/flow-yaml → raw flows/<flowId>.yaml text for the
  // run. Consumed by the web UI's PolyFlow 3D panel (poly-flow-react),
  // which prefers parsing yaml directly over the macro-expanded graph so
  // the visualizer can render `review_loop` as a parallel + aggregator
  // pair and resolve characters via the yaml's `characters:` field.
  m = path.match(/^\/api\/runs\/([^/]+)\/flow-yaml$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const snap = readSnapshot(wt, m[1]);
    const flowId = typeof snap?.flow === "string" ? snap.flow : null;
    if (!flowId) return sendJson(res, 404, { error: "run has no flow id" });
    const yamlPath = resolve(PDH_FLOW_REPO, "flows", `${flowId}.yaml`);
    let text: string;
    try {
      text = readFileSync(yamlPath, "utf8");
    } catch {
      return sendJson(res, 404, { error: `flow yaml not found: ${flowId}` });
    }
    res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
    res.end(text);
    return;
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/gates\/([^/]+)$/);
  if (m && req.method === "POST") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return postGate(req, res, wt, m[1], m[2]);
  }

  // PdM decision-support summary. ?regenerate=1 forces a fresh LLM call;
  // otherwise returns the cached summary keyed on (run, node, round).
  m = path.match(/^\/api\/runs\/([^/]+)\/gates\/([^/]+)\/summary$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const url = new URL(req.url ?? "/", "http://x");
    const regenerate = url.searchParams.get("regenerate") === "1";
    try {
      const summary = await getGateSummary({
        worktreePath: wt,
        runId: m[1],
        nodeId: m[2],
        regenerate,
      });
      return sendJson(res, 200, summary);
    } catch (err) {
      return sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Evidence files staged by final_verifier (or any earlier provider
  // that writes under the run's evidence/ tree). The list endpoint
  // surfaces every round so the UI can show "look at round-2 if you're
  // approving the second close attempt", and the file endpoint streams
  // a single artifact with a content-type guessed from the extension.
  m = path.match(/^\/api\/runs\/([^/]+)\/evidence$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return sendJson(res, 200, listEvidence(wt, m[1]));
  }

  // Per-node activity events. The Web UI's bottom bar polls this (or
  // refetches on SSE change) to surface "running implementer (codex) —
  // 1m23s" while the engine is mid-step. Returns the full list; the
  // client picks the latest unmatched _start to render.
  m = path.match(/^\/api\/runs\/([^/]+)\/events\.json$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const events: RunEvent[] = readEvents(wt, m[1]);
    return sendJson(res, 200, events);
  }
  m = path.match(/^\/api\/runs\/([^/]+)\/evidence\/(round-\d+)\/([^/]+)$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return serveEvidenceFile(res, wt, m[1], m[2], m[3]);
  }

  // Worktree file browser for the Viewer pane: list a directory (?path=
  // worktree-relative; "" = root) and stream a file (?path=...). Path-
  // traversal protected; `.git/` is hidden from listings.
  m = path.match(/^\/api\/runs\/([^/]+)\/tree$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const rel = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
    return listWorktreeDir(res, wt, rel);
  }
  m = path.match(/^\/api\/runs\/([^/]+)\/blob$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const rel = new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "";
    return serveWorktreeFile(res, wt, rel);
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/turns\/([^/]+)\/(\d+)$/);
  if (m && req.method === "POST") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return postTurn(req, res, wt, m[1], m[2], parseInt(m[3], 10));
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/turns\/([^/]+)\/(\d+)\/confirm$/);
  if (m && req.method === "POST") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const result = promoteTurnDraft({
      worktreePath: wt,
      runId: m[1],
      nodeId: m[2],
      turn: parseInt(m[3], 10),
    });
    if (result.ok === true) return sendJson(res, 200, { ok: true, wrote: result.path });
    return sendJson(res, result.status, { error: result.error });
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/gates\/([^/]+)\/confirm$/);
  if (m && req.method === "POST") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return postGateConfirm(res, wt, m[1], m[2]);
  }

  // Discard a proposed (draft) gate decision — drops gates/<node>.draft.json
  // so the human can decide manually instead of confirming the proposal.
  m = path.match(/^\/api\/runs\/([^/]+)\/gates\/([^/]+)\/draft$/);
  if (m && req.method === "DELETE") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return discardGateDraft(res, wt, m[1], m[2]);
  }

  m = path.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    return handleSSE(req, res, wt, m[1]);
  }

  m = path.match(/^\/api\/runs-events$/);
  if (m && req.method === "GET") {
    return handleRunsListSSE(req, res, ctx.worktrees);
  }

  // ── Worktree bootstrap: ticket.sh + .ticket-config.yaml + the PDH doc ──
  // The top-page checks this on load; if files are missing it pops a modal
  // and POSTs here to install them (copied from pdh-flow's bundled templates,
  // .ticket-config.yaml via `ticket.sh init`).
  if (path === "/api/bootstrap" && req.method === "GET") {
    return sendJson(res, 200, bootstrapStatus(ctx.primaryWorktree));
  }
  if (path === "/api/bootstrap" && req.method === "POST") {
    return sendJson(res, 200, applyBootstrap(ctx.primaryWorktree));
  }

  // ── Creation session: spawn claude with a self-contained ticket/epic prompt
  // Used by the top-page "Open terminal" button (kind=general) and the
  // per-epic / contextual cut-ticket buttons (kind=epic|ticket). See
  // assist-terminal.ts:openCreationSession.
  if (path === "/api/assist/create" && req.method === "POST") {
    const body = await readBody(req);
    let parsed: { kind?: string; worktree?: string; epic?: string } = {};
    try { parsed = JSON.parse(body); } catch {}
    const kind =
      parsed.kind === "ticket" ? "ticket"
      : parsed.kind === "epic" ? "epic"
      : parsed.kind === "general" ? "general"
      : null;
    if (!kind) return sendJson(res, 400, { error: "kind is required (general | epic | ticket)" });
    let wt: string | null = null;
    if (parsed.worktree) {
      wt = ctx.worktrees.find((w) => w === parsed.worktree) ?? null;
      if (!wt) return sendJson(res, 400, { error: "unknown worktree", worktree: parsed.worktree });
    } else if (parsed.epic) {
      wt = findWorktreeForEpic(parsed.epic, ctx.worktrees);
      if (!wt) return sendJson(res, 404, { error: "epic not found", epic: parsed.epic });
    } else {
      wt = ctx.worktrees[0] ?? null;
    }
    if (!wt) return sendJson(res, 500, { error: "no worktree resolved" });
    const assist = ctx.assists.get(wt);
    if (!assist) return sendJson(res, 500, { error: "no assist manager for worktree", worktree: wt });
    const r = assist.openCreationSession({ kind, epicSlug: parsed.epic });
    return sendJson(res, 200, { ...r, worktree_path: wt });
  }

  // Cleanup terminal — opened from the UncommittedChangesModal when
  // Start-engine refuses because the worktree has uncommitted changes.
  // Body: { slug }. Resolves the worktree, opens a fresh claude session
  // pre-loaded with the dirty-file list and triage instructions.
  if (path === "/api/assist/cleanup" && req.method === "POST") {
    const body = await readBody(req);
    let parsed: { slug?: string } = {};
    try { parsed = JSON.parse(body); } catch {}
    const slug = typeof parsed.slug === "string" ? parsed.slug : "";
    if (!slug) return sendJson(res, 400, { error: "slug is required" });
    const wt = findWorktreeForTicket(slug, ctx.worktrees);
    if (!wt) return sendJson(res, 404, { error: "ticket not found", slug });
    const assist = ctx.assists.get(wt);
    if (!assist) return sendJson(res, 500, { error: "no assist manager for worktree", worktree: wt });
    const r = assist.openCleanupSession({ slug });
    return sendJson(res, 200, { ...r, worktree_path: wt });
  }

  // ── Assist terminal session create (F-009 + term-webui) ──────────────
  if (path === "/api/assist/open" && req.method === "POST") {
    const body = await readBody(req);
    let parsed: { run_id?: string; node_id?: string; mode?: string; force?: boolean } = {};
    try { parsed = JSON.parse(body); } catch {}
    const runId = typeof parsed.run_id === "string" ? parsed.run_id : "";
    const nodeId = typeof parsed.node_id === "string" ? parsed.node_id : "";
    if (!runId || !nodeId) {
      return sendJson(res, 400, { error: "run_id and node_id are required" });
    }
    const wt = findWorktreeForRun(runId, ctx.worktrees);
    if (!wt) return sendJson(res, 404, { error: "run not found", run_id: runId });
    const assist = ctx.assists.get(wt);
    if (!assist) return sendJson(res, 500, { error: "no assist manager for worktree", worktree: wt });
    const mode = parsed.mode === "fresh" ? "fresh" : "resume";
    const r = assist.openForNode({ runId, nodeId, mode, force: !!parsed.force });
    if ("error" in r) return sendJson(res, 404, r);
    return sendJson(res, 200, r);
  }

  // ── xterm assets (served from node_modules at runtime; v1 pattern) ────
  if (path === "/assets/xterm.js" && req.method === "GET") {
    return serveNodeModuleAsset(res, "@xterm/xterm/lib/xterm.js", "application/javascript; charset=utf-8");
  }
  if (path === "/assets/xterm.css" && req.method === "GET") {
    return serveNodeModuleAsset(res, "@xterm/xterm/css/xterm.css", "text/css; charset=utf-8");
  }
  if (path === "/assets/xterm-addon-fit.js" && req.method === "GET") {
    return serveNodeModuleAsset(res, "@xterm/addon-fit/lib/addon-fit.js", "application/javascript; charset=utf-8");
  }
  if (path === "/assets/xterm-addon-web-links.js" && req.method === "GET") {
    return serveNodeModuleAsset(res, "@xterm/addon-web-links/lib/addon-web-links.js", "application/javascript; charset=utf-8");
  }

  // ── Static ────────────────────────────────────────────────────────────
  return serveStatic(res, ctx.staticDir, path);
}

const REPO_ROOT = resolve(__dirname, "..", "..");

// CLI entry to spawn for detached engine runs. In a built / npx-installed
// package only dist/cli/index.js exists; in a source checkout we run the
// TS entry directly. Prefer the built one when present.
function resolveCliEntry(): string {
  const built = join(REPO_ROOT, "dist", "cli", "index.js");
  if (existsSync(built)) return built;
  return join(REPO_ROOT, "src", "cli", "index.ts");
}

// ── Worktree bootstrap ─────────────────────────────────────────────────
//
// A worktree the engine / ticket flow can drive needs three things at its
// root: `ticket.sh` (the vendored ticket tool), `.ticket-config.yaml` (its
// config), and `docs/product-delivery-hierarchy.md` (the PDH model the
// ticket/epic prompts reference). pdh-flow ships the first and last under
// `templates/`; the config is generated by `ticket.sh init`.

const TEMPLATES_DIR = join(REPO_ROOT, "templates");

interface BootstrapStatus {
  worktree: string;
  /** Relative paths that are missing under the worktree. */
  missing: string[];
  /** True when this pdh-flow build actually ships the template sources. */
  templates_available: boolean;
}

function bootstrapStatus(worktreePath: string): BootstrapStatus {
  const checks: [rel: string, abs: string][] = [
    ["ticket.sh", join(worktreePath, "ticket.sh")],
    [".ticket-config.yaml", join(worktreePath, ".ticket-config.yaml")],
    ["docs/product-delivery-hierarchy.md", join(worktreePath, "docs", "product-delivery-hierarchy.md")],
  ];
  return {
    worktree: worktreePath,
    missing: checks.filter(([, abs]) => !existsSync(abs)).map(([rel]) => rel),
    // ticket.sh is downloaded from upstream at bootstrap time; we just
    // need the override config + delivery-hierarchy doc on disk here.
    templates_available:
      existsSync(join(TEMPLATES_DIR, ".ticket-config.yaml")) &&
      existsSync(join(TEMPLATES_DIR, "product-delivery-hierarchy.md")),
  };
}

/** Upstream of the standalone ticket.sh tool. The bootstrap downloads
 *  the same file the project's `selfupdate` command targets so users
 *  always get the latest released version — pdh-flow no longer vendors
 *  a copy under templates/ (one less file to keep in sync with
 *  upstream and one less merge-conflict surface). */
const TICKET_SH_UPSTREAM =
  "https://raw.githubusercontent.com/masuidrive/ticket.sh/main/ticket.sh";

function applyBootstrap(worktreePath: string): BootstrapStatus & { applied: string[]; error?: string } {
  const before = bootstrapStatus(worktreePath);
  const applied: string[] = [];
  let error: string | undefined;
  try {
    // 1. ticket.sh — fetched from GitHub via curl. We don't vendor a
    //    copy under templates/ anymore (see TICKET_SH_UPSTREAM above).
    //    If the network is down or curl is missing we surface a clear
    //    error rather than silently leaving the worktree half-set-up.
    if (before.missing.includes("ticket.sh")) {
      const dest = join(worktreePath, "ticket.sh");
      const r = spawnSync(
        "curl",
        ["-fsSL", TICKET_SH_UPSTREAM, "-o", dest],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (r.status !== 0 || !existsSync(dest)) {
        throw new Error(
          `failed to download ticket.sh from ${TICKET_SH_UPSTREAM}: ` +
            `${(r.stderr || r.stdout || "curl exit " + r.status).trim().slice(0, 300)}`,
        );
      }
      try { chmodSync(dest, 0o755); } catch {}
      applied.push("ticket.sh");
    }
    // 2. docs/product-delivery-hierarchy.md — copy under docs/.
    if (before.missing.includes("docs/product-delivery-hierarchy.md")) {
      const src = join(TEMPLATES_DIR, "product-delivery-hierarchy.md");
      if (!existsSync(src)) throw new Error(`bundled template missing: ${src}`);
      mkdirSync(join(worktreePath, "docs"), { recursive: true });
      copyFileSync(src, join(worktreePath, "docs", "product-delivery-hierarchy.md"));
      applied.push("docs/product-delivery-hierarchy.md");
    }
    // 3. .ticket-config.yaml — copy the pdh-flow-shipped override from
    //    templates/. We bypass `ticket.sh init` (which would write
    //    upstream's default config with a `## Tasks` checklist nothing
    //    in pdh-flow reads) and ship just the keys we need to override.
    //    Missing keys still fall back to ticket.sh's bash defaults at
    //    runtime, so `tickets_dir` / branch settings / etc. are
    //    inherited.
    if (before.missing.includes(".ticket-config.yaml")) {
      const src = join(TEMPLATES_DIR, ".ticket-config.yaml");
      if (!existsSync(src)) throw new Error(`bundled template missing: ${src}`);
      copyFileSync(src, join(worktreePath, ".ticket-config.yaml"));
      applied.push(".ticket-config.yaml");
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { ...bootstrapStatus(worktreePath), applied, error };
}

function serveNodeModuleAsset(res: ServerResponse, rel: string, mime: string): void {
  const target = join(REPO_ROOT, "node_modules", rel);
  if (!existsSync(target)) {
    return sendJson(res, 404, { error: "asset not found", rel });
  }
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
  res.end(readFileSync(target));
}

// ─── Ticket discovery (F-011/H10-8) ──────────────────────────────────────

interface TicketListItem {
  slug: string;
  title: string | null;
  status: string | null;
  opened_at: string | null;
  closed_at: string | null;
  /** Latest run for this ticket, when one exists. */
  latest_run_id: string | null;
  latest_run_state: string | null;
  /** Owning worktree path. Always set; the Top page uses it to label
   *  rows when more than one worktree contributes tickets. Same slug
   *  could appear in multiple worktrees on the same branch family
   *  (e.g. `epic/foo` and `ticket/foo`), so the UI keys on (slug, worktree). */
  worktree_path: string;
  /** Optional epic linkage from frontmatter. Surfaced so the Top page
   *  can group / filter tickets by epic without re-reading frontmatter
   *  client-side. */
  epic_id: string | null;
}

interface TicketDetail {
  slug: string;
  ticket_frontmatter: Record<string, unknown>;
  ticket_body: string;
  note_body: string | null;
  latest_run: RunSummary | null;
}

function listTickets(worktreePath: string): TicketListItem[] {
  const ticketsDir = join(worktreePath, "tickets");
  if (!existsSync(ticketsDir)) return [];
  const entries = readdirSync(ticketsDir).filter(
    (f) =>
      f.endsWith(".md") &&
      !f.endsWith("-note.md") &&
      f !== "README.md", // ticket.sh init drops a README; not a real ticket
  );
  // For each ticket, also look up the latest run (if any) sharing this ticket_id.
  const runs = listRuns(worktreePath);
  const out: TicketListItem[] = entries.map((file) => {
    const slug = file.replace(/\.md$/, "");
    const fm = readFrontmatter(join(ticketsDir, file));
    const matchingRun = runs.find((r) => r.ticket_id === slug);
    return {
      slug,
      title: typeof fm.title === "string" ? fm.title : null,
      status: typeof fm.status === "string" ? fm.status : null,
      opened_at:
        typeof fm.created_at === "string"
          ? fm.created_at
          : typeof fm.opened_at === "string"
            ? fm.opened_at
            : null,
      closed_at: typeof fm.closed_at === "string" ? fm.closed_at : null,
      latest_run_id: matchingRun?.run_id ?? null,
      latest_run_state: matchingRun?.current_state ?? null,
      worktree_path: worktreePath,
      epic_id: typeof fm.epic_id === "string" ? fm.epic_id : null,
    };
  });
  // Sort: open tickets first, then by opened_at desc.
  out.sort((a, b) => {
    const aOpen = a.status !== "done" && a.status !== "cancelled";
    const bOpen = b.status !== "done" && b.status !== "cancelled";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.opened_at ?? "").localeCompare(a.opened_at ?? "");
  });
  return out;
}

// Concat tickets from every worktree, then re-sort across the union so
// "open across all worktrees" floats to the top. Same slug appearing in
// two worktrees keeps both entries — the UI distinguishes by worktree
// column. Branch siblings of the same ticket (e.g. parked on a backup
// worktree) are intentionally visible so the user notices.
function listTicketsAggregated(worktrees: string[]): TicketListItem[] {
  const all: TicketListItem[] = [];
  for (const wt of worktrees) all.push(...listTickets(wt));
  all.sort((a, b) => {
    const aOpen = a.status !== "done" && a.status !== "cancelled";
    const bOpen = b.status !== "done" && b.status !== "cancelled";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.opened_at ?? "").localeCompare(a.opened_at ?? "");
  });
  return all;
}

function getTicketDetail(
  worktreePath: string,
  slug: string,
): TicketDetail | null {
  const ticketPath = join(worktreePath, "tickets", `${slug}.md`);
  const notePath = join(worktreePath, "tickets", `${slug}-note.md`);
  if (!existsSync(ticketPath)) return null;
  const ticketFull = readFileSync(ticketPath, "utf8");
  const fm = readFrontmatter(ticketPath);
  const ticketBody = stripFrontmatter(ticketFull);
  const noteBody = existsSync(notePath)
    ? readFileSync(notePath, "utf8")
    : null;
  const runs = listRuns(worktreePath);
  const matching = runs.find((r) => r.ticket_id === slug);
  const latestRun = matching ? getRunSummary(worktreePath, matching.run_id) : null;
  return {
    slug,
    ticket_frontmatter: fm,
    ticket_body: ticketBody,
    note_body: noteBody,
    latest_run: latestRun,
  };
}

// ─── Epic discovery (delegates to ticket.sh epic list/show --json) ───────

interface EpicListItem {
  epic_id: string;
  title: string | null;
  status: string | null;
  branch: string | null;
  worktree_path: string;
  open_ticket_count: number;
  closed_ticket_count: number;
  ticket_count: number;
  created_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
}

interface EpicDetail extends EpicListItem {
  /** Raw frontmatter as ticket.sh parsed it (richer than the list shape). */
  epic_frontmatter: Record<string, unknown>;
  epic_body: string;
  cancel_reason: string | null;
  linked_tickets: Array<{
    slug: string;
    title: string | null;
    status: string;
    file_location: string;
    base_branch: string | null;
  }>;
  branch_state: { ahead_of_main?: number; head_sha?: string; behind_main?: number } | null;
  /** Per ticket.sh: { ok: boolean, blockers: string[] } — used by the UI
   * to disable the "Start close cycle" button when blockers exist. */
  preflight: { ok: boolean; blockers: string[] } | null;
  /** Active in-flight pdh-d run if any; the UI links to the run page. */
  active_close_run_id: string | null;
  /** True when ticket.sh preflight is OK AND no in-flight close run. */
  can_start_close: boolean;
}

// Reuse the same resolution order as run-system.ts close_epic helper:
//   $PDH_FLOW_TICKET_SH → <worktree>/ticket.sh → vendored
function resolveTicketShPath(worktreePath: string): string | null {
  const env = process.env.PDH_FLOW_TICKET_SH;
  if (env && existsSync(env)) return env;
  const local = join(worktreePath, "ticket.sh");
  if (existsSync(local)) return local;
  const vendored = join(__dirname, "..", "..", "scripts", "dev", "ticket.sh");
  if (existsSync(vendored)) return vendored;
  return null;
}

function ticketShEpicList(worktreePath: string): unknown[] {
  const ts = resolveTicketShPath(worktreePath);
  if (!ts) return [];
  const r = spawnSync(ts, ["epic", "list", "--json"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ticketShEpicShow(worktreePath: string, slug: string): Record<string, unknown> | null {
  const ts = resolveTicketShPath(worktreePath);
  if (!ts) return null;
  const r = spawnSync(ts, ["epic", "show", slug, "--json"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch (e) {
    // Log so upstream ticket.sh JSON glitches surface in the server log
    // (an empty 404 in the UI is hard to debug otherwise). Truncated
    // output is the typical failure mode — note the byte offset.
    process.stderr.write(
      `[web] ticket.sh epic show ${slug} JSON parse failed in ${worktreePath}: ` +
        `${e instanceof Error ? e.message : String(e)} ` +
        `(stdout=${r.stdout.length} bytes, stderr=${(r.stderr ?? "").trim()})\n`,
    );
    return null;
  }
}

function listEpicsForWorktree(worktreePath: string): EpicListItem[] {
  const raw = ticketShEpicList(worktreePath);
  const out: EpicListItem[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    if (typeof x.epic_id !== "string") continue;
    out.push({
      epic_id: x.epic_id,
      title: typeof x.title === "string" ? x.title : null,
      status: typeof x.status === "string" ? x.status : null,
      branch: typeof x.branch === "string" ? x.branch : null,
      worktree_path: worktreePath,
      open_ticket_count: typeof x.open_ticket_count === "number" ? x.open_ticket_count : 0,
      closed_ticket_count: typeof x.closed_ticket_count === "number" ? x.closed_ticket_count : 0,
      ticket_count: typeof x.ticket_count === "number" ? x.ticket_count : 0,
      created_at: typeof x.created_at === "string" ? x.created_at : null,
      closed_at: typeof x.closed_at === "string" ? x.closed_at : null,
      cancelled_at: typeof x.cancelled_at === "string" ? x.cancelled_at : null,
    });
  }
  return out;
}

function listEpicsAggregated(worktrees: string[]): EpicListItem[] {
  const all: EpicListItem[] = [];
  for (const wt of worktrees) all.push(...listEpicsForWorktree(wt));
  // Open epics float to the top, then by created_at desc.
  all.sort((a, b) => {
    const aOpen = a.status !== "closed" && a.status !== "cancelled";
    const bOpen = b.status !== "closed" && b.status !== "cancelled";
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
  return all;
}

function findWorktreeForEpic(slug: string, worktrees: string[]): string | null {
  for (const wt of worktrees) {
    if (ticketShEpicShow(wt, slug)) return wt;
  }
  return null;
}

function getEpicDetail(worktrees: string[], slug: string): EpicDetail | null {
  const wt = findWorktreeForEpic(slug, worktrees);
  if (!wt) return null;
  const raw = ticketShEpicShow(wt, slug);
  if (!raw) return null;

  // Linked tickets: ticket.sh embeds them already, but we re-derive
  // open/closed counts to be safe (ticket.sh JSON shape may evolve).
  // Field names mirror ticket.sh's epic show --json output:
  //   { slug, title, status, epic_id, base_branch, file_location }
  const linkedRaw = Array.isArray(raw.linked_tickets) ? raw.linked_tickets : [];
  const linked: EpicDetail["linked_tickets"] = [];
  let openCount = 0;
  let closedCount = 0;
  for (const t of linkedRaw) {
    if (!t || typeof t !== "object") continue;
    const x = t as Record<string, unknown>;
    const st = typeof x.status === "string" ? x.status : "";
    linked.push({
      slug: typeof x.slug === "string" ? x.slug : "",
      title: typeof x.title === "string" ? x.title : null,
      status: st,
      file_location: typeof x.file_location === "string" ? x.file_location : "",
      base_branch: typeof x.base_branch === "string" ? x.base_branch : null,
    });
    if (st === "done") closedCount++;
    else openCount++;
  }

  // Look up an active close run by scanning .pdh-flow/runs/ for in-flight
  // pdh-d runs scoped to this epic. "Active" = snapshot exists, current
  // state is NOT terminal/human_intervention/__stopped__/__failed__.
  // The newest matching run wins (so the UI links to the most recent
  // attempt — older finished runs are surfaced via the runs list, not here).
  const activeCloseRunId = findActiveCloseRunId(wt, slug);

  const preflightRaw = (raw.preflight as { ok?: unknown; blockers?: unknown } | undefined) ?? null;
  const preflight = preflightRaw && typeof preflightRaw.ok === "boolean"
    ? {
        ok: preflightRaw.ok,
        blockers: Array.isArray(preflightRaw.blockers)
          ? (preflightRaw.blockers.filter((b) => typeof b === "string") as string[])
          : [],
      }
    : null;

  const branchStateRaw = raw.branch_state;
  const branchState = branchStateRaw && typeof branchStateRaw === "object"
    ? (branchStateRaw as { ahead_of_main?: number; head_sha?: string; behind_main?: number })
    : null;

  return {
    epic_id: typeof raw.epic_id === "string" ? raw.epic_id : slug,
    title: typeof raw.title === "string" ? raw.title : null,
    status: typeof raw.status === "string" ? raw.status : null,
    branch: typeof raw.branch === "string" ? raw.branch : null,
    worktree_path: wt,
    epic_frontmatter: typeof raw.epic_frontmatter === "object" && raw.epic_frontmatter !== null
      ? (raw.epic_frontmatter as Record<string, unknown>)
      : {},
    epic_body: typeof raw.epic_body === "string" ? raw.epic_body : "",
    open_ticket_count: openCount,
    closed_ticket_count: closedCount,
    ticket_count: openCount + closedCount,
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    closed_at: typeof raw.closed_at === "string" ? raw.closed_at : null,
    cancelled_at: typeof raw.cancelled_at === "string" ? raw.cancelled_at : null,
    cancel_reason: typeof raw.cancel_reason === "string" ? raw.cancel_reason : null,
    linked_tickets: linked,
    branch_state: branchState,
    preflight,
    active_close_run_id: activeCloseRunId,
    can_start_close:
      (preflight?.ok ?? false) &&
      activeCloseRunId === null &&
      raw.status !== "closed" &&
      raw.status !== "cancelled",
  };
}

// POST /api/epics/:slug/start-close — spawn a fresh `pdh-flow run-engine
// --flow pdh-d --epic <slug>` against the epic's worktree, detached, and
// return the new runId so the UI can navigate immediately. The engine
// writes snapshot/transitions to .pdh-flow/runs/<runId>/ which the
// existing /api/runs/* endpoints already serve.
async function startEpicCloseRun(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
  slug: string,
): Promise<void> {
  const wt = findWorktreeForEpic(slug, worktrees);
  if (!wt) return sendJson(res, 404, { error: "epic not found", slug });

  // Predeclare runId so we can return it before the engine boots.
  const runId = `run-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-pddw`;

  // Read body for variant override (optional; default light to keep
  // first-cut UX simple — full requires the zero-base review_loop with real LLM).
  const body = await readBody(req);
  let parsed: { variant?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const variant = parsed.variant === "full" ? "full" : "light";

  // Spawn detached. The engine logs to its own snapshot/transitions; the
  // UI follows via SSE. Stdio is /dev/null'd so the parent can fully
  // detach (server stays up; engine outlives this request).
  const node = process.execPath;
  const cliEntry = resolveCliEntry();
  const args = [
    cliEntry,
    "run-engine",
    "--flow", "pdh-d",
    "--epic", slug,
    "--variant", variant,
    "--worktree", wt,
    "--repo", REPO_ROOT,
    "--run-id", runId,
  ];
  try {
    const child = spawn(node, args, {
      cwd: wt,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return sendJson(res, 200, {
      ok: true,
      run_id: runId,
      variant,
      epic_id: slug,
      worktree_path: wt,
      pid: child.pid ?? null,
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: "failed to spawn run-engine",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

// Locate the newest active pdh-d run scoped to this epic. Active means
// snapshot exists and current state is not a sink (terminal /
// human_intervention / __stopped__ / __failed__). Returns null when no
// in-flight close cycle is found.
function findActiveCloseRunId(worktreePath: string, epicSlug: string): string | null {
  const runsDir = join(worktreePath, ".pdh-flow", "runs");
  if (!existsSync(runsDir)) return null;
  let best: { id: string; savedAt: string } | null = null;
  for (const id of readdirSync(runsDir)) {
    const snapPath = join(runsDir, id, "snapshot.json");
    if (!existsSync(snapPath)) continue;
    let snap: Record<string, unknown>;
    try {
      snap = JSON.parse(readFileSync(snapPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (snap.flow !== "pdh-d") continue;
    // ticket_id for an epic run is the synthetic engine-derived value
    // (see deriveTicketId fallback). We instead match on a marker: the
    // snapshot's xstate context epicId, when present, must equal the
    // slug. Older snapshots without epicId aren't matched (avoids
    // false positives).
    const xstate = snap.xstate_snapshot as { context?: { epicId?: unknown } } | undefined;
    const epicIdInContext = xstate?.context?.epicId;
    if (typeof epicIdInContext !== "string" || epicIdInContext !== epicSlug) continue;
    // Filter out terminal-ish states.
    const stateValue = (xstate as { value?: unknown } | undefined)?.value;
    const stateStr = typeof stateValue === "string" ? stateValue : "";
    if (
      stateStr === "terminal" ||
      stateStr === "human_intervention" ||
      stateStr === "__stopped__" ||
      stateStr === "__failed__"
    ) {
      continue;
    }
    const savedAt = typeof snap.saved_at === "string" ? snap.saved_at : "";
    if (!best || savedAt > best.savedAt) best = { id, savedAt };
  }
  return best?.id ?? null;
}

// POST /api/tickets/:slug/start-run — spawn `pdh-flow run-engine
// --ticket <slug>` against the ticket's worktree. Body { variant?, flow? }.
// Defaults: flow=pdh-flow, variant=full. Mirrors startEpicCloseRun shape.
async function startTicketRun(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
  slug: string,
): Promise<void> {
  const wt = findWorktreeForTicket(slug, worktrees);
  if (!wt) return sendJson(res, 404, { error: "ticket not found", slug });
  const body = await readBody(req);
  let parsed: { variant?: string; flow?: string; providers?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const variant = parsed.variant === "light" ? "light" : "full";
  const flow = typeof parsed.flow === "string" && parsed.flow.length > 0 ? parsed.flow : "pdh-flow";
  const providersProfile =
    typeof parsed.providers === "string" && parsed.providers.length > 0
      ? parsed.providers
      : undefined;
  const runId = `run-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-pdcw`;

  // Pre-flight: the engine commits via `git add -A` after every provider /
  // guardian / gate step. If the worktree has uncommitted user changes at
  // start time, those get folded into the first engine commit — the
  // attribution is wrong and the run becomes a mess. Reject early so the
  // human can triage in a cleanup terminal. Applies regardless of whether
  // `ticket.sh start` would run (= we also catch the resume / already-
  // started case where ticket.sh start is skipped).
  const dirty = readWorktreeStatus(wt);
  if (!dirty.clean) {
    return sendJson(res, 409, {
      error: "uncommitted_changes",
      detail:
        `worktree has ${dirty.entries.length} uncommitted file change(s); ` +
        `the engine would attribute these to the first node's commit. ` +
        `Triage them (commit / stash / restore) before starting the engine.`,
      worktree_path: wt,
      entries: dirty.entries,
      slug,
    });
  }

  // A1: invoke `ticket.sh start <slug>` BEFORE spawning run-engine. This
  // creates the `features/<slug>` branch, sets `started_at` in the ticket
  // frontmatter, and ensures the engine commits land on the feature branch
  // (not main). We wrap in flock so two simultaneous "start" presses on
  // different tickets don't race on ticket.sh's writes to the tickets/
  // tree. Skipped (with a warning) when ticket.sh isn't installed or when
  // started_at is already set (idempotent).
  const tsStart = resolveTicketShPath(wt);
  if (tsStart) {
    const alreadyStarted = readTicketStartedAt(wt, slug);
    if (!alreadyStarted) {
      const startResult = spawnSync("flock", [
        "-x",
        "-w",
        "60",
        join(wt, ".pdh-flow", ".ticket.lock"),
        tsStart,
        "start",
        slug,
      ], {
        cwd: wt,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (startResult.status !== 0) {
        return sendJson(res, 409, {
          error: "ticket.sh start failed",
          detail: (startResult.stderr ?? "").slice(-1000) || "(empty)",
          slug,
        });
      }
    }
  } else {
    process.stderr.write(
      `[server] ticket.sh not found for ${wt} — engine will start without a feature branch (commits will land on the current branch).\n`,
    );
  }

  const node = process.execPath;
  const cliEntry = resolveCliEntry();
  const args = [
    cliEntry,
    "run-engine",
    "--flow", flow,
    "--ticket", slug,
    "--variant", variant,
    "--worktree", wt,
    "--repo", REPO_ROOT,
    "--run-id", runId,
  ];
  if (providersProfile) {
    args.push("--providers", providersProfile);
  }
  try {
    const child = spawn(node, args, {
      cwd: wt,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return sendJson(res, 200, {
      ok: true,
      run_id: runId,
      flow,
      variant,
      ticket_id: slug,
      worktree_path: wt,
      providers: providersProfile ?? "default",
      pid: child.pid ?? null,
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: "failed to spawn run-engine",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

// POST /api/runs/:runId/restart — re-spawn `pdh-flow run-engine` on an
// EXISTING run-id so the engine resumes from the saved snapshot. The
// engine's re-spawnability contract (see CLAUDE.md "Core design
// assumptions") handles dedup of frozen judgements, so re-running a
// completed node is a fast skip. Detached, stdio /dev/null'd.
async function restartRun(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
  runId: string,
): Promise<void> {
  const wt = findWorktreeForRun(runId, worktrees);
  if (!wt) return sendJson(res, 404, { error: "run not found", run_id: runId });
  const body = await readBody(req);
  let opts: { fresh?: boolean } = {};
  try { opts = JSON.parse(body); } catch {}

  // ticket / flow / variant come from snapshot.json if present;
  // snapshot.broken.json is a fallback for runs the user manually moved
  // aside (or that we'll move aside on a fresh-restart).
  let snap = readSnapshot(wt, runId);
  if (!snap) {
    const broken = join(wt, ".pdh-flow", "runs", runId, "snapshot.broken.json");
    if (existsSync(broken)) {
      try { snap = JSON.parse(readFileSync(broken, "utf8")); } catch {}
    }
  }
  if (!snap) {
    return sendJson(res, 404, {
      error: "no snapshot or snapshot.broken found — cannot recover run params",
      run_id: runId,
    });
  }
  const ticketId = typeof snap.ticket_id === "string" ? snap.ticket_id : "";
  const flowId = typeof snap.flow === "string" ? snap.flow : "";
  const variant = typeof snap.variant === "string" ? snap.variant : "full";
  if (!ticketId || !flowId) {
    return sendJson(res, 400, {
      error: "snapshot missing ticket_id / flow",
      run_id: runId,
      ticket_id: ticketId,
      flow: flowId,
    });
  }

  // Fresh restart: move snapshot.json aside so the engine starts from
  // the variant's initial node and walks forward, using durable
  // judgements to skip already-completed nodes. Used when the snapshot
  // is suspected to be corrupted (e.g. resumed but actor never
  // re-invokes, leaving the run frozen at an active state).
  if (opts.fresh) {
    const snapPath = join(wt, ".pdh-flow", "runs", runId, "snapshot.json");
    const broken = join(wt, ".pdh-flow", "runs", runId, "snapshot.broken.json");
    if (existsSync(snapPath)) {
      try { fsRenameSync(snapPath, broken); } catch (e) {
        return sendJson(res, 500, {
          error: "failed to move snapshot aside for fresh restart",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  const node = process.execPath;
  const cliEntry = resolveCliEntry();
  const args = [
    cliEntry,
    "run-engine",
    "--flow", flowId,
    "--ticket", ticketId,
    "--variant", variant,
    "--worktree", wt,
    "--repo", REPO_ROOT,
    "--run-id", runId,
  ];
  try {
    const child = spawn(node, args, {
      cwd: wt,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    return sendJson(res, 200, {
      ok: true,
      run_id: runId,
      flow: flowId,
      variant,
      ticket_id: ticketId,
      worktree_path: wt,
      pid: child.pid ?? null,
    });
  } catch (e) {
    return sendJson(res, 500, {
      error: "failed to spawn run-engine",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface PorcelainEntry {
  /** Two-character status code from `git status --porcelain` (XY).
   *  Common values: ` M` modified, `??` untracked, `A ` added,
   *  ` D` deleted, `R ` renamed, `UU` conflicted. */
  status: string;
  /** Path relative to worktree root. For renames, this is the new path. */
  path: string;
}

/** Snapshot of the worktree's uncommitted state via `git status --porcelain`.
 *  Includes untracked files (the engine's `git add -A` would catch them).
 *  Returns clean=true iff the porcelain output is empty. */
function readWorktreeStatus(worktreePath: string): {
  clean: boolean;
  entries: PorcelainEntry[];
} {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    // Treat git failure as dirty so we don't silently start on a broken
    // repo. The detail surfaces in the 409 payload for the human.
    return {
      clean: false,
      entries: [
        {
          status: "??",
          path: `(git status failed: ${(r.stderr ?? "").trim() || "unknown"})`,
        },
      ],
    };
  }
  const text = r.stdout ?? "";
  if (text.length === 0) return { clean: true, entries: [] };
  const entries: PorcelainEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    // Rename: "R  old -> new" — keep only the new path.
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    entries.push({ status, path });
  }
  return { clean: false, entries };
}

/** Probe a ticket's `started_at` frontmatter field so we can skip
 *  re-invoking `ticket.sh start` for an already-started ticket (the script
 *  itself would error). Returns the trimmed value (string) or null. */
function readTicketStartedAt(worktreePath: string, slug: string): string | null {
  const path = join(worktreePath, "tickets", `${slug}.md`);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => l.trimStart().startsWith("started_at:"));
  if (!line) return null;
  // YAML scalar parsing:
  //   1. strip the `key:` prefix
  //   2. strip the inline `# comment` (ticket.sh templates emit
  //      `started_at: null  # Do not modify manually` — the comment must
  //      NOT be treated as part of the value)
  //   3. strip surrounding quotes
  //   4. treat YAML's `null` / `~` / empty as "not started"
  const afterColon = line.replace(/^[^:]*:\s*/, "");
  const commentIdx = afterColon.search(/\s+#/);
  const raw = (commentIdx >= 0 ? afterColon.slice(0, commentIdx) : afterColon).trim();
  const value = raw.replace(/^["']|["']$/g, "").trim();
  if (!value) return null;
  if (value.toLowerCase() === "null" || value === "~") return null;
  return value;
}

// POST /api/tickets — body { slug, title?, epic? }. Shells `ticket.sh
// new <slug> [--epic <slug>]` against the primary worktree. Returns
// the created ticket file path + slug. ticket.sh validates slug shape;
// surfaces non-zero exit as 500.
async function createTicket(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
): Promise<void> {
  const body = await readBody(req);
  let parsed: { slug?: string; title?: string; epic?: string; worktree?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const slug = (parsed.slug ?? "").trim();
  if (!slug) return sendJson(res, 400, { error: "slug is required" });

  // Pick the worktree: explicit, or the epic's worktree (if --epic
  // given), or the first aggregated worktree (primary).
  let wt: string | null = null;
  if (parsed.worktree) {
    wt = worktrees.find((w) => w === parsed.worktree) ?? null;
    if (!wt) return sendJson(res, 400, { error: "unknown worktree", worktree: parsed.worktree });
  } else if (parsed.epic) {
    wt = findWorktreeForEpic(parsed.epic, worktrees);
    if (!wt) return sendJson(res, 404, { error: "epic not found", epic: parsed.epic });
  } else {
    wt = worktrees[0] ?? null;
  }
  if (!wt) return sendJson(res, 500, { error: "no worktree available" });

  const ts = resolveTicketShPath(wt);
  if (!ts) return sendJson(res, 500, { error: "ticket.sh not found", worktree: wt });
  const args = ["new", slug];
  if (parsed.epic) args.push("--epic", parsed.epic);
  const r = spawnSync(ts, args, {
    cwd: wt,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    return sendJson(res, 500, {
      error: "ticket.sh new failed",
      exit: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    });
  }
  // ticket.sh new prints "Created ticket file: tickets/<id>.md" — parse it.
  const stdout = (r.stdout ?? "").trim();
  const m = stdout.match(/Created ticket file:\s*(\S+)/);
  const filePath = m?.[1] ?? null;
  const createdSlug = filePath?.replace(/^tickets\//, "").replace(/\.md$/, "") ?? slug;
  return sendJson(res, 200, {
    ok: true,
    slug: createdSlug,
    ticket_file: filePath,
    epic_id: parsed.epic ?? null,
    worktree_path: wt,
    stdout,
  });
}

// POST /api/tickets/:slug/cancel — body { reason }. ticket.sh cancel
// runs on the ticket's branch (must be `start`'d first); for now we
// accept reason as audit metadata and shell to ticket.sh. If the
// ticket isn't started, ticket.sh will surface that.
async function cancelTicketViaTicketSh(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
  slug: string,
): Promise<void> {
  const wt = findWorktreeForTicket(slug, worktrees);
  if (!wt) return sendJson(res, 404, { error: "ticket not found", slug });
  const body = await readBody(req);
  let parsed: { reason?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const reason = (parsed.reason ?? "").trim();
  if (!reason) return sendJson(res, 400, { error: "reason is required" });
  const ts = resolveTicketShPath(wt);
  if (!ts) return sendJson(res, 500, { error: "ticket.sh not found", worktree: wt });
  // ticket.sh cancel acts on the CURRENT branch (the feature branch
  // for the ticket). The runtime user is responsible for being on
  // the right branch; we record reason in stdout.
  const r = spawnSync(ts, ["cancel", "-f"], {
    cwd: wt,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    input: reason,
  });
  if (r.status !== 0) {
    return sendJson(res, 500, {
      error: "ticket.sh cancel failed",
      exit: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    slug,
    reason,
    worktree_path: wt,
    stdout: (r.stdout ?? "").trim(),
  });
}

// POST /api/epics — body { slug, title?, branch?, main_direct?, from_ref? }.
// Shells `ticket.sh epic new <slug> [--title …] [--main-direct] [--from-ref …]`.
async function createEpic(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
): Promise<void> {
  const body = await readBody(req);
  let parsed: { slug?: string; title?: string; main_direct?: boolean; from_ref?: string; worktree?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const slug = (parsed.slug ?? "").trim();
  if (!slug) return sendJson(res, 400, { error: "slug is required" });
  const wt = parsed.worktree
    ? worktrees.find((w) => w === parsed.worktree) ?? null
    : worktrees[0] ?? null;
  if (!wt) return sendJson(res, 400, { error: "no worktree resolved", worktree: parsed.worktree });
  const ts = resolveTicketShPath(wt);
  if (!ts) return sendJson(res, 500, { error: "ticket.sh not found", worktree: wt });
  const args = ["epic", "new", slug];
  if (parsed.title) args.push("--title", parsed.title);
  if (parsed.main_direct) args.push("--main-direct");
  if (parsed.from_ref) args.push("--from-ref", parsed.from_ref);
  const r = spawnSync(ts, args, {
    cwd: wt,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    return sendJson(res, 500, {
      error: "ticket.sh epic new failed",
      exit: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    slug,
    title: parsed.title ?? slug,
    branch: parsed.main_direct ? "main" : `epic/${slug}`,
    worktree_path: wt,
    stdout: (r.stdout ?? "").trim(),
  });
}

// POST /api/epics/:slug/cancel — direct shell to ticket.sh epic cancel.
// No engine spin-up: cancel is a one-shot mechanic that doesn't need
// the PD-D ceremony (the gist spec treats close + cancel as
// peers, both terminal). Reason is required; the UI surfaces a
// modal that gathers it before the POST.
async function cancelEpicViaTicketSh(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
  slug: string,
): Promise<void> {
  const wt = findWorktreeForEpic(slug, worktrees);
  if (!wt) return sendJson(res, 404, { error: "epic not found", slug });

  const body = await readBody(req);
  let parsed: { reason?: string; push?: boolean; delete_remote?: boolean } = {};
  try { parsed = JSON.parse(body); } catch {}
  const reason = (parsed.reason ?? "").trim();
  if (!reason) {
    return sendJson(res, 400, {
      error: "reason is required",
      detail: "ticket.sh epic cancel needs --reason \"<text>\"; pass it in the request body",
    });
  }
  const ts = resolveTicketShPath(wt);
  if (!ts) {
    return sendJson(res, 500, {
      error: "ticket.sh not found",
      detail: `looked at $PDH_FLOW_TICKET_SH, ${wt}/ticket.sh, vendored`,
    });
  }
  const args = ["epic", "cancel", slug, "--reason", reason];
  if (!parsed.push) args.push("--no-push");
  if (!parsed.delete_remote) args.push("--no-delete-remote");
  const r = spawnSync(ts, args, {
    cwd: wt,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    return sendJson(res, 500, {
      error: "ticket.sh epic cancel failed",
      exit: r.status,
      stdout: (r.stdout ?? "").trim(),
      stderr: (r.stderr ?? "").trim(),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    epic_id: slug,
    worktree_path: wt,
    reason,
    stdout: (r.stdout ?? "").trim(),
  });
}

function readFrontmatter(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  // Minimal YAML parse: scalar key: value lines only. Sufficient for the
  // top-level frontmatter fields the UI needs. We coerce YAML scalar
  // sentinels (`null`/`~`, `true`/`false`, plain numbers) to their JS
  // types so downstream consumers can do truthy checks (e.g. TicketPage
  // treats unset `started_at` as the pre-start signal) without falling
  // into "is the string 'null' truthy?" traps.
  const out: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!lm) continue;
    const key = lm[1];
    const raw = lm[2].trim();
    if (raw === "" || raw.startsWith("-")) continue;
    out[key] = parseFrontmatterScalar(raw);
  }
  return out;
}

function parseFrontmatterScalar(raw: string): unknown {
  if (raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  // Plain or quoted string; strip surrounding quote of either flavour.
  return raw.replace(/^['"]|['"]$/g, "");
}

function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

// ─── Run discovery ────────────────────────────────────────────────────────

interface RunListItem {
  run_id: string;
  saved_at: string | null;
  ticket_id: string | null;
  current_state: string | null;
  /** Owning worktree, surfaced so the runs table can show which checkout
   *  produced this run when the server aggregates across multiple. */
  worktree_path: string;
}

interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  /** True when this is the worktree the running serve is bound to. */
  is_current: boolean;
  /** True when path/.pdh-flow/runs/ has at least one run. */
  has_runs: boolean;
  /** Quick summary metadata, useful for the top-page panel. */
  ticket_count: number;
  run_count: number;
  /** Newest run's saved_at, if any. ISO string or null. */
  last_run_at: string | null;
}

// Parse `git worktree list --porcelain` from the bound worktree's git.
// We treat git as the source of truth — the user might have set up the
// worktree manually or via `pdh-flow ticket new`, both produce the same
// porcelain output. Any worktree under our control should sit on the same
// `git/.git/worktrees/` registry, so this single call surfaces them all.
// Build the worktree panel list directly from the resolved aggregation
// set, so worktrees added via --extra-worktree are visible even when
// they're not siblings under git's worktree registry (e.g. independent
// repos under /tmp). Branch + HEAD are best-effort: if `git worktree
// list --porcelain` from each path returns a single self-row we use
// it; otherwise fields stay null and the UI falls back to "(detached)".
function listAggregatedWorktrees(worktrees: string[], primary: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = worktrees.map((wt) => {
    const meta = describeGitWorktree(wt);
    return {
      path: wt,
      branch: meta?.branch ?? null,
      head: meta?.head ?? null,
      is_current: resolve(wt) === resolve(primary),
      has_runs: existsSync(join(wt, ".pdh-flow", "runs")),
      ticket_count: countTickets(wt),
      run_count: countRuns(wt),
      last_run_at: latestRunSavedAt(wt),
    };
  });
  out.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return (a.branch ?? a.path).localeCompare(b.branch ?? b.path);
  });
  return out;
}

function describeGitWorktree(worktreePath: string): { branch: string | null; head: string | null } | null {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Porcelain output lists every worktree in the shared registry,
    // including the one we ran the command from. We have to find the
    // block whose `worktree <path>` resolves to the same path we asked
    // about; the first block (= primary worktree of the registry) is
    // not necessarily us.
    const target = resolve(worktreePath);
    const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const wm = lines.find((l) => l.startsWith("worktree "));
      if (!wm) continue;
      const blockPath = wm.slice("worktree ".length).trim();
      if (resolve(blockPath) !== target) continue;
      let head: string | null = null;
      let branch: string | null = null;
      for (const line of lines) {
        if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch ")) {
          const ref = line.slice("branch ".length).trim();
          branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        }
      }
      return { branch, head };
    }
    return null;
  } catch {
    return null;
  }
}

function listWorktrees(currentWorktreePath: string): WorktreeInfo[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: currentWorktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Not a git worktree, or git not installed. Return only the current
    // tree so the UI panel still has *something* to show.
    return [{
      path: currentWorktreePath,
      branch: null,
      head: null,
      is_current: true,
      has_runs: existsSync(join(currentWorktreePath, ".pdh-flow", "runs")),
      ticket_count: countTickets(currentWorktreePath),
      run_count: countRuns(currentWorktreePath),
      last_run_at: latestRunSavedAt(currentWorktreePath),
    }];
  }
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const out: WorktreeInfo[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) {
        // Format: "branch refs/heads/<name>"
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached") {
        branch = null;
      }
    }
    if (!path) continue;
    out.push({
      path,
      branch,
      head,
      is_current: resolve(path) === resolve(currentWorktreePath),
      has_runs: existsSync(join(path, ".pdh-flow", "runs")),
      ticket_count: countTickets(path),
      run_count: countRuns(path),
      last_run_at: latestRunSavedAt(path),
    });
  }
  // Current worktree first, rest by branch name.
  out.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return (a.branch ?? a.path).localeCompare(b.branch ?? b.path);
  });
  return out;
}

function countTickets(worktreePath: string): number {
  const dir = join(worktreePath, "tickets");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith(".md") && !f.endsWith("-note.md"),
    ).length;
  } catch {
    return 0;
  }
}

function countRuns(worktreePath: string): number {
  const dir = join(worktreePath, ".pdh-flow", "runs");
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function latestRunSavedAt(worktreePath: string): string | null {
  const dir = join(worktreePath, ".pdh-flow", "runs");
  if (!existsSync(dir)) return null;
  let best: string | null = null;
  try {
    for (const name of readdirSync(dir)) {
      const snap = readSnapshot(worktreePath, name);
      const saved = snap?.saved_at ?? null;
      if (saved && (!best || saved.localeCompare(best) > 0)) best = saved;
    }
  } catch {
    // ignore
  }
  return best;
}

function listRuns(worktreePath: string): RunListItem[] {
  const runsDir = join(worktreePath, ".pdh-flow", "runs");
  if (!existsSync(runsDir)) return [];
  const entries = readdirSync(runsDir).filter((name) => {
    try {
      return statSync(join(runsDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  const items: RunListItem[] = entries.map((runId) => {
    const snap = readSnapshot(worktreePath, runId);
    return {
      run_id: runId,
      saved_at: snap?.saved_at ?? null,
      ticket_id: snap?.ticket_id ?? null,
      current_state: snap ? extractState(snap) : null,
      worktree_path: worktreePath,
    };
  });
  // Newest first.
  items.sort((a, b) => (b.saved_at ?? "").localeCompare(a.saved_at ?? ""));
  return items;
}

function listRunsAggregated(worktrees: string[]): RunListItem[] {
  const all: RunListItem[] = [];
  for (const wt of worktrees) all.push(...listRuns(wt));
  all.sort((a, b) => (b.saved_at ?? "").localeCompare(a.saved_at ?? ""));
  return all;
}

interface RunSummary {
  run_id: string;
  ticket_id: string | null;
  flow: string | null;
  variant: string | null;
  saved_at: string | null;
  current_state: string;
  round: number;
  last_guardian_decision: string | null;
  active_gate: string | null;
  /** A decision proposed via the gate-respond wrapper (e.g. from a terminal
   *  "open in terminal" session) that a human has not confirmed yet. The
   *  engine reads the *final* gates/<node>.json; this draft is pending the
   *  Confirm action. Null when there's no active gate or no draft. */
  gate_draft: GateDraft | null;
  /** F-012: pending in-step turn, when a provider_step is awaiting an answer. */
  active_turn: ActiveTurn | null;
  /** True when an answer file exists with mtime newer than the snapshot's
   *  saved_at and no question is currently pending — i.e. the user has
   *  already submitted, the engine has not yet finished the resumed
   *  provider call, and the run page would otherwise look frozen. */
  processing_answer: boolean;
  judgements: { node_id: string; round: number; decision: string }[];
  gate_decisions: { node_id: string; decision: string; decided_at: string }[];
  closed: boolean;
  /** When current_state is `__failed__` the engine recorded the
   *  throwing error in ctx.__lastError. Surface it so the UI can show
   *  what went wrong without forcing the human into the snapshot JSON. */
  last_error: string | null;
  /** The user submitted a gate decision but await-gate's business-rule
   *  validation refused it (e.g. concern_triage missing). The engine
   *  archives the failed file to `<gate>__rejected-<ts>.json` and
   *  writes `<gate>__rejection.json` with the reason. We surface that
   *  here so the UI can tell the user why their click did nothing —
   *  the previous behaviour was a silent no-op which is a real foot-
   *  gun ("approve押しても進まない"). Null when the active gate has
   *  no pending rejection (file missing OR superseded by a successful
   *  later decision). */
  gate_rejection: GateRejection | null;
}

interface GateRejection {
  node_id: string;
  rejected_at: string;
  error: string;
  /** The decision the user tried to submit (so the UI can echo back
   *  "you tried to approve but…" instead of generic text). */
  attempted_decision: Record<string, unknown> | null;
}

interface GateDraft {
  node_id: string;
  decision: string;
  comment?: string;
  approver?: string;
  decided_at?: string;
  via?: string;
}

interface ActiveTurn {
  node_id: string;
  turn: number;
  round: number;
  asked_at: string | null;
  question: string;
  options: { label: string; description?: string }[];
  context: string | null;
}

function getRunSummary(worktreePath: string, runId: string): RunSummary | null {
  const runDir = join(worktreePath, ".pdh-flow", "runs", runId);
  if (!existsSync(runDir)) return null;
  const snap = readSnapshot(worktreePath, runId);
  const currentState = snap ? extractState(snap) : "<unknown>";
  const judgements = readJudgements(worktreePath, runId);
  const gateDecisions = readGateDecisions(worktreePath, runId);
  // active_gate: heuristic — if currentState matches a gate-shaped name, flag.
  // A gate node id by convention is `<name>_gate` or `<name>.gate`.
  const isGate =
    /(^|_|\.)gate$/.test(currentState) ||
    currentState === "plan_gate" ||
    currentState === "close_gate" ||
    currentState === "review_gate";
  // "Already decided for the current cycle" means a *live* decision file
  // sitting at gates/<node>.json. After the engine consumes a decision
  // it renames the file to gates/<node>__consumed.json — that's a
  // historical record from a previous loop iteration, not the current
  // cycle. Looking only at gateDecisions here would mis-flag the gate
  // as decided when the engine has actually looped back and is waiting
  // for a fresh decision (e.g. plan_gate rejected → investigate_plan →
  // plan_review → plan_gate again).
  const activeGatePath = isGate
    ? join(runDir, "gates", `${currentState}.json`)
    : null;
  const liveDecisionExists = activeGatePath ? existsSync(activeGatePath) : false;
  const activeGate = isGate && !liveDecisionExists ? currentState : null;
  const gateDraft = activeGate ? readGateDraft(worktreePath, runId, activeGate) : null;
  const gateRejection = activeGate
    ? readActiveGateRejection(worktreePath, runId, activeGate)
    : null;
  // F-011/H10-2: closed status lives in note frontmatter (durable), not in
  // `.pdh-flow/runs/<runId>/closed.json` (ephemeral, may be wiped).
  const closed = isTicketClosed(worktreePath, snap?.ticket_id ?? null);
  const activeTurn = findActiveTurn(worktreePath, runId);
  const processingAnswer =
    activeTurn === null && hasAnswerNewerThanSnapshot(worktreePath, runId, snap?.saved_at);
  return {
    run_id: runId,
    ticket_id: snap?.ticket_id ?? null,
    flow: snap?.flow ?? null,
    variant: snap?.variant ?? null,
    saved_at: snap?.saved_at ?? null,
    current_state: currentState,
    round: typeof snap?.xstate_snapshot?.context?.round === "number"
      ? snap.xstate_snapshot.context.round
      : 0,
    last_guardian_decision: snap?.xstate_snapshot?.context?.lastGuardianDecision ?? null,
    active_gate: activeGate,
    gate_draft: gateDraft,
    active_turn: activeTurn,
    processing_answer: processingAnswer,
    judgements,
    gate_decisions: gateDecisions,
    closed,
    last_error: extractLastError(snap),
    gate_rejection: gateRejection,
  };
}

/** Surface the most recent `<gate>__rejection.json` for the currently
 *  active gate, but only when it's *fresher* than the last consumed
 *  decision — otherwise we'd echo a stale rejection from a previous
 *  cycle that the user has already moved past. Returns null when no
 *  rejection.json exists, when reading/parsing fails, or when a
 *  consumed.json with a later timestamp exists. */
function readActiveGateRejection(
  worktreePath: string,
  runId: string,
  activeGate: string,
): GateRejection | null {
  const gatesDir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  const rejPath = join(gatesDir, `${activeGate}__rejection.json`);
  if (!existsSync(rejPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(rejPath, "utf8"));
  } catch {
    return null;
  }
  const rejectedAt = typeof raw.rejected_at === "string" ? raw.rejected_at : null;
  const error = typeof raw.error === "string" ? raw.error : null;
  if (!rejectedAt || !error) return null;
  // Suppress if a successful (consumed) decision exists after this rejection
  // — the user has already moved on, the warning would be misleading.
  const consumedPath = join(gatesDir, `${activeGate}__consumed.json`);
  if (existsSync(consumedPath)) {
    try {
      const consumed = JSON.parse(readFileSync(consumedPath, "utf8")) as {
        decided_at?: unknown;
      };
      if (
        typeof consumed.decided_at === "string" &&
        Date.parse(consumed.decided_at) > Date.parse(rejectedAt)
      ) {
        return null;
      }
    } catch {
      /* unparseable consumed → show the rejection */
    }
  }
  const attempted =
    raw.attempted_decision && typeof raw.attempted_decision === "object"
      ? (raw.attempted_decision as Record<string, unknown>)
      : null;
  return {
    node_id: activeGate,
    rejected_at: rejectedAt,
    error,
    attempted_decision: attempted,
  };
}

/** Pull the engine's most recent thrown-error string out of the
 *  snapshot context. Used by the run summary to surface why a
 *  `__failed__` run failed. Returns null when the field is missing or
 *  not a string. */
function extractLastError(snap: unknown): string | null {
  const ctx = (snap as { xstate_snapshot?: { context?: Record<string, unknown> } } | null)
    ?.xstate_snapshot?.context;
  const v = ctx?.__lastError;
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
    return (v as { message: string }).message;
  }
  return null;
}

function hasAnswerNewerThanSnapshot(
  worktreePath: string,
  runId: string,
  savedAtIso: string | null | undefined,
): boolean {
  const turnsRoot = join(worktreePath, ".pdh-flow", "runs", runId, "turns");
  if (!existsSync(turnsRoot)) return false;
  const savedAtMs = savedAtIso ? Date.parse(savedAtIso) : 0;
  let nodes: string[];
  try {
    nodes = readdirSync(turnsRoot);
  } catch {
    return false;
  }
  for (const nodeId of nodes) {
    const nodeDir = join(turnsRoot, nodeId);
    let files: string[];
    try {
      if (!statSync(nodeDir).isDirectory()) continue;
      files = readdirSync(nodeDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^turn-\d{3}-answer\.json$/.test(f)) continue;
      try {
        const t = statSync(join(nodeDir, f)).mtimeMs;
        if (t > savedAtMs) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

// pdh-flow repo root (where flows/ lives). Resolved relative to this file
// so it works regardless of which worktree the engine is serving.
const PDH_FLOW_REPO = resolve(__dirname, "..", "..");

interface FlowMetaChoice {
  name: string;
  label: string;
  description: string;
}
interface FlowMeta {
  flow_id: string;
  variants: FlowMetaChoice[];
  providers: FlowMetaChoice[];
  /** When the flow yaml can't be loaded, return an empty meta + this
   *  error string so the UI can render the fallback rather than crash. */
  error?: string;
}

/** Read flows/<flowId>.yaml and project the variant + provider profile
 *  metadata for the TicketPage start card. Strips the role mappings from
 *  each provider profile and surfaces just `name` + `label` + `description`
 *  (defaulting label/description to the profile key + an empty string when
 *  the yaml hasn't been annotated yet). */
function getFlowMeta(flowId: string): FlowMeta {
  let flow;
  try {
    flow = loadFlow({ repoPath: PDH_FLOW_REPO, flowId });
  } catch (err) {
    return {
      flow_id: flowId,
      variants: [],
      providers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const variantsObj = flow.variants as Record<
    string,
    { label?: string; description?: string }
  >;
  const variants: FlowMetaChoice[] = Object.entries(variantsObj).map(
    ([name, v]) => ({
      name,
      label: typeof v.label === "string" && v.label.length > 0 ? v.label : name,
      description: typeof v.description === "string" ? v.description.trim() : "",
    }),
  );
  const providersObj = flow.providers as Record<
    string,
    { label?: string; description?: string }
  >;
  const providers: FlowMetaChoice[] = Object.entries(providersObj).map(
    ([name, p]) => ({
      name,
      label: typeof p.label === "string" && p.label.length > 0 ? p.label : name,
      description: typeof p.description === "string" ? p.description.trim() : "",
    }),
  );
  return { flow_id: flowId, variants, providers };
}

interface RunGraphResponse extends BuildGraphResult {
  current_node: string | null;
  visited_node_ids: string[];
  judgement_decisions: Record<string, string>;
  /** Full judgement records (decision + reasoning + finding count)
   *  surfaced for the timeline detail panel. */
  judgements: JudgementEntry[];
  /** Full gate decision records (approver / comment / via). */
  gate_decisions: GateDecisionEntry[];
  transitions: TransitionEntry[];
}

function getRunGraph(worktreePath: string, runId: string): RunGraphResponse | null {
  const snap = readSnapshot(worktreePath, runId);
  if (!snap) return null;
  const flowId = typeof snap.flow === "string" ? snap.flow : null;
  const variant = typeof snap.variant === "string" ? snap.variant : "full";
  if (!flowId) return null;
  let graph: BuildGraphResult;
  try {
    graph = buildGraph({ repoPath: PDH_FLOW_REPO, flowId, variant });
  } catch (err) {
    process.stderr.write(
      `[web] buildGraph failed for run=${runId} flow=${flowId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  const active = activeNodeIds(snap);
  const judgements = readJudgements(worktreePath, runId);
  const gateDecisions = readGateDecisions(worktreePath, runId);
  const judgementDecisions: Record<string, string> = {};
  for (const j of judgements) judgementDecisions[j.node_id] = j.decision;
  for (const g of gateDecisions) judgementDecisions[g.node_id] = g.decision;
  const transitions = readTransitions(worktreePath, runId);
  const visited = new Set<string>([
    ...active,
    ...judgements.map((j) => j.node_id),
    ...gateDecisions.map((g) => g.node_id),
    ...transitions.map((t) => t.to),
  ]);
  // Pick the current_node — most specific (deepest dotted) active id.
  const currentNode = active.length === 0
    ? null
    : active.reduce((best, cur) => (cur.split(".").length > best.split(".").length ? cur : best));
  return {
    ...graph,
    current_node: currentNode,
    visited_node_ids: [...visited],
    judgement_decisions: judgementDecisions,
    judgements,
    gate_decisions: gateDecisions,
    transitions,
  };
}

/** Recursively walk the XState snapshot's `value` and return every node
 *  id mentioned (parent compound + parallel branches + leaves). XState
 *  uses `__` as the separator (compile-machine.ts replaces dots), so we
 *  reverse that on the way out. */
function activeNodeIds(snap: any): string[] {
  const out: string[] = [];
  collectStateIds(snap?.xstate_snapshot?.value, out);
  return out.map((s) => s.replaceAll("__", "."));
}

function collectStateIds(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStateIds(child, out);
    }
  }
}

interface EngineStatus {
  alive: boolean;
  pid: number | null;
  last_heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  state: string | null;
  kind:
    | "running"
    | "waiting-gate"
    | "waiting-turn"
    | "processing-answer"
    | "stuck"
    | "crashed"
    | "finished"
    | "needs-human"
    | "stopped"
    | "failed"
    | "unknown";
  last_transition_at: string | null;
  same_state_seconds: number | null;
  last_error: string | null;
  /** UI uses this to render action buttons. Order = preferred → fallback. */
  recommended_actions: Array<{
    /** Stable identifier used as React key and as the action selector. */
    kind:
      | "restart"
      | "restart-fresh"
      | "open-terminal"
      | "approve-gate"
      | "answer-turn"
      | "none";
    label: string;
    description: string;
    /** True for the primary action (rendered as filled button). */
    primary?: boolean;
  }>;
  /** One-line summary the UI surfaces verbatim. */
  message: string;
}

const HEARTBEAT_STALE_SECONDS = 30;

/** Fallback liveness probe: scan `ps` for a `run-engine ... --run-id
 *  <runId>` process. Returns the pid if found, null otherwise. Used
 *  when `engine.pid` is missing — the engine may have failed to write
 *  the pid file (older build, fs hiccup) but still be alive. */
function findEnginePidByCmdline(runId: string): number | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) return null; // sanity: keep runId shell-safe
  try {
    // -ww disables column truncation so the full args (including
    // `--run-id <runId>`) are visible; without it ps caps at terminal
    // width and may hide the match.
    const out = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      if (!line.includes("run-engine")) continue;
      if (!line.includes(`--run-id ${runId}`)) continue;
      // Skip the strace / grep noise — only match the actual node engine
      // process (its command line starts with the node binary path).
      if (!/\bnode\b/.test(line)) continue;
      const m = line.match(/^\s*(\d+)\b/);
      if (m) {
        const parsed = parseInt(m[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }
  } catch {
    /* ps unavailable → caller already classified as not alive */
  }
  return null;
}
const SAME_STATE_STUCK_SECONDS = 180;

function computeEngineStatus(worktreePath: string, runId: string): EngineStatus {
  const runDir = join(worktreePath, ".pdh-flow", "runs", runId);
  const snap = readSnapshot(worktreePath, runId);
  const state = snap ? extractState(snap) : null;

  // ── Process aliveness ───────────────────────────────────────────────
  // Primary signal: `engine.pid` file written by the engine on start.
  // Secondary fallback: `pgrep -f` for `run-engine ... --run-id <runId>`
  // — older engines (or ones whose pid-file write failed silently) still
  // need to be visible to the UI, otherwise a perfectly healthy engine
  // looks "crashed". The pgrep cost is one fork per status probe; the
  // UI polls every 5–15s so this is acceptable.
  let pid: number | null = null;
  const pidPath = join(runDir, "engine.pid");
  if (existsSync(pidPath)) {
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    } catch { /* missing pid → fall through to pgrep */ }
  }
  let alive = false;
  if (pid !== null) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }
  // Fallback: find by command line if pid file is missing or stale.
  if (!alive) {
    const found = findEnginePidByCmdline(runId);
    if (found !== null) {
      pid = found;
      alive = true;
    }
  }

  // ── Heartbeat freshness ─────────────────────────────────────────────
  let lastHeartbeatAt: string | null = null;
  let heartbeatAge: number | null = null;
  const hbPath = join(runDir, "heartbeat.json");
  if (existsSync(hbPath)) {
    try {
      const raw = JSON.parse(readFileSync(hbPath, "utf8")) as { ts?: unknown };
      if (typeof raw.ts === "string") {
        lastHeartbeatAt = raw.ts;
        const parsed = Date.parse(raw.ts);
        if (Number.isFinite(parsed)) {
          heartbeatAge = Math.max(0, (Date.now() - parsed) / 1000);
        }
      }
    } catch { /* corrupt heartbeat: treat as no signal */ }
  }
  const heartbeatFresh =
    heartbeatAge !== null && heartbeatAge <= HEARTBEAT_STALE_SECONDS;

  // ── Same-state dwell (stuck detection) ──────────────────────────────
  let lastTransitionAt: string | null = null;
  let sameStateSeconds: number | null = null;
  const txPath = join(runDir, "transitions.jsonl");
  if (existsSync(txPath)) {
    try {
      const txt = readFileSync(txPath, "utf8");
      const lines = txt.trim().split("\n").filter((l) => l.length > 0);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]) as { ts?: unknown };
        if (typeof last.ts === "string") {
          lastTransitionAt = last.ts;
          const parsed = Date.parse(last.ts);
          if (Number.isFinite(parsed)) {
            sameStateSeconds = Math.max(0, (Date.now() - parsed) / 1000);
          }
        }
      }
    } catch { /* skip */ }
  }

  // ── Engine waiting flags pulled from snapshot context ──────────────
  const ctx = snap?.xstate_snapshot?.context ?? {};
  const activeGate = state && isGateState(state, ctx) ? state : null;
  const activeTurn = !!ctx?.activeTurn || readActiveTurnFromDisk(runDir);
  const processingAnswer = !!ctx?.processingAnswer;
  const lastError =
    typeof ctx?.__lastError === "string" ? ctx.__lastError : null;
  const closed = !!ctx?.closedAt;

  // ── Classify ────────────────────────────────────────────────────────
  let kind: EngineStatus["kind"] = "unknown";
  let message = "";

  if (state === "terminal") {
    kind = "finished";
    message = "Run completed successfully.";
  } else if (state === "__failed__") {
    kind = "failed";
    message = lastError
      ? `Engine failed: ${lastError}`
      : "Engine entered the failed terminal state.";
  } else if (state === "__stopped__") {
    kind = "stopped";
    message = "Engine stopped before reaching a terminal node.";
  } else if (state === "human_intervention") {
    kind = "needs-human";
    message =
      "Engine routed to `human_intervention`. A close-step failed or the gate was cancelled.";
  } else if (activeGate) {
    kind = "waiting-gate";
    message = `Engine is waiting for your decision at gate \`${activeGate}\`.`;
  } else if (processingAnswer) {
    kind = "processing-answer";
    message = "Engine is generating its response to your answer.";
  } else if (activeTurn) {
    kind = "waiting-turn";
    message = "Engine is waiting for your answer to an in-step question.";
  } else if (alive && (heartbeatFresh || heartbeatAge === null)) {
    // Fresh heartbeat OR no heartbeat at all (engine alive but not
    // writing the file — older build / hiccup) → trust process aliveness
    // as the running signal. Without this fallback a perfectly healthy
    // engine that simply isn't writing heartbeat.json would be flagged
    // as "stuck" or "crashed" 30s after start.
    kind = "running";
    message = state ? `Engine running on \`${state}\`.` : "Engine running.";
  } else if (!alive && state) {
    kind = "crashed";
    message = lastError
      ? `Engine process is no longer running. Last context error: ${lastError}`
      : "Engine process is no longer running but the snapshot is non-terminal.";
  } else if (
    alive &&
    sameStateSeconds !== null &&
    sameStateSeconds > SAME_STATE_STUCK_SECONDS &&
    heartbeatAge !== null &&
    !heartbeatFresh
  ) {
    // Heartbeat was being written but went stale while the process is
    // still up — strong "alive but hung" signal. We require an existing
    // (now-stale) heartbeat record so engines that never wrote one
    // don't get falsely flagged as stuck.
    kind = "stuck";
    message = `Engine has been on \`${state}\` for ${Math.round(sameStateSeconds)}s without progress.`;
  } else {
    kind = "unknown";
    message = state
      ? `Engine state \`${state}\` — liveness signal missing.`
      : "No snapshot found for this run.";
  }

  // ── Recommended actions per kind ────────────────────────────────────
  const actions: EngineStatus["recommended_actions"] = [];
  switch (kind) {
    case "running":
    case "processing-answer":
      actions.push({
        kind: "none",
        label: "(no action — engine is working)",
        description: "Wait for the next step.",
      });
      break;
    case "waiting-gate":
      actions.push({
        kind: "approve-gate",
        label: "Review the gate",
        description: "Scroll to the gate card below to approve / reject.",
        primary: true,
      });
      break;
    case "waiting-turn":
      actions.push({
        kind: "answer-turn",
        label: "Answer the question",
        description: "Scroll to the turn card below.",
        primary: true,
      });
      break;
    case "crashed":
      actions.push(
        {
          kind: "restart",
          label: "Restart",
          description: "Re-spawn the engine; resumes from the saved snapshot.",
          primary: true,
        },
        {
          kind: "restart-fresh",
          label: "Restart fresh",
          description:
            "Walk forward from the variant's initial node using durable judgements. Use when normal Restart does nothing.",
        },
        {
          kind: "open-terminal",
          label: "Open terminal",
          description:
            "Bash terminal in the worktree with the resume command pre-printed.",
        },
      );
      break;
    case "stuck":
      actions.push(
        {
          kind: "restart-fresh",
          label: "Restart fresh",
          description: "Force a fresh walk; durable judgements skip done work.",
          primary: true,
        },
        {
          kind: "open-terminal",
          label: "Open terminal",
          description: "Inspect logs / state manually.",
        },
      );
      break;
    case "needs-human":
    case "stopped":
      actions.push(
        {
          kind: "restart-fresh",
          label: "Restart fresh",
          description:
            "Resume the run via fresh walk-forward. Useful after fixing the close-step bug that routed here.",
          primary: true,
        },
        {
          kind: "open-terminal",
          label: "Open terminal",
          description: "Open a bash terminal in the worktree to investigate.",
        },
      );
      break;
    case "failed":
      actions.push(
        {
          kind: "open-terminal",
          label: "Open terminal",
          description:
            "Inspect the failure in the worktree, then Restart fresh.",
          primary: true,
        },
        {
          kind: "restart-fresh",
          label: "Restart fresh",
          description:
            "Walk forward from the start. Frozen judgements skip done work.",
        },
      );
      break;
    case "finished":
      // No action — informational.
      break;
    case "unknown":
      actions.push({
        kind: "open-terminal",
        label: "Open terminal",
        description: "Inspect this run's directory in the worktree.",
      });
      break;
  }
  void closed;
  return {
    alive,
    pid,
    last_heartbeat_at: lastHeartbeatAt,
    heartbeat_age_seconds: heartbeatAge,
    state,
    kind,
    last_transition_at: lastTransitionAt,
    same_state_seconds: sameStateSeconds,
    last_error: lastError,
    recommended_actions: actions,
    message,
  };
}

function isGateState(state: string, _ctx: unknown): boolean {
  // Engine sets up gate nodes with a state matching the node id; the
  // dotted form survives extractState(). We detect by suffix and by
  // a live gate decision file's absence: any state ending in `_gate`
  // qualifies as a candidate. The summary-level activeGate detection
  // (used by /api/runs/:runId) considers the live decision file; here
  // we keep it loose because engine-status is a fast-path probe.
  return /(^|\W)([a-z0-9_]+_gate)$/i.test(state);
}

function readActiveTurnFromDisk(runDir: string): boolean {
  const dir = join(runDir, "turns");
  if (!existsSync(dir)) return false;
  try {
    for (const f of readdirSync(dir)) {
      // Question without matching answer = active turn.
      if (f.endsWith("-question.json")) {
        const ans = f.replace("-question.json", "-answer.json");
        if (!existsSync(join(dir, ans))) return true;
      }
    }
  } catch { /* fall through */ }
  return false;
}

function readSnapshot(worktreePath: string, runId: string): any | null {
  const path = join(worktreePath, ".pdh-flow", "runs", runId, "snapshot.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function extractState(snap: any): string {
  const v = snap?.xstate_snapshot?.value;
  // compile-machine.ts replaces dots with `__` to make XState-safe ids;
  // restore the canonical dotted node id before surfacing to the UI / API.
  // Leave the engine sentinels (__stopped__, __failed__) alone — they're
  // not node ids, just terminal sinks the runtime uses.
  const unsafe = (s: string): string =>
    s.replace(/([A-Za-z0-9])__([A-Za-z])/g, "$1.$2");
  if (typeof v === "string") return unsafe(v);
  if (v && typeof v === "object") {
    // parallel_group: XState value is `{ <group_id>: { region1: state1, ... } }`.
    // Collapse to "<group> (n active)" so the UI doesn't render a wall of JSON.
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const group = unsafe(keys[0]);
      const inner = (v as Record<string, unknown>)[keys[0]];
      if (inner && typeof inner === "object") {
        const regions = Object.keys(inner as Record<string, unknown>);
        return `${group} (${regions.length} parallel)`;
      }
      return group;
    }
    return JSON.stringify(v);
  }
  return "<unknown>";
}

interface JudgementEntry {
  node_id: string;
  round: number;
  decision: string;
  reasoning?: string;
  blocking_findings_count?: number;
}

interface JudgementEntryWithTs extends JudgementEntry {
  /** Internal: when the engine wrote this judgement. Used to sort the
   *  list chronologically (= flow order) before stripping. */
  __ts: string;
}

function readJudgements(worktreePath: string, runId: string): JudgementEntry[] {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "judgements");
  if (!existsSync(dir)) return [];
  const out: JudgementEntryWithTs[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const findings = Array.isArray(obj.guardian_output?.blocking_findings)
        ? obj.guardian_output.blocking_findings.length
        : 0;
      // qa system_step writes its own shape (`{kind: "qa_script",
      // exit_code, stderr_tail, …}`) — no `guardian_output`. Synthesize
      // a `pass`/`fail` decision from the exit code so the Judgements
      // table doesn't show `<unknown>` for what is conceptually a
      // pass/fail verdict. stderr_tail is surfaced as the reasoning so
      // the failure mode is one click away.
      let decision = obj.guardian_output?.decision;
      let reasoning =
        typeof obj.guardian_output?.reasoning === "string"
          ? obj.guardian_output.reasoning
          : undefined;
      if (!decision && obj.kind === "qa_script") {
        decision = obj.exit_code === 0 ? "pass" : "fail";
        if (!reasoning) {
          const tail =
            typeof obj.stderr_tail === "string" && obj.stderr_tail.trim().length > 0
              ? obj.stderr_tail.trim()
              : typeof obj.stdout_tail === "string" && obj.stdout_tail.trim().length > 0
                ? obj.stdout_tail.trim()
                : "";
          reasoning = `qa: ${obj.script ?? "?"} exit=${obj.exit_code}${tail ? `\n${tail}` : ""}`;
        }
      }
      // final_verifier writes its own shape (`{kind: "final_verifier",
      // ac_verification[], summary_md}`) — no `guardian_output`.
      // Synthesize a `pass`/`fail` decision from per-AC `status`: all
      // verified/user_accepted ⇒ pass; any unverified ⇒ fail. close_gate
      // still demands a deferral plan for unverified rows, but for the
      // Judgements table a coarse pass/fail makes the verdict glanceable.
      if (!decision && obj.kind === "final_verifier") {
        const rows = Array.isArray(obj.ac_verification) ? obj.ac_verification : [];
        const total = rows.length;
        const unverified = rows.filter(
          (r: { status?: string }) => r?.status === "unverified",
        ).length;
        decision = total === 0 ? "<empty>" : unverified === 0 ? "pass" : "fail";
        if (!reasoning) {
          reasoning =
            total === 0
              ? "final_verifier returned no ac_verification rows"
              : unverified === 0
                ? `final_verifier: all ${total} AC(s) verified`
                : `final_verifier: ${unverified}/${total} AC(s) unverified — deferral required at close_gate`;
        }
      }
      // Timestamp source varies by record kind:
      //   guardian:        top-level `frozen_at` (engine writes it on freeze)
      //   qa system_step:  top-level `timestamp` (set by run_qa_script)
      //   final_verifier:  no native ts yet — fall back to file mtime
      // Empty string sorts to the front; we use the file mtime as a last
      // resort so chronologically-recent judgements still appear later.
      let ts: string =
        typeof obj.frozen_at === "string"
          ? obj.frozen_at
          : typeof obj.timestamp === "string"
            ? obj.timestamp
            : "";
      if (!ts) {
        try { ts = statSync(join(dir, f)).mtime.toISOString(); } catch { /* keep empty */ }
      }
      out.push({
        node_id: obj.frozen_by_node_id ?? f.replace(/__round-.*$/, ""),
        round: obj.round ?? 1,
        decision: decision ?? "<unknown>",
        reasoning,
        blocking_findings_count: findings,
        __ts: ts,
      });
    } catch {
      // skip malformed
    }
  }
  // Chronological (= flow order). Tie-break by round so two judgements
  // emitted in the same millisecond still order sensibly.
  out.sort((a, b) =>
    a.__ts === b.__ts ? a.round - b.round : a.__ts.localeCompare(b.__ts),
  );
  return out.map(({ __ts: _ts, ...rest }) => rest);
}

interface GateConcernTriageEntry {
  concern: string;
  action: "fix_in_this_ticket" | "accept" | "defer" | "dismiss";
  rationale: string;
  follow_up_ticket?: string;
}

interface GateDeferralApprovalEntry {
  ac_item: string;
  follow_up_ticket: string;
  reason: string;
}

interface GateDecisionEntry {
  node_id: string;
  decision: string;
  decided_at: string;
  comment?: string;
  round?: number;
  concern_triage?: GateConcernTriageEntry[];
  deferral_approvals?: GateDeferralApprovalEntry[];
}

function readGateDecisions(worktreePath: string, runId: string): GateDecisionEntry[] {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  if (!existsSync(dir)) return [];
  const out: GateDecisionEntry[] = [];
  for (const f of readdirSync(dir)) {
    // Skip non-decision files:
    //   *.draft.json          — proposals pending human confirmation
    //   __rejection.json      — await-gate's "why we refused you" metadata
    //                            (no top-level `decision` field, would
    //                            otherwise show as a bogus "<unknown>")
    //   __rejected-<ts>.json  — archive of a single refused attempt;
    //                            decision=approved on disk but the engine
    //                            never acted on it. Listing them as
    //                            "approved" rows is misleading (the user
    //                            sees 4 approves when only 1 actually
    //                            transitioned the flow).
    if (
      !f.endsWith(".json") ||
      f.endsWith(".draft.json") ||
      f.endsWith("__rejection.json") ||
      /__rejected-[^/]+\.json$/.test(f)
    ) {
      continue;
    }
    try {
      const obj = JSON.parse(readFileSync(join(dir, f), "utf8"));
      // `approver` + `via` are schema-required for audit but the web UI
      // never has a meaningful value (they always default to "web-ui"),
      // so we strip them from the API response to keep the timeline
      // clean. concern_triage / deferral_approvals carry the human's
      // actual decisions and ARE surfaced — the Gate decisions card
      // expands inline to show them.
      out.push({
        node_id: obj.node_id ?? f.replace(/__consumed\.json$|\.json$/, ""),
        decision: obj.decision ?? "<unknown>",
        decided_at: obj.decided_at ?? "",
        comment: typeof obj.comment === "string" ? obj.comment : undefined,
        round: typeof obj.round === "number" ? obj.round : undefined,
        concern_triage: Array.isArray(obj.concern_triage)
          ? obj.concern_triage
          : undefined,
        deferral_approvals: Array.isArray(obj.deferral_approvals)
          ? obj.deferral_approvals
          : undefined,
      });
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => a.decided_at.localeCompare(b.decided_at));
}

// A gate-respond --draft write pending human confirmation, for a given
// gate node. Returns null when there's no draft, or when the gate has
// already been finalised (the final wins).
function readGateDraft(
  worktreePath: string,
  runId: string,
  nodeId: string,
): GateDraft | null {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  const finalPath = join(dir, `${nodeId}.json`);
  const draftPath = join(dir, `${nodeId}.draft.json`);
  if (existsSync(finalPath) || !existsSync(draftPath)) return null;
  try {
    const obj = JSON.parse(readFileSync(draftPath, "utf8")) as Record<string, unknown>;
    return {
      node_id: typeof obj.node_id === "string" ? obj.node_id : nodeId,
      decision: typeof obj.decision === "string" ? obj.decision : "<unknown>",
      comment: typeof obj.comment === "string" ? obj.comment : undefined,
      approver: typeof obj.approver === "string" ? obj.approver : undefined,
      decided_at: typeof obj.decided_at === "string" ? obj.decided_at : undefined,
      via: typeof obj.via === "string" ? obj.via : undefined,
    };
  } catch {
    return null;
  }
}

function readNote(worktreePath: string): string | null {
  const path = join(worktreePath, "current-note.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** Generic helper: read a worktree-relative file as UTF-8, or null when
 *  the file doesn't exist. Symlinks resolve transparently — used for
 *  `current-ticket.md` (symlink) and `product-brief.md` (regular file). */
function readWorktreeFile(worktreePath: string, relPath: string): string | null {
  const path = join(worktreePath, relPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

interface EvidenceFile {
  filename: string;
  /** URL the frontend can fetch directly; resolves through this server. */
  url: string;
  /** Coarse classification driven by extension. The UI picks the
   *  renderer: image → <img>, pdf → link, text → expandable <pre>,
   *  mermaid → MermaidView (fetched + rendered as inline SVG),
   *  html → sandboxed <iframe>, other → download link. */
  kind: "image" | "pdf" | "text" | "mermaid" | "html" | "other";
  size_bytes: number;
  /** mtime as ISO; gives the UI a stable sort key when filenames don't sort sensibly. */
  modified_at: string;
}

interface EvidenceRound {
  round: number;
  files: EvidenceFile[];
}

// List every evidence artifact stored under
// `<worktree>/.pdh-flow/runs/<runId>/evidence/round-<N>/`. Returned
// rounds are sorted ascending so the UI can highlight the most recent
// at the bottom (or pick the latest by `[length-1]`).
function listEvidence(worktreePath: string, runId: string): EvidenceRound[] {
  const root = join(worktreePath, ".pdh-flow", "runs", runId, "evidence");
  if (!existsSync(root)) return [];
  const out: EvidenceRound[] = [];
  for (const dirent of readdirSync(root)) {
    const m = dirent.match(/^round-(\d+)$/);
    if (!m) continue;
    const dir = join(root, dirent);
    if (!statSync(dir).isDirectory()) continue;
    const files: EvidenceFile[] = [];
    for (const file of readdirSync(dir)) {
      const full = join(dir, file);
      const st = statSync(full);
      if (!st.isFile()) continue;
      files.push({
        filename: file,
        url: `/api/runs/${encodeURIComponent(runId)}/evidence/${dirent}/${encodeURIComponent(file)}`,
        kind: classifyEvidence(file),
        size_bytes: st.size,
        modified_at: st.mtime.toISOString(),
      });
    }
    files.sort((a, b) => a.filename.localeCompare(b.filename));
    out.push({ round: parseInt(m[1], 10), files });
  }
  out.sort((a, b) => a.round - b.round);
  return out;
}

function classifyEvidence(file: string): EvidenceFile["kind"] {
  const ext = extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".mmd") return "mermaid";
  if (ext === ".html" || ext === ".htm") return "html";
  if ([".txt", ".log", ".md", ".json", ".yaml", ".yml", ".sh", ".ts", ".js", ".py"].includes(ext)) return "text";
  return "other";
}

const EVIDENCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
};

function serveEvidenceFile(
  res: ServerResponse,
  worktreePath: string,
  runId: string,
  roundDir: string,
  filename: string,
): void {
  // Defence against `..` traversal: only allow leaf names that match the
  // patterns we control, and resolve against the evidence root before
  // checking the prefix. Re-validate after path resolution because a
  // crafted filename could still escape if we trust the regex alone.
  if (!/^round-\d+$/.test(roundDir) || filename.includes("/") || filename.includes("..")) {
    return sendJson(res, 400, { error: "bad evidence path" });
  }
  const root = join(worktreePath, ".pdh-flow", "runs", runId, "evidence");
  const target = resolve(root, roundDir, filename);
  if (!target.startsWith(resolve(root) + "/")) {
    return sendJson(res, 400, { error: "bad evidence path" });
  }
  if (!existsSync(target)) return sendJson(res, 404, { error: "evidence not found" });
  const ext = extname(filename).toLowerCase();
  const mime = EVIDENCE_MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=60",
  });
  res.end(readFileSync(target));
}

// ── worktree file browser (Viewer pane) ──────────────────────────────
// Files the engine produced live in the run's worktree, so the Viewer
// can browse it directly. Hidden from listings: `.git/` (huge, not
// "source"). Everything else is fair game — this server already runs
// trusted against the worktree (it spawns claude/codex there).

const HIDDEN_TOP_LEVEL = new Set([".git"]);

// Resolve a worktree-relative path safely. Rejects `..` escapes, the
// hidden `.git/` subtree, and symlinks that lead outside the worktree.
// Returns the absolute path, or null if disallowed. "" / "." → root.
function safeWorktreePath(worktreePath: string, rel: string): string | null {
  const root = resolve(worktreePath);
  const cleaned = (rel ?? "").replace(/^[/\\]+/, "");
  const target = resolve(root, cleaned || ".");
  if (target !== root && !target.startsWith(root + "/")) return null;
  const segs = target.slice(root.length).split("/").filter(Boolean);
  if (segs.length > 0 && HIDDEN_TOP_LEVEL.has(segs[0])) return null;
  // Symlink-escape guard: the realpath must still be inside the worktree.
  try {
    const real = realpathSync(target);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + "/")) return null;
  } catch {
    // path doesn't exist yet — leave it; the caller will 404.
  }
  return target;
}

interface WorktreeEntry {
  name: string;
  type: "file" | "dir";
  size_bytes?: number;
}

function listWorktreeDir(res: ServerResponse, worktreePath: string, rel: string): void {
  const target = safeWorktreePath(worktreePath, rel);
  if (!target) return sendJson(res, 400, { error: "bad path" });
  if (!existsSync(target)) return sendJson(res, 404, { error: "not found" });
  let st;
  try {
    st = statSync(target);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!st.isDirectory()) return sendJson(res, 400, { error: "not a directory" });
  const atRoot = resolve(target) === resolve(worktreePath);
  const entries: WorktreeEntry[] = [];
  for (const name of readdirSync(target)) {
    if (atRoot && HIDDEN_TOP_LEVEL.has(name)) continue;
    let est;
    try {
      est = statSync(join(target, name));
    } catch {
      continue; // dangling symlink etc.
    }
    if (est.isDirectory()) entries.push({ name, type: "dir" });
    else if (est.isFile()) entries.push({ name, type: "file", size_bytes: est.size });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const cleaned = (rel ?? "").replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
  return sendJson(res, 200, { path: cleaned, entries });
}

const BLOB_TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".markdown",
  ".txt", ".log", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".sh", ".bash",
  ".zsh", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".css", ".scss", ".less", ".html", ".htm", ".xml", ".csv", ".sql", ".graphql", ".gql",
  ".gitignore", ".npmignore", ".editorconfig", ".dockerignore", ".prettierrc", ".eslintrc",
  ".j2", ".jinja2", ".njk", ".lock", ".mod", ".sum", ".diff", ".patch",
]);
const BLOB_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".avif": "image/avif", ".pdf": "application/pdf",
};
const BLOB_MAX_BYTES = 8 * 1024 * 1024;

function serveWorktreeFile(res: ServerResponse, worktreePath: string, rel: string): void {
  const target = safeWorktreePath(worktreePath, rel);
  if (!target) return sendJson(res, 400, { error: "bad path" });
  if (!existsSync(target)) return sendJson(res, 404, { error: "not found" });
  let st;
  try {
    st = statSync(target);
  } catch {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!st.isFile()) return sendJson(res, 400, { error: "not a file" });
  if (st.size > BLOB_MAX_BYTES) {
    return sendJson(res, 413, { error: `file too large (${st.size} bytes; max ${BLOB_MAX_BYTES})` });
  }
  const base = target.slice(target.lastIndexOf("/") + 1);
  const ext = extname(base).toLowerCase();
  // Files like ".gitignore" have no extname → use the basename.
  const key = ext || base.toLowerCase();
  let mime = BLOB_MIME[ext];
  if (!mime) mime = BLOB_TEXT_EXT.has(key) ? "text/plain; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, max-age=10" });
  res.end(readFileSync(target));
}

// True when the note frontmatter shows the run reached a terminal close
// state. Source of truth is tickets/<id>-note.md frontmatter.status; falls
// back to current-note.md when the ticketId is unknown (legacy path).
function isTicketClosed(
  worktreePath: string,
  ticketId: string | null,
): boolean {
  // F-011/H10-2: closed status lives in durable file state, not in the
  // ephemeral `.pdh-flow/runs/<runId>/closed.json`. There are three
  // independent signals — any one of them is sufficient evidence that
  // the ticket is closed:
  //
  //   1. ticket file moved to `tickets/done/<id>.md` by ticket.sh close
  //   2. ticket frontmatter has `closed_at:` (engine writes it when
  //      ticket.sh is skipped)
  //   3. note frontmatter has `status: completed` (engine-owned;
  //      survives even when ticket files have been moved)
  //
  // We check all three. Pre-fix only #3 was consulted, and only in the
  // active `tickets/` location — so a ticket that ticket.sh had moved
  // to `tickets/done/` reported closed=false because the lookup found
  // no file at the active path. This was misleading on the run summary
  // for any healthy close.
  if (!ticketId) {
    // Single-tenant fallback: just read current-note.md.
    const note = join(worktreePath, "current-note.md");
    if (existsSync(note)) {
      try {
        const text = readFileSync(note, "utf8");
        const m = text.match(/^---\s*[\s\S]*?status:\s*(\w+)/m);
        if (m?.[1] === "completed") return true;
      } catch {
        /* fall through */
      }
    }
    return false;
  }
  // 1 & 2: ticket file (active or done) with closed_at.
  for (const dir of ["tickets", "tickets/done"] as const) {
    const path = join(worktreePath, dir, `${ticketId}.md`);
    if (!existsSync(path)) continue;
    if (dir === "tickets/done") return true; // located in done/ — closed.
    try {
      const text = readFileSync(path, "utf8");
      if (/^---\s*[\s\S]*?closed_at:\s*\S+/m.test(text)) return true;
      if (/^---\s*[\s\S]*?status:\s*done\b/m.test(text)) return true;
    } catch {
      /* skip */
    }
  }
  // 3: note file (active or done) with status=completed.
  for (const dir of ["tickets", "tickets/done"] as const) {
    const path = join(worktreePath, dir, `${ticketId}-note.md`);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const m = text.match(/^---\s*[\s\S]*?status:\s*(\w+)/m);
      if (m?.[1] === "completed") return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

// ─── Active turn discovery (F-012) ───────────────────────────────────────

function findActiveTurn(
  worktreePath: string,
  runId: string,
): ActiveTurn | null {
  const turnsRoot = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "turns",
  );
  if (!existsSync(turnsRoot)) return null;
  // Scan node-id directories for an unanswered question. Prefer the
  // lowest turn number in the most-recently-asked node (heuristic; in
  // practice only one turn is ever pending at once).
  const nodes = readdirSync(turnsRoot).filter((name) => {
    try {
      return statSync(join(turnsRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  let best: { mtime: number; turn: ActiveTurn } | null = null;
  for (const nodeId of nodes) {
    const nodeDir = join(turnsRoot, nodeId);
    const files = readdirSync(nodeDir);
    const seqs = new Set<number>();
    const answered = new Set<number>();
    for (const f of files) {
      const qm = f.match(/^turn-(\d{3})-question\.json$/);
      const am = f.match(/^turn-(\d{3})-answer\.json$/);
      if (qm) seqs.add(parseInt(qm[1], 10));
      if (am) answered.add(parseInt(am[1], 10));
    }
    const open = [...seqs].filter((n) => !answered.has(n)).sort((a, b) => a - b);
    if (open.length === 0) continue;
    const turnNum = open[0];
    const seq = String(turnNum).padStart(3, "0");
    const qPath = join(nodeDir, `turn-${seq}-question.json`);
    let q: any;
    try {
      q = JSON.parse(readFileSync(qPath, "utf8"));
    } catch {
      continue;
    }
    const mtime = statSync(qPath).mtimeMs;
    const candidate: ActiveTurn = {
      node_id: nodeId,
      turn: turnNum,
      round: typeof q.round === "number" ? q.round : 1,
      asked_at: typeof q.asked_at === "string" ? q.asked_at : null,
      question: typeof q.ask?.question === "string" ? q.ask.question : "(no question)",
      options: Array.isArray(q.ask?.options)
        ? q.ask.options
            .filter((o: any) => o && typeof o.label === "string")
            .map((o: any) => ({
              label: o.label,
              ...(typeof o.description === "string" ? { description: o.description } : {}),
            }))
        : [],
      context: typeof q.ask?.context === "string" ? q.ask.context : null,
    };
    if (!best || mtime > best.mtime) {
      best = { mtime, turn: candidate };
    }
  }
  return best?.turn ?? null;
}

// ─── Turn answer post (F-012) ────────────────────────────────────────────

async function postTurn(
  req: IncomingMessage,
  res: ServerResponse,
  worktreePath: string,
  runId: string,
  nodeId: string,
  turnNum: number,
): Promise<void> {
  const body = await readBody(req);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    return sendJson(res, 400, { error: "text is required and must be non-empty" });
  }
  const responder = typeof parsed.responder === "string"
    ? parsed.responder.slice(0, 128)
    : "web-ui";
  const selectedOption =
    typeof parsed.selected_option === "number" && Number.isInteger(parsed.selected_option) && parsed.selected_option >= 0
      ? parsed.selected_option
      : undefined;

  // Read the matching question file to copy round (and confirm question exists).
  const seq = String(turnNum).padStart(3, "0");
  const qPath = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "turns",
    nodeId,
    `turn-${seq}-question.json`,
  );
  if (!existsSync(qPath)) {
    return sendJson(res, 404, {
      error: "question file not found",
      path: qPath,
    });
  }
  const aPath = qPath.replace("-question.", "-answer.");
  if (existsSync(aPath)) {
    return sendJson(res, 409, {
      error: "turn already answered",
      existing: JSON.parse(readFileSync(aPath, "utf8")),
    });
  }
  let round = 1;
  try {
    const q = JSON.parse(readFileSync(qPath, "utf8"));
    if (typeof q.round === "number") round = q.round;
  } catch { /* ignore */ }

  const answer: Record<string, unknown> = {
    status: "completed",
    node_id: nodeId,
    round,
    turn: turnNum,
    answered_at: new Date().toISOString(),
    answer: {
      text,
      ...(selectedOption !== undefined ? { selected_option: selectedOption } : {}),
    },
    via: "web_ui",
    responder,
  };

  const v = getValidator();
  const result = v.validate(SCHEMA_IDS.turnAnswer, answer);
  if (result.ok === false) {
    return sendJson(res, 400, {
      error: "turn answer failed schema validation",
      details: formatErrors(result.errors),
    });
  }
  writeFileSync(aPath, JSON.stringify(answer, null, 2) + "\n");
  return sendJson(res, 200, { ok: true, written: aPath, answer });
}

// ─── Gate post ────────────────────────────────────────────────────────────

async function postGate(
  req: IncomingMessage,
  res: ServerResponse,
  worktreePath: string,
  runId: string,
  nodeId: string,
): Promise<void> {
  const body = await readBody(req);
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const decision = parsed.decision;
  if (!["approved", "rejected", "cancelled"].includes(decision)) {
    return sendJson(res, 400, {
      error: "decision must be one of approved/rejected/cancelled",
    });
  }
  const approver = String(parsed.approver ?? "").slice(0, 128) || "web-ui";
  const comment = parsed.comment ? String(parsed.comment).slice(0, 4000) : undefined;

  const decided: any = {
    status: "completed",
    node_id: nodeId,
    round: parsed.round ?? 1,
    decision,
    approver,
    decided_at: new Date().toISOString(),
    via: "web_ui",
  };
  if (comment) decided.comment = comment;
  if (parsed.form_data && typeof parsed.form_data === "object") {
    decided.form_data = parsed.form_data;
  }
  // PDH concern triage: pass-through; schema validation below catches a
  // malformed array. Each entry persists to gates/<nodeId>.json and
  // (for accept / defer) gets echoed to the ticket by close_ticket.
  if (Array.isArray(parsed.concern_triage) && parsed.concern_triage.length > 0) {
    decided.concern_triage = parsed.concern_triage;
  }
  if (Array.isArray(parsed.deferral_approvals) && parsed.deferral_approvals.length > 0) {
    decided.deferral_approvals = parsed.deferral_approvals;
  }

  // Validate against gate-output.schema.json before writing.
  const v = getValidator();
  const result = v.validate(SCHEMA_IDS.gateOutput, decided);
  if (result.ok === false) {
    return sendJson(res, 400, {
      error: "gate decision failed schema validation",
      details: formatErrors(result.errors),
    });
  }

  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${nodeId}.json`);
  if (existsSync(path)) {
    return sendJson(res, 409, {
      error: "gate already decided",
      existing: JSON.parse(readFileSync(path, "utf8")),
    });
  }
  writeFileSync(path, JSON.stringify(decided, null, 2));
  return sendJson(res, 200, { ok: true, written: path, decision: decided });
}

// Confirm a gate draft written by the assist wrapper (gate-respond
// --draft) by atomically renaming `<nodeId>.draft.json` → `<nodeId>.json`.
function postGateConfirm(
  res: ServerResponse,
  worktreePath: string,
  runId: string,
  nodeId: string,
): void {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  const final = join(dir, `${nodeId}.json`);
  const draft = join(dir, `${nodeId}.draft.json`);
  if (existsSync(final)) {
    return sendJson(res, 409, {
      error: "already_finalized",
      existing: JSON.parse(readFileSync(final, "utf8")),
    });
  }
  if (!existsSync(draft)) {
    return sendJson(res, 404, { error: "no_draft" });
  }
  // Validate the draft before promoting.
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(draft, "utf8"));
  } catch (e) {
    return sendJson(res, 400, {
      error: `invalid_draft_json: ${(e as Error).message}`,
    });
  }
  const v = getValidator();
  const r = v.validate<GateStepOutput>(SCHEMA_IDS.gateOutput, obj);
  if (r.ok === false) {
    return sendJson(res, 400, {
      error: "draft_schema_violation",
      details: formatErrors(r.errors),
    });
  }
  // Defense in depth: the engine's business rules (concern_triage
  // coverage on approve, deferral_approvals on close, no fix_in_this_ticket
  // entries on approve) used to throw at await-gate and crash the run.
  // Re-run them here so a Web-UI draft confirm refuses to promote a
  // decision the engine would reject. The same function is exported
  // from await-gate so the rules stay defined in exactly one place.
  try {
    validateBusinessRules({
      nodeId,
      runId,
      worktreePath,
      decision: r.data,
    });
  } catch (e) {
    return sendJson(res, 400, {
      error: "business_rule_violation",
      message: e instanceof Error ? e.message : String(e),
    });
  }
  // fs.renameSync is atomic on the same filesystem (runs/ lives
  // under the worktree). Imported as fsRenameSync at the top.
  fsRenameSync(draft, final);
  return sendJson(res, 200, { ok: true, written: final, decision: r.data });
}

// Drop a proposed (draft) gate decision so the human can decide manually
// instead of confirming the proposal. No-op-success if there's no draft.
function discardGateDraft(
  res: ServerResponse,
  worktreePath: string,
  runId: string,
  nodeId: string,
): void {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  const final = join(dir, `${nodeId}.json`);
  const draft = join(dir, `${nodeId}.draft.json`);
  if (existsSync(final)) {
    return sendJson(res, 409, { error: "already_finalized" });
  }
  if (existsSync(draft)) rmSync(draft, { force: true });
  return sendJson(res, 200, { ok: true });
}

// ─── SSE: per-run change stream ───────────────────────────────────────────

function handleSSE(
  req: IncomingMessage,
  res: ServerResponse,
  worktreePath: string,
  runId: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`:connected ${runId}\n\n`);

  const runDir = join(worktreePath, ".pdh-flow", "runs", runId);
  const watchers: FSWatcher[] = [];
  let closed = false;
  let coalesce: NodeJS.Timeout | null = null;

  const emitChange = (): void => {
    if (closed || coalesce) return;
    coalesce = setTimeout(() => {
      coalesce = null;
      if (!closed) res.write("event: change\ndata: {}\n\n");
    }, 100);
  };

  const safeWatch = (dir: string): void => {
    if (!existsSync(dir)) return;
    try {
      const w = watch(dir, () => emitChange());
      watchers.push(w);
    } catch (e) {
      process.stderr.write(
        `[web] watch failed on ${dir}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  };

  // Watch run dir + sub-dirs that already exist.
  safeWatch(runDir);
  safeWatch(join(runDir, "judgements"));
  safeWatch(join(runDir, "gates"));
  // F-012: turn question/answer files come and go inside per-node
  // dirs. Watch the parent so creation of those dirs surfaces, plus
  // each child dir if it already exists.
  safeWatch(join(runDir, "turns"));
  const turnsRoot = join(runDir, "turns");
  if (existsSync(turnsRoot)) {
    for (const name of readdirSync(turnsRoot)) {
      const sub = join(turnsRoot, name);
      try {
        if (statSync(sub).isDirectory()) safeWatch(sub);
      } catch { /* skip */ }
    }
  }

  // If sub-dirs are created later, the run-dir watcher fires and triggers a
  // refetch on the client; the missed sub-dir watcher only matters once for
  // the very first event in that sub-dir. Acceptable for MVP — the client
  // refetches the full summary on any change anyway.

  // Heartbeat keeps proxies / load balancers from killing idle conns.
  const hb = setInterval(() => {
    if (!closed) res.write(`:hb ${Date.now()}\n\n`);
  }, 15_000);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    if (coalesce) clearTimeout(coalesce);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ─── SSE: home (runs list) change stream ──────────────────────────────────

function handleRunsListSSE(
  req: IncomingMessage,
  res: ServerResponse,
  worktrees: string[],
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":connected runs\n\n");

  const watchers: FSWatcher[] = [];
  let closed = false;
  let coalesce: NodeJS.Timeout | null = null;

  const emitChange = (): void => {
    if (closed || coalesce) return;
    coalesce = setTimeout(() => {
      coalesce = null;
      if (!closed) res.write("event: change\ndata: {}\n\n");
    }, 200);
  };

  // Watch every worktree's runs dir non-recursively. Any one of them
  // gaining/losing a run dir invalidates the home-page list. Per-run
  // intra-state changes are picked up by the detail page's /events SSE,
  // which already resolves the right worktree via runId lookup.
  for (const worktreePath of worktrees) {
    const runsDir = join(worktreePath, ".pdh-flow", "runs");
    if (!existsSync(runsDir)) continue;
    try {
      watchers.push(watch(runsDir, () => emitChange()));
    } catch {
      /* skip unreadable */
    }
  }

  const hb = setInterval(() => {
    if (!closed) res.write(`:hb ${Date.now()}\n\n`);
  }, 15_000);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    if (coalesce) clearTimeout(coalesce);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
}

// ─── Static files ─────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res: ServerResponse, staticDir: string, urlPath: string): void {
  // Default to index.html for `/`.
  const safe = urlPath === "/" ? "/index.html" : urlPath;
  // Prevent path traversal.
  const target = resolve(staticDir, "." + safe);
  if (!target.startsWith(resolve(staticDir))) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA fallback: navigation paths without an extension fall through to
    // index.html so React Router can resolve them client-side. Real asset
    // 404s (a missing .js / .css / .png) keep returning 404 — those would
    // otherwise mask broken bundles.
    if (extname(urlPath) === "") {
      const indexHtml = resolve(staticDir, "./index.html");
      if (existsSync(indexHtml)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(indexHtml));
        return;
      }
    }
    return sendJson(res, 404, { error: "not found", path: urlPath });
  }
  const mime = MIME[extname(target)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(readFileSync(target));
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
