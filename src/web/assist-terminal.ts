// Assist terminal manager (v2 port of v1's src/runtime/assist/terminal.ts).
//
// Spawns claude / codex as a PTY child process, streams I/O over a
// WebSocket so the user can chat interactively in a browser-embedded
// xterm. Sessions are keyed by `<runId>:<nodeId>` and resume the
// recorded provider session captured during the engine's prior run
// (sessions/<nodeId>.json from F-001/J3).
//
// Per-session state:
//   - PTY process (claude/codex with --resume / resume)
//   - rolling output buffer (300 KB cap, replayed on reconnect)
//   - clients set (multi-tab attach via the same sessionId broadcast)
//   - status (running / exited)
//
// Exited sessions are retained for RETAIN_EXITED_MS so a brief tab
// reload still sees the final output before the GC runs.

import { spawn as spawnPty } from "@lydell/node-pty";
import { spawnSync } from "node:child_process";
import type { IPty } from "@lydell/node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { renderPrompt } from "../engine/prompts/render.ts";

// Path to this file's directory; used to resolve the CLI entry point so
// the dropped wrapper scripts can re-invoke `pdh-flow turn-respond` /
// `pdh-flow gate-respond` against the same checkout.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_EXT = __filename.endsWith(".js") ? ".js" : ".ts";
const CLI_PATH = join(__dirname, "..", "cli", `index${CLI_EXT}`);
const NODE_PATH = process.execPath;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_BUFFER = 300_000;
const RETAIN_EXITED_MS = 30 * 60 * 1000;

interface AssistSession {
  id: string;
  key: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  pty: IPty;
  buffer: string;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  createdAt: number;
  updatedAt: number;
  clients: Set<WebSocket>;
  /** Cleanup hook for the submission watcher (turn answer / gate decision
   *  file mtime > baseline). Stopped on session exit / closeAll. */
  submissionWatcher?: () => void;
}

export interface OpenResult {
  sessionId: string;
  status: string;
  reused: boolean;
  title: string;
  command: string;
}

export interface AssistManager {
  /** Spawn (or reuse) an assist session for a recorded provider session. */
  openForNode(opts: {
    runId: string;
    nodeId: string;
    /** "resume" (default) requires sessions/<nodeId>.json; "fresh" spawns
     *  plain claude in the worktree (no resume), useful for gate cards
     *  where no provider session was captured. */
    mode?: "resume" | "fresh";
    force?: boolean;
  }): OpenResult | { error: string };
  /** Spawn a fresh claude session for working on this project's epics/tickets.
   *  The first user message is a self-contained brief (no skill dependency).
   *  Always force-fresh (each click opens a new session). */
  openCreationSession(opts: {
    kind: "epic" | "ticket" | "general";
    /** Optional: seed the prompt with an existing epic slug so the
     *  cut-ticket-from-epic-X path is preselected. */
    epicSlug?: string;
  }): OpenResult;
  /** Spawn a fresh claude session to triage uncommitted changes blocking a
   *  Start-engine attempt. The prompt feeds claude the current `git status`
   *  output and instructs it to help the user commit / stash / restore.
   *  Always force-fresh (each click opens a new session). */
  openCleanupSession(opts: {
    /** Ticket slug the user was trying to start. */
    slug: string;
  }): OpenResult;
  /** Spawn a plain bash terminal in the worktree for an idle run, with
   *  the `run-engine --run-id <existing>` resume command pre-printed in
   *  the banner so the user can copy/run it. Used by the IdleRecoveryCard
   *  on the run page. */
  openResumeSession(opts: {
    runId: string;
    ticketId: string;
    flowId: string;
    variant: string;
  }): OpenResult;
  /** Spawn a fresh claude session to cut a follow-up ticket from a
   *  `defer` triage entry. The post-close worktree is already on the
   *  parent ticket's base_branch (main / epics/<slug>) so the new ticket
   *  lands on the correct branch with no extra git plumbing. */
  openFollowUpSession(opts: {
    parentTicketId: string;
    parentEpicId: string | null;
    parentTicketPath: string;
    parentNotePath: string;
    suggestedSlug: string;
    deferredConcern: string;
    deferredRationale: string;
    sourceNode: string;
  }): OpenResult;
  /** WebSocket upgrade handler for /api/assist/ws?session=<id>. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Tear down all sessions on server shutdown. */
  closeAll(): void;
}

export function createAssistManager(opts: { worktreePath: string }): AssistManager {
  const sessions = new Map<string, AssistSession>();
  const activeByKey = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket: WebSocket, _req, session: AssistSession) => {
    attachSocket(socket, session);
  });

  function attachSocket(socket: WebSocket, session: AssistSession): void {
    session.clients.add(socket);
    send(socket, {
      type: "snapshot",
      sessionId: session.id,
      title: session.title,
      status: session.status,
      data: session.buffer,
    });
    socket.on("message", (message) => {
      let payload: { type?: string; data?: string; cols?: number; rows?: number } | null = null;
      try {
        payload = JSON.parse(String(message));
      } catch {
        return;
      }
      if (!payload) return;
      if (payload.type === "input" && session.status === "running" && typeof payload.data === "string" && payload.data.length > 0) {
        try { session.pty.write(payload.data); } catch { /* pty may have exited */ }
      } else if (payload.type === "resize") {
        const cols = Number(payload.cols) || DEFAULT_COLS;
        const rows = Number(payload.rows) || DEFAULT_ROWS;
        if (session.status === "running") {
          try { session.pty.resize(Math.max(20, cols), Math.max(8, rows)); } catch {}
        }
      } else if (payload.type === "ping") {
        send(socket, { type: "pong" });
      }
    });
    socket.on("close", () => {
      session.clients.delete(socket);
    });
  }

  function send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(payload)); } catch { /* dead socket */ }
  }

  function broadcast(session: AssistSession, payload: unknown): void {
    for (const sock of session.clients) send(sock, payload);
  }

  function trimBuffer(text: string): string {
    return text.length <= MAX_BUFFER ? text : text.slice(text.length - MAX_BUFFER);
  }

  function pruneSessions(): void {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.status === "running") continue;
      if (now - s.updatedAt > RETAIN_EXITED_MS) {
        for (const sock of s.clients) sock.close(1001, "session_expired");
        sessions.delete(id);
      }
    }
  }

  function openForNode(p: {
    runId: string;
    nodeId: string;
    mode?: "resume" | "fresh";
    force?: boolean;
  }): OpenResult | { error: string } {
    if (p.mode === "fresh") {
      // Plain claude in the worktree, no --resume. For gate cards
      // (no provider session captured) or general worktree exploration.
      // Drop the gate-respond wrapper so claude can submit a decision
      // (approve/reject/cancel) by exec'ing a worktree-scoped script.
      ensureWrapperScript({
        worktreePath: opts.worktreePath,
        name: "gate-respond",
        runId: p.runId,
        nodeId: p.nodeId,
      });
      const hint = buildWrapperHint("gate", p.nodeId);
      // v1-style: inject the prompt via claude's args (--append-system-prompt
      // for the behaviour rules + the review task as the positional initial
      // message), not by auto-typing into the PTY. --setting-sources user so
      // the repo's CLAUDE.md/settings aren't auto-applied as instructions;
      // bypassPermissions so it can run git diff / read files / the wrapper
      // without prompting.
      const gateSystemPrompt = renderPrompt("gate-terminal-system", {
        nodeId: p.nodeId,
        runId: p.runId,
      });
      const gateBody = renderPrompt("gate-terminal-body", {
        nodeId: p.nodeId,
        runId: p.runId,
      });
      const result = openManagedSession({
        key: `${p.runId}:${p.nodeId}:fresh`,
        title: `claude (gate review) — ${p.nodeId}`,
        command: "claude",
        args: [
          "--append-system-prompt", gateSystemPrompt,
          "--setting-sources", "user",
          "--permission-mode", "bypassPermissions",
          gateBody,
        ],
        cwd: opts.worktreePath,
        force: p.force,
        initialHint: hint,
      });
      const session = sessions.get(result.sessionId);
      if (session && !session.submissionWatcher) {
        session.submissionWatcher = startSubmissionWatcher(
          session,
          opts.worktreePath,
          p.runId,
          p.nodeId,
          "gate",
          broadcast,
        );
      }
      return result;
    }
    const sessionPath = join(
      opts.worktreePath,
      ".pdh-flow",
      "runs",
      p.runId,
      "sessions",
      `${p.nodeId}.json`,
    );
    if (!existsSync(sessionPath)) {
      return { error: `no session record at ${sessionPath} — has the engine run this node yet?` };
    }
    let rec: { provider?: string; sessionId?: string } = {};
    try {
      rec = JSON.parse(readFileSync(sessionPath, "utf8"));
    } catch (e) {
      return { error: `could not parse session record: ${(e as Error).message}` };
    }
    if (!rec || typeof rec.sessionId !== "string" || (rec.provider !== "claude" && rec.provider !== "codex")) {
      return { error: "session record malformed (missing provider/sessionId)" };
    }
    const command = rec.provider;
    const args = rec.provider === "claude"
      ? ["--resume", rec.sessionId]
      : ["resume", rec.sessionId];
    const title = `${command} — ${p.nodeId}`;
    // Drop the turn-respond wrapper so the resumed provider can submit
    // an answer back to the engine via a worktree-scoped script.
    ensureWrapperScript({
      worktreePath: opts.worktreePath,
      name: "turn-respond",
      runId: p.runId,
      nodeId: p.nodeId,
    });
    const hint = buildWrapperHint("turn", p.nodeId);
    const result = openManagedSession({
      key: `${p.runId}:${p.nodeId}`,
      title,
      command,
      args,
      cwd: opts.worktreePath,
      force: p.force,
      initialHint: hint,
    });
    const session = sessions.get(result.sessionId);
    if (session && !session.submissionWatcher) {
      session.submissionWatcher = startSubmissionWatcher(
        session,
        opts.worktreePath,
        p.runId,
        p.nodeId,
        "turn",
        broadcast,
      );
    }
    return result;
  }

  function openManagedSession(p: {
    key: string;
    title: string;
    command: string;
    args: string[];
    cwd: string;
    force?: boolean;
    /** Optional ANSI-formatted hint to seed the rolling buffer + broadcast
     *  before any PTY output arrives. Used to surface the wrapper-script
     *  command to the human user. */
    initialHint?: string;
  }): OpenResult {
    pruneSessions();
    const existingId = activeByKey.get(p.key);
    if (existingId && p.force) {
      const existing = sessions.get(existingId);
      if (existing) {
        try { existing.pty.kill(); } catch {}
        for (const sock of existing.clients) {
          try { sock.close(1000, "force_reprompt"); } catch {}
        }
        existing.status = "exited";
        sessions.delete(existingId);
      }
      activeByKey.delete(p.key);
    } else if (existingId) {
      const existing = sessions.get(existingId);
      if (existing && existing.status === "running") {
        return {
          sessionId: existing.id,
          status: existing.status,
          reused: true,
          title: existing.title,
          command: existing.command,
        };
      }
      activeByKey.delete(p.key);
    }

    const id = `assist-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const pty = spawnPty(p.command, p.args, {
      name: "xterm-color",
      cwd: p.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
    });
    const session: AssistSession = {
      id,
      key: p.key,
      title: p.title,
      command: p.command,
      args: p.args,
      cwd: p.cwd,
      pty,
      buffer: "",
      status: "running",
      exitCode: null,
      signal: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clients: new Set(),
    };
    sessions.set(id, session);
    activeByKey.set(p.key, id);

    if (p.initialHint) {
      session.buffer = p.initialHint;
      // No clients yet at this point; the first WS attach will replay
      // the buffer via the snapshot message.
    }

    pty.onData((data) => {
      session.buffer = trimBuffer(session.buffer + data);
      session.updatedAt = Date.now();
      broadcast(session, { type: "output", data });
    });
    pty.onExit((event) => {
      session.status = "exited";
      session.exitCode = event.exitCode ?? 0;
      session.signal = event.signal ?? null;
      session.updatedAt = Date.now();
      if (activeByKey.get(p.key) === id) activeByKey.delete(p.key);
      try { session.submissionWatcher?.(); } catch {}
      session.submissionWatcher = undefined;
      broadcast(session, {
        type: "exit",
        exitCode: session.exitCode,
        signal: session.signal,
      });
    });

    return {
      sessionId: id,
      status: "running",
      reused: false,
      title: p.title,
      command: p.command,
    };
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/assist/ws") return false;
    const sessionId = url.searchParams.get("session");
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, session);
    });
    return true;
  }

  function closeAll(): void {
    for (const s of sessions.values()) {
      if (s.status === "running") {
        try { s.pty.kill(); } catch {}
      }
      try { s.submissionWatcher?.(); } catch {}
      s.submissionWatcher = undefined;
      for (const sock of s.clients) {
        try { sock.close(1001, "server_shutdown"); } catch {}
      }
    }
    sessions.clear();
    activeByKey.clear();
    try { wss.close(); } catch {}
  }

  // Open a fresh claude session whose first user message is a self-contained
  // brief for working on this project's delivery hierarchy (epics / tickets).
  // The prompt is handed to claude as a positional argument (NOT auto-typed
  // into the PTY — keystroke injection is racy and we don't do it anywhere);
  // --setting-sources user so the worktree's own CLAUDE.md isn't auto-applied,
  // --permission-mode bypassPermissions so claude can run `./ticket.sh ...` and
  // write the ticket/epic files without prompting. No skill dependency — the
  // instructions are inline. `kind`:
  //   "general" — top-page "Open terminal": claude can cut a ticket OR an epic,
  //               the human picks in the chat. (Bootstrap of ticket.sh /
  //               product-delivery-hierarchy.md is handled out-of-band by the
  //               ticket-list page, not here — assume they're present.)
  //   "ticket"  — cut one ticket (optionally under `epicSlug`).
  //   "epic"    — cut one epic.
  function openCreationSession(p: {
    kind: "epic" | "ticket" | "general";
    epicSlug?: string;
  }): OpenResult {
    const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
    const key = `create:${p.kind}:${p.epicSlug ?? ""}:${stamp}`;
    const title =
      p.kind === "general"
        ? "claude (epic / ticket)"
        : p.kind === "epic"
          ? "claude (new epic)"
          : p.epicSlug
            ? `claude (new ticket → ${p.epicSlug})`
            : "claude (new ticket)";

    const acBlock =
      "生成された `tickets/<slug>.md` に: 概要と、**Acceptance Criteria** を *観測可能な振る舞い* として書く — 実行コマンド / 期待 stdout / exit code / stderr が空であること。各 AC に検証手段を 1 つタグ付け: 自動テスト / mock だけで証明できるもの (`unit-test-sufficient`)、実プロセスや内部 DB を起動する必要があるもの (`integration-required`)、実 API や外部サービス・実機が要るもの (`real-env-required`)。実装はまだしない。ticket ファイルを作って整えたら止まって私を待って。";

    const initialPrompt =
      p.kind === "general"
        ? [
            "この worktree のプロダクト階層（Product Brief → Epic → Ticket）の作業を手伝って。まず最初に **必ず** `docs/product-delivery-hierarchy.md` を読んで階層の考え方を把握し、`product-brief.md`（あれば）にも目を通して。`./ticket.sh` がこのリポにある前提（無ければ「セットアップが要る」と私に言って、勝手に作業を進めない）。",
            "そのうえで、私が「ticket 切って」と言ったら: 何を作るか確認（指定が無ければ product-brief の Scope の「まだ無い次の項目」を提案）→ 短い kebab-case slug → `./ticket.sh new <slug>`（epic 配下なら `./ticket.sh new <slug> --epic <epic-slug>`、既存 epic は `./ticket.sh epic list` で確認）→ " + acBlock,
            "私が「epic 切って」と言ったら: `product-brief.md` と `docs/product-delivery-hierarchy.md` を踏まえて epic の Outcome / Scope（含める ticket の見取り図）/ Exit Criteria を確認 → `./ticket.sh epic new <slug>` → `epics/<slug>.md` の中身を整える。個別 ticket はまだ作らない。",
            "まず上の2つのドキュメントを読んでから、「ticket と epic どちらを作りますか / それとも別の作業？」と私に聞いて。",
          ].join("\n\n")
        : p.kind === "epic"
          ? [
              "新しい **epic** を作りたい。まず `docs/product-delivery-hierarchy.md` と `product-brief.md`（あれば）を読んで、この epic が何を達成するか・どの ticket 群を含むか・完了条件を把握して。",
              "それから `./ticket.sh epic new <kebab-case-slug>` を実行して `epics/<slug>.md` を作り、その中身（Outcome / Scope = 含める ticket の見取り図 / Exit Criteria）を整えて。",
              "個別 ticket はまだ作らない（私が「次のチケット切って」と言ったら作る）。epic ファイルが出来たら要点を報告して止まって。",
            ].join("\n\n")
          : p.epicSlug
            ? [
                `新しい **ticket** を、既存の epic \`${p.epicSlug}\` の配下に切りたい。まず \`docs/product-delivery-hierarchy.md\`・\`product-brief.md\`・epic ファイル（\`./ticket.sh epic show ${p.epicSlug}\`）を読んで文脈を掴んで。`,
                `次に何を作るかは私が指示する（無ければ product-brief の Scope の「まだ無い次の項目」を選んで）。短い kebab-case slug を決めて \`./ticket.sh new <slug> --epic ${p.epicSlug}\` を実行。`,
                acBlock,
              ].join("\n\n")
            : [
                "新しい **ticket** を切りたい。まず `docs/product-delivery-hierarchy.md` と `product-brief.md`（あれば）を読んで何を作るプロジェクトか把握して。既存の epic があれば `./ticket.sh epic list` で確認し、この ticket がどれかの配下に入るべきなら後で `--epic` を付ける。",
                "何を作るかは私が指示する（無ければ product-brief の Scope の「まだ無い次の項目」を選んで）。短い kebab-case slug を決めて `./ticket.sh new <slug>`（epic 配下なら `./ticket.sh new <slug> --epic <epic-slug>`）を実行。",
                acBlock,
              ].join("\n\n");
    const hint = banner([
      `kind=${p.kind}${p.epicSlug ? `  epic=${p.epicSlug}` : ""}`,
      `worktree=${opts.worktreePath}`,
      p.kind === "general"
        ? "claude が docs/product-delivery-hierarchy.md と product-brief を読んでから、ticket / epic どちらを作るか聞いてきます。"
        : p.kind === "epic"
          ? "claude が product-brief を読んで `./ticket.sh epic new <slug>` で epic を作ります。"
          : "claude が product-brief を読んで `./ticket.sh new <slug>` で ticket を作ります。",
      "切れた場合はこの terminal を Restart するか、自分で claude に同じ指示を出してください。",
    ]);
    return openManagedSession({
      key,
      title,
      command: "claude",
      args: [
        "--setting-sources", "user",
        "--permission-mode", "bypassPermissions",
        initialPrompt,
      ],
      cwd: opts.worktreePath,
      force: true,
      initialHint: hint,
    });
  }

  // Cleanup session: opened when Start-engine refuses because the
  // worktree has uncommitted changes. The session is a fresh claude
  // PTY in the worktree with a focused triage prompt — claude sees the
  // dirty file list up-front and helps the user pick commit vs stash
  // vs restore. When the user is satisfied, they close the terminal
  // modal and click Start engine again on the ticket page.
  function openCleanupSession(p: { slug: string }): OpenResult {
    const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
    const key = `cleanup:${p.slug}:${stamp}`;
    const title = `claude (cleanup) — ${p.slug}`;

    // Probe `git status` once here so the prompt can include a fresh
    // snapshot. Claude will also be able to re-run `git status` inside
    // the session as the user makes changes.
    const statusResult = spawnSync(
      "git",
      ["status", "--porcelain=v1"],
      {
        cwd: opts.worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const porcelain = (statusResult.stdout ?? "").trim() || "(empty — already clean)";

    const initialPrompt = [
      `この worktree (\`${opts.worktreePath}\`) には未コミットの変更が残っているため、ticket \`${p.slug}\` の engine を起動できません。engine は各ノード完了時に \`git add -A && git commit\` するので、ユーザの未コミット作業まで「engine の commit」として混入してしまう。先に手動で整理する必要がある。`,
      `現在の \`git status --porcelain\`:\n\n\`\`\`\n${porcelain}\n\`\`\``,
      [
        "あなたの役目: ユーザと対話しながら以下を整える。",
        "- 各変更を読んで、**意味のあるまとまり** で commit するか、**捨てる** (stash / restore) かを提案する。判断はユーザに確認する。",
        "- commit メッセージは候補を出すがユーザの了承を得てから実行する。",
        "- 完全に \"clean\" (`git status --porcelain` が空) になるまで進める。",
        "- engine の commit と被らないように、ここでの commit メッセージは `[<scope>] <summary>` 形式（pdh-flow の engine commit の `[<node>/round-N] ...` とは区別できる形）にする。",
      ].join("\n"),
      "実行は ./ticket.sh / git / Edit / Read 等の通常ツールで OK。完了したら `git status` を最後にもう一度走らせて clean なことを確認し、要点を一行で報告して止まって。私が ticket ページに戻って Start engine を再度押す。",
    ].join("\n\n");

    const hint = banner([
      `cleanup for ticket=${p.slug}`,
      `worktree=${opts.worktreePath}`,
      "claude が `git status` の各エントリについて commit / stash / restore を提案します。",
      "整え終わったらこの terminal を閉じて、ticket ページで Start engine を再度押してください。",
    ]);

    return openManagedSession({
      key,
      title,
      command: "claude",
      args: [
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
        initialPrompt,
      ],
      cwd: opts.worktreePath,
      force: true,
      initialHint: hint,
    });
  }

  function openResumeSession(p: {
    runId: string;
    ticketId: string;
    flowId: string;
    variant: string;
  }): OpenResult {
    const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
    const key = `resume:${p.runId}:${stamp}`;
    const title = `bash (resume) — ${p.runId}`;

    // Build the resume command the user can copy or just hit Enter on
    // after editing. Use the pdh-flow CLI installed in PATH; fall back
    // to running the source entry directly if the user prefers (we
    // print both forms).
    const cmd = [
      "pdh-flow",
      "run-engine",
      "--ticket",
      shellQuote(p.ticketId),
      "--flow",
      shellQuote(p.flowId),
      "--variant",
      shellQuote(p.variant),
      "--project",
      shellQuote(opts.worktreePath),
      "--run-id",
      shellQuote(p.runId),
    ].join(" ");

    const hint = banner([
      `resume run=${p.runId}`,
      `worktree=${opts.worktreePath}`,
      "Engine is idle. To re-spawn the engine on this run, run:",
      "",
      `  ${cmd}`,
      "",
      "Or inspect snapshot/transitions/judgements under `.pdh-flow/runs/`.",
    ]);

    const shell =
      typeof process.env.SHELL === "string" && process.env.SHELL.length > 0
        ? process.env.SHELL
        : "bash";
    return openManagedSession({
      key,
      title,
      command: shell,
      args: ["-l"],
      cwd: opts.worktreePath,
      force: true,
      initialHint: hint,
    });
  }

  /** Spawn a fresh claude session pre-loaded with the context for cutting
   *  a follow-up ticket from a deferred concern at close time. The
   *  worktree is already on the parent ticket's base_branch (main or
   *  epics/<slug>) because ticket.sh close checked it out as part of the
   *  squash-merge, so `./ticket.sh new <slug>` lands on the correct
   *  branch with no extra branch handling. Epic propagation is handled
   *  via the parent ticket's `epic_id` frontmatter, which we inline into
   *  the prompt for claude to pass as `--epic <epic_id>`. */
  function openFollowUpSession(p: {
    parentTicketId: string;
    parentEpicId: string | null;
    parentTicketPath: string;
    parentNotePath: string;
    suggestedSlug: string;
    deferredConcern: string;
    deferredRationale: string;
    sourceNode: string;
  }): OpenResult {
    const stamp = `${Date.now()}-${randomBytes(2).toString("hex")}`;
    const key = `followup:${p.suggestedSlug}:${stamp}`;
    const title = `claude (follow-up → ${p.suggestedSlug})`;

    const newCmd = p.parentEpicId
      ? `./ticket.sh new ${p.suggestedSlug} --epic ${p.parentEpicId}`
      : `./ticket.sh new ${p.suggestedSlug}`;

    const acBlock =
      "生成された `tickets/<slug>.md` の Acceptance Criteria は *観測可能な振る舞い* として書く — 実行コマンド / 期待 stdout / exit code / stderr が空であること。各 AC に検証手段タグ (`unit-test-sufficient` / `integration-required` / `real-env-required`) を 1 つ付ける。実装はまだしない。ticket ファイルを編集して整えたら止まって私を待って。";

    const initialPrompt = [
      `親 ticket \`${p.parentTicketId}\` の close 時に "defer" 判定された懸念を、新しい follow-up ticket として 1 件切る。`,
      `元 concern (元 ${p.sourceNode} の triage 抜粋):\n> ${p.deferredConcern}`,
      `元 rationale (なぜ別 ticket にしたか):\n> ${p.deferredRationale}`,
      `推奨 slug: \`${p.suggestedSlug}\`${p.parentEpicId ? ` / epic 引き継ぎ: \`${p.parentEpicId}\`` : ""}`,
      `参考にすべき文脈 (この順で読む):\n  1. 親 ticket: \`${p.parentTicketPath}\`\n  2. 親 note: \`${p.parentNotePath}\` (議論と決着が全部ここに)\n  3. 親 ticket の merge 結果: \`git log --oneline -5\` と \`git diff --stat HEAD~1\`、必要なら \`git show HEAD\` で全差分。これが新 ticket の Why / What の根拠になる。`,
      `手順:`,
      `  1. 上の context を読んでから \`${newCmd}\` を実行 (現在の branch は親と同じ base_branch なので、追加の branch 操作は不要)。`,
      `  2. 生成された \`tickets/${p.suggestedSlug}.md\` を編集:`,
      `     - Why に「元 ticket ${p.parentTicketId} の deferred 項目。元 concern: …」と書き、親 ticket / 親 note への参照を載せる`,
      `     - What に具体的な変更対象 (file / api / UI) の見積もり`,
      `     - Acceptance Criteria を観測可能な振る舞いで列挙`,
      `  3. ${acBlock}`,
      `  4. 編集が済んだら 1 行で要点を報告して止まる (commit / push はまだしない。次に \`./ticket.sh start <slug>\` する時に branch が切られる)。`,
    ].join("\n\n");

    const hint = banner([
      `parent=${p.parentTicketId}${p.parentEpicId ? `  epic=${p.parentEpicId}` : ""}`,
      `slug=${p.suggestedSlug}`,
      `worktree=${opts.worktreePath}`,
      `claude が親 ticket / note / git diff を読んでから \`${newCmd}\` で follow-up を作ります。`,
      "切れた場合はこの terminal を Restart するか、自分で claude に同じ指示を出してください。",
    ]);
    return openManagedSession({
      key,
      title,
      command: "claude",
      args: [
        "--setting-sources", "user",
        "--permission-mode", "bypassPermissions",
        initialPrompt,
      ],
      cwd: opts.worktreePath,
      force: true,
      initialHint: hint,
    });
  }

  return {
    openForNode,
    openCreationSession,
    openCleanupSession,
    openResumeSession,
    openFollowUpSession,
    handleUpgrade,
    closeAll,
  };
}

function banner(lines: string[]): string {
  // Plain-text banner, written to the rolling buffer so the user sees it
  // before claude prints anything. Avoids ANSI codes so xterm renders it
  // even with no theme processing.
  const out: string[] = [
    "─── pdh-flow create session ───────────────────────────────────────────",
  ];
  for (const l of lines) out.push(`  ${l}`);
  out.push("───────────────────────────────────────────────────────────────────────\n");
  return out.join("\n") + "\n";
}

// ─── Wrapper script helpers ──────────────────────────────────────────────
//
// On every assist-terminal session open, drop a worktree-scoped shell
// wrapper that exec's `pdh-flow turn-respond` (resume mode) or
// `pdh-flow gate-respond` (fresh mode). Run id / node id / worktree are
// pre-filled so the provider running inside the assist session can call
// it like:
//
//   ./.pdh-flow/bin/turn-respond --text "fedora"
//   ./.pdh-flow/bin/turn-respond --option 2
//   ./.pdh-flow/bin/gate-respond --decision approved
//   ./.pdh-flow/bin/gate-respond --decision rejected --comment "..."
//
// The script lives in `.pdh-flow/bin/` (gitignored). Multiple concurrent
// runs against the same worktree would race on this file — but the
// single-machine / single-ticket-at-a-time assumption (D-010, CLAUDE.md)
// makes that a non-issue in practice.

function ensureWrapperScript(p: {
  worktreePath: string;
  name: "turn-respond" | "gate-respond";
  runId: string;
  nodeId: string;
}): string {
  const binDir = join(p.worktreePath, ".pdh-flow", "bin");
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, p.name);
  const stripFlag = CLI_EXT === ".ts" ? " --experimental-strip-types" : "";
  // --draft makes the wrapper write a *.draft.json file that the
  // engine ignores. The human user must press "Yes, close" on the
  // assist modal banner (which calls /api/.../confirm) to promote
  // it to the final filename the engine reads. Lets claude
  // submit-and-revise from inside the chat without committing the
  // engine to the first draft.
  const body =
    `#!/usr/bin/env bash\n` +
    `set -euo pipefail\n` +
    `# Auto-generated by pdh-flow assist-terminal at session open.\n` +
    `# Pre-fills --run-id / --node-id / --project / --via assist /\n` +
    `# --draft for ${p.name}; pass the remaining args (e.g.\n` +
    `# --text "..." or --decision approved).\n` +
    `exec ${shellQuote(NODE_PATH)}${stripFlag} ${shellQuote(CLI_PATH)} ${p.name} \\\n` +
    `  --run-id ${shellQuote(p.runId)} \\\n` +
    `  --node-id ${shellQuote(p.nodeId)} \\\n` +
    `  --project ${shellQuote(p.worktreePath)} \\\n` +
    `  --via assist \\\n` +
    `  --draft \\\n` +
    `  "$@"\n`;
  writeFileSync(scriptPath, body);
  try { chmodSync(scriptPath, 0o755); } catch {}
  return scriptPath;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── Submission watcher ──────────────────────────────────────────────────
//
// Watches the worktree filesystem for the answer / gate decision file
// that the wrapper script writes on success. PTY-based detection
// (scanning the assistant's output for a sentinel) is unreliable —
// claude collapses long Bash tool output into "+N lines" placeholders
// in the rendered chat, so the sentinel may never reach the WS stream.
//
// File appearance is the canonical signal of "command execution
// succeeded", regardless of how it's surfaced in the chat UI.

import { readdirSync, statSync } from "node:fs";

function startSubmissionWatcher(
  session: AssistSession,
  worktreePath: string,
  runId: string,
  nodeId: string,
  kind: "turn" | "gate",
  broadcastFn: (s: AssistSession, payload: unknown) => void,
): () => void {
  const intervalMs = 500;
  // Track mtime, not just file existence: the user may dismiss the
  // first banner ("No, stay") and then ask claude to revise via the
  // wrapper. The second exec rewrites the same file (turn-NNN-answer
  // for the active turn, or the single gate file). We need to fire
  // again on every new write.
  let baselineMtime = Date.now();
  const turnsDir = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "turns",
    nodeId,
  );
  const gatePath = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "gates",
    `${nodeId}.json`,
  );

  // Watch the *.draft.json sibling files (not the final ones) — the
  // engine reads the final, but human-confirmation is gated by the
  // wrapper's draft write. baseline = latest pre-existing draft mtime,
  // so we only fire on writes that happen after this session opens.
  const draftPathFor = (turn: number) =>
    join(
      turnsDir,
      `turn-${String(turn).padStart(3, "0")}-answer.draft.json`,
    );
  const gateDraftPath = join(
    worktreePath,
    ".pdh-flow",
    "runs",
    runId,
    "gates",
    `${nodeId}.draft.json`,
  );
  if (kind === "turn") {
    try {
      for (const f of readdirSync(turnsDir)) {
        if (!/^turn-\d{3}-answer\.draft\.json$/.test(f)) continue;
        const t = statSync(join(turnsDir, f)).mtimeMs;
        if (t > baselineMtime) baselineMtime = t;
      }
    } catch { /* dir may not exist yet */ }
  } else {
    try {
      const t = statSync(gateDraftPath).mtimeMs;
      if (t > baselineMtime) baselineMtime = t;
    } catch { /* draft doesn't exist yet */ }
  }
  void gatePath;        // retained for future "watch final too" use
  void draftPathFor;    // (unused — directory scan handles all turns)

  const tick = (): void => {
    if (kind === "turn") {
      let latestMtime = 0;
      let latestFile: string | null = null;
      let latestTurn: number | null = null;
      try {
        for (const f of readdirSync(turnsDir)) {
          const m = f.match(/^turn-(\d{3})-answer\.draft\.json$/);
          if (!m) continue;
          const t = statSync(join(turnsDir, f)).mtimeMs;
          if (t > latestMtime) {
            latestMtime = t;
            latestFile = f;
            latestTurn = parseInt(m[1], 10);
          }
        }
      } catch { /* ignore */ }
      if (latestMtime > baselineMtime + 1) {
        baselineMtime = latestMtime;
        broadcastFn(session, {
          type: "submitted",
          kind: "turn",
          filename: latestFile,
          turn: latestTurn,
        });
      }
    } else {
      let mt = 0;
      try { mt = statSync(gateDraftPath).mtimeMs; } catch { /* missing */ }
      if (mt > baselineMtime + 1) {
        baselineMtime = mt;
        broadcastFn(session, { type: "submitted", kind: "gate" });
      }
    }
  };

  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

function buildWrapperHint(kind: "turn" | "gate", nodeId: string): string {
  const cyan = "\x1b[36m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  if (kind === "turn") {
    return (
      `${cyan}[pdh-flow] in-step turn at ${nodeId}: ` +
      `submit your answer back to the engine with one of:${reset}\r\n` +
      `${dim}  ./.pdh-flow/bin/turn-respond --text "<your answer>"${reset}\r\n` +
      `${dim}  ./.pdh-flow/bin/turn-respond --option <0-based-index>${reset}\r\n` +
      `\r\n`
    );
  }
  return (
    `${cyan}[pdh-flow] gate at ${nodeId}: ` +
    `record your decision back to the engine with:${reset}\r\n` +
    `${dim}  ./.pdh-flow/bin/gate-respond --decision approved${reset}\r\n` +
    `${dim}  ./.pdh-flow/bin/gate-respond --decision rejected --comment "<reason>"${reset}\r\n` +
    `${dim}  ./.pdh-flow/bin/gate-respond --decision cancelled${reset}\r\n` +
    `\r\n`
  );
}
