#!/usr/bin/env bash
# Cases for lib/rehearsal.sh (#3891, deploy rehearsal design §11-§13).
# Bash only: forge and cast are stubs on PATH that print their arguments, so
# no node, network or key is involved. Run: bash contracts/script/lib/rehearsal.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$SCRIPT_DIR/lib/rehearsal.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/contracts/cache"
echo '{}' > "$WORK/contracts/cache/solidity-files-cache.json"

# Stubs. `cast code` answers with whatever $STUB_MARKER_CODE holds; every other
# call prints its arguments with any 0x-prefixed 64-hex key masked.
cat > "$WORK/bin/forge" <<'S'
#!/usr/bin/env bash
echo "forge $*"
S
cat > "$WORK/bin/cast" <<'S'
#!/usr/bin/env bash
case "$1" in
  code) echo "${STUB_MARKER_CODE:-0x}" ;;
  wallet) echo 0x1111111111111111111111111111111111111111 ;;
  *) echo "cast $*" ;;
esac
S
chmod +x "$WORK/bin/forge" "$WORK/bin/cast"
export PATH="$WORK/bin:$PATH"

# shellcheck source=rehearsal.sh
source "$SCRIPT_DIR/lib/rehearsal.sh"
fails=0
ok() { echo "ok    $1"; }
bad() { fails=$((fails + 1)); echo "FAIL  $1"; }
expect_true() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
expect_false() { if eval "$2"; then bad "$1"; else ok "$1"; fi; }

# ── loopback ──
for u in http://127.0.0.1:8545 http://localhost:8545/ http://[::1]:8545 https://127.0.0.1 http://127.0.0.1:18545/rpc; do
  expect_true "loopback: $u" "rehearsal_is_loopback_url '$u'"
done
for u in http://10.0.0.1:8545 https://base-sepolia.example/v2/key http://127.0.0.1@evil.example:80 \
  http://127.0.0.1.evil.example http://localhost:8545x ws://127.0.0.1:8545 http://127.0.0.2:8545 ''; do
  expect_false "not loopback: ${u:-<empty>}" "rehearsal_is_loopback_url '$u'"
done

# ── scratch root ──
expect_true "root under the rehearsal prefix" "rehearsal_root_ok deployments/.forge-test/rehearsal/run-1"
for r in deployments/base-sepolia deployments/.forge-test/e2e deployments/.forge-test/rehearsal/ \
  deployments/.forge-test/rehearsal/../../base-sepolia /tmp/x ''; do
  expect_false "root refused: ${r:-<empty>}" "rehearsal_root_ok '$r'"
done

# ── prescan ──
REHEARSE=0; rehearsal_prescan base-sepolia --phase contracts
expect_true "prescan: no flag, real run" '[ "$REHEARSE" = 0 ]'
rehearsal_prescan base-sepolia --phase contracts --rehearse
expect_true "prescan: --rehearse sets the mode" '[ "$REHEARSE" = 1 ]'
expect_true "the loader leaves keys out in a rehearsal" '[ "$(rehearsal_env_load_flags)" = --drop-key-vars ]'
REHEARSE=0
expect_true "the loader loads everything in a real run" '[ -z "$(rehearsal_env_load_flags)" ]'

# ── real run: forge and cast pass through ──
out=$(forge script script/X.s.sol --rpc-url http://x --broadcast)
expect_true "real run: forge script is unchanged" '[ "$out" = "forge script script/X.s.sol --rpc-url http://x --broadcast" ]'
ADMIN_PRIVATE_KEY=0xabc out=$(ADMIN_PRIVATE_KEY=0xabc vk_cast_send ADMIN 0xdiamond "f()")
expect_true "real run: cast send signs with the role's key" '[[ "$out" == "cast send --private-key 0xabc 0xdiamond f()" ]]'
out=$(ADMIN_PRIVATE_KEY=0xabc ADMIN_ADDRESS=0x2222222222222222222222222222222222222222 vk_cast_send ADMIN 0xd "f()" 2>&1)
expect_true "real run: a key for another address is refused" '[[ "$out" == *"is not the address of ADMIN_PRIVATE_KEY"* && "$out" != *0xabc* ]]'
STUB_MARKER_CODE=$REHEARSAL_MARKER_CODE
export STUB_MARKER_CODE
expect_false "real run: a marker node is refused" "rehearsal_refuse_marker_node http://127.0.0.1:8545 2>/dev/null"
STUB_MARKER_CODE=0x
expect_true "real run: a node without the marker is accepted" "rehearsal_refuse_marker_node http://127.0.0.1:8545"

# ── entering the mode ──
enter() {
  ( REHEARSE=1; cd "$WORK"; rehearsal_enter "$1" "$WORK/contracts" "$WORK/.env" >/dev/null 2>&1 && echo entered )
}
printf 'DEPLOYER_PRIVATE_KEY=0xsecret\nexport OTHER_PRIVATE_KEY=0xsecret\nRPC=x\n' > "$WORK/.env"
export DEPLOYER_ADDRESS=0x3333333333333333333333333333333333333333 ADMIN_ADDRESS=0x4444444444444444444444444444444444444444
export VAIPAKAM_REHEARSAL_ROOT=deployments/.forge-test/rehearsal/t1
STUB_MARKER_CODE=0x
expect_true "test 1: a loopback node without the marker is refused" '[ -z "$(enter http://127.0.0.1:8545)" ]'
STUB_MARKER_CODE=$REHEARSAL_MARKER_CODE
expect_true "test 1: a marker but a non-loopback URL is refused" '[ -z "$(enter https://rpc.example/v2/k)" ]'
expect_true "loopback + marker + scratch root enters" '[ "$(enter http://127.0.0.1:8545)" = entered ]'
VAIPAKAM_REHEARSAL_ROOT=deployments/base-sepolia
expect_true "a root outside the scratch is refused" '[ -z "$(enter http://127.0.0.1:8545)" ]'
VAIPAKAM_REHEARSAL_ROOT=deployments/.forge-test/rehearsal/t1
expect_true "no DEPLOYER_ADDRESS is refused" '[ -z "$(DEPLOYER_ADDRESS= enter http://127.0.0.1:8545)" ]'

# Inside the mode: keys pinned, roots moved, forge and cast unlocked.
REHEARSE=1
DEPLOYER_PRIVATE_KEY=0xsecret
rehearsal_enter http://127.0.0.1:8545 "$WORK/contracts" "$WORK/.env" >/dev/null
expect_true "every key variable is pinned to zero" '[ "$DEPLOYER_PRIVATE_KEY" = 0 ] && [ "$OTHER_PRIVATE_KEY" = 0 ]'
expect_true "the flag is exported" '[ "$VAIPAKAM_REHEARSAL" = 1 ]'
expect_true "forge never reads a cached view of the real chain" '[ "$FOUNDRY_NO_STORAGE_CACHING" = true ]'
expect_true "records go to the scratch root" '[ "$RECORDS_ROOT" = "$WORK/contracts/deployments/.forge-test/rehearsal/t1" ]'
expect_true "forge broadcast and cache go to scratch" '[[ "$FOUNDRY_BROADCAST" == "$RECORDS_ROOT"/* && "$FOUNDRY_CACHE_PATH" == "$RECORDS_ROOT"/* ]]'
expect_true "the scratch cache is seeded from the real index" '[ -f "$FOUNDRY_CACHE_PATH/solidity-files-cache.json" ]'
out=$(forge script script/X.s.sol --rpc-url http://x --broadcast)
expect_true "rehearsal: a broadcasting script is unlocked as the deployer" '[ "$out" = "forge script script/X.s.sol --rpc-url http://x --broadcast --unlocked --sender $DEPLOYER_ADDRESS" ]'
out=$(forge script script/X.s.sol --sig "preflight()")
expect_true "rehearsal: a simulation is unchanged" '[ "$out" = "forge script script/X.s.sol --sig preflight()" ]'
out=$(vk_cast_send ADMIN 0xd "f()")
expect_true "rehearsal: cast send goes from the impersonated address, no key" '[ "$out" = "cast send --unlocked --from $ADMIN_ADDRESS 0xd f()" ]'
# shellcheck source=retired-deployment.sh
source "$SCRIPT_DIR/lib/retired-deployment.sh"
out=$(seed_retired_deployments_now "$WORK/no-repo")
expect_true "rehearsal: the real indexer database is never seeded" '[[ "$out" == *"not seeded"* ]]'

echo
if [ "$fails" -gt 0 ]; then echo "$fails rehearsal case(s) failed." >&2; exit 1; fi
echo "All rehearsal cases pass."
