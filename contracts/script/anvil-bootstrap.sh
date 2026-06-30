#!/usr/bin/env bash
#
# anvil-bootstrap.sh — local Anvil playground for Range Orders Phase 1.
#
# Brings up a self-contained anvil node + full Diamond + mock liquidity +
# master kill-switch flags ON + one matchable lender/borrower offer pair,
# so the keeper-bot's `offerMatcher` detector has something to match
# against without burning testnet faucet drips.
#
# Prereqs:
#   - foundry (forge + anvil) installed
#   - the keeper-bot sibling repo at ../../vaipakam-keeper-bot
#
# Usage:
#   bash contracts/script/anvil-bootstrap.sh
#
#   # In a separate terminal, run the bot:
#   cd ../../vaipakam-keeper-bot
#   cp .env.example .env   # if you don't already have one
#   # set CHAIN_IDS=31337 + CHAIN_31337_DIAMOND + CHAIN_31337_RPC_URL etc.
#   npm start
#
# What it does NOT do:
#   - Doesn't start anvil for you. Anvil must already be running on
#     localhost:8545 with chain-id 31337. For interactive UI testing run
#     `anvil --chain-id 31337 --block-time 1` in a separate terminal — the
#     interval mining keeps the head advancing so offers/loans you create
#     from the dapp clear the frontend's safe-block buffer and show up.
#     (Plain `anvil --chain-id 31337` works too; this script mines a buffer
#     after seeding, but a frozen head hides anything you create afterward.)
#   - Doesn't run the bot. The bot lives in the sibling repo and is
#     started independently so you can iterate on it without
#     re-bootstrapping the chain.
#
# Re-running:
#   - DeployDiamond is NOT idempotent — re-running deploys a NEW
#     diamond. Restart anvil between runs (Ctrl+C, then re-launch
#     with --chain-id 31337) for a fresh playground.
#   - SeedAnvilOffers IS append-only — re-running creates additional
#     offer pairs without touching existing state. Useful for testing
#     the bot's bucket logic with multiple matchable pairs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$CONTRACTS_DIR"

RPC="${ANVIL_RPC_URL:-http://localhost:8545}"

# Anvil's standard prefunded keys (Foundry's default mnemonic).
# Public knowledge — never use these on a real network.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # account #0
ADMIN_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"     # account #1
TREASURY_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"                           # account #2

# Verify anvil is reachable on the configured RPC. A clear early
# error beats a 60-second forge timeout when the operator forgot
# to start anvil.
if ! curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' \
       "$RPC" >/dev/null 2>&1; then
  echo "Error: cannot reach anvil at $RPC" >&2
  echo "Start it in a separate terminal with: anvil --chain-id 31337" >&2
  exit 1
fi

# Confirm chain-id 31337 — refuse to bootstrap a real network.
CHAIN_ID_HEX=$(curl -s -X POST -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" \
       | sed -E 's/.*"result":"([^"]+)".*/\1/')
if [ "$CHAIN_ID_HEX" != "0x7a69" ]; then
  echo "Error: RPC at $RPC reported chainId=$CHAIN_ID_HEX, expected 0x7a69 (31337)" >&2
  echo "Restart anvil with: anvil --chain-id 31337" >&2
  exit 1
fi

ADMIN_ADDR=$(cast wallet address --private-key "$ADMIN_KEY")

echo "=== anvil-bootstrap ==="
echo "RPC:       $RPC"
echo "Deployer:  $(cast wallet address --private-key "$DEPLOYER_KEY")"
echo "Admin:     $ADMIN_ADDR"
echo "Treasury:  $TREASURY_ADDR"
echo

export DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY"
export ADMIN_PRIVATE_KEY="$ADMIN_KEY"
export ADMIN_ADDRESS="$ADMIN_ADDR"
export TREASURY_ADDRESS="$TREASURY_ADDR"

echo "[1/6] DeployDiamond"
forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow

# Stamp the REAL diamond-creation block into addresses.json.
#
# `forge script` evaluates the script body (including
# `Deployments.writeDeployBlock()` → `block.number`) during the SIMULATION
# pass, which runs against the chain head BEFORE the collected txs are
# broadcast. On a freshly-started anvil that head is block 0, so deployBlock is
# recorded as 0 even though the Diamond proxy is actually created dozens of
# blocks later once the broadcast lands. The frontend's logIndex scanner treats
# `deployBlock <= 0` as "chain config unresolved" and SKIPS the event scan
# entirely (a guard meant to avoid genesis-scanning a real chain), so the dapp
# shows an empty Dashboard / Offer Book even though offers + loans exist
# on-chain. Read the Diamond's creation block back out of the broadcast receipt
# and overwrite deployBlock so the scan runs from the right height. (Live
# testnet/mainnet deploys don't hit this — there the simulation head is a real
# recent block, a harmless few blocks before creation.)
DIAMOND_ADDR=$(jq -r '.diamond // empty' deployments/anvil/addresses.json 2>/dev/null || echo "")
DEPLOY_BLOCK=$(python3 - "$DIAMOND_ADDR" <<'PY'
import json, sys
diamond = (sys.argv[1] or "").lower()
try:
    d = json.load(open("broadcast/DeployDiamond.s.sol/31337/run-latest.json"))
except Exception:
    print(0); sys.exit(0)
blk = None
for r in d.get("receipts", []):
    if (r.get("contractAddress") or "").lower() == diamond:
        blk = int(r["blockNumber"], 16); break
if blk is None and d.get("receipts"):
    # Fall back to the first deploy tx's block — still a safe lower bound.
    blk = min(int(r["blockNumber"], 16) for r in d["receipts"])
print(blk or 0)
PY
)
if [ "${DEPLOY_BLOCK:-0}" -gt 0 ]; then
  tmp=$(mktemp)
  jq --argjson b "$DEPLOY_BLOCK" '.deployBlock = $b' deployments/anvil/addresses.json > "$tmp" \
    && mv "$tmp" deployments/anvil/addresses.json
  echo "    deployBlock stamped from broadcast receipt: $DEPLOY_BLOCK"
else
  echo "    WARN: could not resolve Diamond creation block — frontend may skip the logIndex scan" >&2
fi

echo "[2/6] DeployTestnetLiquidityMocks (mUSDC, mWBTC, mock WETH, oracles, Univ3)"
forge script script/DeployTestnetLiquidityMocks.s.sol --rpc-url "$RPC" --broadcast --slow

# Etch Multicall3 at the canonical address. The frontend's
# `lib/multicall.ts` calls `aggregate3` at
# 0xcA11bde05977b3631167028862bE2a173976CA11, which is empty on a
# fresh anvil node — every dashboard read using batched multicall
# (useUserLoans, useTVL, useRecentOffers, etc.) reverts with
# "aggregate3 returned no data" until something is at that address.
# Deploy a fresh stub via `forge create`, then copy its runtime
# bytecode to the canonical address via `anvil_setCode`. Idempotent —
# safe to re-run.
echo "[3/6] Etching Multicall3 at canonical address"
# `forge create --json` emits a pretty-printed multi-line JSON object.
# Pipe through `jq -r '.deployedTo'` directly — jq parses across
# newlines — rather than snipping with `tail -1` which would only
# capture the closing brace.
MULTICALL3_DEPLOYED=$(forge create --rpc-url "$RPC" \
  --private-key "$DEPLOYER_KEY" \
  --broadcast \
  test/mocks/Multicall3Mock.sol:Multicall3Mock \
  --json 2>/dev/null | jq -r '.deployedTo // empty')
if [ -z "$MULTICALL3_DEPLOYED" ] || [ "$MULTICALL3_DEPLOYED" = "null" ]; then
  echo "Error: failed to deploy Multicall3Mock — frontend dashboard reads will fail" >&2
  exit 1
fi
MULTICALL3_CODE=$(cast code "$MULTICALL3_DEPLOYED" --rpc-url "$RPC")
cast rpc anvil_setCode \
  "0xcA11bde05977b3631167028862bE2a173976CA11" \
  "$MULTICALL3_CODE" \
  --rpc-url "$RPC" >/dev/null
echo "    Multicall3 etched (mock at $MULTICALL3_DEPLOYED → canonical 0xcA11…cA11)"

echo "[4/6] BootstrapAnvil (flip Range Orders master flags ON)"
forge script script/BootstrapAnvil.s.sol --rpc-url "$RPC" --broadcast --slow

echo "[5/6] SeedAnvilOffers (one matchable lender + borrower pair)"
forge script script/SeedAnvilOffers.s.sol --rpc-url "$RPC" --broadcast --slow

# Advance the chain past the frontend's safe-block confirmation buffer.
#
# The dapp's logIndex scanner only indexes up to a "safe block" = head minus a
# reorg-confirmation depth (~32). On a live chain new blocks keep arriving so
# the safe block marches past freshly-created offers within seconds. A default
# anvil only mines on a transaction, so once bootstrap finishes the head FREEZES
# — and everything created in the final ~32 blocks (i.e. the seeded offers
# themselves) sits permanently in the unconfirmed tail, invisible in the Offer
# Book even though it's on-chain. Mine a buffer of empty blocks so the seeded
# state clears the safe-block threshold immediately.
#
# NOTE: this only fixes the SEEDED offers. For interactive testing (creating
# offers/loans from the UI), start anvil with interval mining so the head keeps
# advancing: `anvil --chain-id 31337 --block-time 1`. Otherwise each UI action
# lands at a frozen head and stays unconfirmed until you mine again.
echo "    mining 40 blocks so seeded offers clear the frontend safe-block buffer"
cast rpc anvil_mine 40 --rpc-url "$RPC" >/dev/null 2>&1 \
  || echo "    WARN: anvil_mine failed — seeded offers may stay below the safe block until more blocks are mined" >&2

# [6/6] Sync ABI bundles + consolidated deployments JSON to dependent
# repos so the frontend (apps/{defi,labs}) + Workers (apps/{keeper,
# indexer,agent}, all reading via @vaipakam/contracts) + the
# public reference keeper-bot pick up the freshly-deployed anvil
# diamond on next reload. All three exports are
# idempotent and fast (forge inspect reads cached artifacts; jq
# merges per-chain addresses.json into a single keyed object).
# The keeper-bot export is gated on the sibling repo being present
# so a contributor without that checkout still gets a clean run.
echo "[6/6] Sync frontend ABIs + consolidated deployments + (optional) keeper-bot ABIs"
bash "$SCRIPT_DIR/exportFrontendAbis.sh"
bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

KEEPER_BOT_DIR_DEFAULT="$CONTRACTS_DIR/../../vaipakam-keeper-bot"
if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
  bash "$SCRIPT_DIR/exportAbis.sh"
else
  echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
fi

echo
echo "=== Anvil playground ready ==="
DIAMOND=$(jq -r '.diamond // empty' deployments/anvil/addresses.json 2>/dev/null || echo "")
if [ -n "$DIAMOND" ]; then
  echo "Diamond:  $DIAMOND"
fi
echo
echo "Next: start the bot pointed at this diamond:"
echo "  cd ../../vaipakam-keeper-bot"
echo "  CHAIN_IDS=31337 \\"
echo "    CHAIN_31337_DIAMOND=$DIAMOND \\"
echo "    CHAIN_31337_RPC_URL=$RPC \\"
echo "    KEEPER_PRIVATE_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba \\"
echo "    LOG_LEVEL=debug \\"
echo "    npm start"
echo
echo "(KEEPER_PRIVATE_KEY above is anvil account #5 - edit to use a different prefunded key.)"
