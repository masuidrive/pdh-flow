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
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync as fsRenameSync,
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

  // Sibling worktree discovery — purely topology, doesn't aggregate runs.
  // Top page renders this in the "Worktrees" panel so the user can see
  // every checkout that this server is now also aggregating from.
  if (path === "/api/worktrees" && req.method === "GET") {
    return sendJson(res, 200, listAggregatedWorktrees(ctx.worktrees, ctx.primaryWorktree));
  }

  let m = path.match(/^\/api\/tickets\/([^/]+)$/);
  if (m && req.method === "GET") {
    const wt = findWorktreeForTicket(m[1], ctx.worktrees);
    if (!wt) return sendJson(res, 404, { error: "ticket not found" });
    const detail = getTicketDetail(wt, m[1]);
    if (!detail) return sendJson(res, 404, { error: "ticket not found" });
    return sendJson(res, 200, detail);
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

  m = path.match(/^\/api\/runs\/([^/]+)\/graph$/);
  if (m && req.method === "GET") {
    const wt = resolveRunWorktree(m[1]);
    if (!wt) return;
    const graph = getRunGraph(wt, m[1]);
    if (!graph) return sendJson(res, 404, { error: "run/flow not found" });
    return sendJson(res, 200, graph);
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
    (f) => f.endsWith(".md") && !f.endsWith("-note.md"),
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

  // Look up an active close run by scanning .pdh-flow/runs/<id>/snapshot.json
  // for ones whose flow=pdh-d AND ticket_id (snapshot stores epic-* synthetic
  // for epic runs) — simplest pass: just match runs where the snapshot
  // mentions this epic_id. For the first cut we leave this null and let the
  // user navigate via the runs list; the start-close response gives the
  // fresh runId.
  const activeCloseRunId: string | null = null;

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
  // first-cut UX simple — full requires PD-D-2 review_loop with real LLM).
  const body = await readBody(req);
  let parsed: { variant?: string } = {};
  try { parsed = JSON.parse(body); } catch {}
  const variant = parsed.variant === "full" ? "full" : "light";

  // Spawn detached. The engine logs to its own snapshot/transitions; the
  // UI follows via SSE. Stdio is /dev/null'd so the parent can fully
  // detach (server stays up; engine outlives this request).
  const node = process.execPath;
  const cliEntry = join(REPO_ROOT, "src", "cli", "index.ts");
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
  // top-level frontmatter fields the UI needs.
  const out: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const lm = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!lm) continue;
    const key = lm[1];
    const raw = lm[2].trim();
    if (raw === "" || raw.startsWith("-")) continue;
    out[key] = raw.replace(/^['"]|['"]$/g, "");
  }
  return out;
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
  const alreadyDecided = gateDecisions.some((g) => g.node_id === currentState);
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
    active_gate: isGate && !alreadyDecided ? currentState : null,
    active_turn: activeTurn,
    processing_answer: processingAnswer,
    judgements,
    gate_decisions: gateDecisions,
    closed,
  };
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
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    // parallel_group: XState value is `{ <group_id>: { region1: state1, ... } }`.
    // Collapse to "<group> (n active)" so the UI doesn't render a wall of JSON.
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const group = keys[0];
      const inner = (v as Record<string, unknown>)[group];
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

function readJudgements(worktreePath: string, runId: string): JudgementEntry[] {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "judgements");
  if (!existsSync(dir)) return [];
  const out: JudgementEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const findings = Array.isArray(obj.guardian_output?.blocking_findings)
        ? obj.guardian_output.blocking_findings.length
        : 0;
      out.push({
        node_id: obj.frozen_by_node_id ?? f.replace(/__round-.*$/, ""),
        round: obj.round ?? 1,
        decision: obj.guardian_output?.decision ?? "<unknown>",
        reasoning: typeof obj.guardian_output?.reasoning === "string"
          ? obj.guardian_output.reasoning
          : undefined,
        blocking_findings_count: findings,
      });
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) =>
    a.node_id === b.node_id ? a.round - b.round : a.node_id.localeCompare(b.node_id),
  );
}

interface GateDecisionEntry {
  node_id: string;
  decision: string;
  decided_at: string;
  comment?: string;
  via?: string;
  round?: number;
}

function readGateDecisions(worktreePath: string, runId: string): GateDecisionEntry[] {
  const dir = join(worktreePath, ".pdh-flow", "runs", runId, "gates");
  if (!existsSync(dir)) return [];
  const out: GateDecisionEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const obj = JSON.parse(readFileSync(join(dir, f), "utf8"));
      // `approver` is schema-required for audit but the web UI never has
      // a meaningful value (it always defaults to "web-ui" placeholder),
      // so we strip it from the API response to keep the timeline clean.
      out.push({
        node_id: obj.node_id ?? f.replace(/\.json$/, ""),
        decision: obj.decision ?? "<unknown>",
        decided_at: obj.decided_at ?? "",
        comment: typeof obj.comment === "string" ? obj.comment : undefined,
        via: typeof obj.via === "string" ? obj.via : undefined,
        round: typeof obj.round === "number" ? obj.round : undefined,
      });
    } catch {
      // skip malformed
    }
  }
  return out.sort((a, b) => a.decided_at.localeCompare(b.decided_at));
}

function readNote(worktreePath: string): string | null {
  const path = join(worktreePath, "current-note.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

interface EvidenceFile {
  filename: string;
  /** URL the frontend can fetch directly; resolves through this server. */
  url: string;
  /** Coarse classification driven by extension — image/pdf/text/other.
   *  The UI uses this to pick `<img>` vs link rendering. */
  kind: "image" | "pdf" | "text" | "other";
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
  if ([".txt", ".log", ".md", ".json"].includes(ext)) return "text";
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

// True when the note frontmatter shows the run reached a terminal close
// state. Source of truth is tickets/<id>-note.md frontmatter.status; falls
// back to current-note.md when the ticketId is unknown (legacy path).
function isTicketClosed(
  worktreePath: string,
  ticketId: string | null,
): boolean {
  const candidate = ticketId
    ? join(worktreePath, "tickets", `${ticketId}-note.md`)
    : join(worktreePath, "current-note.md");
  if (!existsSync(candidate)) return false;
  try {
    const text = readFileSync(candidate, "utf8");
    const m = text.match(/^---\s*[\s\S]*?status:\s*(\w+)/m);
    return m?.[1] === "completed";
  } catch {
    return false;
  }
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
  const r = v.validate(SCHEMA_IDS.gateOutput, obj);
  if (r.ok === false) {
    return sendJson(res, 400, {
      error: "draft_schema_violation",
      details: formatErrors(r.errors),
    });
  }
  // fs.renameSync is atomic on the same filesystem (runs/ lives
  // under the worktree). Imported as fsRenameSync at the top.
  fsRenameSync(draft, final);
  return sendJson(res, 200, { ok: true, written: final, decision: r.data });
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
