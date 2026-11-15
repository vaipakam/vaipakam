#!/usr/bin/env bash
#
# run-staged.sh — the broadcastable run of a staged positive-flow module (#3502).
#
# An offer can be filled only once its terms have stood the minimum age
# (#3412, seconds), and one `forge script --broadcast` cannot wait between its
# own transactions. A staged module ({PositiveFlowsStaged}) therefore runs in
# stages: each `stage()` call broadcasts the next step of its scenarios and
# records where each has got to and how long the next stage must wait. This
# script runs the stages, waits between them, and then runs the read-only
# `finish()`, which confirms the last stage landed and removes the record.
#
# The wait is usually the terms age, but a step can ask for longer
# (PositiveFlowsTimed: the five-minute cancel cooldown, and a periodic
# checkpoint a month after its loan opens, #3574). On a local Anvil every wait
# is a clock step. On a live chain the script waits out a wait up to
# STAGED_MAX_WAIT_SECONDS (default 1800); for a longer one it stops with exit
# code 75 and says when the next stage may run. Run the same command again
# then: the run resumes from its record.
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
# record to remove for a fresh run. A run that changed a protocol setting it
# had not yet put back (the record lists it under `restore_`) is unwound first,
# with `forge script <module> --sig "unwind()" --broadcast`.
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
# The longest wait this script sits out on a live chain.
MAX_WAIT_SECONDS="${STAGED_MAX_WAIT_SECONDS:-1800}"
# Exit code for "the next stage is not due yet; run this again later".
NOT_YET=75
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

wait_until() {   # $1 = the chain time to wait for
  local target="$1"
  local now
  now="$(cast block latest --field timestamp --rpc-url "$RPC")"
  [ "$now" -ge "$target" ] && return
  if $anvil; then
    echo "== stepping the Anvil clock by $((target - now))s =="
    cast rpc evm_increaseTime "$((target - now))" --rpc-url "$RPC" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC" >/dev/null
    return
  fi
  if [ "$((target - now))" -gt "$MAX_WAIT_SECONDS" ]; then
    echo "run-staged.sh: the next stage may run once the chain's clock passes $target (now $now, $((target - now))s away)," >&2
    echo "  longer than STAGED_MAX_WAIT_SECONDS=$MAX_WAIT_SECONDS. Run the same command again then; it resumes from $RECORD." >&2
    exit "$NOT_YET"
  fi
  echo "== waiting for the chain's clock to pass $target (now $now) =="
  while [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -lt "$target" ]; do
    sleep 2
  done
}

set_ready_at() {   # after a stage lands: its record's readyAt, from the landed block
  # The stage wrote `readyAt` from its simulation's clock, before anything was
  # sent, and its broadcast landed later (a fixture deploy and dozens of
  # transactions can take a minute). Counting the wait from the block the
  # broadcast landed in is what the chain's own rules count from, so the
  # record is moved to that, and a resumed run, or the next stage's own
  # check, waits for the right moment.
  local landed ready
  landed="$(cast block latest --field timestamp --rpc-url "$RPC")"
  ready=$((landed + $(jq -r '.waitSec' "$RECORD") + MARGIN_SECONDS))
  jq --argjson r "$ready" '.readyAt = $r' "$RECORD" > "$RECORD.tmp"
  mv "$RECORD.tmp" "$RECORD"
}

RECORD="$(record_path)"
[ -n "$RECORD" ] || { echo "run-staged.sh: could not resolve the record path for $MODULE" >&2; exit 1; }
if [ -e "$RECORD" ]; then
  echo "run-staged.sh: resuming the run recorded at $RECORD"
  if [ "$(jq -r '.finished' "$RECORD")" != "true" ]; then
    wait_until "$(jq -r '.readyAt // 0' "$RECORD")"
  fi
fi

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
    set_ready_at
    wait_until "$(jq -r '.readyAt' "$RECORD")"
  fi
done

fresh_block
echo "== finish =="
forge script "$TARGET" --sig "finish()" --rpc-url "$RPC" "$@"
