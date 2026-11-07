#!/usr/bin/env bash
#
# reward-funding.test.sh — the post-deploy funding read (#3253). `cast` is
# stubbed with a shell function, so the cases run in seconds with no chain.
# A canonical chain whose rewards are launched with a zero delivered-fresh
# bound must FAIL; a read that does not answer must never pass as funded.
#
# Runs from any working directory; needs bash only. Exit 0 when every case
# behaves.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=reward-funding.sh
source "$HERE/reward-funding.sh"

# The stub's answers, per call; an empty value makes that read fail.
ROLE="" LAUNCH="" LEDGER="" BOUND=""
cast() {
  local value=""
  case "$3" in
    'getRewardRole()(uint8)') value="$ROLE" ;;
    'getInteractionLaunchTimestamp()(uint256)') value="$LAUNCH" ;;
    'armedFreshLedger()(uint256,uint256)') value="$LEDGER" ;;
    'getDeliveredFreshBound()(uint256,uint256)') value="$BOUND" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s\n' "$value"
}

pass=0
fail=0

# expect <want rc> <case name> <role> <launch> <ledger> <bound>
expect() {
  local want="$1" name="$2"
  ROLE="$3" LAUNCH="$4" LEDGER="$5" BOUND="$6"
  local got=0
  reward_pool_funding 0xD1 http://rpc >/dev/null 2>&1 || got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $name: want rc $want, got $got" >&2
    fail=$((fail + 1))
  fi
}

MAX='115792089237316195423570985008687907853269984665640564039457584007913129639935 [1.157e77]'

# The 2026-11-06 Base Sepolia state: launched, never funded.
expect 1 "canonical, launched, never funded" 0 "1762214400 [1.762e9]" $'0\n0' $'0\n0'
expect 1 "canonical, launched, funding used up" 0 "1762214400 [1.762e9]" $'5000 [5e3]\n5000 [5e3]' $'5000 [5e3]\n0'
expect 0 "canonical, launched, funded" 0 "1762214400 [1.762e9]" $'10000000000000000000000 [1e22]\n0' $'0\n9999999958904109589040 [9.999e21]'
expect 0 "canonical, not launched, unfunded (stated, not failed)" 0 "0" $'0\n0' $'0\n0'
expect 0 "mirror" 1 "" "" ""
expect 0 "unconfigured" 2 "" "" ""
expect 0 "detached" 3 "" "" ""
expect 2 "role unreadable" "" "" "" ""
expect 2 "role out of range" 7 "" "" ""
expect 2 "launch unreadable" 0 "" $'0\n0' $'0\n0'
expect 2 "ledger unreadable" 0 "1762214400" "" $'0\n0'
expect 2 "bound unreadable" 0 "1762214400" $'0\n0' ""
expect 2 "bound missing its second word" 0 "1762214400" $'0\n0' "0"
expect 0 "uint256 max remaining is compared as text" 0 "1762214400" $'1\n0' "0
$MAX"

echo "reward-funding: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
