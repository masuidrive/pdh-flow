#!/usr/bin/env bash
# E5: audit-closed-epics.sh — single-shot audit of every closed Epic
# against the current skill basis.
#
# Scans `epics/done/*.md` and reports each Epic that's missing one or
# more of the current PDH-D-4 close-time invariants:
#   - frontmatter `zero_base_reviewed: true`
#   - a `<slug>-verification.md` sibling (or `verification.md` companion)
#
# Pure read-only. Does NOT re-close, re-run engines, or auto-cut tickets.
# The output is a markdown punch list for the human; they decide whether
# to re-open / re-verify / let it be.
#
# Usage:
#   scripts/audit-closed-epics.sh [--since <YYYY-MM-DD>] [<worktree-path>]
#
# Defaults:
#   worktree-path: current directory (`pwd`)
#   --since: no filter (audit every closed Epic)
#
# Skill-spec ref: PD-D-3 retrospective audit (E5).

set -euo pipefail

SINCE=""
WORKTREE="$(pwd)"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --since)
            SINCE="${2:-}"
            shift 2
            ;;
        --help|-h)
            grep '^# ' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *)
            WORKTREE="$1"
            shift
            ;;
    esac
done

EPICS_DIR="$WORKTREE/epics/done"
if [[ ! -d "$EPICS_DIR" ]]; then
    echo "no closed Epics found at $EPICS_DIR" >&2
    exit 0
fi

# Helper: read a top-level frontmatter scalar (`key: value`) from a file.
read_fm() {
    local file="$1" key="$2"
    awk -v key="$key" '
        BEGIN { in_fm = 0 }
        /^---$/ { in_fm = !in_fm; next }
        in_fm && $1 == key":" { sub(/^[^:]*:[ \t]*/, ""); print; exit }
    ' "$file"
}

# Helper: ISO date compare. Returns 0 (success) if $1 >= $2.
date_ge() {
    [[ -z "$2" ]] && return 0
    [[ "$1" > "$2" ]] || [[ "$1" == "$2"* ]]
}

ok_count=0
flag_count=0
flagged=()

for epic_file in "$EPICS_DIR"/*.md; do
    [[ -f "$epic_file" ]] || continue
    slug="$(basename "$epic_file" .md)"

    closed_at="$(read_fm "$epic_file" closed_at || true)"
    if [[ -n "$SINCE" && -n "$closed_at" ]]; then
        if ! date_ge "$closed_at" "$SINCE"; then
            continue
        fi
    fi

    issues=()

    # Issue 1: zero_base_reviewed not stamped (skill L678).
    zbr="$(read_fm "$epic_file" zero_base_reviewed || true)"
    if [[ "$zbr" != "true" ]]; then
        issues+=("missing \`zero_base_reviewed: true\` in frontmatter (skill L678)")
    fi

    # Issue 2: no verification.md sibling.
    verification_active="$WORKTREE/epics/${slug}-verification.md"
    verification_done="$EPICS_DIR/${slug}-verification.md"
    if [[ ! -f "$verification_active" && ! -f "$verification_done" ]]; then
        issues+=("no \`${slug}-verification.md\` companion file (skill L578)")
    fi

    if [[ ${#issues[@]} -eq 0 ]]; then
        ok_count=$((ok_count + 1))
        continue
    fi

    flag_count=$((flag_count + 1))
    block=$'- **'"$slug"'**'$'\n'"  closed_at: ${closed_at:-(unknown)}"$'\n'
    for i in "${issues[@]}"; do
        block+="  - $i"$'\n'
    done
    flagged+=("$block")
done

# ── Report ───────────────────────────────────────────────────────────────
cat <<MD
# Closed-Epic Audit

- Worktree: \`$WORKTREE\`
- Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Since filter: ${SINCE:-(none — full history)}
- Compliant Epics: $ok_count
- Flagged Epics: $flag_count

MD

if [[ $flag_count -eq 0 ]]; then
    echo "All closed Epics comply with the current skill basis."
    exit 0
fi

echo "## Flagged Epics"
echo
for entry in "${flagged[@]}"; do
    printf "%s\n" "$entry"
done

cat <<MD

## Recommended action

Review each flagged Epic and decide individually:
1. **Re-verify in place** — open the Epic file, run a targeted check (often a quick \`scripts/test-all.sh\` against the squashed merge commit), and update the frontmatter / verification.md by hand if it passes the current basis. Commit on \`main\` with subject \`[audit/<slug>] retrospective verify\`.
2. **Cut a follow-up ticket** — when the gap is non-trivial (e.g. the Epic never had real-env verification and acquiring the environment is work), open a ticket against the relevant Epic so the gap is tracked.
3. **Mark as accepted** — when the gap is intentional (e.g. the Epic predates the current skill and the human accepts the legacy state), add an explicit \`accepted_legacy: <date> <reason>\` line to the Epic frontmatter so future audits skip it.

Do NOT auto-re-close, auto-cut tickets, or auto-edit closed Epic files. The audit is advisory; the human owns the next move.
MD
