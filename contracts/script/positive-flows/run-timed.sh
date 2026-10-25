#!/usr/bin/env bash
#
# run-timed.sh — the staged positive-flows run on a local Anvil (#848).
#
# Runs PositiveFlowsTimed's open stage, steps the Anvil clock past the moment
# the open stage recorded, runs its settle stage, and then its read-only
# finish stage, which removes the record once the chain shows nothing it
# names is still open. The scenarios are the
# positive flows whose second step must wait: an offer cancel after the cancel
# cooldown (PF-045, PF-046) and a due periodic-interest checkpoint (PF-116).
# See script/positive-flows/PositiveFlowsTimed.s.sol for what each stage does
# and what it changes until the settle stage restores it.
#
# Usage, from contracts/ (the actor keys PositiveFlowsBase reads must be set):
#
#   bash script/positive-flows/run-timed.sh
#   ONLY_SCENARIO=PF-116 bash script/positive-flows/run-timed.sh
#
# Anvil only: the clock step is `evm_increaseTime`, which a live chain does not
# offer. On a rehearsal chain run the stages by hand: `--sig "open()"` and,
# once the recorded time has passed, `--sig "settle()"` (both with
# --broadcast), then `--sig "finish()"` without --broadcast. The settle stage
# refuses to run early and says when it is due. If a broadcast stops
# part-way, the record stays: run settle() again, then finish().
#
# Extra arguments are passed to every `forge script` call.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$CONTRACTS_DIR"

RPC="${RPC_URL:-http://localhost:8545}"
STATE_FILE="deployments/anvil/positive-flows-timed.json"
TARGET="script/positive-flows/PositiveFlowsTimed.s.sol"
# Seconds past the recorded due time, so the settle stage's simulation and
# every transaction it broadcasts land after it.
MARGIN_SECONDS=60

for tool in forge cast jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "run-timed.sh: $tool is required" >&2; exit 1; }
done

chain_id="$(cast chain-id --rpc-url "$RPC")"
if [ "$chain_id" != "31337" ]; then
  echo "run-timed.sh: $RPC is chain $chain_id, not a local Anvil (31337); the clock step is Anvil-only" >&2
  exit 1
fi

if [ -e "$STATE_FILE" ]; then
  echo "run-timed.sh: $STATE_FILE already records an open run; run its settle() and finish() stages first" >&2
  exit 1
fi

run_stage() {   # $1 = the stage's function signature; rest = extra forge args
  local sig="$1"; shift
  forge script "$TARGET" --sig "$sig" --rpc-url "$RPC" \
    --broadcast --slow --disable-block-gas-limit "$@"
}

# The finish stage sends nothing, so it runs without --broadcast, and after
# the settle stage's broadcast has landed: it reads the chain, not a plan.
finish_stage() {
  forge script "$TARGET" --sig "finish()" --rpc-url "$RPC" "$@"
}

# A fresh block: the simulation runs at the latest block's time, and an idle
# Anvil's latest block can be hours old (see script/PositiveFlows.s.sol).
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

echo "== open stage =="
run_stage "open()" "$@"

if [ ! -f "$STATE_FILE" ]; then
  echo "run-timed.sh: the open stage wrote no record at $STATE_FILE" >&2
  exit 1
fi
settle_after="$(jq -r '.settleAfter' "$STATE_FILE")"
now="$(cast block latest --field timestamp --rpc-url "$RPC")"
if [ "$settle_after" -gt "$now" ]; then
  step=$((settle_after - now + MARGIN_SECONDS))
  echo "== stepping the Anvil clock by ${step}s (due at $settle_after, chain at $now) =="
  cast rpc evm_increaseTime "$step" --rpc-url "$RPC" >/dev/null
fi
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

echo "== settle stage =="
run_stage "settle()" "$@"

echo "== finish stage =="
finish_stage "$@"
