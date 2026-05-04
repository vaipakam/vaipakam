#!/usr/bin/env bash
#
# deploy-chain.sh — testnet one-shot deployment.
#
# A single command that:
#   1. forge build
#   2. Deploys the Diamond on the selected chain
#   3. Deploys the Timelock
#   4. Deploys the VPFI lane (canonical on Base / Base Sepolia,
#      mirror on every other chain — branched on chain-slug)
#   5. Deploys the Reward OApp (also canonical-vs-mirror branched)
#   6. Syncs ABIs + consolidated deployments JSON to the frontend
#      and the hf-watcher (via the existing export scripts)
#   7. Builds the frontend and deploys to Cloudflare Workers
#      Static Assets via wrangler
#   8. Deploys the hf-watcher Cloudflare Worker via wrangler
#
# Scope: TESTNETS ONLY. Refuses any mainnet chain-slug. Mainnet is
# tiered via `deploy-mainnet.sh` so the operator sees + confirms each
# stage before any irreversible action.
#
# Out of scope (stays manual on every chain):
#   - Role rotation to governance multisig + timelock — multi-party
#     ceremony, can't safely live in a script. Run via the
#     DeploymentRunbook §6 once the contract deploy is green and the
#     deployer has finished the first-day config sweep.
#   - LayerZero peer wiring across chains — needs canonical AND
#     mirror deployed first; the 2-leg `setPeer` ceremony is in
#     `WireVPFIPeers.s.sol`. Run after `deploy-chain.sh` lands the
#     pair on both sides.
#   - LayerZero DVN policy — `ConfigureLZConfig.s.sol` carries DVN
#     addresses + thresholds that are operator-curated per chain.
#     Run separately (instructions in DeploymentRunbook).
#   - Wrangler secrets (`wrangler secret put TG_BOT_TOKEN` etc.) —
#     operator-specific, never in any repo.
#
# Usage:
#   bash contracts/script/deploy-chain.sh <chain-slug> [flags]
#
#   chain-slug:
#     anvil          — local dev (chainId 31337) — calls
#                      anvil-bootstrap.sh which is the more complete
#                      local flow (mocks + multicall etch + flag flips
#                      + seed offers).
#     base-sepolia   — canonical-VPFI testnet (84532)
#     sepolia        — mirror testnet (11155111)
#     arb-sepolia    — mirror testnet (421614)
#     op-sepolia     — mirror testnet (11155420)
#     bnb-testnet    — mirror testnet (97 — native-gas mode acceptable)
#     polygon-amoy   — mirror testnet (80002 — native-gas mode acceptable)
#
#   flags:
#     --skip-frontend  — don't build / wrangler-deploy the frontend
#     --skip-watcher   — don't wrangler-deploy the hf-watcher
#     --skip-cf        — alias for both --skip-frontend --skip-watcher
#     --skip-vpfi      — skip the VPFI lane + reward OApp (handy when
#                        re-running after a partial failure that already
#                        landed those)
#
# Pre-flight:
#   - `.env` populated (PRIVATE_KEY, ADMIN_PRIVATE_KEY, ADMIN_ADDRESS,
#     TREASURY_ADDRESS, VPFI_OWNER, VPFI_TREASURY, VPFI_INITIAL_MINTER,
#     <CHAIN>_RPC_URL for the target chain, and the LZ_ENDPOINT_*
#     entry for the target chain). The script `set -a` sources `.env`
#     before any forge call so per-chain env vars surface.
#   - Frontend + watcher: `npm install` already run inside each so
#     `wrangler` resolves locally (the script does NOT auto-install
#     to keep the deploy step deterministic).
#   - Wrangler authentication: `npx wrangler whoami` works without
#     prompting (i.e., the operator has logged in or set a token).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
WATCHER_DIR="$REPO_ROOT/ops/hf-watcher"

cd "$CONTRACTS_DIR"

# ── Args ──────────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  cat >&2 <<EOF
Usage: bash contracts/script/deploy-chain.sh <chain-slug> [flags]

Supported chain-slugs:
  anvil  base-sepolia  sepolia  arb-sepolia  op-sepolia  bnb-testnet  polygon-amoy

Flags:
  --skip-frontend  --skip-watcher  --skip-cf  --skip-vpfi

For mainnet, use deploy-mainnet.sh — refuses to land mainnet here.
EOF
  exit 1
fi

CHAIN_SLUG="$1"; shift

SKIP_FRONTEND=0
SKIP_WATCHER=0
SKIP_VPFI=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-watcher)  SKIP_WATCHER=1 ;;
    --skip-cf)       SKIP_FRONTEND=1; SKIP_WATCHER=1 ;;
    --skip-vpfi)     SKIP_VPFI=1 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# ── Chain registry ────────────────────────────────────────────────────
# Refuse mainnet here. Anvil delegates to the more complete bootstrap
# (which also etches Multicall3 + flips Range Orders flags + seeds
# offers — those steps are anvil-only and don't belong in a generic
# chain deploy).

case "$CHAIN_SLUG" in
  anvil)
    echo "anvil dev playground — delegating to anvil-bootstrap.sh"
    exec bash "$SCRIPT_DIR/anvil-bootstrap.sh"
    ;;
  base-sepolia)
    CHAIN_ID=84532;     RPC_VAR="BASE_SEPOLIA_RPC_URL"; IS_CANONICAL=1; LZ_EID=40245 ;;
  sepolia)
    CHAIN_ID=11155111;  RPC_VAR="SEPOLIA_RPC_URL";       IS_CANONICAL=0; LZ_EID=40161 ;;
  arb-sepolia)
    CHAIN_ID=421614;    RPC_VAR="ARB_SEPOLIA_RPC_URL";   IS_CANONICAL=0; LZ_EID=40231 ;;
  op-sepolia)
    CHAIN_ID=11155420;  RPC_VAR="OP_SEPOLIA_RPC_URL";    IS_CANONICAL=0; LZ_EID=40232 ;;
  bnb-testnet)
    CHAIN_ID=97;        RPC_VAR="BNB_TESTNET_RPC_URL";   IS_CANONICAL=0; LZ_EID=40102 ;;
  polygon-amoy)
    CHAIN_ID=80002;     RPC_VAR="POLYGON_AMOY_RPC_URL";  IS_CANONICAL=0; LZ_EID=40267 ;;
  base|ethereum|arbitrum|optimism|polygon-zkevm|bnb|polygon)
    cat >&2 <<EOF
Refusing to run mainnet chain '$CHAIN_SLUG' from deploy-chain.sh.
Use deploy-mainnet.sh — it gates each phase behind a confirm flag so
the operator sees what's about to land before it lands.
EOF
    exit 1
    ;;
  *)
    echo "Unknown chain-slug: $CHAIN_SLUG" >&2
    exit 1
    ;;
esac

# ── Load .env and resolve RPC ─────────────────────────────────────────

if [ -f "$CONTRACTS_DIR/.env" ]; then
  set -a; source "$CONTRACTS_DIR/.env"; set +a
else
  echo "Error: $CONTRACTS_DIR/.env not found." >&2
  echo "Copy .env.example → .env and populate the keys for $CHAIN_SLUG." >&2
  exit 1
fi

RPC="${!RPC_VAR:-}"
if [ -z "$RPC" ]; then
  echo "Error: \$$RPC_VAR not set in .env." >&2
  exit 1
fi

# Confirm RPC actually points at the expected chain. Catches the
# common cut-and-paste error where SEPOLIA_RPC_URL got pasted into
# BASE_SEPOLIA_RPC_URL slot — running a $84532-aware Diamond against
# Sepolia would burn faucet ETH on a confused chain.
RESPONSE_CHAIN_HEX=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" \
  | sed -E 's/.*"result":"([^"]+)".*/\1/' || true)
RESPONSE_CHAIN_DEC=$(printf "%d\n" "$RESPONSE_CHAIN_HEX" 2>/dev/null || echo 0)
if [ "$RESPONSE_CHAIN_DEC" != "$CHAIN_ID" ]; then
  cat >&2 <<EOF
Error: $RPC_VAR points at chainId=$RESPONSE_CHAIN_DEC, expected $CHAIN_ID for '$CHAIN_SLUG'.
Check the RPC URL in .env.
EOF
  exit 1
fi

# Required env vars for every chain.
for v in PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
         VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER \
         TIMELOCK_PROPOSER; do
  if [ -z "${!v:-}" ]; then
    echo "Error: \$$v required in .env but not set." >&2
    exit 1
  fi
done

echo "═══════════════════════════════════════════════════════════════"
echo "deploy-chain.sh"
echo "  chain-slug:    $CHAIN_SLUG"
echo "  chain-id:      $CHAIN_ID"
echo "  lz-eid:        $LZ_EID"
if [ "$IS_CANONICAL" = "1" ]; then
  echo "  vpfi lane:     CANONICAL  (DeployVPFICanonical + DeployVPFIBuyReceiver)"
else
  echo "  vpfi lane:     MIRROR     (DeployVPFIMirror + DeployVPFIBuyAdapter)"
fi
echo "  rpc:           $RPC"
echo "  skip-vpfi:     $SKIP_VPFI"
echo "  skip-frontend: $SKIP_FRONTEND"
echo "  skip-watcher:  $SKIP_WATCHER"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── 1. Build ──────────────────────────────────────────────────────────

echo "[1] forge build"
forge build

# ── 2. Diamond ────────────────────────────────────────────────────────

echo
echo "[2] DeployDiamond.s.sol"
forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow

# ── 3. Timelock ───────────────────────────────────────────────────────

echo
echo "[3] DeployTimelock.s.sol"
forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow

# ── 4. VPFI lane (canonical vs mirror) ────────────────────────────────

if [ "$SKIP_VPFI" = "0" ]; then
  if [ "$IS_CANONICAL" = "1" ]; then
    echo
    echo "[4a] DeployVPFICanonical.s.sol  (canonical lane — OFTAdapter + token)"
    forge script script/DeployVPFICanonical.s.sol --rpc-url "$RPC" --broadcast --slow

    echo
    echo "[4b] DeployVPFIBuyReceiver.s.sol  (canonical lane — buy receiver on Base)"
    forge script script/DeployVPFIBuyReceiver.s.sol --rpc-url "$RPC" --broadcast --slow
  else
    echo
    echo "[4a] DeployVPFIMirror.s.sol  (mirror lane — mirror OFT)"
    forge script script/DeployVPFIMirror.s.sol --rpc-url "$RPC" --broadcast --slow

    echo
    echo "[4b] DeployVPFIBuyAdapter.s.sol  (mirror lane — buy adapter)"
    forge script script/DeployVPFIBuyAdapter.s.sol --rpc-url "$RPC" --broadcast --slow
  fi

  # Reward OApp — canonical-vs-mirror branched the same way.
  echo
  echo "[5] DeployRewardOAppCreate2.s.sol"
  if [ "$IS_CANONICAL" = "1" ]; then
    export IS_CANONICAL_REWARD=true
  else
    export IS_CANONICAL_REWARD=false
  fi
  forge script script/DeployRewardOAppCreate2.s.sol --rpc-url "$RPC" --broadcast --slow
else
  echo
  echo "[4-5] Skipping VPFI lane + Reward OApp (--skip-vpfi)"
fi

# ── 6. Sync ABIs + consolidated deployments JSON ──────────────────────

echo
echo "[6] Sync ABIs + consolidated deployments JSON"
bash "$SCRIPT_DIR/exportFrontendAbis.sh"
bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
  bash "$SCRIPT_DIR/exportAbis.sh"
else
  echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
fi

# ── 7. Frontend Cloudflare deploy ─────────────────────────────────────

if [ "$SKIP_FRONTEND" = "0" ]; then
  echo
  echo "[7] Frontend build + Cloudflare Workers Static Assets deploy"
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "Error: $FRONTEND_DIR/node_modules missing — run \`cd frontend && npm install\` first." >&2
    exit 1
  fi
  ( cd "$FRONTEND_DIR" && npm run build && npx wrangler deploy )
else
  echo
  echo "[7] Skipping frontend deploy (--skip-frontend)"
fi

# ── 8. hf-watcher Cloudflare deploy ───────────────────────────────────

if [ "$SKIP_WATCHER" = "0" ]; then
  echo
  echo "[8] hf-watcher Cloudflare Worker deploy"
  if [ ! -d "$WATCHER_DIR" ]; then
    echo "    (no $WATCHER_DIR — skipping)"
  elif [ ! -d "$WATCHER_DIR/node_modules" ]; then
    echo "Error: $WATCHER_DIR/node_modules missing — run \`cd ops/hf-watcher && npm install\` first." >&2
    exit 1
  else
    ( cd "$WATCHER_DIR" && npx wrangler deploy )
  fi
else
  echo
  echo "[8] Skipping watcher deploy (--skip-watcher)"
fi

# ── Summary ───────────────────────────────────────────────────────────

DIAMOND=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")

echo
echo "═══════════════════════════════════════════════════════════════"
echo "deploy-chain.sh — ✓ done"
echo "  chain-slug:    $CHAIN_SLUG ($CHAIN_ID)"
if [ -n "$DIAMOND" ]; then
  echo "  diamond:       $DIAMOND"
fi
echo "  artifact:      contracts/deployments/$CHAIN_SLUG/addresses.json"
echo
echo "Follow-up steps NOT in this script:"
echo "  1. Configure LZ DVN policy:  forge script script/ConfigureLZConfig.s.sol --rpc-url \$$RPC_VAR --broadcast"
echo "     (sets the 3-required + 2-optional DVN set + confirmations per the project policy)"
echo "  2. LZ peer wiring across chains:  forge script script/WireVPFIPeers.s.sol ..."
echo "     (run after both legs of every cross-chain pair are deployed)"
echo "  3. Role rotation to governance + timelock — DeploymentRunbook §6"
echo "═══════════════════════════════════════════════════════════════"
