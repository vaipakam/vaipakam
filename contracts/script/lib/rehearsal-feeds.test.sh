#!/usr/bin/env bash
# Cases for rh_feeds_restamp in lib/rehearsal-forks.sh (#3891, ruling on design
# open item 4). A plain local anvil stands for a fork; the feeds and the guard
# are the fakes in testdata/rehearsal-feed-fakes.sol.fixture, compiled with
# this tree's solc. Needs anvil, cast, jq, node and solc 0.8.29.
# Run: bash contracts/script/lib/rehearsal-feeds.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$HERE/../.." && pwd)"
# shellcheck source=rehearsal-forks.sh
source "$HERE/rehearsal-forks.sh"
WORK="$(mktemp -d)"
PORT="${RH_TEST_FEED_PORT:-18651}"
URL="http://127.0.0.1:$PORT"
pid=""
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
fails=0
ok() { echo "ok    $1"; }
bad() { fails=$((fails + 1)); echo "FAIL  $1"; }

SOLC=$(ls "$HOME"/.svm/0.8.29/solc-0.8.29 "$HOME"/.local/share/svm/0.8.29/solc-0.8.29 2>/dev/null | head -1)
[ -n "$SOLC" ] || { echo "skip: solc 0.8.29 not found"; exit 0; }
cp "$HERE/testdata/rehearsal-feed-fakes.sol.fixture" "$WORK/Fakes.sol"
cp "$CONTRACTS_DIR/script/rehearsal/RehearsalFeedStandIn.sol" "$WORK/StandIn.sol"
(cd "$WORK" && "$SOLC" --optimize --bin --bin-runtime -o out Fakes.sol StandIn.sol >/dev/null) || { echo "FAIL  the fakes do not compile"; exit 1; }
code() { printf '0x%s' "$(cat "$WORK/out/$1.$2")"; }
STANDIN=$(code RehearsalFeedStandIn bin-runtime)

anvil --port "$PORT" --chain-id 84532 --silent &
pid=$!
for _ in $(seq 50); do cast chain-id --rpc-url "$URL" >/dev/null 2>&1 && break; sleep 0.1; done
FROM=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
export DEPLOYER_ADDRESS="$FROM"
deploy() { # deploy NAME CTOR-SIG ARGS... — prints the address
  local name="$1" sig="$2"; shift 2
  local args=""
  [ -n "$sig" ] && args=$(cast abi-encode "$sig" "$@" | sed 's/^0x//')
  cast send --unlocked --from "$FROM" --rpc-url "$URL" --create "$(code "$name" bin)$args" --json | jq -r .contractAddress
}
T0=$(cast block latest --field timestamp --rpc-url "$URL")
REAL=$(deploy FakeRealFeed 'f(int256,uint256,uint80,uint8)' 200000000000 "$T0" 18446744073709551621 8)
REAL2=$(deploy FakeRealFeed 'f(int256,uint256,uint80,uint8)' 99990000 "$T0" 7 8)
MOCK=$(deploy MockChainlinkAggregator 'f(int256,uint256,uint8)' 100000000 "$T0" 8)
SEQ=$(deploy MockChainlinkAggregator 'f(int256,uint256,uint8)' 0 "$((T0 - 7200))" 0)
GUARD=$(deploy FakeGuard '')
send() { cast send --unlocked --from "$FROM" --rpc-url "$URL" "$@" >/dev/null; }
send "$GUARD" 'setSingle(uint8,address)' 2 "$REAL"
send "$GUARD" 'setSingle(uint8,address)' 5 "$SEQ"
send "$GUARD" 'setStable(bytes32,address)' 0x5553444300000000000000000000000000000000000000000000000000000000 "$MOCK"
send "$GUARD" 'setAssetDirect(address,address)' 0x00000000000000000000000000000000000000aa "$REAL2"

# A day passes: every feed is now stale to the guard.
rh_clock_set "$((T0 + 86400))" "$URL"
[ "$(cast call "$GUARD" 'readFeed(address,bool)(bool,uint256,uint8)' "$REAL" true --rpc-url "$URL" | head -1)" = false ] \
  && ok "after the clock step the feed reads as stale" || bad "the feed did not go stale"

LIST="FEED $REAL eth-numeraire
SKIP $SEQ sequencer-status
FEED $MOCK stable-ref-USDC"
seq_before=$(cast call "$SEQ" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$URL" | tr '\n' ' ')
OUT="$WORK/feeds.tsv"
if RH_FEED_LIST="$LIST" rh_feeds_restamp base-sepolia "$URL" "$GUARD" 0 "$STANDIN" "$OUT" 2>"$WORK/err"; then
  ok "the re-stamp passes"
else
  bad "the re-stamp failed: $(cat "$WORK/err")"
fi
NOW=$((T0 + 86400)) # the time the re-stamp read at its start
for f in "$REAL" "$MOCK" "$REAL2"; do
  [ "$(cast call "$GUARD" 'readFeed(address,bool)(bool,uint256,uint8)' "$f" true --rpc-url "$URL" | head -1)" = true ] \
    && ok "the guard reads $f again" || bad "the guard still refuses $f"
done
r=$(cast call "$REAL" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$URL" | cut -d' ' -f1 | tr '\n' ' ')
[ "$r" = "18446744073709551621 200000000000 $NOW $NOW 18446744073709551621 " ] \
  && ok "a real feed keeps its round and answer; only its time moved" || bad "real feed after: $r"
[ "$(cast call "$REAL" 'decimals()(uint8)' --rpc-url "$URL")" = 8 ] && ok "and its decimals" || bad "decimals moved"
grep -q "eth-numeraire	replaced	200000000000	$T0	$NOW" "$OUT" && ok "a real feed is reported as replaced, with times before and after" || bad "report: $(cat "$OUT")"
grep -q "stable-ref-USDC	mock-setter	" "$OUT" && ok "a repo mock is re-stamped through its setter" || bad "mock not reported"
grep -q "asset-direct-0x00000000000000000000000000000000000000aa	replaced" "$OUT" && ok "an asset direct feed is found from the guard's events" || bad "asset direct feed missed"
[ "$(cast call "$SEQ" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url "$URL" | tr '\n' ' ')" = "$seq_before" ] \
  && ok "the sequencer status feed is left alone" || bad "the sequencer feed was touched"
grep -q "$SEQ" "$OUT" && bad "the sequencer feed is in the report" || ok "and is not reported as re-stamped"

# A second clock step: a feed already replaced gets only its time written.
rh_clock_set "$(( $(cast block latest --field timestamp --rpc-url "$URL") + 86400 ))" "$URL"
: > "$OUT"
RH_FEED_LIST="FEED $REAL eth-numeraire" rh_feeds_restamp base-sepolia "$URL" "$GUARD" 0 "$STANDIN" "$OUT" 2>"$WORK/err" \
  && grep -q "eth-numeraire	stand-in	" "$OUT" && ok "a second step re-stamps the stand-in" || bad "second step: $(cat "$WORK/err") $(cat "$OUT")"

# What cannot be re-stamped fails by name.
RH_FEED_LIST="UNCOVERED pyth-cross-check (signed updates carry their own publish time)" \
  rh_feeds_restamp base-sepolia "$URL" "$GUARD" 0 "$STANDIN" "$OUT" 2>"$WORK/err" \
  && bad "an uncovered source passed" || { grep -q "cannot re-stamp pyth-cross-check" "$WORK/err" && ok "a Pyth source fails the step by name" || bad "uncovered message: $(cat "$WORK/err")"; }
NOTAFEED=$(deploy MockChainlinkAggregator 'f(int256,uint256,uint8)' 1 "$T0" 8)
cast rpc --rpc-url "$URL" anvil_setCode "$NOTAFEED" 0x00 >/dev/null
RH_FEED_LIST="FEED $NOTAFEED broken" rh_feeds_restamp base-sepolia "$URL" "$GUARD" 0 "$STANDIN" "$OUT" 2>"$WORK/err" \
  && bad "a feed that does not answer passed" || { grep -q "$NOTAFEED (broken)" "$WORK/err" && ok "a feed that does not answer fails by name" || bad "message: $(cat "$WORK/err")"; }

# The list script itself, when this tree's build has it.
if [ -f "$CONTRACTS_DIR/out/ListPriceFeeds.s.sol/ListPriceFeeds.json" ]; then
  listed=$(cd "$CONTRACTS_DIR" && FOUNDRY_NO_STORAGE_CACHING=true forge script script/rehearsal/ListPriceFeeds.s.sol --sig 'list(address)' "$GUARD" --rpc-url "$URL" 2>&1)
  grep -q "FEED $REAL eth-numeraire" <<<"$listed" && grep -q "SKIP $SEQ sequencer-status" <<<"$listed" && grep -q "FEED $MOCK stable-ref-USDC" <<<"$listed" \
    && ok "the list script reads every source from the guard" || bad "list script: $listed"
  send "$GUARD" 'setPyth(address)' "$MOCK"
  listed=$(cd "$CONTRACTS_DIR" && FOUNDRY_NO_STORAGE_CACHING=true forge script script/rehearsal/ListPriceFeeds.s.sol --sig 'list(address)' "$GUARD" --rpc-url "$URL" 2>&1)
  grep -q "UNCOVERED pyth-cross-check" <<<"$listed" && ok "the list script names a Pyth source as uncovered" || bad "no pyth line: $listed"
else
  echo "skip  the list script is not built (forge build --skip test)"
fi

echo
if [ "$fails" -gt 0 ]; then echo "$fails feed case(s) failed." >&2; exit 1; fi
echo "All feed re-stamp cases pass."
