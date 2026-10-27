#!/usr/bin/env bash
#
# abi-drift.test.sh — the classifier the pre-deploy ABI gate relies on
# (#1564). The gate only NOTES `decode` drift on the keeper bot's ABIs, so a
# classifier that called a changed function `decode` would hide exactly the
# drift that breaks the bot's calls. Every `calls` case below is one such
# disguise; the `none` cases prove it does not report reordering as drift.
#
# Runs from any working directory; needs jq. Exit 0 when every case behaves.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=abi-drift.sh
source "$HERE/abi-drift.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FN='{"type":"function","name":"repayLoan","inputs":[{"name":"loanId","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"}'
ERR='{"type":"error","name":"LoanNotActive","inputs":[]}'
EV='{"type":"event","name":"LoanRepaid","inputs":[{"name":"loanId","type":"uint256","indexed":true,"internalType":"uint256"}],"anonymous":false}'
BASE="[$FN,$ERR,$EV]"

pass=0
fail=0

# expect <want> <case name> <committed json> <compiled json>
expect() {
  local want="$1" name="$2"
  printf '%s' "$3" >"$WORK/committed.json"
  printf '%s' "$4" >"$WORK/compiled.json"
  local got
  got="$(abi_drift_kind "$WORK/committed.json" "$WORK/compiled.json")"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $name: want $want, got $got" >&2
    fail=$((fail + 1))
  fi
}

# none: the same entries, in another order and with keys reordered.
expect none "identical" "$BASE" "$BASE"
expect none "entries reordered" "$BASE" "[$EV,$FN,$ERR]"
expect none "keys reordered" "$BASE" \
  '[{"outputs":[],"name":"repayLoan","stateMutability":"nonpayable","inputs":[{"internalType":"uint256","type":"uint256","name":"loanId"}],"type":"function"},{"inputs":[],"name":"LoanNotActive","type":"error"},{"anonymous":false,"name":"LoanRepaid","type":"event","inputs":[{"indexed":true,"internalType":"uint256","name":"loanId","type":"uint256"}]}]'

# decode: only the error/event list moved.
expect decode "error added" "$BASE" "[$FN,$ERR,$EV,{\"type\":\"error\",\"name\":\"RecycleBackingTokenUnset\",\"inputs\":[]}]"
expect decode "error removed" "$BASE" "[$FN,$EV]"
expect decode "event field changed" "$BASE" \
  "[$FN,$ERR,{\"type\":\"event\",\"name\":\"LoanRepaid\",\"inputs\":[{\"name\":\"loanId\",\"type\":\"uint256\",\"indexed\":false,\"internalType\":\"uint256\"}],\"anonymous\":false}]"

# calls: anything a call encodes or decodes.
expect calls "argument type changed" "$BASE" \
  "[{\"type\":\"function\",\"name\":\"repayLoan\",\"inputs\":[{\"name\":\"loanId\",\"type\":\"uint128\",\"internalType\":\"uint128\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},$ERR,$EV]"
expect calls "result added" "$BASE" \
  "[{\"type\":\"function\",\"name\":\"repayLoan\",\"inputs\":[{\"name\":\"loanId\",\"type\":\"uint256\",\"internalType\":\"uint256\"}],\"outputs\":[{\"name\":\"\",\"type\":\"bool\",\"internalType\":\"bool\"}],\"stateMutability\":\"nonpayable\"},$ERR,$EV]"
expect calls "mutability changed" "$BASE" \
  "[{\"type\":\"function\",\"name\":\"repayLoan\",\"inputs\":[{\"name\":\"loanId\",\"type\":\"uint256\",\"internalType\":\"uint256\"}],\"outputs\":[],\"stateMutability\":\"payable\"},$ERR,$EV]"
expect calls "function removed" "$BASE" "[$ERR,$EV]"
expect calls "function and error both changed" "$BASE" "[$EV]"
expect calls "fallback added" "$BASE" "[$FN,$ERR,$EV,{\"type\":\"fallback\",\"stateMutability\":\"payable\"}]"
expect calls "unknown entry type with an error change" "$BASE" "[$FN,$EV,{\"type\":\"futureKind\",\"name\":\"x\"}]"

# calls: nothing can be vouched for in an ABI that does not parse.
expect calls "committed not JSON" "not json" "$BASE"
expect calls "committed empty" "" "$BASE"
expect calls "committed an object" '{"abi":[]}' "$BASE"
expect calls "entry not an object" '["x"]' "$BASE"

echo "abi-drift: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
