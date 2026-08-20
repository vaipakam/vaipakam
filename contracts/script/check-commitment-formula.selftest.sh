#!/usr/bin/env bash
#
# check-commitment-formula.selftest.sh — prove the guard is not vacuous.
#
# A checker that reports success is worthless unless you know it CAN fail. The
# first version of `check-commitment-formula.py` passed on three separate
# mutations it was written to catch, and every one of those holes was found by
# attacking it rather than by reading it:
#
#   * its scan roots were cwd-relative, and `predeploy-check.sh` cds into
#     `contracts/` first — so it walked nothing and printed OK;
#   * it joined comment lines without stripping `///`, so the multi-line case it
#     existed for produced `reported + released - /// consumed` and matched
#     nothing;
#   * it only saw lines that BEGIN with a comment token, so trailing comments
#     were invisible.
#
# This script re-runs that attack. It injects each retired shape into a real
# source file, asserts the guard FAILS, restores the file, and then asserts the
# guard does NOT fire on the correct shapes — a checker that flags valid code
# gets exempted into uselessness, which is the same hole by the opposite door.
#
# Runs from any working directory. Exit 0 when every case behaves.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS="$(cd "$HERE/.." && pwd)"
GUARD="$HERE/check-commitment-formula.py"
TARGET="$CONTRACTS/src/libraries/LibMeshFunding.sol"
BACKUP="$(mktemp)"
ANCHOR="    /// @dev #1222 M3 B2-d3 — Base's model of a mirror's committable recycle"

cp "$TARGET" "$BACKUP"
trap 'cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"' EXIT

FAIL=0

run_case () {
  local name="$1" inject="$2" expect="$3"
  python3 - "$TARGET" "$inject" "$ANCHOR" <<'PY'
import io, sys
path, inject, anchor = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(path, encoding="utf-8").read()
assert s.count(anchor) == 1, "anchor not unique — update selftest ANCHOR"
io.open(path, "w", encoding="utf-8").write(s.replace(anchor, inject + "\n" + anchor))
PY
  python3 "$GUARD" >/dev/null 2>&1
  local got=$?
  cp "$BACKUP" "$TARGET"
  if [ "$got" = "$expect" ]; then
    printf '  PASS  %-38s (exit %s)\n' "$name" "$got"
  else
    printf '  FAIL  %-38s (exit %s, expected %s)\n' "$name" "$got" "$expect"
    FAIL=1
  fi
}

echo "Retired shapes — the guard MUST fail on each:"
run_case "bare form"                 '    /// @dev avail is reported - consumed.' 1
run_case "addition form"             '    /// @dev avail = reported + released - consumed.' 1
run_case "exemption marker, no reason" '    /// @dev avail = reported - consumed. formula-check:allow' 1
run_case "addition split across lines" '    /// @dev avail = reported + released −
    /// consumed, the B1 backstop.' 1
run_case "trailing comment"          '    uint256 private constant _SELFTEST = 1; // reported + released - consumed' 1
run_case "production ledger names"   '    /// @dev chainReportedRecycled[c] + chainReleasedRecycled[c] - chainConsumedRecycled[c]' 1
run_case "block comment /* */"       '    /* avail = reported - consumed */' 1

echo "Correct shapes — the guard must NOT fire:"
run_case "normalized net identifier" '    /// @dev consumedMinusReleased <= reported is the bound.' 0
run_case "canonical subtraction"     '    /// @dev reported − (consumed − released) − repatNet is availability.' 0
run_case "sat() form"                '    /// @dev sat(consumed - released) <= reported.' 0

echo
echo "Root resolution — identical verdict from any cwd:"
A="$(cd "$CONTRACTS/.." && python3 "$GUARD" | tail -1)"
B="$(cd "$CONTRACTS"    && python3 "$GUARD" | tail -1)"
# Paths in the listing are relative, so compare the summary counts only.
AN="$(printf '%s' "$A" | grep -o '[0-9]\+ file(s), [0-9]\+ comment block(s)')"
BN="$(printf '%s' "$B" | grep -o '[0-9]\+ file(s), [0-9]\+ comment block(s)')"
if [ -n "$AN" ] && [ "$AN" = "$BN" ]; then
  echo "  PASS  same scan from repo root and contracts/ ($AN)"
else
  echo "  FAIL  cwd changes what is scanned: '$AN' vs '$BN'"
  FAIL=1
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "check-commitment-formula.selftest: all cases behave."
else
  echo "check-commitment-formula.selftest: FAILURES above." >&2
fi
exit "$FAIL"
