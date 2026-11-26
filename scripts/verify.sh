#!/usr/bin/env bash
# The whole verification loop, as one command that exits non-zero if any part fails.
#
# This exists because I committed on a red suite. My hand-written gate checked
# parity, the web tests and the endpoint tests, and silently omitted
# tools/run_tests.sh, which was failing at the time. A gate assembled by hand at
# each commit omits whatever the author is not thinking about, and the author is
# thinking about the change rather than about the gate.
#
# Usage: scripts/verify.sh    (exit 0 = safe to commit)
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
step() {
  local name="$1"; shift
  if "$@" >/tmp/verify.$$ 2>&1; then printf "  ok    %s\n" "$name"
  else printf "  FAIL  %s\n" "$name"; sed 's/^/        /' /tmp/verify.$$ | tail -5; FAIL=1; fi
}
step "build.sh"            ./scripts/build.sh
step "tools/run_tests.sh"  bash -c 'cd tools && ./run_tests.sh'
step "assemble + validate" bash -c 'python3 scripts/assemble.py examples/daily-brief-passport.md /tmp/verify-out.md >/dev/null && python3 tools/validate.py /tmp/verify-out.md >/dev/null'
step "web/tools/parity"    node web/tools/parity.mjs
step "store split"         node web/tools/check-store-split.mjs
step "web tests"           bash -c 'cd web && node --test tools/*.test.mjs'
step "endpoint tests"      node web/tools/run-endpoint-tests.mjs
rm -f /tmp/verify.$$
if [ "$FAIL" = 0 ]; then echo "VERIFIED"; else echo "NOT VERIFIED - do not commit"; fi
exit $FAIL
