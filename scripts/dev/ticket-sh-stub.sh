#!/usr/bin/env bash
# ticket-sh-stub.sh — minimal bash stub conforming to the ticket.sh epic
# CLI surface spec'd at:
#   https://gist.github.com/masuidrive/09b482ac49812feec2d074cb116cb3e1
#
# Purpose: lets pdh-flow's PD-D flow + web UI develop end-to-end against
# the planned upstream ticket.sh feature set BEFORE that upstream work
# ships. Once real ticket.sh has these commands, delete this stub and
# adjust pdh-flow's PATH / invocation to use it instead.
#
# Scope: covers the commands PD-D + web actually invoke:
#   epic new / epic close / epic cancel / epic show --json / epic list --json
# Does NOT implement `ticket.sh new --epic` (that's skill territory).
#
# Reference impl (TypeScript, was committed and reverted):
#   commit c5cba8e on github.com/masuidrive/pdh
#     pdh-flow/src/cli/epic-{helpers,new,close}.ts
#
# Dependencies: bash 4+, git, python3 (only for --json output formatting).

set -uo pipefail

EPIC_SLUG_RE='^[a-z][a-z0-9._-]{0,79}$'

# --- helpers --------------------------------------------------------------

err() { printf 'error: %s\n' "$*" >&2; }

slug_valid() { [[ "$1" =~ $EPIC_SLUG_RE ]]; }

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Dump frontmatter (without the --- markers). Reads file path or stdin.
fm_extract() {
  awk '/^---$/{c++; next} c==1{print}' "$@"
}

# Read body (everything after the second ---).
body_extract() {
  awk '/^---$/{c++; next} c>=2{print}' "$@"
}

# Get a top-level scalar value from a frontmatter blob (stdin) by key.
fm_get() {
  local key="$1"
  awk -v k="$key" '
    $0 ~ "^"k":" {
      sub("^"k":[ \t]*", "")
      gsub(/^"|"$/, "")
      print
      exit
    }'
}

# Set/update a top-level scalar key in a frontmatter blob (stdin → stdout).
fm_set() {
  local key="$1" val="$2"
  awk -v k="$key" -v v="$val" '
    BEGIN { found = 0 }
    $0 ~ "^"k":" { print k": "v; found=1; next }
    { print }
    END { if (!found) print k": "v }'
}

# Resolve an epic by slug. Echoes:  <branch>\t<origin>\t<source-ref>
resolve_epic() {
  local slug="$1"
  if git show "main:epics/${slug}.md" >/dev/null 2>&1; then
    local b
    b=$(git show "main:epics/${slug}.md" | fm_extract | fm_get branch)
    [[ -z "$b" ]] && b="main"
    printf '%s\t%s\t%s\n' "$b" "main" "main:epics/${slug}.md"
    return 0
  fi
  while IFS= read -r br; do
    [[ -z "$br" ]] && continue
    if git show "${br}:epics/${slug}.md" >/dev/null 2>&1; then
      local b
      b=$(git show "${br}:epics/${slug}.md" | fm_extract | fm_get branch)
      [[ -z "$b" ]] && b="$br"
      printf '%s\t%s\t%s\n' "$b" "branch" "${br}:epics/${slug}.md"
      return 0
    fi
  done < <(git for-each-ref --format='%(refname:short)' 'refs/heads/epic/*')
  if git show "main:epics/done/${slug}/index.md" >/dev/null 2>&1; then
    local b
    b=$(git show "main:epics/done/${slug}/index.md" | fm_extract | fm_get branch)
    [[ -z "$b" ]] && b="main"
    printf '%s\t%s\t%s\n' "$b" "main" "main:epics/done/${slug}/index.md"
    return 0
  fi
  return 1
}

# Find tickets linked to an epic. Echoes "<location>\t<status>" per line.
find_linked_tickets() {
  local slug="$1" epic_branch="$2"
  local f base
  if [[ -d tickets ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      base=$(basename "$f")
      [[ "$base" == "README.md" ]] && continue
      local e
      e=$(fm_extract <"$f" | fm_get epic_id)
      if [[ "$e" == "$slug" ]]; then
        if [[ "$f" == tickets/done/* ]]; then
          printf '%s\tdone\n' "$f (working tree)"
        else
          printf '%s\topen\n' "$f (working tree)"
        fi
      fi
    done < <(find tickets -maxdepth 2 -name '*.md' -type f 2>/dev/null)
  fi
  if [[ -n "$epic_branch" ]]; then
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      [[ "$path" == "tickets/README.md" ]] && continue
      local e
      e=$(git show "${epic_branch}:${path}" 2>/dev/null | fm_extract | fm_get epic_id)
      if [[ "$e" == "$slug" ]]; then
        if [[ "$path" == tickets/done/* ]]; then
          printf '%s\tdone\n' "$path (on $epic_branch)"
        else
          printf '%s\topen\n' "$path (on $epic_branch)"
        fi
      fi
    done < <(git ls-tree -r --name-only "$epic_branch" -- 'tickets/' 2>/dev/null | grep '\.md$' || true)
  fi
}

# After `git merge --squash -X theirs <branch>`, resolve modify/delete +
# rename/delete residuals.
resolve_squash_residuals() {
  local epic_branch="$1"
  local p
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if git cat-file -e "${epic_branch}:${p}" 2>/dev/null; then
      git checkout --theirs -- "$p" || return 1
      git add "$p" || return 1
    else
      git rm -f "$p" || return 1
    fi
  done < <(git diff --name-only --diff-filter=U)
}

# Collect preflight blockers. Echoes one blocker per call (multiple lines
# possible). Returns 0 if no blockers, non-zero otherwise. Caller captures
# stdout via $() and inspects return code (NOT a global, since $() runs in
# a subshell and global var mutations don't propagate to parent).
preflight() {
  local mode="$1" slug="$2" epic_branch="$3" closed_at="$4" cancelled_at="$5"
  local blocker_count=0

  if [[ "$mode" == "close" && -n "$closed_at" ]]; then
    echo "Epic frontmatter already has closed_at=$closed_at; appears already closed."
    blocker_count=$((blocker_count+1))
  fi
  if [[ "$mode" == "cancel" && -n "$cancelled_at" ]]; then
    echo "Epic frontmatter already has cancelled_at=$cancelled_at; appears already cancelled."
    blocker_count=$((blocker_count+1))
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is dirty; commit/stash/discard before retrying."
    blocker_count=$((blocker_count+1))
  fi

  if [[ "$epic_branch" != "main" ]] && ! git rev-parse --verify "refs/heads/$epic_branch" >/dev/null 2>&1; then
    echo "Epic frontmatter says branch=$epic_branch but that branch does not exist locally."
    blocker_count=$((blocker_count+1))
  fi

  local linked open_count=0
  if [[ "$epic_branch" != "main" ]]; then
    linked=$(find_linked_tickets "$slug" "$epic_branch")
  else
    linked=$(find_linked_tickets "$slug" "")
  fi
  open_count=$(echo "$linked" | grep -c '	open$' || true)
  if [[ "$open_count" -gt 0 ]]; then
    echo "Epic still has $open_count open ticket(s) linked to it:"
    echo "$linked" | grep '	open$' | sed -e 's/\topen$//' -e 's/^/    /'
    blocker_count=$((blocker_count+1))
  fi

  return "$blocker_count"
}

# --- commands -------------------------------------------------------------

cmd_epic_new() {
  local slug="" title="" branch_policy="" from_ref="main" main_direct=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2;;
      --main-direct) main_direct=1; shift;;
      --from-ref) from_ref="$2"; shift 2;;
      --branch) branch_policy="$2"; shift 2;;
      -*) err "unknown option: $1"; return 64;;
      *) [[ -z "$slug" ]] && slug="$1" || { err "unexpected positional: $1"; return 64; }; shift;;
    esac
  done
  [[ -z "$slug" ]] && { err "usage: ticket.sh epic new <slug> [--title …] [--main-direct] [--from-ref <ref>]"; return 64; }
  slug_valid "$slug" || { err "invalid slug $slug"; return 3; }
  [[ -z "$title" ]] && title="$slug"
  if [[ -z "$branch_policy" ]]; then
    [[ "$main_direct" -eq 1 ]] && branch_policy="main" || branch_policy="epic/$slug"
  fi

  if git show "main:epics/${slug}.md" >/dev/null 2>&1; then
    err "Epic already exists on main: epics/${slug}.md"; return 4
  fi
  if [[ "$branch_policy" != "main" ]] && git rev-parse --verify "refs/heads/$branch_policy" >/dev/null 2>&1; then
    err "Epic branch already exists: $branch_policy"; return 5
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    err "Working tree dirty; commit/stash/discard before creating an epic"; return 6
  fi

  local original_branch
  original_branch=$(git rev-parse --abbrev-ref HEAD)
  local switched=""

  if [[ "$branch_policy" != "main" ]]; then
    git switch -c "$branch_policy" "$from_ref" >/dev/null || return 7
    switched="$branch_policy"
  elif [[ "$original_branch" != "main" ]]; then
    git switch main >/dev/null || return 7
    switched="main"
  fi

  mkdir -p epics
  local now; now=$(now_iso)
  cat > "epics/${slug}.md" <<EOF
---
version: 1
epic_id: $slug
title: "$title"
status: open
branch: $branch_policy
created_at: $now
---

# $title

## Outcome

(when this epic completes, what new capability exists?)

## Problem

(what problem does this directly solve?)

## Scope

(concrete deliverables — granular enough that "is X in scope" is unambiguous)

## Non-goals

(what we are deliberately NOT doing — name the AI-temptations to drift into)

## Exit Criteria

(when these are true, close the epic. all linked tickets done is necessary but not sufficient)

## Tickets

(filled as tickets are cut)
EOF
  git add -- "epics/${slug}.md" || return 7
  git commit -m "[epic/new] Create epic ${slug}" >/dev/null || return 7

  cat <<EOF
Epic $slug created.
  branch: $branch_policy
  file:   epics/${slug}.md
Next: ticket.sh new <slug> --epic $slug
EOF
}

do_lifecycle() {
  local mode="$1" slug="$2" reason="$3"
  local dry_run="$4" no_push="$5" no_delete_remote="$6" force="$7"

  local resolved
  resolved=$(resolve_epic "$slug") || { err "Epic $slug not found"; return 1; }
  local epic_branch origin source_ref
  IFS=$'\t' read -r epic_branch origin source_ref <<<"$resolved"
  local fm body
  fm=$(git show "$source_ref" | fm_extract)
  body=$(git show "$source_ref" | body_extract)
  local closed_at cancelled_at
  closed_at=$(echo "$fm" | fm_get closed_at)
  cancelled_at=$(echo "$fm" | fm_get cancelled_at)

  echo "Epic: $slug"
  echo "Branch policy: $epic_branch"
  echo "Mode: $mode${reason:+ (reason: $reason)}"
  echo "Push: $([[ "$no_push" -eq 1 ]] && echo skip || echo 'push to origin')"
  echo "Remote branch delete: $([[ "$no_delete_remote" -eq 1 ]] && echo skip || echo 'delete after merge')"
  echo "note: Epic file resolved via git show $source_ref"

  local blockers preflight_rc
  blockers=$(preflight "$mode" "$slug" "$epic_branch" "$closed_at" "$cancelled_at")
  preflight_rc=$?
  if [[ "$preflight_rc" -eq 0 ]]; then
    echo "Preflight: OK"
  else
    echo "Preflight: BLOCKED"
    echo "$blockers" | sed 's/^/  ✗ /'
    if [[ "$force" -ne 1 ]]; then
      err "Preflight failed for epic $slug. Resolve the blockers above, or pass --force."
      return 2
    fi
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    echo "--dry-run: no changes were made."
    return 0
  fi

  local now; now=$(now_iso)

  if [[ "$mode" == "close" ]]; then
    if [[ "$epic_branch" != "main" ]]; then
      execute_close_epic_branch "$slug" "$epic_branch" "$fm" "$body" "$now" "$no_push" "$no_delete_remote"
    else
      execute_close_main_direct "$slug" "$fm" "$body" "$now" "$no_push"
    fi
  else
    if [[ "$epic_branch" != "main" ]]; then
      execute_cancel_epic_branch "$slug" "$epic_branch" "$fm" "$body" "$now" "$reason" "$no_push" "$no_delete_remote"
    else
      execute_cancel_main_direct "$slug" "$fm" "$body" "$now" "$reason" "$no_push"
    fi
  fi
}

write_epic_file() {
  local target="$1" fm="$2" body="$3"
  mkdir -p "$(dirname "$target")"
  {
    echo "---"
    echo "$fm"
    echo "---"
    echo "$body"
  } > "$target"
}

execute_close_epic_branch() {
  local slug="$1" branch="$2" fm="$3" body="$4" now="$5" no_push="$6" no_delete_remote="$7"
  git switch "$branch" >/dev/null || return 7
  fm=$(echo "$fm" | fm_set status closed | fm_set closed_at "$now")
  local old="epics/${slug}.md" new="epics/done/${slug}/index.md"
  mkdir -p "$(dirname "$new")"
  if [[ -f "$old" ]]; then
    git mv "$old" "$new" || return 7
  fi
  write_epic_file "$new" "$fm" "$body"
  git add -A epics/ || return 7
  git commit -m "[epic/close] Close epic $slug" >/dev/null || return 7

  git switch main >/dev/null || return 7
  git merge --squash -X theirs "$branch" >/dev/null 2>&1 || true
  resolve_squash_residuals "$branch" || return 7
  git commit -m "[epic/close] Close epic $slug" >/dev/null || return 7

  if [[ "$no_push" -ne 1 ]]; then
    git push origin main >/dev/null 2>&1 || echo "warning: push failed (continuing)" >&2
  fi
  git branch -D "$branch" >/dev/null
  if [[ "$no_push" -ne 1 && "$no_delete_remote" -ne 1 ]]; then
    git push origin --delete "$branch" >/dev/null 2>&1 || true
  fi
  echo "Epic $slug closed. main contains the squash merge; $branch branch deleted."
}

execute_close_main_direct() {
  local slug="$1" fm="$2" body="$3" now="$4" no_push="$5"
  git switch main >/dev/null || return 7
  fm=$(echo "$fm" | fm_set status closed | fm_set closed_at "$now")
  local old="epics/${slug}.md" new="epics/done/${slug}/index.md"
  mkdir -p "$(dirname "$new")"
  [[ -f "$old" ]] && git mv "$old" "$new"
  write_epic_file "$new" "$fm" "$body"
  git add -A epics/ || return 7
  git commit -m "[epic/close] Close epic $slug" >/dev/null || return 7
  if [[ "$no_push" -ne 1 ]]; then
    git push origin main >/dev/null 2>&1 || echo "warning: push failed" >&2
  fi
  echo "Epic $slug closed (main-direct, no branch operations)."
}

execute_cancel_epic_branch() {
  local slug="$1" branch="$2" fm="$3" body="$4" now="$5" reason="$6" no_push="$7" no_delete_remote="$8"
  git switch main >/dev/null || return 7
  fm=$(echo "$fm" | fm_set status cancelled | fm_set cancelled_at "$now" | fm_set cancel_reason "$reason")
  local new="epics/done/${slug}/index.md"
  write_epic_file "$new" "$fm" "$body"
  while IFS= read -r f; do
    [[ -z "$f" || "$f" == "$new" ]] && continue
    mkdir -p "$(dirname "$f")"
    git show "${branch}:${f}" > "$f" 2>/dev/null || true
  done < <(git ls-tree -r --name-only "$branch" -- "epics/done/${slug}/" 2>/dev/null || true)
  git add -A epics/ || return 7
  git commit -m "[epic/cancel] Cancel epic $slug: ${reason:-(no reason)}" >/dev/null || return 7
  if [[ "$no_push" -ne 1 ]]; then
    git push origin main >/dev/null 2>&1 || echo "warning: push failed" >&2
  fi
  git branch -D "$branch" >/dev/null
  if [[ "$no_push" -ne 1 && "$no_delete_remote" -ne 1 ]]; then
    git push origin --delete "$branch" >/dev/null 2>&1 || true
  fi
  echo "Epic $slug cancelled. Implementation commits on $branch were NOT merged into main."
}

execute_cancel_main_direct() {
  local slug="$1" fm="$2" body="$3" now="$4" reason="$5" no_push="$6"
  git switch main >/dev/null || return 7
  fm=$(echo "$fm" | fm_set status cancelled | fm_set cancelled_at "$now" | fm_set cancel_reason "$reason")
  local old="epics/${slug}.md" new="epics/done/${slug}/index.md"
  mkdir -p "$(dirname "$new")"
  [[ -f "$old" ]] && git mv "$old" "$new"
  write_epic_file "$new" "$fm" "$body"
  git add -A epics/ || return 7
  git commit -m "[epic/cancel] Cancel epic $slug: ${reason:-(no reason)}" >/dev/null || return 7
  if [[ "$no_push" -ne 1 ]]; then
    git push origin main >/dev/null 2>&1 || echo "warning: push failed" >&2
  fi
  echo "Epic $slug cancelled (main-direct)."
}

cmd_epic_close() {
  local slug="" dry_run=0 no_push=0 no_delete_remote=0 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) dry_run=1; shift;;
      --no-push) no_push=1; shift;;
      --no-delete-remote) no_delete_remote=1; shift;;
      --force) force=1; shift;;
      -*) err "unknown option: $1"; return 64;;
      *) [[ -z "$slug" ]] && slug="$1" || { err "unexpected positional: $1"; return 64; }; shift;;
    esac
  done
  [[ -z "$slug" ]] && { err "usage: ticket.sh epic close <slug> [--dry-run] [--no-push] [--no-delete-remote] [--force]"; return 64; }
  do_lifecycle close "$slug" "" "$dry_run" "$no_push" "$no_delete_remote" "$force"
}

cmd_epic_cancel() {
  local slug="" reason="" dry_run=0 no_push=0 no_delete_remote=0 force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --reason) reason="$2"; shift 2;;
      --dry-run) dry_run=1; shift;;
      --no-push) no_push=1; shift;;
      --no-delete-remote) no_delete_remote=1; shift;;
      --force) force=1; shift;;
      -*) err "unknown option: $1"; return 64;;
      *) [[ -z "$slug" ]] && slug="$1" || { err "unexpected positional: $1"; return 64; }; shift;;
    esac
  done
  [[ -z "$slug" ]] && { err "usage: ticket.sh epic cancel <slug> --reason \"…\" [...]"; return 64; }
  [[ -z "$reason" ]] && { err "ticket.sh epic cancel requires --reason \"<text>\""; return 64; }
  do_lifecycle cancel "$slug" "$reason" "$dry_run" "$no_push" "$no_delete_remote" "$force"
}

cmd_epic_show() {
  local slug="" json=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift;;
      *) [[ -z "$slug" ]] && slug="$1" || { err "unexpected positional: $1"; return 64; }; shift;;
    esac
  done
  [[ -z "$slug" ]] && { err "usage: ticket.sh epic show <slug> [--json]"; return 64; }

  local resolved
  resolved=$(resolve_epic "$slug") || { err "Epic $slug not found"; return 1; }
  local epic_branch origin source_ref
  IFS=$'\t' read -r epic_branch origin source_ref <<<"$resolved"
  local fm body
  fm=$(git show "$source_ref" | fm_extract)
  body=$(git show "$source_ref" | body_extract)

  if [[ "$json" -ne 1 ]]; then
    echo "Epic: $slug"
    echo "Source: $source_ref"
    echo "Frontmatter:"
    echo "$fm" | sed 's/^/  /'
    return 0
  fi

  local title status branch created_at closed_at cancelled_at cancel_reason
  title=$(echo "$fm" | fm_get title)
  status=$(echo "$fm" | fm_get status)
  branch=$(echo "$fm" | fm_get branch)
  created_at=$(echo "$fm" | fm_get created_at)
  closed_at=$(echo "$fm" | fm_get closed_at)
  cancelled_at=$(echo "$fm" | fm_get cancelled_at)
  cancel_reason=$(echo "$fm" | fm_get cancel_reason)

  local linked open_count=0 closed_count=0
  linked=$(find_linked_tickets "$slug" "$epic_branch")
  open_count=$(echo "$linked" | grep -c '	open$' || true)
  closed_count=$(echo "$linked" | grep -c '	done$' || true)

  local ahead=0
  if [[ "$branch" != "main" ]] && git rev-parse --verify "refs/heads/$branch" >/dev/null 2>&1; then
    ahead=$(git rev-list --count "main..$branch" 2>/dev/null || echo 0)
  fi

  local py
  py=$(command -v python3 || command -v python || true)
  if [[ -n "$py" ]]; then
    "$py" - "$slug" "$title" "$status" "$branch" "$created_at" "$closed_at" "$cancelled_at" "$cancel_reason" "$open_count" "$closed_count" "$ahead" "$body" "$linked" <<'PY'
import json, sys
slug, title, status, branch, created_at, closed_at, cancelled_at, cancel_reason, open_count, closed_count, ahead, body, linked = sys.argv[1:14]
def n(v): return v if v else None
linked_list = []
for line in linked.strip().split("\n"):
    if not line: continue
    loc, st = line.rsplit("\t", 1)
    linked_list.append({"location": loc, "status": st})
out = {
  "epic_id": slug, "title": title, "status": status, "branch": branch,
  "created_at": created_at, "closed_at": n(closed_at),
  "cancelled_at": n(cancelled_at), "cancel_reason": n(cancel_reason),
  "epic_body": body,
  "linked_tickets": linked_list,
  "open_ticket_count": int(open_count or 0),
  "closed_ticket_count": int(closed_count or 0),
  "ticket_count": int(open_count or 0) + int(closed_count or 0),
  "branch_state": None if branch == "main" else {"ahead_of_main": int(ahead or 0)},
}
json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
print()
PY
  else
    err "python required for --json output (stub limitation)"
    return 1
  fi
}

cmd_epic_list() {
  local json=0 status_filter=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json=1; shift;;
      --status) status_filter="$2"; shift 2;;
      *) err "unknown option: $1"; return 64;;
    esac
  done

  local files=()
  if [[ -d epics ]]; then
    while IFS= read -r f; do files+=("$f"); done < <(find epics -maxdepth 1 -name '*.md' -type f 2>/dev/null)
    while IFS= read -r f; do files+=("$f"); done < <(find epics/done -mindepth 2 -maxdepth 2 -name 'index.md' -type f 2>/dev/null)
  fi

  if [[ "$json" -ne 1 ]]; then
    printf '%-20s %-10s %-25s %s\n' "SLUG" "STATUS" "BRANCH" "TITLE"
    for f in "${files[@]}"; do
      local fm; fm=$(fm_extract <"$f")
      local sl=$(echo "$fm" | fm_get epic_id) st=$(echo "$fm" | fm_get status) br=$(echo "$fm" | fm_get branch) ti=$(echo "$fm" | fm_get title)
      [[ -n "$status_filter" && "$st" != "$status_filter" ]] && continue
      printf '%-20s %-10s %-25s %s\n' "$sl" "$st" "$br" "$ti"
    done
    return 0
  fi

  local py; py=$(command -v python3 || command -v python || true)
  [[ -z "$py" ]] && { err "python required for --json (stub limitation)"; return 1; }

  {
    for f in "${files[@]}"; do
      local fm; fm=$(fm_extract <"$f")
      local sl st br ti ca cl cn
      sl=$(echo "$fm" | fm_get epic_id)
      st=$(echo "$fm" | fm_get status)
      br=$(echo "$fm" | fm_get branch)
      ti=$(echo "$fm" | fm_get title)
      ca=$(echo "$fm" | fm_get created_at)
      cl=$(echo "$fm" | fm_get closed_at)
      cn=$(echo "$fm" | fm_get cancelled_at)
      [[ -n "$status_filter" && "$st" != "$status_filter" ]] && continue
      local linked open_c=0 close_c=0
      linked=$(find_linked_tickets "$sl" "$([[ "$br" != "main" ]] && echo "$br" || echo "")")
      open_c=$(echo "$linked" | grep -c '	open$' || true)
      close_c=$(echo "$linked" | grep -c '	done$' || true)
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$sl" "$ti" "$st" "$br" "$ca" "$cl" "$cn" "$open_c" "$close_c"
    done
  } | "$py" -c '
import json, sys
out = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line: continue
    parts = line.split("\t")
    while len(parts) < 9: parts.append("")
    sl, ti, st, br, ca, cl, cn, oc, cc = parts[:9]
    out.append({
      "epic_id": sl, "title": ti, "status": st, "branch": br,
      "created_at": ca, "closed_at": cl or None, "cancelled_at": cn or None,
      "open_ticket_count": int(oc or 0),
      "closed_ticket_count": int(cc or 0),
      "ticket_count": int(oc or 0) + int(cc or 0),
    })
json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
print()
'
}

cmd_epic_dispatcher() {
  local action="${1:-}"; shift || true
  case "$action" in
    new) cmd_epic_new "$@";;
    close) cmd_epic_close "$@";;
    cancel) cmd_epic_cancel "$@";;
    show) cmd_epic_show "$@";;
    list) cmd_epic_list "$@";;
    -h|--help|"") cat <<EOF
ticket.sh epic — Epic lifecycle (DEV STUB; see gist for spec)
  epic new <slug> [--title …] [--main-direct] [--from-ref <ref>]
  epic close <slug> [--dry-run] [--no-push] [--no-delete-remote] [--force]
  epic cancel <slug> --reason "…" [...]
  epic show <slug> [--json]
  epic list [--status open|closed|cancelled] [--json]
EOF
       ;;
    *) err "unknown epic action: $action"; return 64;;
  esac
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    epic) cmd_epic_dispatcher "$@";;
    -h|--help|"") cat <<EOF
ticket.sh DEV STUB — see https://gist.github.com/masuidrive/09b482ac49812feec2d074cb116cb3e1
Implements only the epic subcommand (pdh-flow PD-D consumer). Real ticket.sh
adds: init / new / list / start / close / cancel / restore / check / etc.
EOF
       ;;
    *) err "unknown command: $cmd (this stub only implements 'epic')"; return 64;;
  esac
}

main "$@"
