#!/usr/bin/env bash
#
# run-staged.sh — the broadcastable run of a staged positive-flow module (#3502).
#
# An offer can be filled only once its terms have stood the minimum age
# (#3412, seconds), and one `forge script --broadcast` cannot wait between its
# own transactions. A staged module ({PositiveFlowsStaged}) therefore runs in
# stages: each `stage()` call broadcasts one step of every unfinished
# scenario and records where each has got to. This script runs the stages,
# lets the terms age between them, and then runs the read-only `finish()`,
# which confirms the last stage landed and removes the record.
#
# Usage, from contracts/ (the actor keys PositiveFlowsBase reads must be set):
#
#   bash script/positive-flows/run-staged.sh PositiveFlowsBasicLifecycle
#   ONLY_SCENARIO=PF-090 bash script/positive-flows/run-staged.sh PositiveFlowsBasicLifecycle
#
# RPC_URL picks the chain (default http://localhost:8545). Any chain the module
# itself accepts works ({RehearsalChain}): on a local Anvil the wait is a
# clock step, elsewhere the script waits until the chain's own clock has
# passed it. A record left by a run that stopped is resumed: a stage refuses
# to run on top of a stage whose broadcast did not land whole, and names the
# record to remove for a fresh run.
#
# Extra arguments are passed to every `forge script` call.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$CONTRACTS_DIR"

MODULE="${1:?usage: run-staged.sh <PositiveFlows module name> [forge args...]}"
shift
TARGET="script/positive-flows/${MODULE}.s.sol"
[ -f "$TARGET" ] || { echo "run-staged.sh: no module at $TARGET" >&2; exit 1; }

RPC="${RPC_URL:-http://localhost:8545}"
# Seconds past the minimum age, so the next stage's simulation and every
# transaction it sends land after the terms became fillable.
MARGIN_SECONDS=2
# Gas headroom over what forge's simulation measured, in percent (forge's
# default is 130). A stage's simulation runs every step at one timestamp, so a
# loan opened and repaid in one step accrues no interest there; on chain the
# repayment lands seconds later, interest is due, and its fee legs cost more
# gas than the simulation saw (measured: a repay of an illiquid-asset loan used
# 639,222 gas against a 648,919 limit and ran out inside a nested call).
GAS_ESTIMATE_MULTIPLIER=200

for tool in forge cast jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "run-staged.sh: $tool is required" >&2; exit 1; }
done

chain_id="$(cast chain-id --rpc-url "$RPC")"
anvil=false
[ "$chain_id" = "31337" ] && anvil=true

record_path() {
  # The record lives beside the chain's deployment artifact; the module
  # names it, so this script never re-derives the chain's folder.
  forge script "$TARGET" --sig "recordPath()" --rpc-url "$RPC" 2>/dev/null \
    | sed -n 's/^ *STAGED_RECORD=//p' | tail -n 1
}

fresh_block() {
  # The simulation runs at the latest block's time; an idle Anvil's latest
  # block can be minutes old.
  if $anvil; then cast rpc evm_mine --rpc-url "$RPC" >/dev/null; fi
}

wait_out() {   # $1 = seconds to wait past the chain's latest block
  local wait="$1"
  local now target
  now="$(cast block latest --field timestamp --rpc-url "$RPC")"
  target=$((now + wait + MARGIN_SECONDS))
  if $anvil; then
    echo "== stepping the Anvil clock by $((wait + MARGIN_SECONDS))s =="
    cast rpc evm_increaseTime "$((wait + MARGIN_SECONDS))" --rpc-url "$RPC" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC" >/dev/null
    return
  fi
  echo "== waiting for the chain's clock to pass $target (now $now) =="
  while [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$target" ]; do
    sleep 2
  done
}

RECORD="$(record_path)"
[ -n "$RECORD" ] || { echo "run-staged.sh: could not resolve the record path for $MODULE" >&2; exit 1; }
[ -e "$RECORD" ] && echo "run-staged.sh: resuming the run recorded at $RECORD"

# The record names the most stages its scenarios can need (the first, plus
# one per wait) and how many have run, a resumed run's earlier ones included;
# stage() itself refuses to run past that bound too.
while :; do
  if [ -e "$RECORD" ]; then
    [ "$(jq -r '.finished' "$RECORD")" = "true" ] && break
    if [ "$(jq -r '.stage' "$RECORD")" -ge "$(jq -r '.maxStages' "$RECORD")" ]; then
      echo "run-staged.sh: $RECORD is not finished after its last possible stage" >&2
      exit 1
    fi
  fi
  fresh_block
  echo "== stage =="
  forge script "$TARGET" --sig "stage()" --rpc-url "$RPC" \
    --broadcast --slow --disable-block-gas-limit \
    --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER" "$@"
  [ -e "$RECORD" ] || { echo "run-staged.sh: the stage wrote no record at $RECORD" >&2; exit 1; }
  if [ "$(jq -r '.finished' "$RECORD")" != "true" ]; then
    wait_out "$(jq -r '.waitSec' "$RECORD")"
  fi
done

fresh_block
echo "== finish =="
forge script "$TARGET" --sig "finish()" --rpc-url "$RPC" "$@"
