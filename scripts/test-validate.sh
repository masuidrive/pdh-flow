#!/usr/bin/env bash
# Phase C verification: run the schema validation test suite.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ -f /home/masuidrive/.nvm/nvm.sh ]; then
  # shellcheck disable=SC1091
  source /home/masuidrive/.nvm/nvm.sh >/dev/null
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pass() {
  printf '  ok    %s\n' "$1"
}

fail() {
  printf '  FAIL  %s\n' "$1" >&2
  if [ "${2-}" != "" ]; then
    printf '        %s\n' "$2" >&2
  fi
  exit 1
}

assert_stdout_equals() {
  local label="$1"
  local expected="$2"
  shift 2

  local actual_file="$tmpdir/actual.txt"
  local expected_file="$tmpdir/expected.txt"

  if "$@" >"$actual_file"; then
    pass "$label exits 0"
  else
    fail "$label exits 0"
  fi

  printf '%s' "$expected" >"$expected_file"
  if cmp -s "$actual_file" "$expected_file"; then
    pass "$label stdout matches"
  else
    fail "$label stdout matches" "got: $(sed -n '1,20l' "$actual_file" | tr '\n' ' ')"
  fi
}

assert_stdout_matches() {
  local label="$1"
  local pattern="$2"
  shift 2

  local actual_file="$tmpdir/actual.txt"

  if "$@" >"$actual_file"; then
    pass "$label exits 0"
  else
    fail "$label exits 0"
  fi

  if grep -Eq "$pattern" "$actual_file"; then
    pass "$label output matches"
  else
    fail "$label output matches" "stdout: $(sed -n '1,40l' "$actual_file" | tr '\n' ' ')"
  fi
}

node scripts/test-validate.ts

# Exercise the public CLI in real subprocesses here; nested Node spawns from
# the TS runner are sandbox-limited in this environment.
printf '\n=== CLI: hello ===\n'

assert_stdout_equals \
  'hello' \
  $'hello, world\n' \
  node src/cli/index.ts hello

assert_stdout_equals \
  'hello --name Yuichiro' \
  $'hello, Yuichiro\n' \
  node src/cli/index.ts hello --name Yuichiro

assert_stdout_equals \
  'hello --name ""' \
  $'hello, world\n' \
  node src/cli/index.ts hello --name ''

assert_stdout_matches \
  'pdh-flow with no args' \
  '(^|[[:space:]])hello[[:space:]]+\[--name <name>\]' \
  node src/cli/index.ts

assert_stdout_matches \
  'pdh-flow help' \
  '(^|[[:space:]])hello[[:space:]]+\[--name <name>\]' \
  node src/cli/index.ts help

ln -s "$REPO/src/cli/index.ts" "$tmpdir/pdh-flow"
assert_stdout_equals \
  'symlinked cli entrypoint' \
  $'hello, world\n' \
  node "$tmpdir/pdh-flow" hello
