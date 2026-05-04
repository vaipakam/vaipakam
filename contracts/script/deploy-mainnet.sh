#!/usr/bin/env bash
#
# deploy-mainnet.sh — mainnet tiered deploy.
#
# Mainnet routes real value. Every irreversible step is one phase
# behind a confirm gate. This script does NOT chain phases together;
# the operator runs each phase explicitly, eyeballs the diff, then
# moves to the next.
#
# Tiered flow:
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase preflight
#       Reads .env, verifies RPC chainId, balance, expected env vars.
#       Read-only — no broadcasts. Run before any other phase.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase contracts \
#                                           --confirm-i-have-multisig-ready
#       Deploys Diamond + Timelock + VPFI lane + Reward OApp.
#       The confirm flag is a deliberate friction — without it, the
#       script refuses. The flag asserts: governance multisig is
#       reachable for the role-rotation ceremony at the end of the
#       deploy day, and the operator has eyeballed the .env one more
#       time.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase lz-config \
#                                           --confirm-dvn-policy-reviewed
#       Runs ConfigureLZConfig.s.sol — the DVN set + confirmations
#       must already be set in .env (DVN_REQUIRED_1/2/3,
#       DVN_OPTIONAL_1/2, CONFIRMATIONS, REMOTE_EIDS, OAPP, SEND_LIB,
#       RECV_LIB). The confirm flag asserts the operator has reviewed
#       the policy against contracts/README.md "Cross-Chain Security"
#       (3-required + 2-optional, threshold 1-of-2, operator
#       diversity).
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase abi-sync
#       Runs the three export scripts. No on-chain effect — safe to
#       re-run. Usually run after `--phase contracts` lands.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-frontend
#       Builds the frontend and deploys to Cloudflare via wrangler.
#       Requires `frontend/node_modules` (operator runs npm install).
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-watcher
#       Deploys the hf-watcher Cloudflare Worker via wrangler.
#       Requires `ops/hf-watcher/node_modules`.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase verify
#       Read-only smoke checks against the deployed Diamond.
#
# What this script does NOT do (and never should):
#   - Role rotation to multisig + timelock — multi-party ceremony.
#     See DeploymentRunbook §6. The signers run grantRole +
#     renounceRole one at a time after this script lands `--phase
#     contracts`.
#   - LayerZero peer wiring across chains. Use WireVPFIPeers.s.sol
#     after every leg of the canonical-mirror pair has landed.
#   - `wrangler secret put` — operator-specific (TG_BOT_TOKEN,
#     RPC_*  with API keys, PUSH_CHANNEL_PK, aggregator keys, keeper
#     PK). The script doesn't know what they are; it would have no
#     way to authenticate them; and they MUST live outside the repo.
#   - Auto-promote across phases. Each phase is a deliberate operator
#     action.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
WATCHER_DIR="$REPO_ROOT/ops/hf-watcher"

cd "$CONTRACTS_DIR"

# ── Args ──────────────────────────────────────────────────────────────

if [ $# -lt 3 ]; then
  cat >&2 <<EOF
Usage:
  bash contracts/script/deploy-mainnet.sh <chain-slug> --phase <phase> [confirm-flags]

Mainnet chain-slugs:
  ethereum  base  arbitrum  optimism  polygon-zkevm  bnb  polygon

Phases:
  preflight       — Read-only, run first. No broadcasts.
  contracts       — Diamond + Timelock + VPFI lane + Reward OApp.
                    Requires --confirm-i-have-multisig-ready
  lz-config       — DVN policy via ConfigureLZConfig.s.sol.
                    Requires --confirm-dvn-policy-reviewed
  abi-sync        — Frontend + watcher + keeper-bot ABI/JSON sync.
  cf-frontend     — Build + wrangler deploy frontend.
  cf-watcher      — wrangler deploy watcher.
  verify          — Read-only smoke checks.

For testnets, use deploy-chain.sh — it auto-chains phases.
EOF
  exit 1
fi

CHAIN_SLUG="$1"; shift

PHASE=""
CONFIRM_MULTISIG=0
CONFIRM_DVN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      shift
      PHASE="$1"
      ;;
    --confirm-i-have-multisig-ready) CONFIRM_MULTISIG=1 ;;
    --confirm-dvn-policy-reviewed)   CONFIRM_DVN=1 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -z "$PHASE" ]; then
  echo "Error: --phase <phase> required" >&2
  exit 1
fi

# ── Mainnet chain registry ────────────────────────────────────────────
# WETH-pull mode is required on bnb / polygon (both have non-ETH-priced
# native gas). The DeployVPFIBuyAdapter pre-flight already enforces
# this via `_chainRequiresWethPaymentToken(chainId)`, so the script
# only needs to surface the env-var name the operator must populate
# before the contracts phase.

case "$CHAIN_SLUG" in
  ethereum)
    CHAIN_ID=1;       RPC_VAR="ETHEREUM_RPC_URL";      IS_CANONICAL=0; LZ_EID=30101; WETH_PULL_VAR="" ;;
  base)
    CHAIN_ID=8453;    RPC_VAR="BASE_RPC_URL";          IS_CANONICAL=1; LZ_EID=30184; WETH_PULL_VAR="" ;;
  arbitrum)
    CHAIN_ID=42161;   RPC_VAR="ARBITRUM_RPC_URL";      IS_CANONICAL=0; LZ_EID=30110; WETH_PULL_VAR="" ;;
  optimism)
    CHAIN_ID=10;      RPC_VAR="OPTIMISM_RPC_URL";      IS_CANONICAL=0; LZ_EID=30111; WETH_PULL_VAR="" ;;
  polygon-zkevm)
    CHAIN_ID=1101;    RPC_VAR="POLYGON_ZKEVM_RPC_URL"; IS_CANONICAL=0; LZ_EID=30158; WETH_PULL_VAR="" ;;
  bnb)
    CHAIN_ID=56;      RPC_VAR="BNB_RPC_URL";           IS_CANONICAL=0; LZ_EID=30102; WETH_PULL_VAR="BNB_VPFI_BUY_PAYMENT_TOKEN" ;;
  polygon)
    CHAIN_ID=137;     RPC_VAR="POLYGON_RPC_URL";       IS_CANONICAL=0; LZ_EID=30109; WETH_PULL_VAR="POLYGON_VPFI_BUY_PAYMENT_TOKEN" ;;
  anvil|sepolia|base-sepolia|arb-sepolia|op-sepolia|bnb-testnet|polygon-amoy)
    cat >&2 <<EOF
Refusing to run testnet chain '$CHAIN_SLUG' from deploy-mainnet.sh.
Use deploy-chain.sh — it's the testnet one-shot.
EOF
    exit 1
    ;;
  *)
    echo "Unknown chain-slug: $CHAIN_SLUG" >&2
    exit 1
    ;;
esac

# ── Load .env ─────────────────────────────────────────────────────────

if [ -f "$CONTRACTS_DIR/.env" ]; then
  set -a; source "$CONTRACTS_DIR/.env"; set +a
else
  echo "Error: $CONTRACTS_DIR/.env not found." >&2
  exit 1
fi

RPC="${!RPC_VAR:-}"
if [ -z "$RPC" ]; then
  echo "Error: \$$RPC_VAR not set in .env." >&2
  exit 1
fi

# ── Phase: preflight ──────────────────────────────────────────────────

phase_preflight() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — preflight  ($CHAIN_SLUG / $CHAIN_ID)"
  echo "═══════════════════════════════════════════════════════════════"

  # 1. RPC chainId
  RESPONSE_CHAIN_HEX=$(curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" \
    | sed -E 's/.*"result":"([^"]+)".*/\1/' || true)
  RESPONSE_CHAIN_DEC=$(printf "%d\n" "$RESPONSE_CHAIN_HEX" 2>/dev/null || echo 0)
  if [ "$RESPONSE_CHAIN_DEC" != "$CHAIN_ID" ]; then
    echo "FAIL: $RPC_VAR points at chainId=$RESPONSE_CHAIN_DEC, expected $CHAIN_ID."
    exit 1
  fi
  echo "  ✓ RPC chainId matches  ($CHAIN_ID)"

  # 2. Required env vars
  MISSING=()
  for v in PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
           VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER \
           TIMELOCK_PROPOSER; do
    if [ -z "${!v:-}" ]; then MISSING+=("$v"); fi
  done
  if [ -n "$WETH_PULL_VAR" ]; then
    if [ -z "${!WETH_PULL_VAR:-}" ]; then
      MISSING+=("$WETH_PULL_VAR  (REQUIRED on $CHAIN_SLUG — bridged WETH9 address)")
    fi
  fi
  if [ ${#MISSING[@]} -ne 0 ]; then
    echo "FAIL: required env vars missing in .env:"
    for v in "${MISSING[@]}"; do echo "    - $v"; done
    exit 1
  fi
  echo "  ✓ Required env vars present"

  # 3. Deployer balance
  DEPLOYER_ADDR=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || echo "?")
  BAL=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC" 2>/dev/null || echo "?")
  echo "  ✓ Deployer:  $DEPLOYER_ADDR    balance: $BAL wei"

  # 4. WETH-pull check (if applicable)
  if [ -n "$WETH_PULL_VAR" ]; then
    WETH_ADDR="${!WETH_PULL_VAR}"
    DECIMALS=$(cast call "$WETH_ADDR" "decimals()(uint8)" --rpc-url "$RPC" 2>/dev/null || echo "?")
    SYMBOL=$(cast call "$WETH_ADDR" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null || echo "?")
    echo "  ✓ $WETH_PULL_VAR = $WETH_ADDR  symbol=$SYMBOL decimals=$DECIMALS"
    echo "    ⚠ Eyeball-confirm against the chain's official bridged-WETH9 registry"
    echo "      before --phase contracts. CLAUDE.md lists the canonical addresses."
  fi

  echo
  echo "preflight OK. Next: --phase contracts --confirm-i-have-multisig-ready"
}

# ── Phase: contracts ──────────────────────────────────────────────────

phase_contracts() {
  if [ "$CONFIRM_MULTISIG" != "1" ]; then
    cat >&2 <<EOF
Refusing --phase contracts on mainnet without --confirm-i-have-multisig-ready.

This phase deploys Diamond + Timelock + VPFI lane + Reward OApp on $CHAIN_SLUG.
Once landed, the role-rotation ceremony (DeploymentRunbook §6) must run on
the same day to renounce DEPLOYER_ROLE / DEFAULT_ADMIN_ROLE / etc.

Re-run with the flag once the multisig signers are reachable.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — contracts  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"

  echo "[1] forge build"
  forge build

  echo
  echo "[2] DeployDiamond.s.sol"
  forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow

  echo
  echo "[3] DeployTimelock.s.sol"
  forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow

  if [ "$IS_CANONICAL" = "1" ]; then
    echo
    echo "[4a] DeployVPFICanonical.s.sol"
    forge script script/DeployVPFICanonical.s.sol --rpc-url "$RPC" --broadcast --slow

    echo
    echo "[4b] DeployVPFIBuyReceiver.s.sol"
    forge script script/DeployVPFIBuyReceiver.s.sol --rpc-url "$RPC" --broadcast --slow

    export IS_CANONICAL_REWARD=true
  else
    echo
    echo "[4a] DeployVPFIMirror.s.sol"
    forge script script/DeployVPFIMirror.s.sol --rpc-url "$RPC" --broadcast --slow

    echo
    echo "[4b] DeployVPFIBuyAdapter.s.sol  (T-036 WETH-pull pre-flight enforced)"
    forge script script/DeployVPFIBuyAdapter.s.sol --rpc-url "$RPC" --broadcast --slow

    export IS_CANONICAL_REWARD=false
  fi

  echo
  echo "[5] DeployRewardOAppCreate2.s.sol"
  forge script script/DeployRewardOAppCreate2.s.sol --rpc-url "$RPC" --broadcast --slow

  echo
  echo "✓ contracts phase done."
  echo "Next:"
  echo "  1. --phase abi-sync   (sync the freshly-written addresses.json)"
  echo "  2. --phase lz-config --confirm-dvn-policy-reviewed   (DVN set)"
  echo "  3. WireVPFIPeers.s.sol on each (canonical, mirror) pair"
  echo "  4. Role rotation ceremony per DeploymentRunbook §6"
}

# ── Phase: lz-config ──────────────────────────────────────────────────

phase_lz_config() {
  if [ "$CONFIRM_DVN" != "1" ]; then
    cat >&2 <<EOF
Refusing --phase lz-config without --confirm-dvn-policy-reviewed.

Project policy (contracts/README.md "Cross-Chain Security"):
  - 3 required DVNs + 2 optional, threshold 1-of-2.
  - Required: LayerZero Labs + Google Cloud + (Polyhedra OR Nethermind).
  - Optional: BWare Labs + (Stargate OR Horizen).
  - Operator diversity is load-bearing — different corporate operators.

This phase calls ConfigureLZConfig.s.sol which reads:
  DVN_REQUIRED_1, DVN_REQUIRED_2, DVN_REQUIRED_3,
  DVN_OPTIONAL_1, DVN_OPTIONAL_2, CONFIRMATIONS,
  OAPP, SEND_LIB, RECV_LIB, REMOTE_EIDS  (all from .env).

Eyeball every address against the LZ + DVN-operator docs, then
re-run with --confirm-dvn-policy-reviewed.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — lz-config  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"
  forge script script/ConfigureLZConfig.s.sol --rpc-url "$RPC" --broadcast --slow
}

# ── Phase: abi-sync ───────────────────────────────────────────────────

phase_abi_sync() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — abi-sync"
  echo "═══════════════════════════════════════════════════════════════"
  bash "$SCRIPT_DIR/exportFrontendAbis.sh"
  bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

  KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    bash "$SCRIPT_DIR/exportAbis.sh"
  else
    echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
  fi

  echo
  echo "Review and commit:"
  echo "  git diff frontend/src/contracts/abis/ frontend/src/contracts/deployments.json"
  echo "  git diff ops/hf-watcher/src/deployments.json"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    echo "  cd $KEEPER_BOT_DIR_DEFAULT && git diff src/abis/"
  fi
}

# ── Phase: cf-frontend ────────────────────────────────────────────────

phase_cf_frontend() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "Error: $FRONTEND_DIR/node_modules missing — run \`cd frontend && npm install\` first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-frontend"
  echo "═══════════════════════════════════════════════════════════════"
  ( cd "$FRONTEND_DIR" && npm run build && npx wrangler deploy )
}

# ── Phase: cf-watcher ─────────────────────────────────────────────────

phase_cf_watcher() {
  if [ ! -d "$WATCHER_DIR" ]; then
    echo "Error: $WATCHER_DIR not present." >&2
    exit 1
  fi
  if [ ! -d "$WATCHER_DIR/node_modules" ]; then
    echo "Error: $WATCHER_DIR/node_modules missing — run \`cd ops/hf-watcher && npm install\` first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-watcher"
  echo "═══════════════════════════════════════════════════════════════"

  echo "[a] wrangler deploy"
  ( cd "$WATCHER_DIR" && npx wrangler deploy )

  echo
  echo "[b] D1 migrations (vaipakam-alerts-db)"
  # Idempotent — wrangler skips already-applied entries. Without this the
  # Worker returns 500 'byParticipant-failed' (D1_ERROR no such table).
  ( cd "$WATCHER_DIR" && npm run db:migrate )

  echo
  echo "[c] RPC-secret check for chainId=$CHAIN_ID"
  # Mainnet chain-slug → expected secret name (mirrors loanRoutes.ts).
  case "$CHAIN_SLUG" in
    ethereum)      EXPECTED_RPC_SECRET="RPC_ETH" ;;
    base)          EXPECTED_RPC_SECRET="RPC_BASE" ;;
    arbitrum)      EXPECTED_RPC_SECRET="RPC_ARB" ;;
    optimism)      EXPECTED_RPC_SECRET="RPC_OP" ;;
    polygon-zkevm) EXPECTED_RPC_SECRET="RPC_ZKEVM" ;;
    bnb)           EXPECTED_RPC_SECRET="RPC_BNB" ;;
    polygon)       EXPECTED_RPC_SECRET="RPC_POLYGON" ;;
    *)             EXPECTED_RPC_SECRET="" ;;
  esac
  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    SECRET_PRESENT=$(
      cd "$WATCHER_DIR" && npx wrangler secret list 2>/dev/null \
        | grep -c "\"$EXPECTED_RPC_SECRET\"" \
        || echo 0
    )
    if [ "$SECRET_PRESENT" = "0" ]; then
      echo "  ⚠  $EXPECTED_RPC_SECRET is NOT set on the watcher Worker."
      echo "     The watcher will return 503 'chain-not-configured' for"
      echo "     chainId=$CHAIN_ID until you set it. From inside ops/hf-watcher:"
      echo
      echo "       echo -n '<your-rpc-url>' | npx wrangler secret put $EXPECTED_RPC_SECRET"
      echo
      echo "     Per CLAUDE.md mainnet hot-key policy, this RPC URL should"
      echo "     carry an API key from a paid tier (Alchemy / Infura /"
      echo "     QuickNode / DRPC) and live ONLY as a wrangler secret."
    else
      echo "  ✓ $EXPECTED_RPC_SECRET is set"
    fi
  fi
}

# ── Phase: verify ─────────────────────────────────────────────────────

phase_verify() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — verify  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"

  DIAMOND=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
  if [ -z "$DIAMOND" ]; then
    echo "FAIL: no diamond address in deployments/$CHAIN_SLUG/addresses.json — was --phase contracts run?"
    exit 1
  fi
  echo "  diamond: $DIAMOND"

  echo
  echo "  paused()        = $(cast call "$DIAMOND" 'paused()(bool)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
  echo "  getTreasury()   = $(cast call "$DIAMOND" 'getTreasury()(address)' --rpc-url "$RPC" 2>/dev/null || echo '?')"

  echo
  echo "verify OK. Continue with the role-rotation + LZ peer-wiring ceremonies."
}

# ── Dispatch ──────────────────────────────────────────────────────────

case "$PHASE" in
  preflight)    phase_preflight ;;
  contracts)    phase_contracts ;;
  lz-config)    phase_lz_config ;;
  abi-sync)     phase_abi_sync ;;
  cf-frontend)  phase_cf_frontend ;;
  cf-watcher)   phase_cf_watcher ;;
  verify)       phase_verify ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    exit 1
    ;;
esac
