#!/usr/bin/env bash
# FIRST statement, before ANY assignment: the baseline `load_env_file`
# compares each `.env` name against (#1932 / #1938 — `.env` is read as data,
# never sourced).
__lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
# rehearse-reprice-anvil.sh — dress rehearsal of RepriceTestnetMock.s.sol on
# an Anvil fork of Base Sepolia, before anyone runs it against the testnet
# itself (#2314).
#
# What it proves, against the LIVE testnet state (forked, never written):
#   1. The #2314 shape: a FEED-ONLY move of tLIQ past the TWAP-consistency
#      band reads Illiquid, and restoring the feed restores Liquid.
#   2. The script, broadcast as the real mock owner (impersonated), moves the
#      feed, the pool spot and the venue together, and tLIQ stays Liquid at
#      a -20% and a -55% step, with the Diamond reading each new price.
#   3. The script refuses, sending nothing, for a non-owner broadcaster and
#      for an asset name outside the two faucet liquid tokens.
#
# Usage (from contracts/):
#   bash script/rehearse-reprice-anvil.sh
#
# Needs BASE_SEPOLIA_RPC_URL — taken from the environment, else read from
# contracts/.env as data (lib/load-env.sh; the file is never sourced). It is
# never printed: Anvil echoes its fork URL on start-up, so Anvil's own output
# goes to /dev/null, not to a log.
#
# Writes nothing outside the fork. The fork is discarded on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

for tool in forge anvil cast jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "rehearse-reprice-anvil: '$tool' is not on PATH (needs forge, anvil, cast and jq)" >&2
    exit 2
  }
done

# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
if [[ -z "${BASE_SEPOLIA_RPC_URL:-}" && -f .env ]]; then
  load_env_file .env || { echo "rehearse-reprice-anvil: could not read contracts/.env" >&2; exit 2; }
fi
if [[ -z "${BASE_SEPOLIA_RPC_URL:-}" ]]; then
  echo "rehearse-reprice-anvil: BASE_SEPOLIA_RPC_URL is not set (env or contracts/.env)" >&2
  exit 2
fi

PORT="${REHEARSE_ANVIL_PORT:-8547}"
RPC="http://127.0.0.1:${PORT}"
ART="deployments/base-sepolia/addresses.json"

# The port must be FREE: if another node already answers on it, the launch
# below fails while the readiness loop happily connects to that node, and the
# rehearsal would then impersonate and write to it.
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "rehearse-reprice-anvil: something already answers on port $PORT; set REHEARSE_ANVIL_PORT" >&2
  exit 2
fi
# --chain-id is explicit: Anvil's own default is 31337, and whether a fork
# inherits the forked chain's id has varied across Anvil versions.
anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532 --port "$PORT" --silent >/dev/null 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
# And the node that answered must be the one this script started.
kill -0 "$ANVIL_PID" 2>/dev/null || { echo "rehearse-reprice-anvil: anvil exited on start" >&2; exit 1; }
CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
[[ "$CHAIN_ID" == "84532" ]] || { echo "fork reports chain id $CHAIN_ID, expected 84532" >&2; exit 1; }

DIAMOND="$(jq -r .diamond "$ART")"
TLIQ="$(jq -r .testnetMocks.liquidToken "$ART")"
FEED="$(jq -r .testnetMocks.liquidTokenUsdFeed "$ART")"
POOL="$(jq -r .testnetMocks.liquidTokenWethPool "$ART")"
VENUE="$(jq -r .testnetMocks.mockSwapAdapter "$ART")"
OWNER="$(cast call "$POOL" "owner()(address)" --rpc-url "$RPC")"

PASS=0
FAIL=0
check() { # check <label> <actual> <expected>
  if [[ "$2" == "$3" ]]; then
    echo "  PASS  $1 ($2)"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1: got $2, expected $3"; FAIL=$((FAIL + 1))
  fi
}
liquidity() { cast call "$DIAMOND" "checkLiquidity(address)(uint8)" "$TLIQ" --rpc-url "$RPC"; }
oracle_price() { cast call "$DIAMOND" "getAssetPrice(address)(uint256,uint8)" "$TLIQ" --rpc-url "$RPC" | head -1 | awk '{print $1}'; }
venue_price() { cast call "$VENUE" "tokenUsdPrice8(address)(uint256)" "$TLIQ" --rpc-url "$RPC" | awk '{print $1}'; }
feed_price() { cast call "$FEED" "price()(int256)" --rpc-url "$RPC" | awk '{print $1}'; }

impersonate() {
  cast rpc anvil_impersonateAccount "$1" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$1" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
}

reprice() { # reprice <asset-key> <price-e8> <sender> — returns forge's exit code
  # MOCK_OWNER_PRIVATE_KEY=0 is pinned on the command line, because a value
  # already in the environment wins over the `.env` Forge loads by itself
  # (unsetting would not be enough): the script then broadcasts as --sender,
  # so the owner/stranger identities below are the ones actually tested.
  MOCK_OWNER_PRIVATE_KEY=0 REPRICE_ASSET="$1" REPRICE_USD_E8="$2" \
    forge script script/RepriceTestnetMock.s.sol \
      --rpc-url "$RPC" --broadcast --slow --unlocked --sender "$3" >"$LOG_DIR/reprice-$1-$2.log" 2>&1
}

LOG_DIR="$(mktemp -d)"
echo "Fork of Base Sepolia at block $(cast block-number --rpc-url "$RPC"); forge logs in $LOG_DIR"
echo "tLIQ $TLIQ  mock owner $OWNER"

SEED_PRICE="$(feed_price)"
# The contrast move is RELATIVE to whatever the fork starts at — an earlier
# rehearsal may have left the live price anywhere, so a hard-coded target
# could land inside the TWAP-consistency band (3% by default) and never show
# the #2314 shape. -20% of the current price is far past the default band; a
# band raised past 20% would make check [1] fail loudly, not pass silently.
FEED_ONLY_PRICE=$(( SEED_PRICE * 80 / 100 ))
echo "[0] baseline"
check "tLIQ reads Liquid at the fork's current price (e8 $SEED_PRICE)" "$(liquidity)" "0"

echo "[1] feed-only move (the #2314 shape)"
impersonate "$OWNER"
cast send "$FEED" "setPrice(int256)" "$FEED_ONLY_PRICE" --unlocked --from "$OWNER" --rpc-url "$RPC" >/dev/null
check "feed-only -20% (e8 $SEED_PRICE -> $FEED_ONLY_PRICE) reads Illiquid" "$(liquidity)" "1"
cast send "$FEED" "setPrice(int256)" "$SEED_PRICE" --unlocked --from "$OWNER" --rpc-url "$RPC" >/dev/null
check "restoring the feed restores Liquid" "$(liquidity)" "0"

echo "[2] RepriceTestnetMock as the mock owner"
for P in 160000000000 90000000000; do
  if reprice liquidToken "$P" "$OWNER"; then
    check "script run at e8 $P" "ok" "ok"
  else
    check "script run at e8 $P" "exit $?" "ok"
  fi
  check "Liquid after a coherent reprice to e8 $P" "$(liquidity)" "0"
  check "the Diamond reads e8 $P" "$(oracle_price)" "$P"
  check "the venue pays e8 $P" "$(venue_price)" "$P"
  grep -q "^  Not checked: the venue's output-token float" "$LOG_DIR/reprice-liquidToken-$P.log" \
    && check "the run states what it does not check" "yes" "yes" \
    || check "the run states what it does not check" "no" "yes"
  grep -h "Venue report\|WARNING: venue\|WARNING: oracle" "$LOG_DIR/reprice-liquidToken-$P.log" | sed 's/^ */    info  /'
done

echo "[3] refusals send nothing"
BEFORE="$(feed_price)"
STRANGER="0x000000000000000000000000000000000000dEaD"
impersonate "$STRANGER"
if reprice liquidToken 120000000000 "$STRANGER"; then
  check "non-owner broadcaster refused" "ran" "refused"
else
  check "non-owner broadcaster refused" "refused" "refused"
  grep -q "broadcaster does not own the feed" "$LOG_DIR/reprice-liquidToken-120000000000.log" \
    && check "refusal names the feed owner" "yes" "yes" \
    || check "refusal names the feed owner" "no" "yes"
fi
if reprice mWeth 250000000000 "$OWNER"; then
  check "mWeth refused by name" "ran" "refused"
else
  check "mWeth refused by name" "refused" "refused"
fi
check "feed unchanged by the refused runs" "$(feed_price)" "$BEFORE"

echo
echo "rehearse-reprice-anvil: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
