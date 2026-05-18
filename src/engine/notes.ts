// Routing of a node's LLM/system output into current-note.md sections.
//
// Two modes (configured via the yaml `note_target` field on the node):
//
//   - `replace`: the node owns one or more `## <header>` sections in the
//     note. Each fresh run replaces the body of those sections (so PD-C-N
//     sections always show the latest round, not an append log). When
//     multiple sections are owned, the LLM is expected to emit each
//     `## <header>` block in its raw output; the helper extracts the body
//     per header and writes into the corresponding spot in the note.
//
//   - `archive`: the node's output is audit-only. Appended under a
//     top-level `## audit log` heading as a sub-section
//     `### <node_id> (round N)`. Used for reviewer members / repair /
//     qa whose round-by-round trail matters for forensics but would
//     otherwise crowd the readable PD-C dashboard sections.
//
// Falls back to plain-append (`## <node_id> (round N)\n<body>`) when no
// note_target is configured — preserves the original behaviour for nodes
// the flow author hasn't migrated yet.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface NoteTargetReplace {
  mode: "replace";
  /** Header texts (without the leading `## `) this node owns. */
  sections: string[];
}
export interface NoteTargetArchive {
  mode: "archive";
}
export type NoteTarget = NoteTargetReplace | NoteTargetArchive;

const ARCHIVE_HEADER = "audit log";

/** Top-level entry: write a node's output to current-note.md per its
 *  configured target. When `target` is null/undefined, falls back to the
 *  legacy append-as-`## <nodeId> (round N)` behaviour so partially-
 *  migrated flows still work. */
export function writeNoteOutput(p: {
  notePath: string;
  nodeId: string;
  round: number;
  body: string;
  target: NoteTarget | null | undefined;
}): void {
  if (!p.target) {
    appendFileSync(p.notePath, legacySection(p.nodeId, p.round, p.body));
    return;
  }
  if (p.target.mode === "archive") {
    appendArchive(p.notePath, p.nodeId, p.round, p.body);
    return;
  }
  // replace mode
  applyReplaceTarget(p.notePath, p.nodeId, p.round, p.body, p.target.sections);
}

function legacySection(nodeId: string, round: number, body: string): string {
  return `## ${nodeId} (round ${round})\n\n${body.trimEnd()}\n\n`;
}

function applyReplaceTarget(
  notePath: string,
  nodeId: string,
  round: number,
  body: string,
  sections: string[],
): void {
  ensureNoteFile(notePath);
  const blocks = parseLlmSections(body);
  if (sections.length === 1) {
    // Single-section case: if the LLM emitted one matching block, use
    // it; otherwise treat the entire body as the section's content
    // (the LLM may have just emitted the body without the header).
    const target = sections[0];
    const fromBlock = blocks.get(target);
    const newBody = fromBlock ?? body.trim();
    replaceSection(notePath, target, newBody);
    return;
  }
  // Multi-section case: every header must come from a matched LLM block;
  // missing blocks land a sentinel so future runs are obvious.
  for (const header of sections) {
    const matched = blocks.get(header);
    const newBody =
      matched ?? `_(node ${nodeId} round ${round} produced no \`## ${header}\` block)_`;
    replaceSection(notePath, header, newBody);
  }
}

/** Find every `^## <header>` in raw LLM output and return a map
 *  `header → body` (body = lines up to the next `## ` or EOF, trimmed).
 *  Headers inside fenced code blocks are NOT captured — we walk the
 *  text line by line, tracking fence state. */
export function parseLlmSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceChar = "";
  let curHeader: string | null = null;
  let buf: string[] = [];
  const commit = () => {
    if (curHeader !== null) {
      out.set(curHeader, buf.join("\n").trim());
    }
    curHeader = null;
    buf = [];
  };
  for (const line of lines) {
    // Track fenced code blocks so we don't capture `## ` lines inside them.
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar && fence[1].length >= 3) {
        inFence = false;
      }
    }
    if (!inFence) {
      const hm = line.match(/^##\s+(.+?)\s*$/);
      if (hm) {
        commit();
        curHeader = hm[1].trim();
        continue;
      }
    }
    if (curHeader !== null) buf.push(line);
  }
  commit();
  return out;
}

/** Replace the body of the FIRST `^## <header>` block found in the note.
 *  When the header doesn't yet exist, append a fresh section at the end.
 *  Header matching is exact (after trim). */
export function replaceSection(
  notePath: string,
  header: string,
  newBody: string,
): void {
  ensureNoteFile(notePath);
  const text = readFileSync(notePath, "utf8");
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match `## <header>` on its own line, lazily capture body up to the
  // next `## ` at line-start or EOF.
  const re = new RegExp(`^(##\\s+${escaped}\\s*\\r?\\n)([\\s\\S]*?)(?=^##\\s|\\Z)`, "m");
  const trimmedBody = newBody.trimEnd();
  if (re.test(text)) {
    const replaced = text.replace(re, (_full, head) => {
      return `${head}\n${trimmedBody}\n\n`;
    });
    writeFileSync(notePath, replaced);
    return;
  }
  // No existing section — append at end.
  const sep = text.endsWith("\n") ? "" : "\n";
  writeFileSync(notePath, `${text}${sep}\n## ${header}\n\n${trimmedBody}\n`);
}

/** Append a node's output to the `## audit log` section as a
 *  `### <nodeId> (round N)` sub-section. Creates the audit-log section
 *  the first time it's needed. */
export function appendArchive(
  notePath: string,
  nodeId: string,
  round: number,
  body: string,
): void {
  ensureNoteFile(notePath);
  const sub = `### ${nodeId} (round ${round})\n\n${body.trimEnd()}\n`;
  const text = readFileSync(notePath, "utf8");
  const archiveRe = new RegExp(`^##\\s+${ARCHIVE_HEADER}\\s*\\r?\\n`, "mi");
  if (archiveRe.test(text)) {
    appendFileSync(notePath, `\n${sub}\n`);
    return;
  }
  // First time — create the section at the end.
  const sep = text.endsWith("\n") ? "" : "\n";
  writeFileSync(notePath, `${text}${sep}\n## ${ARCHIVE_HEADER}\n\n${sub}\n`);
}

function ensureNoteFile(notePath: string): void {
  if (!existsSync(notePath)) {
    writeFileSync(notePath, "");
  }
}
