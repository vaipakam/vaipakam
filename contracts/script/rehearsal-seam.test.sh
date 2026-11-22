#!/usr/bin/env bash
# rehearsal-seam.test.sh — the deploy rehearsal's Solidity seams in their real
# context (#3891, deploy rehearsal design §20 tests 1-4).
#
# The record-root rule and the signer library read the process environment and
# the node, and neither reads them under `forge test`. So this drives a
# `forge script` probe (test/rehearsal/SignerSeamProbe.s.sol) against a local
# Anvil started with a real testnet's chain id (84532), with and without the
# local-node marker, and checks each verdict:
#
#   1. the flag against a node without the marker is refused;
#   2. a marker node run without the flag is refused (real mode on a fork);
#   3. on a marker node with the flag but no scratch root, the record root is
#      refused, and with one it is that root;
#   4. a real run stops when the key's address differs from <ROLE>_ADDRESS or
#      the address is missing; a rehearsal reads no key (a key for ANOTHER
#      address is present and ignored) and broadcasts as the stated address.
#
# No RPC, no key of any value: the only key used is Anvil's published
# development key 0, and the node is on loopback.
#
# Usage (from contracts/): bash script/rehearsal-seam.test.sh
set -uo pipefail

cd "$(dirname "$0")/.."
PROBE="test/rehearsal/SignerSeamProbe.s.sol:SignerSeamProbe"
PORT="${REHEARSAL_SEAM_PORT:-18545}"
RPC="http://127.0.0.1:$PORT"
SCRATCH="$(mktemp -d)"
ROOT_OK="deployments/.forge-test/rehearsal/seam-test-$$"
ANVIL_KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ANVIL_ADDR0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OTHER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

pass=0
fail=0
anvil_pid=""
cleanup() {
  [[ -n "$anvil_pid" ]] && kill "$anvil_pid" 2>/dev/null
  rm -rf "$SCRATCH" "$ROOT_OK"
}
trap cleanup EXIT

start_node() {
  [[ -n "$anvil_pid" ]] && kill "$anvil_pid" 2>/dev/null && wait "$anvil_pid" 2>/dev/null
  # No development accounts: a rehearsal fork has none, so the only senders
  # the node accepts unsigned are the ones it was told to impersonate.
  anvil --port "$PORT" --chain-id 84532 --accounts 0 --silent &
  anvil_pid=$!
  for _ in $(seq 50); do
    if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
      cast rpc --rpc-url "$RPC" anvil_setBalance "$ANVIL_ADDR0" 0xde0b6b3a7640000 >/dev/null
      cast rpc --rpc-url "$RPC" anvil_setBalance "$OTHER_ADDR" 0xde0b6b3a7640000 >/dev/null
      return 0
    fi
    sleep 0.1
  done
  echo "anvil did not start" >&2
  exit 1
}

# shellcheck source=lib/rehearsal.sh
source script/lib/rehearsal.sh
place_marker() {
  cast rpc --rpc-url "$RPC" anvil_setCode "$REHEARSAL_MARKER_ADDRESS" "$REHEARSAL_MARKER_CODE" >/dev/null
}

# probe <sig> [forge flags...] — env comes from the caller. Output in $OUT.
probe() {
  local sig=$1
  shift
  OUT=$(env FOUNDRY_BROADCAST="$SCRATCH/broadcast" FOUNDRY_CACHE_PATH="$SCRATCH/cache" \
    forge script "$PROBE" --sig "$sig" --rpc-url "$RPC" "$@" 2>&1)
  return $?
}

expect_ok() {
  local name=$1 needle=$2
  if [[ $RC -eq 0 && "$OUT" == *"$needle"* ]]; then
    echo "  ✓ $name"; pass=$((pass + 1))
  else
    echo "  ✗ $name (rc=$RC, wanted: $needle)"; echo "$OUT" | tail -15 | sed 's/^/      /'; fail=$((fail + 1))
  fi
}

expect_refused() {
  local name=$1 needle=$2
  if [[ $RC -ne 0 && "$OUT" == *"$needle"* ]]; then
    echo "  ✓ $name"; pass=$((pass + 1))
  else
    echo "  ✗ $name (rc=$RC, wanted refusal: $needle)"; echo "$OUT" | tail -15 | sed 's/^/      /'; fail=$((fail + 1))
  fi
}

# Every case starts from an environment with none of the seam's variables.
unset VAIPAKAM_REHEARSAL VAIPAKAM_REHEARSAL_ROOT DEPLOYER_PRIVATE_KEY DEPLOYER_ADDRESS

echo "→ a node with a real testnet's chain id and no marker"
start_node

VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_ROOT="$ROOT_OK" probe "root()"; RC=$?
expect_refused "test 1: the flag without the marker is refused" "without the local-node marker"

probe "root()"; RC=$?
expect_ok "a real run resolves the committed records" "ROOT deployments"

DEPLOYER_PRIVATE_KEY=$ANVIL_KEY0 DEPLOYER_ADDRESS=$OTHER_ADDR probe "send()"; RC=$?
expect_refused "test 4: a key for another address stops a real run" "is not the address of DEPLOYER_PRIVATE_KEY"

DEPLOYER_PRIVATE_KEY=$ANVIL_KEY0 probe "send()"; RC=$?
expect_refused "test 4: a real chain requires DEPLOYER_ADDRESS" "DEPLOYER_ADDRESS is required on a real chain"

DEPLOYER_PRIVATE_KEY=$ANVIL_KEY0 DEPLOYER_ADDRESS=$ANVIL_ADDR0 probe "send()"; RC=$?
expect_ok "a matching key and address sign the real run" "KEYED true"

echo "→ the same node carrying the local-node marker"
place_marker

probe "root()"; RC=$?
expect_refused "tests 2-3: a marker node without the flag is refused" "carries the local-node marker"

VAIPAKAM_REHEARSAL=1 probe "root()"; RC=$?
expect_refused "test 3: the flag with no scratch root is refused" "no VAIPAKAM_REHEARSAL_ROOT"

VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_ROOT=deployments/base-sepolia probe "root()"; RC=$?
expect_refused "a root outside the rehearsal scratch is refused" "must start with deployments/.forge-test/rehearsal/"

VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_ROOT="$ROOT_OK" probe "root()"; RC=$?
expect_ok "a rehearsal resolves its scratch root" "ROOT $ROOT_OK"

cast rpc --rpc-url "$RPC" anvil_impersonateAccount "$OTHER_ADDR" >/dev/null
before=$(cast balance 0x000000000000000000000000000000000000BEEF --rpc-url "$RPC")
VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_ROOT="$ROOT_OK" \
  DEPLOYER_PRIVATE_KEY=$ANVIL_KEY0 DEPLOYER_ADDRESS=$OTHER_ADDR \
  probe "send()" --broadcast --unlocked --sender "$OTHER_ADDR"; RC=$?
expect_ok "test 4: a rehearsal reads no key" "KEYED false"
after=$(cast balance 0x000000000000000000000000000000000000BEEF --rpc-url "$RPC")
nonce=$(cast nonce "$OTHER_ADDR" --rpc-url "$RPC")
if [[ $RC -eq 0 && "$after" != "$before" && "$nonce" == 1 ]]; then
  echo "  ✓ test 4: the rehearsal broadcast as the stated address"; pass=$((pass + 1))
else
  echo "  ✗ test 4: the rehearsal did not broadcast as $OTHER_ADDR (nonce $nonce)"; fail=$((fail + 1))
fi

cast rpc --rpc-url "$RPC" anvil_stopImpersonatingAccount "$OTHER_ADDR" >/dev/null
VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_ROOT="$ROOT_OK" DEPLOYER_ADDRESS=$OTHER_ADDR \
  probe "send()" --broadcast --unlocked --sender "$OTHER_ADDR"; RC=$?
if [[ $RC -ne 0 ]]; then
  echo "  ✓ the node refuses a sender it was not told to impersonate"; pass=$((pass + 1))
else
  echo "  ✗ the node accepted an unimpersonated sender"; fail=$((fail + 1))
fi

echo
echo "rehearsal seam: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
