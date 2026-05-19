// `pdh-flow serve` — launch the Web UI HTTP server against a worktree.
//
// Reads engine state from `<worktree>/.pdh-flow/runs/` and serves both the
// JSON API and the static frontend (web/index.html etc.).
//
// Multi-worktree default: at startup we run `git worktree list --porcelain`
// from the bound worktree and aggregate all sibling worktrees too — so a
// PdM with `pdh-flow ticket new` worktrees in flight sees every ticket in
// one server instead of having to spin up one `serve` per checkout. Pass
// `--no-aggregate-worktrees` to revert to the single-worktree behaviour
// (e.g. when serving from a sandboxed clone where you don't want sibling
// branches surfaced).

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseSubcommandArgs } from "./index.ts";
import { startWebServer } from "../web/server.ts";

export async function cmdServe(argv: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(argv, {
    project: { type: "string" },
    "extra-worktree": { type: "string", multiple: true },
    "no-aggregate-worktrees": { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    "static-dir": { type: "string" },
  });

  // The primary project directory the serve is bound to — typically the
  // `main` checkout of the user's repo. `--worktree` was the historical
  // flag name but conflated with `git worktree`; the canonical form is
  // `--project` now. Sibling git-worktree discovery still uses
  // `--extra-worktree` (that flag name keeps the git terminology because
  // it really does mean "additional git worktrees").
  const worktreePath = (values.project as string | undefined)
    ? resolve(values.project as string)
    : process.cwd();

  const portRaw = values.port as string | undefined;
  const port = portRaw ? Number(portRaw) : 5170;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be a valid TCP port; got ${portRaw}`);
  }

  const host = values.host as string | undefined;

  // Build the extra-worktree list. Both sources are additive: `--extra-
  // worktree` lets the user pin worktrees that aren't visible from this
  // checkout's `git worktree list` (e.g. independent git repos under
  // /tmp/), and auto-discover surfaces any sibling git worktrees of the
  // primary. `--no-aggregate-worktrees` disables only the auto path.
  const explicitRaw = values["extra-worktree"] as string | string[] | undefined;
  const explicit = Array.isArray(explicitRaw)
    ? explicitRaw.map((p) => resolve(p))
    : explicitRaw
      ? [resolve(explicitRaw)]
      : [];
  const aggregate = !values["no-aggregate-worktrees"];
  const auto = aggregate ? discoverSiblingWorktrees(worktreePath) : [];
  const extraWorktrees = [...explicit, ...auto].filter((p) => resolve(p) !== resolve(worktreePath));

  startWebServer({
    worktreePath,
    extraWorktrees,
    port,
    ...(host ? { host } : {}),
    staticDir: values["static-dir"]
      ? resolve(values["static-dir"] as string)
      : undefined,
  });

  // Keep the process alive until the server is stopped.
  await new Promise<void>(() => {});
}

// Parse `git worktree list --porcelain` from the bound worktree's git
// view. Quietly returns [] when not in a git checkout — single-tenant
// behaviour is the safe fallback (the user just gets the worktree they
// passed via --worktree).
function discoverSiblingWorktrees(currentWorktreePath: string): string[] {
  let stdout: string;
  try {
    stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: currentWorktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const block of stdout.split(/\n\n+/)) {
    const m = block.match(/^worktree (.+)$/m);
    if (m) out.push(m[1].trim());
  }
  return out;
}
