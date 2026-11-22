#!/usr/bin/env bash
# Cases for lib/rehearsal-forks.sh (#3891, deploy rehearsal design §14, §20
# test 7). The "source chain" is a local anvil, so a fork is started from it
# with no network and no provider key.
# Run: bash contracts/script/lib/rehearsal-forks.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=rehearsal-forks.sh
source "$SCRIPT_DIR/lib/rehearsal-forks.sh"
WORK="$(mktemp -d)"
SRC_PORT="${RH_TEST_SRC_PORT:-18601}"
src_pid=""
cleanup() { rh_fork_stop_all; [ -n "$src_pid" ] && kill "$src_pid" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
fails=0
ok() { echo "ok    $1"; }
bad() { fails=$((fails + 1)); echo "FAIL  $1"; }

# ── test 7: the redactor ──
export BASE_SEPOLIA_RPC_URL="https://base-sepolia.g.example/v2/SECRETPROVIDERKEY"
export ARB_SEPOLIA_RPC_URL="https://arb.example/SECRETPROVIDERKEY"
export ADMIN_PRIVATE_KEY=0
out=$(printf 'forking %s at 123\nalso https://arb.example/SECRETPROVIDERKEY/x and 0\n' "$BASE_SEPOLIA_RPC_URL" | rh_redact)
if [[ "$out" == *'${BASE_SEPOLIA_RPC_URL}'* && "$out" == *'${ARB_SEPOLIA_RPC_URL}/x'* && "$out" != *SECRETPROVIDERKEY* ]]; then
  ok "test 7: an RPC value in a log line comes out as the variable's name"
else
  bad "test 7: the redactor left a value: $out"
fi
if [[ "$out" == *" and 0"* ]]; then ok "a pinned zero key does not blank the log"; else bad "short values were replaced: $out"; fi
unset BASE_SEPOLIA_RPC_URL ARB_SEPOLIA_RPC_URL
# With no secret in the environment (keys still only in .env) the line passes through.
out=$(timeout 10 env -i PATH="$PATH" bash -c "source '$HERE/rehearsal-forks.sh'; printf 'plain line\n' | rh_redact")
[ "$out" = "plain line" ] && ok "with no secrets set, the redactor passes the line through" || bad "no-secret redact: '$out'"

# ── the launcher, from a local source chain ──
anvil --port "$SRC_PORT" --chain-id 84532 --silent &
src_pid=$!
for _ in $(seq 50); do cast chain-id --rpc-url "http://127.0.0.1:$SRC_PORT" >/dev/null 2>&1 && break; sleep 0.1; done
cast rpc --rpc-url "http://127.0.0.1:$SRC_PORT" anvil_mine 0x20 >/dev/null
export TEST_SRC_RPC_URL="http://127.0.0.1:$SRC_PORT"
ROLE=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RH_SAFE_DEPTH=4
if rh_fork_start base-sepolia 84532 TEST_SRC_RPC_URL 18602 "$WORK/logs" "$ROLE"; then
  ok "a fork starts"
else
  bad "the fork did not start"
fi
URL="$RH_LAST_URL"
[ "$(cast chain-id --rpc-url "$URL")" = 84532 ] && ok "the fork keeps the real chain id" || bad "wrong chain id"
blk=$(cut -f3 "$WORK/logs/forks.tsv")
[ "$blk" = 28 ] && ok "the fork is a safe depth behind the head (32 - 4)" || bad "fork block $blk"
if rehearsal_node_has_marker "$URL"; then ok "the fork carries the local-node marker"; else bad "no marker"; fi
if ! rehearsal_node_has_marker "$TEST_SRC_RPC_URL"; then ok "the source chain does not"; else bad "marker on source"; fi
if cast send --unlocked --from "$ROLE" 0x000000000000000000000000000000000000BEEF --value 1 --rpc-url "$URL" >/dev/null 2>&1; then
  ok "a role address is impersonated"
else
  bad "the role address could not send"
fi
if ! cast send --unlocked --from 0x90F79bf6EB2c4f870365E785982E1f101E93b906 0x000000000000000000000000000000000000BEEF --value 1 --rpc-url "$URL" >/dev/null 2>&1; then
  ok "any other sender is refused"
else
  bad "an unimpersonated sender was accepted"
fi
if grep -q "$TEST_SRC_RPC_URL" "$WORK/logs/anvil-base-sepolia.log" 2>/dev/null; then
  bad "the source URL reached the fork's log"
else
  ok "the source URL does not reach the fork's log"
fi
if ! rh_fork_start base-sepolia 84532 TEST_SRC_RPC_URL 18602 "$WORK/logs" 2>/dev/null; then
  ok "a port that already answers is refused"
else
  bad "a busy port was accepted"
fi

# ── the clock, over two forks ──
rh_fork_start arb-sepolia 421614 TEST_SRC_RPC_URL 18603 "$WORK/logs" "$ROLE" || bad "second fork"
URL2="$RH_LAST_URL"
rh_clock_align "$URL" "$URL2" || bad "align"
t1=$(cast block latest --field timestamp --rpc-url "$URL"); t2=$(cast block latest --field timestamp --rpc-url "$URL2")
[ "$t1" = "$t2" ] && ok "aligned forks share one time" || bad "aligned $t1 vs $t2"
rh_clock_set $((t1 + 86400)) "$URL" "$URL2" || bad "clock step"
t1=$(cast block latest --field timestamp --rpc-url "$URL"); t2=$(cast block latest --field timestamp --rpc-url "$URL2")
[ "$t1" = "$t2" ] && ok "a clock step moves every fork to the same time" || bad "stepped $t1 vs $t2"
if ! rh_clock_set $((t1 - 10)) "$URL" "$URL2" 2>/dev/null; then ok "the clock refuses to move backwards"; else bad "moved backwards"; fi

rh_fork_stop_all
if ! cast chain-id --rpc-url "$URL" >/dev/null 2>&1; then ok "stopping ends every fork"; else bad "a fork outlived stop"; fi

echo
if [ "$fails" -gt 0 ]; then echo "$fails fork case(s) failed." >&2; exit 1; fi
echo "All fork cases pass."
