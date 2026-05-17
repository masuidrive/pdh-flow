#!/usr/bin/env bash
# Smoke-test the PolyFlow 3D panel against a live serve via agent-browser.
#
# Usage:
#   web/scripts/smoke-polyflow.sh <run-url>
#
# Example:
#   web/scripts/smoke-polyflow.sh http://raspi5:8765/runs/run-20260515011833-pdcw
#
# agent-browser runs headless Chromium without GPU access, so WebGL
# context creation fails. The PolyFlowPanel falls back to a text
# message but still wires `window.__POLY_FLOW_DEBUG`, so the
# data-layer checks below work even though no pixels are rendered.

set -u

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <run-url>" >&2
  exit 2
fi

# Try to find agent-browser. The Tailscale raspi5 environment installs
# it as `agent-browser` on $PATH. Override with $AGENT_BROWSER if
# needed.
AB="${AGENT_BROWSER:-agent-browser}"
if ! command -v "$AB" >/dev/null 2>&1; then
  echo "error: $AB not on \$PATH. Set \$AGENT_BROWSER to the binary." >&2
  exit 3
fi

run() { echo "  $ $AB $*" >&2; "$AB" "$@"; }

echo "=== 1. open + wait for canvas host ===" >&2
run open "$URL" >/dev/null
run wait 3000 >/dev/null

echo "=== 2. internal debug hook ===" >&2
DBG_JSON=$("$AB" eval 'JSON.stringify({mounted: !!window.__POLY_FLOW_DEBUG, stagesCount: window.__POLY_FLOW_DEBUG?.stagesCount, currentStageId: window.__POLY_FLOW_DEBUG?.currentStageId, followLive: window.__POLY_FLOW_DEBUG?.followLive, failPathsCount: Object.keys(window.__POLY_FLOW_DEBUG?.failPaths || {}).length})' | sed -n 's/^"\(.*\)"$/\1/p' | sed 's/\\"/"/g')
echo "  $DBG_JSON"

echo "=== 3. errors / console ===" >&2
run errors

echo "=== 4. HUD presence (STEP badge + Live button) ===" >&2
run find text 'STEP' >/dev/null && echo "  OK STEP badge"
run find text 'Live' >/dev/null && echo "  OK Live button"

echo "=== 5. manual nav: click Next ===" >&2
run find text '›' click >/dev/null
run wait 500 >/dev/null
AFTER_NEXT=$("$AB" eval 'JSON.stringify({active: window.__POLY_FLOW_DEBUG?.currentStageId, followLive: window.__POLY_FLOW_DEBUG?.followLive})' | sed -n 's/^"\(.*\)"$/\1/p' | sed 's/\\"/"/g')
echo "  $AFTER_NEXT"

echo "=== 6. Follow live snap back ===" >&2
run find text 'Follow live' click >/dev/null
run wait 500 >/dev/null
AFTER_LIVE=$("$AB" eval 'JSON.stringify({active: window.__POLY_FLOW_DEBUG?.currentStageId, followLive: window.__POLY_FLOW_DEBUG?.followLive})' | sed -n 's/^"\(.*\)"$/\1/p' | sed 's/\\"/"/g')
echo "  $AFTER_LIVE"

echo "=== 7. mobile viewport ===" >&2
run set viewport 390 844 >/dev/null
run wait 500 >/dev/null
run screenshot /tmp/poly-mobile.png >/dev/null
echo "  saved /tmp/poly-mobile.png"

echo "=== 8. bundle: three chunk independent ===" >&2
"$AB" eval "JSON.stringify(performance.getEntriesByType('resource').filter(r=>r.name.match(/three|PolyFlowPanel/i)).map(r=>r.name.split('/').pop()))" | tail -1

echo >&2
echo "smoke complete." >&2
