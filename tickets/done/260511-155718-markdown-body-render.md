---
priority: 2
base_branch: default
description: "Render epic/ticket body as Markdown in the Web UI instead of raw <pre>"
created_at: "2026-05-11T15:57:18Z"
started_at: 2026-05-11T15:57:47Z
closed_at: 2026-05-11T16:08:48Z
canceled_at: null
---

# Markdown body rendering (Web UI)

## Why

EpicPage and TicketPage currently dump `epic_body` / `ticket_body` into a
`<pre class="pre-wrap ...">` block. So `# Outcome`, `## Scope`, bullet
lists, links etc. all show as literal text. For a manual-quality UX the
body should render as Markdown — headings, lists, inline code, links.

This was flagged as a known gap in commit `95fa702` ("Markdown rendering
of body text (still <pre>)").

## What

- Add a Markdown renderer to the `web/` package (e.g. `react-markdown` +
  `remark-gfm` for tables/strikethrough). Keep it minimal — no raw HTML
  pass-through (XSS), no syntax-highlight plugin (overkill here).
- New shared component `web/src/components/Markdown.tsx` that wraps the
  renderer with daisyUI-friendly prose styling (Tailwind `prose` class or
  a hand-tuned className set, whichever fits the current build).
- Replace the `<pre>{e.epic_body}</pre>` in `EpicPage.tsx` Body card with
  `<Markdown source={e.epic_body} />`.
- Same for `TicketPage.tsx` — `ticket_body` and `note_body` (Note card).
- Leave the **Frontmatter** card as raw JSON `<pre>` — that's structured
  data, not prose.

## Acceptance Criteria

- AC-1: EpicPage `/epics/<slug>` Body card renders `# Outcome` etc. as
  real `<h1>`/`<h2>`, bullet lists as `<ul>`, links as anchors.
- AC-2: TicketPage `/tickets/<slug>` Body + Note cards render Markdown
  the same way.
- AC-3: `npm run web:check` + `npm run web:build` green.
- AC-4: No raw-HTML injection path (react-markdown default disallows it;
  do not add `rehype-raw`).
- AC-5: Frontmatter card unchanged (still JSON `<pre>`).

## Out of scope

- Syntax highlighting of fenced code blocks
- Markdown editing in-browser
- Rendering `current-note.md` on the RunPage (separate surface; the
  RunPage Note card can follow later if it matters)
