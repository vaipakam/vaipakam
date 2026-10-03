#!/usr/bin/env bash
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
# Needs BASE_SEPOLIA_RPC_URL — taken from the environment, else from
# contracts/.env. It is never printed: Anvil echoes its fork URL on start-up,
# so Anvil's own output goes to /dev/null, not to a log.
#
# Writes nothing outside the fork. The fork is discarded on exit.
set -euo pipefail

cd "$(dirname "$0")/.."

for tool in forge anvil cast jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "rehearse-reprice-anvil: '$tool' is not on PATH (needs forge, anvil, cast and jq)" >&2
    exit 2
  }
done

if [[ -z "${BASE_SEPOLIA_RPC_URL:-}" && -f .env ]]; then
  # shellcheck disable=SC1091
  BASE_SEPOLIA_RPC_URL="$(set -a; . ./.env >/dev/null 2>&1; printf '%s' "${BASE_SEPOLIA_RPC_URL:-}")"
fi
if [[ -z "${BASE_SEPOLIA_RPC_URL:-}" ]]; then
  echo "rehearse-reprice-anvil: BASE_SEPOLIA_RPC_URL is not set (env or contracts/.env)" >&2
  exit 2
fi

PORT="${REHEARSE_ANVIL_PORT:-8547}"
RPC="http://127.0.0.1:${PORT}"
ART="deployments/base-sepolia/addresses.json"

anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --port "$PORT" --silent >/dev/null 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
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
  env -u MOCK_OWNER_PRIVATE_KEY REPRICE_ASSET="$1" REPRICE_USD_E8="$2" \
    forge script script/RepriceTestnetMock.s.sol \
      --rpc-url "$RPC" --broadcast --unlocked --sender "$3" >"$LOG_DIR/reprice-$1-$2.log" 2>&1
}

LOG_DIR="$(mktemp -d)"
echo "Fork of Base Sepolia at block $(cast block-number --rpc-url "$RPC"); forge logs in $LOG_DIR"
echo "tLIQ $TLIQ  mock owner $OWNER"

SEED_PRICE="$(feed_price)"
echo "[0] baseline"
check "tLIQ reads Liquid at the seeded price" "$(liquidity)" "0"

echo "[1] feed-only move (the #2314 shape)"
impersonate "$OWNER"
cast send "$FEED" "setPrice(int256)" 160000000000 --unlocked --from "$OWNER" --rpc-url "$RPC" >/dev/null
check "feed-only -20% reads Illiquid" "$(liquidity)" "1"
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
