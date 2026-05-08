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
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase swap-adapters
#       Runs DeploySwapAdapters.s.sol — deploys the Phase 7a
#       ZeroExAggregatorAdapter + OneInchAggregatorAdapter and
#       registers both in the diamond's swap-adapter chain via
#       AdminFacet.addSwapAdapter. Requires INITIAL_SETTLERS env
#       var (comma-separated 0x Settler addresses). Pull current
#       Settler set via the 0x deployer's ownerOf(...) at
#       0x00000000000004533Fe15556B1E086BB1A72cEae or by reading
#       transaction.to from a fresh /swap/allowance-holder/quote
#       call on this chain. Mantle operators ALSO set
#       ALLOWANCE_HOLDER_OVERRIDE — Mantle's AllowanceHolder
#       lives at 0x0000000000005E88410CcDFaDe4a5EfaE4b49562
#       instead of the Cancun-fork canonical 0x0000…2734.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase abi-sync
#       Runs the three export scripts. No on-chain effect — safe to
#       re-run. Usually run after `--phase contracts` lands.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-frontend
#       Builds the frontend and deploys to Cloudflare via wrangler.
#       Requires `apps/defi/node_modules` (operator runs pnpm install).
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

# ── Node version preflight ────────────────────────────────────────────
# Vite 5+ and Wrangler 4+ both require Node 20+. The cf-frontend +
# cf-watcher phases call them deep into the deploy; a version
# mismatch there manifests as obscure crashes (e.g.
# `ReferenceError: CustomEvent is not defined` from Vite). Failing
# fast at the top catches the operator before they spend hours on
# an on-chain deploy that ends in a frontend-build crash.
#
# Auto-recovers via nvm if any installed Node ≥ 20 is on disk;
# hard-fails with a clear message otherwise. Mainnet-strict — this
# runs at script start regardless of which `--phase` is requested.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
else
  NODE_MAJOR=0
fi
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  if [ -d "$HOME/.nvm/versions/node" ]; then
    BEST_NODE_BIN=""
    while IFS= read -r CANDIDATE; do
      CANDIDATE_MAJOR="$(basename "$CANDIDATE" | sed -E 's/^v([0-9]+).*/\1/')"
      if [ "${CANDIDATE_MAJOR:-0}" -ge 20 ]; then
        BEST_NODE_BIN="$CANDIDATE/bin"
      fi
    done < <(find "$HOME/.nvm/versions/node" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
    if [ -n "$BEST_NODE_BIN" ]; then
      export PATH="$BEST_NODE_BIN:$PATH"
      echo "[node-preflight] auto-switched to $BEST_NODE_BIN (was Node v$NODE_MAJOR)"
    else
      echo "Error: Node v$NODE_MAJOR detected. cf-frontend and cf-watcher phases need Node 20+ for Vite + Wrangler." >&2
      echo "       Either run \`nvm install 20 && nvm use 20\`, or invoke this script with PATH" >&2
      echo "       overridden to a Node-20+ install (e.g. \`PATH=/path/to/node-20/bin:\$PATH bash …\`)." >&2
      exit 1
    fi
  else
    echo "Error: Node v$NODE_MAJOR detected. cf-frontend and cf-watcher phases need Node 20+ for Vite + Wrangler." >&2
    echo "       Install Node 20+ (or nvm) before running this script." >&2
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/apps/defi"
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
  swap-adapters   — Phase 7a aggregator adapters via
                    DeploySwapAdapters.s.sol. Requires
                    INITIAL_SETTLERS env var.
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

# ── Phase markers + history sidecar ───────────────────────────────────
# Mainnet runs each phase as a deliberate operator action — no auto-
# resume / auto-chain. Markers serve as a tamper-evident record of
# "did I already run this phase?" so the operator can audit ahead of
# the role-rotation ceremony, and so a re-run of a phase that already
# landed prints a loud notice (instead of silently re-broadcasting
# txs that would mint a duplicate Diamond etc.).

DEPLOY_DIR="$CONTRACTS_DIR/deployments/$CHAIN_SLUG"
MARKERS_DIR="$DEPLOY_DIR/.markers"
HISTORY_DIR="$DEPLOY_DIR/.history"
mkdir -p "$DEPLOY_DIR" "$MARKERS_DIR" "$HISTORY_DIR"

phase_already_done() {
  local p="$1"
  [ -f "$MARKERS_DIR/phase-$p.done" ]
}

mark_phase_done() {
  local p="$1"
  date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/phase-$p.done"
}

snapshot_addresses() {
  local label="$1"
  if [ -f "$DEPLOY_DIR/addresses.json" ]; then
    cp "$DEPLOY_DIR/addresses.json" "$HISTORY_DIR/$label-$(date +%s).json"
  fi
}

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

  if phase_already_done "contracts"; then
    cat >&2 <<EOF
Refusing --phase contracts: marker file exists at
  $MARKERS_DIR/phase-contracts.done
indicating this phase already landed for $CHAIN_SLUG. Re-running would
deploy a SECOND Diamond with a different address and orphan the first.

If this is intentional (forensic redeploy / aborted prior attempt that
left a marker but no on-chain effect), remove the marker manually:
  rm $MARKERS_DIR/phase-contracts.done
then re-run. We refuse to auto-clear it because automated overwrites
on mainnet have a high blast radius.
EOF
    exit 1
  fi

  # Refuse a dirty working tree on mainnet. The deployment_source.json
  # is the load-bearing "which monorepo commit produced this bytecode"
  # record; with a dirty tree the recorded commit is a lie (the actual
  # bytecode includes uncommitted changes that no commit captures).
  # For testnet rehearsal the (dirty) flag is acceptable because the
  # whole rehearsal can be re-run; for mainnet it's a hard NO since
  # post-incident forensics depend on commit→bytecode equivalence.
  if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null || \
     ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then
    cat >&2 <<EOF
Refusing --phase contracts: working tree is dirty (uncommitted changes).
Mainnet deploys must be reproducible from a commit hash; a dirty deploy
makes post-incident forensics ambiguous. Either commit / stash the
changes, or run from a clean checkout.

  git status --short

  # then either commit:
  git add -A && git commit -m "..."

  # or stash:
  git stash
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
  snapshot_addresses "post-contracts"
  # Write deployment_source.json (commit + deployer + timestamp) —
  # same shape as deploy-chain.sh writes, so the operator can see
  # at a glance which monorepo commit is live on this chain.
  DEPLOYER_ADDR=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || echo "?")
  COMMIT_HASH=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "?")
  COMMIT_DIRTY=""
  if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then COMMIT_DIRTY=" (dirty)"; fi
  DIAMOND_NOW=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  cat > "$DEPLOY_DIR/deployment_source.json" <<EOF
{
  "chainSlug": "$CHAIN_SLUG",
  "chainId": $CHAIN_ID,
  "deployedAt": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "monorepoCommit": "$COMMIT_HASH$COMMIT_DIRTY",
  "deployer": "$DEPLOYER_ADDR",
  "diamond": "$DIAMOND_NOW"
}
EOF
  mark_phase_done "contracts"
  echo
  echo "Next:"
  echo "  1. --phase abi-sync   (sync the freshly-written addresses.json)"
  echo "  2. --phase lz-config --confirm-dvn-policy-reviewed   (DVN set)"
  echo "  3. WireVPFIPeers.s.sol on each (canonical, mirror) pair"
  echo "  4. --phase verify   (sentinel reads + facet count + rate-limit check)"
  echo "  5. Role rotation ceremony per DeploymentRunbook §6"
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
  mark_phase_done "lz-config"
}

# ── Phase: swap-adapters ──────────────────────────────────────────────

phase_swap_adapters() {
  if [ -z "${INITIAL_SETTLERS:-}" ]; then
    cat >&2 <<EOF
Refusing --phase swap-adapters: INITIAL_SETTLERS env var unset.

This phase calls DeploySwapAdapters.s.sol which deploys the
ZeroExAggregatorAdapter + OneInchAggregatorAdapter and registers
both with the diamond's swap-adapter chain via
AdminFacet.addSwapAdapter.

The 0x adapter constructor requires a non-empty seed allowlist of
permitted Settler call destinations — Settler addresses rotate
per 0x release and vary by route type, so they MUST be supplied
explicitly. Pull current Settlers via:

  (a) The 0x deployer's ownerOf(...) at
      0x00000000000004533Fe15556B1E086BB1A72cEae, OR
  (b) Reading transaction.to from a fresh
      \`https://api.0x.org/swap/allowance-holder/quote\` call on
      this chain.

Then re-run with:
  INITIAL_SETTLERS=0xSettlerA,0xSettlerB,... \\
    bash contracts/script/deploy-mainnet.sh $CHAIN_SLUG --phase swap-adapters

Optional overrides (defaults shown):
  ALLOWANCE_HOLDER_OVERRIDE  default 0x0000000000001fF3684f28c67538d4D072C22734
                             Set to 0x0000000000005E88410CcDFaDe4a5EfaE4b49562 on Mantle.
  ONEINCH_ROUTER_OVERRIDE    default 0x111111125421cA6dc452d289314280a0f8842A65
                             Same address on every chain we deploy to.
EOF
    exit 1
  fi

  if phase_already_done "swap-adapters"; then
    cat >&2 <<EOF
Refusing --phase swap-adapters: marker file exists at
$MARKERS_DIR/phase-swap-adapters.done

If you genuinely need to re-run (e.g. a previous deploy failed
mid-broadcast and the adapters are NOT registered with the
diamond), delete the marker file manually and rerun. Do NOT
re-run after a successful deploy — you'll deploy a second pair
of adapters and register both in the chain, doubling the
slot count.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — swap-adapters  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"
  echo "  INITIAL_SETTLERS:           $INITIAL_SETTLERS"
  echo "  ALLOWANCE_HOLDER_OVERRIDE:  ${ALLOWANCE_HOLDER_OVERRIDE:-(default 0x…2734)}"
  echo "  ONEINCH_ROUTER_OVERRIDE:    ${ONEINCH_ROUTER_OVERRIDE:-(default 0x…2A65)}"
  echo
  forge script script/DeploySwapAdapters.s.sol --rpc-url "$RPC" --broadcast --slow
  mark_phase_done "swap-adapters"
}

# ── Phase: abi-sync ───────────────────────────────────────────────────

phase_abi_sync() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — abi-sync"
  echo "═══════════════════════════════════════════════════════════════"
  bash "$SCRIPT_DIR/exportFrontendAbis.sh"
  # Watcher ABI sync — mirrors the rationale in deploy-chain.sh phase
  # 6 (and ReleaseNotes-2026-05-05.md "Watcher offer-decode drift").
  # The hand-typed `as const` ABI tuples in
  # `ops/hf-watcher/src/diamondAbi.ts` were replaced by JSON imports
  # generated from the compiled bytecode via this script — auto-
  # exporting on every deploy ensures the worker's positional decoder
  # can never silently misalign from a struct-shape change.
  bash "$SCRIPT_DIR/exportWatcherAbis.sh"
  bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

  KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    bash "$SCRIPT_DIR/exportAbis.sh"
  else
    echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
  fi

  echo
  echo "Review and commit:"
  echo "  git diff packages/contracts/src/abis/ packages/contracts/src/deployments.json"
  echo "  git diff ops/hf-watcher/src/deployments.json"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    echo "  cd $KEEPER_BOT_DIR_DEFAULT && git diff src/abis/"
  fi
  mark_phase_done "abi-sync"
}

# ── Phase: cf-frontend ────────────────────────────────────────────────

phase_cf_frontend() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "Error: $FRONTEND_DIR/node_modules missing — run \`pnpm install\` at the repo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-frontend"
  echo "═══════════════════════════════════════════════════════════════"
  ( cd "$FRONTEND_DIR" && npm run build && npx wrangler deploy )
  mark_phase_done "cf-frontend"
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
      # Hard-fail (was warn-only pre-2026-05-06). The 2026-05-06 testnet
      # rehearsal proved that silent-skipping a missing RPC secret leaves
      # `getChainConfigs(env)` (env.ts:151 — `if (!m.rpc) continue;`)
      # filtering this chain out of the round-robin entirely. The cron
      # never visits it; D1 stays empty for chainId=$CHAIN_ID until an
      # operator notices via missing OfferBook rows. On mainnet that
      # window between 'deploy claims success' and 'first user wonders
      # why their offer isn't showing up' is a credibility hit we don't
      # need to take. Operator sets the secret, re-runs the script, and
      # `mark_phase_done` resumes from the next phase.
      echo "  ✗ FAIL: $EXPECTED_RPC_SECRET is NOT set on the watcher Worker."
      echo
      echo "  The watcher's getChainConfigs() filter (env.ts:151) drops any"
      echo "  chain whose RPC env binding is empty, so chainId=$CHAIN_ID will"
      echo "  silently never enter the round-robin. Set the secret before"
      echo "  re-running this script:"
      echo
      echo "    cd $WATCHER_DIR"
      echo "    echo -n '<your-paid-rpc-url>' | npx wrangler secret put $EXPECTED_RPC_SECRET"
      echo
      echo "  Per CLAUDE.md mainnet hot-key policy, the RPC URL must carry"
      echo "  an API key from a paid tier (Alchemy / Infura / QuickNode /"
      echo "  DRPC) and live ONLY as a wrangler secret — never in the repo."
      exit 1
    fi
    echo "  ✓ $EXPECTED_RPC_SECRET is set"
  fi

  # [d] Seed indexer_cursor at current safe head — closes the
  # backfill latency window. After the watcher is freshly deployed
  # AND its D1 schema is migrated (steps a + b above), the next
  # cron tick reads `indexer_cursor` for this chain. With no row
  # present, the cron falls back to `deployBlock - 1` and starts a
  # multi-tick backfill of the empty pre-deploy range.
  #
  # Mainnet operators kick off smoke tests + the public deployment
  # announcement immediately after `--phase cf-watcher` lands; a 5-
  # to 10-minute backfill window means the indexer-backed views
  # show stale (empty) data for that long. Seeding the cursor at
  # current safe head means the next cron tick captures the
  # smoke-test events directly — no empty backfill.
  #
  # Misses any events emitted between deployBlock and seed-time —
  # which on mainnet is just `--phase contracts` admin calls (role
  # grants, init steps), no OfferCreated / LoanInitiated. Those
  # only fire from user-facing flows post-deploy. Activity_events
  # table loses the diagnostic admin events; trade-off is
  # documented in DeploymentRunbook.md.
  echo
  echo "[d] Seed indexer_cursor for chainId=$CHAIN_ID at safe head"
  if [ -z "${RPC:-}" ]; then
    echo "    ⚠ RPC not set — skipping cursor seed (re-run with RPC env exported)"
  else
    SAFE_HEAD="$(cast block-number --rpc-url "$RPC" --tag safe 2>/dev/null \
      || cast block-number --rpc-url "$RPC" 2>/dev/null \
      || echo "")"
    if [ -z "$SAFE_HEAD" ]; then
      echo "    ⚠ cast block-number failed against \$RPC — skipping cursor seed"
    else
      NOW_TS=$(date +%s)
      ( cd "$WATCHER_DIR" && npx wrangler d1 execute vaipakam-alerts-db --remote --command \
        "INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
         VALUES ($CHAIN_ID, 'diamond', $SAFE_HEAD, $NOW_TS)
         ON CONFLICT(chain_id, kind) DO UPDATE SET
           last_block = excluded.last_block,
           updated_at = excluded.updated_at;" >/dev/null 2>&1 ) \
        && echo "    ✓ cursor seeded at block $SAFE_HEAD" \
        || echo "    ⚠ wrangler d1 execute failed — cron will fall through to deployBlock-1"
    fi
  fi

  mark_phase_done "cf-watcher"
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
  echo "[1] Sentinel reads"
  echo "  paused()         = $(cast call "$DIAMOND" 'paused()(bool)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
  echo "  getTreasury()    = $(cast call "$DIAMOND" 'getTreasury()(address)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
  echo "  nextOfferId()    = $(cast call "$DIAMOND" 'nextOfferId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
  echo "  nextLoanId()     = $(cast call "$DIAMOND" 'nextLoanId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"

  echo
  echo "[2] Facet-count verification (DiamondLoupe)"
  # Same check as deploy-chain.sh step 2b — the two-half diamondCut
  # split (commit `585179f`) can leave the diamond half-cut if the
  # second half silently drops due to a gas spike or RPC hiccup. Catch
  # it here on mainnet too, before any role-rotation ceremony locks
  # the deploy in.
  # 32 cut facets — DiamondCutFacet is callable but not loupe-
  # enumerated (see DeployDiamond.s.sol post-cut comment).
  EXPECTED_FACETS=32
  FACET_COUNT_RAW=$(cast call "$DIAMOND" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null \
    | tr ',' '\n' | grep -c '0x' || echo 0)
  if [ "$FACET_COUNT_RAW" -lt "$EXPECTED_FACETS" ]; then
    echo "  FAIL: $FACET_COUNT_RAW facets registered, expected $EXPECTED_FACETS." >&2
    echo "        Run --phase contracts again before any other phase." >&2
    exit 1
  fi
  echo "  ✓ $FACET_COUNT_RAW facets (≥ $EXPECTED_FACETS expected)"

  echo
  echo "[3] Master flag state"
  echo "  getMasterFlags() = $(cast call "$DIAMOND" 'getMasterFlags()(bool,bool,bool)' --rpc-url "$RPC" 2>/dev/null | tr '\n' ' ' || echo '?')"

  # If a VPFIBuyAdapter is present (mirror chain), confirm rate
  # limits are non-default (i.e. NOT uint256.max). The mainnet
  # cross-chain security policy requires explicit limits before any
  # buy-vpfi traffic — this is the verify-time backstop in case
  # `--phase contracts` skipped the post-deploy setRateLimits.
  BUY_ADAPTER=$(jq -r '.vpfiBuyAdapter // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
  if [ -n "$BUY_ADAPTER" ]; then
    echo
    echo "[4] Buy-VPFI rate limits"
    # Both caps are read via VPFIBuyAdapter.getRateLimits() (added
    # post-rehearsal — see ContractFollowupsFromRehearsal-2026-05-06.md
    # Item 1). uint256.max in either slot means the canonical-mint
    # cap is still at the unlimited default — that's a mainnet-deploy
    # gate per CLAUDE.md "Cross-Chain Security Policy", so fail-hard
    # with a non-zero exit and refuse to mark verify done.
    RATE_LIMITS_RAW=$(cast call "$BUY_ADAPTER" 'getRateLimits()(uint256,uint256)' --rpc-url "$RPC" 2>/dev/null || echo "")
    if [ -z "$RATE_LIMITS_RAW" ]; then
      echo "  ✗ getRateLimits() call failed — adapter may not be deployed at $BUY_ADAPTER."
      exit 1
    fi
    PER_REQ=$(echo "$RATE_LIMITS_RAW" | sed -n '1p' | awk '{print $1}')
    DAILY=$(echo "$RATE_LIMITS_RAW" | sed -n '2p' | awk '{print $1}')
    UINT256_MAX="115792089237316195423570985008687907853269984665640564039457584007913129639935"
    echo "  perRequestCap = $PER_REQ"
    echo "  dailyCap      = $DAILY"
    if [ "$PER_REQ" = "$UINT256_MAX" ] || [ "$DAILY" = "$UINT256_MAX" ]; then
      echo "  ✗ FAIL: at least one rate-limit cap is still at type(uint256).max."
      echo "          A canonical-mint mainnet deploy with unlimited spend is a"
      echo "          mainnet-deploy gate violation. Send setRateLimits(...) and"
      echo "          re-run --phase verify before declaring deploy ready."
      exit 1
    fi
    echo "  ✓ both caps finite — BuyAdapter ready for canonical mint."
  fi

  echo
  echo "verify OK. Continue with the role-rotation + LZ peer-wiring ceremonies."
  mark_phase_done "verify"
}

# ── Dispatch ──────────────────────────────────────────────────────────

case "$PHASE" in
  preflight)    phase_preflight ;;
  contracts)    phase_contracts ;;
  lz-config)    phase_lz_config ;;
  swap-adapters) phase_swap_adapters ;;
  abi-sync)     phase_abi_sync ;;
  cf-frontend)  phase_cf_frontend ;;
  cf-watcher)   phase_cf_watcher ;;
  verify)       phase_verify ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    exit 1
    ;;
esac
