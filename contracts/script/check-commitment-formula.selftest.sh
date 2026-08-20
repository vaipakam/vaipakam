#!/usr/bin/env bash
#
# check-commitment-formula.selftest.sh — prove the guard is not vacuous.
#
# A checker that reports success is worthless unless you know it CAN fail.
# `check-commitment-formula.py` has now been found vacuous across two review
# rounds, in NINE independent ways — cwd-relative roots that walked nothing,
# unstripped `///` that broke the multi-line joining it existed for, invisible
# trailing comments, bypassable ledger identifiers, an over-broad `net`
# exemption, missed trailing block comments, a waived addition form, a missed
# commuted bound, and block-scoped exemptions that licensed newly introduced
# false statements. Not one was found by reading it.
#
# Every case below is one of those holes, kept as a regression.
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
run_case "TRAILING block comment"    '    uint256 private constant _ST2 = 2; /* avail = reported - consumed */' 1
run_case "commuted addition bound"   '    /// @dev consumed <= released + reported.' 1
run_case "addition w/ net consumed"  '    /// @dev avail = reported + released - consumedMinusReleased.' 1
run_case "gross name starting 'net'" '    /// @dev networkConsumedCumulative <= networkReportedCumulative.' 1
run_case "marker too far from mention" '    /// formula-check:allow this reason is real but far away.
    ///
    ///
    ///
    /// @dev avail = reported - consumed.' 1
run_case "parenthesized addition"    '    /// @dev avail = reported + (released - consumed).' 1
run_case "reversed bare comparison"  '    /// @dev reported >= consumed always holds.' 1
run_case "reversed addition bound"   '    /// @dev reported + released >= consumed always holds.' 1
run_case "prose: reported less consumed" '    /// @dev availability is reported less consumed.' 1
run_case "prose: plus/minus word form" '    /// @dev avail is reported plus released minus consumed.' 1
run_case "one marker cannot cover two mentions" '    /// formula-check:allow the historical form is quoted here on purpose.
    /// @dev the old B2-d3 shape was reported - consumed.
    /// @dev current availability is reported - consumed.' 1

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
