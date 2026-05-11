# Work Notes for 260511-155718-markdown-body-render

## Implementation

- `react-markdown@^10` was already a `web/` dependency (used by GateCard
  for `data.summary`). Added `remark-gfm` for tables / strikethrough /
  task-list checkboxes.
- New `web/src/components/Markdown.tsx`: thin wrapper around
  `<ReactMarkdown remarkPlugins={[remarkGfm]}>`, wrapped in the existing
  `.markdown-content` class. No `rehype-raw` — raw HTML in source is not
  rendered (XSS-safe by default). AC-4 ✓
- `EpicPage.tsx`: Body card `<pre>{e.epic_body}</pre>` →
  `<div className="text-sm bg-base-200 p-3 rounded max-h-[600px] overflow-auto"><Markdown source={e.epic_body} /></div>`
- `TicketPage.tsx`: same for `ticket_body` (Body card) + `note_body`
  (Note card). Frontmatter card left as raw JSON `<pre>`. AC-5 ✓
- `app.css`: extended `.markdown-content` rules — added `p` spacing,
  `a` links (daisyUI primary + underline), fenced `pre` blocks,
  `blockquote`, GFM `table` borders, `li` spacing, task-list checkbox
  inline display (`ul:has(> li > input[type=checkbox])`), `hr`.
  (h1/h2/h3, `ul`, `ol`, inline `code` were already covered.)

## Verification

- `npm run web:check` + `npm run web:build` — green. AC-3 ✓
- `npm run check` (engine side) — green (no engine changes, just sanity).
- Visual: `/tickets/260511-155718-markdown-body-render` Body card now
  renders `# Markdown body rendering` as `<h1>`, `## Why` / `## What`
  as headings, bullet lists with discs, inline code with grey bg.
  Frontmatter card still raw JSON. AC-1 ✓ (AC-2 same code path).

## Tasks

- [x] Add remark-gfm
- [x] Markdown.tsx component
- [x] EpicPage Body → Markdown
- [x] TicketPage Body + Note → Markdown
- [x] app.css prose rules for the new elements
- [x] web:check + web:build green
- [x] Visual confirmation via agent-browser

## Out of scope (per ticket)

- Syntax highlighting of fenced code blocks
- In-browser markdown editing
- RunPage Note card markdown rendering (separate surface)
