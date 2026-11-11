#!/usr/bin/env bash
# check-test-treasury-sync.sh — a test changes the Diamond's treasury only
# through LibTestVaultBeacon.setTreasury (#3431 follow-up).
#
# Why: since #3431 the vault code fixes its treasury as an immutable, so a
# test that calls AdminFacet.setTreasury directly leaves every vault refusing
# fee and treasury movements to the new address (OutflowDestinationRefused).
# The failure surfaces in whichever suite first moves a fee, often far from the
# setter call, and #3499 found 23 suites in that state after the fact. The
# helper sets the treasury AND brings the vault code's treasury endpoint with
# it, so routing every call through it removes the class.
#
# What it refuses: any `.setTreasury(` call in a Solidity file under the test
# root, outside the files listed in ALLOWED below. Comment lines (starting
# with `//`, `///` or `*`) are skipped. The helper's own call
# (`LibTestVaultBeacon.setTreasury(`) is what tests are meant to write and is
# not counted.
#
# What it does not see, stated rather than implied: a call made without that
# spelling (an encoded selector passed to a low-level call, for instance).
# It is a text check over test code, not a proof; it exists to make the usual
# spelling fail loudly.
#
# Usage: bash contracts/script/check-test-treasury-sync.sh [test-root]
#   test-root defaults to contracts/test (relative to the repository root, or
#   to the script's own location when run from elsewhere).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$SCRIPT_DIR/../test}"

# Files that may call the setter directly, each with its reason.
ALLOWED=(
  # The helper itself: it is the one place the setter is called.
  "helpers/LibTestVaultBeacon.sol"
  # The setter's own suite: tests its access control, zero-address refusal
  # and event, which the helper would wrap.
  "AdminFacetTest.t.sol"
  # Ownership-transfer tests that use the setter as the probe for who may act.
  "DiamondLoupeFacetTest.t.sol"
)

if [ ! -d "$ROOT" ]; then
  echo "check-test-treasury-sync: no test root at $ROOT" >&2
  exit 2
fi

offenders=()
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line_no="${rest%%:*}"
  text="${rest#*:}"
  rel="${file#"$ROOT"/}"
  allowed=0
  for a in "${ALLOWED[@]}"; do
    if [ "$rel" = "$a" ]; then allowed=1; break; fi
  done
  [ "$allowed" -eq 1 ] && continue
  trimmed="${text#"${text%%[![:space:]]*}"}"
  case "$trimmed" in
    //*|\**) continue ;;
  esac
  # The helper's own spelling is the intended call.
  stripped="${text//LibTestVaultBeacon.setTreasury(/}"
  case "$stripped" in
    *.setTreasury\(*) offenders+=("$rel:$line_no: $trimmed") ;;
  esac
done < <(grep -rn --include='*.sol' '\.setTreasury(' "$ROOT" || true)

if [ "${#offenders[@]}" -gt 0 ]; then
  echo "✗ a test sets the treasury without moving the vault code's treasury with it:" >&2
  for o in "${offenders[@]}"; do echo "    $o" >&2; done
  echo "  Use LibTestVaultBeacon.setTreasury(diamond, treasury) instead (#3431)." >&2
  exit 1
fi
echo "✓ every test treasury change goes through LibTestVaultBeacon.setTreasury"
