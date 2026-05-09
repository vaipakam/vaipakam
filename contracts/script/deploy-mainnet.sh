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
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-defi
#       Builds apps/defi (the dApp) and deploys to Cloudflare Workers
#       Static Assets via wrangler. Requires the monorepo's `pnpm
#       install` to have populated `apps/defi/node_modules`.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-www
#       Builds apps/www (the marketing site) and deploys via wrangler.
#       Same install prerequisite as cf-defi.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-keeper
#       Deploys apps/keeper (autonomous HF-liquidation Worker) via
#       wrangler. Stateless — reads RPC + signing key from per-Worker
#       wrangler secrets. The phase verifies the chain-specific RPC
#       secret is present on the Worker before claiming success.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-indexer
#       Deploys apps/indexer (D1 indexer + read-only API) via
#       wrangler, then applies any pending D1 migrations to the shared
#       `vaipakam-archive` database. The indexer is the only Worker
#       that owns migrations — keeper + agent are stateless. Seeds
#       indexer_cursor at safe head if `--seed-cursor` is passed
#       alongside this phase (skipped by default — mainnet redeploys
#       almost always preserve the diamond and its prior cursor).
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase cf-agent
#       Deploys apps/agent (notifications + frames + agent surfaces)
#       via wrangler. Stateless; same per-Worker RPC-secret check as
#       cf-keeper.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase verify
#       Read-only smoke checks against the deployed Diamond.
#
#   --phase pause-rehearsal is REFUSED on mainnet — that phase is
#       testnet-only, where it exists in deploy-testnet.sh as a
#       sub-5-minute N-chain simultaneous-pause drill (Penpie-style
#       defense rehearsal). On mainnet a pause is a real incident
#       lever and runs from `pause-all-chains.sh`, not from a deploy
#       script.
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
# Vite 5+ and Wrangler 4+ both require Node 20+. The cf-{defi,www,
# keeper,indexer,agent} phases call them deep into the deploy; a
# version mismatch there manifests as obscure crashes (e.g.
# `ReferenceError: CustomEvent is not defined` from Vite). Failing
# fast at the top catches the operator before they spend hours on
# an on-chain deploy that ends in a Worker-build crash.
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
      echo "Error: Node v$NODE_MAJOR detected. cf-{defi,www,keeper,indexer,agent} phases need Node 20+ for Vite + Wrangler." >&2
      echo "       Either run \`nvm install 20 && nvm use 20\`, or invoke this script with PATH" >&2
      echo "       overridden to a Node-20+ install (e.g. \`PATH=/path/to/node-20/bin:\$PATH bash …\`)." >&2
      exit 1
    fi
  else
    echo "Error: Node v$NODE_MAJOR detected. cf-{defi,www,keeper,indexer,agent} phases need Node 20+ for Vite + Wrangler." >&2
    echo "       Install Node 20+ (or nvm) before running this script." >&2
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
# Stage 3 / Stage 4 source-tree split — see CLAUDE.md "Worker ABI
# consumption (Stage 3 split)" + "Frontend ABI sync". apps/defi and
# apps/www are the two SPAs; apps/{keeper,indexer,agent} are the
# three focused Workers that replaced the old `ops/hf-watcher`
# monolith. The legacy `ops/hf-watcher` tree is archived under
# `alpha/hf-watcher/` and is never deployed by this script.
DEFI_DIR="$REPO_ROOT/apps/defi"
WWW_DIR="$REPO_ROOT/apps/www"
KEEPER_DIR="$REPO_ROOT/apps/keeper"
INDEXER_DIR="$REPO_ROOT/apps/indexer"
AGENT_DIR="$REPO_ROOT/apps/agent"

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
  abi-sync        — packages/contracts ABI + deployments.json sync
                    + sibling keeper-bot repo (when present).
  cf-defi         — Build + wrangler deploy apps/defi (the dApp).
  cf-www          — Build + wrangler deploy apps/www (marketing).
  cf-keeper       — wrangler deploy apps/keeper (autonomous keeper).
  cf-indexer      — wrangler deploy apps/indexer + D1 migrations
                    on the shared `vaipakam-archive` database.
  cf-agent        — wrangler deploy apps/agent (notifications, frames).
  verify          — Read-only smoke checks.

For testnet rehearsals (mirrors this tiered phase model + adds a
pause-rehearsal phase), use deploy-testnet.sh.
For Anvil + dev quick-iteration, use deploy-chain.sh.
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
  # Single canonical export target after the Stage 3 split:
  # `packages/contracts/src/{abis,deployments.json}`. Every consumer in
  # the monorepo — apps/{defi,www} (the SPAs) and apps/{keeper,indexer,
  # agent} (the Workers) — imports from `@vaipakam/contracts`. So this
  # one step keeps the entire downstream surface (SPA reads, Worker
  # event decode, sibling keeper-bot reads) on the same compiled-
  # bytecode shape — no manual follow-up before the cf-* phases.
  #
  # The historical `exportWatcherAbis.sh` was deleted alongside
  # `ops/hf-watcher` itself in the Stage 3 cleanup; positional-decode
  # drift of the kind captured in ReleaseNotes-2026-05-05.md
  # (`periodicInterestCadence` shifting `getOfferDetails` tuple
  # positions) can't recur because every Worker now imports the
  # Solidity-compiler-emitted JSON instead of hand-typed `as const`
  # arrays.
  bash "$SCRIPT_DIR/exportFrontendAbis.sh"
  bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

  KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    bash "$SCRIPT_DIR/exportAbis.sh"
  else
    echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
  fi

  # ops/{subgraph,tenderly,lz-watcher} exports — best-effort, scoped
  # to THIS chain. Each is a no-op for chains its target system can't
  # name. The lz-watcher emitter writes to a gitignored sidecar; it
  # never auto-applies (secrets-bearing wrangler-secret-put commands
  # stay a deliberate operator action).
  if [ -d "$REPO_ROOT/ops/subgraph" ]; then
    bash "$SCRIPT_DIR/exportSubgraphAbis.sh" "$CHAIN_SLUG"
  fi
  if [ -d "$REPO_ROOT/ops/tenderly" ]; then
    bash "$SCRIPT_DIR/exportTenderlyAlerts.sh" "$CHAIN_SLUG"
  fi
  if [ -d "$REPO_ROOT/ops/lz-watcher" ]; then
    mkdir -p "$REPO_ROOT/ops/lz-watcher/generated"
    bash "$SCRIPT_DIR/exportLzWatcherVars.sh" "$CHAIN_SLUG" \
      > "$REPO_ROOT/ops/lz-watcher/generated/secrets-$CHAIN_SLUG.sh"
    echo "    ops/lz-watcher/generated/secrets-$CHAIN_SLUG.sh — review + apply manually."
  fi

  echo
  echo "Review and commit:"
  echo "  git diff packages/contracts/src/abis/ packages/contracts/src/deployments.json"
  echo "  git diff ops/subgraph/abis/ ops/subgraph/generated/ ops/tenderly/generated/"
  if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
    echo "  cd $KEEPER_BOT_DIR_DEFAULT && git diff src/abis/"
  fi
  mark_phase_done "abi-sync"
}

# ── Phase: cf-defi ────────────────────────────────────────────────────
# Builds + deploys apps/defi (the dApp — connected wallet, OfferBook,
# LoanList, vault management). Cloudflare Workers Static Assets target
# is `vaipakam-defi`. Stage 4 split (May 2026) made this its own app
# distinct from apps/www; per-phase deploys let the operator iterate
# on one without touching the other.

phase_cf_defi() {
  if [ ! -d "$DEFI_DIR/node_modules" ]; then
    echo "Error: $DEFI_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-defi"
  echo "═══════════════════════════════════════════════════════════════"
  ( cd "$DEFI_DIR" && pnpm run build && pnpm exec wrangler deploy )
  mark_phase_done "cf-defi"
}

# ── Phase: cf-www ─────────────────────────────────────────────────────
# Builds + deploys apps/www (the marketing site — landing, docs, blog,
# brand surfaces). Cloudflare Workers Static Assets target is
# `vaipakam-www`. Same install prerequisite as cf-defi (root pnpm
# install populates both `node_modules` symlink chains).

phase_cf_www() {
  if [ ! -d "$WWW_DIR/node_modules" ]; then
    echo "Error: $WWW_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-www"
  echo "═══════════════════════════════════════════════════════════════"
  ( cd "$WWW_DIR" && pnpm run build && pnpm exec wrangler deploy )
  mark_phase_done "cf-www"
}

# ── Worker RPC-secret helper ──────────────────────────────────────────
# Fans the chain-specific RPC-secret presence check across the three
# Workers (each Worker has its own Cloudflare secret store). Hard-fails
# the phase if missing — the silent-drop failure mode (cron filters the
# chain out of round-robin so D1 stays empty for ~50 min before the
# operator notices) was exactly the May-2026 rehearsal pain point that
# made this a hard gate.

verify_rpc_secret_on_worker() {
  local worker_dir="$1"
  local worker_name="$2"
  local secret_name="$3"
  local chain_id="$4"

  local present=$(
    cd "$worker_dir" && pnpm exec wrangler secret list 2>/dev/null \
      | grep -c "\"$secret_name\"" \
      || echo 0
  )
  if [ "$present" = "0" ]; then
    echo "  ✗ FAIL: $secret_name is NOT set on $worker_name."
    echo
    echo "  The Worker's chain-config filter drops any chain whose RPC binding"
    echo "  is empty, so chainId=$chain_id will silently never be queried."
    echo "  Set the secret before re-running this phase:"
    echo
    echo "    cd $worker_dir"
    echo "    echo -n '<your-paid-rpc-url>' | pnpm exec wrangler secret put $secret_name"
    echo
    echo "  Per CLAUDE.md mainnet hot-key policy, the RPC URL must carry"
    echo "  an API key from a paid tier (Alchemy / Infura / QuickNode /"
    echo "  DRPC) and live ONLY as a wrangler secret — never in the repo."
    return 1
  fi
  echo "  ✓ $secret_name is set on $worker_name"
  return 0
}

# Map mainnet chain-slug → expected RPC secret name. Same secret name
# on each Worker (each Worker has its own copy in its own Cloudflare
# secret store; the name is shared but the values are scoped per Worker).
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

# ── Phase: cf-keeper ──────────────────────────────────────────────────
# Deploys apps/keeper — the autonomous HF-liquidation Worker. Stateless:
# signs `triggerLiquidation` on-chain when an active loan's HF drops
# below 1e18. Reads RPC + signing key from per-Worker wrangler secrets;
# no D1 writes (consumes indexer reads via internal fetch).

phase_cf_keeper() {
  if [ ! -d "$KEEPER_DIR" ]; then
    echo "Error: $KEEPER_DIR not present." >&2
    exit 1
  fi
  if [ ! -d "$KEEPER_DIR/node_modules" ]; then
    echo "Error: $KEEPER_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-keeper"
  echo "═══════════════════════════════════════════════════════════════"

  echo "[a] wrangler deploy"
  ( cd "$KEEPER_DIR" && pnpm exec wrangler deploy )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "[b] RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$KEEPER_DIR" "vaipakam-keeper" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  mark_phase_done "cf-keeper"
}

# ── Phase: cf-indexer ─────────────────────────────────────────────────
# Deploys apps/indexer — the D1 indexer + read-only API. Owns the
# shared `vaipakam-archive` D1 database + its migrations (the keeper
# and agent Workers BIND the same D1 but never run migrations against
# it). Three sub-steps:
#   [a] wrangler deploy
#   [b] D1 migrations apply  (only this Worker runs them)
#   [c] RPC-secret check for this chain
#
# Note on cursor seeding: deploy-chain.sh and deploy-testnet.sh seed
# `indexer_cursor` at safe head under `--fresh` to skip the empty
# backfill window. On MAINNET we deliberately DO NOT auto-seed —
# mainnet redeploys virtually always preserve the diamond and its
# prior cursor, so re-seeding would lose indexed history. If a
# mainnet operator ever genuinely needs to reset the cursor (e.g.
# migration to a brand-new diamond, full-history reindex), do it
# manually via `pnpm exec wrangler d1 execute vaipakam-archive
# --remote --command "UPDATE indexer_cursor SET last_block = ..."`.

phase_cf_indexer() {
  if [ ! -d "$INDEXER_DIR" ]; then
    echo "Error: $INDEXER_DIR not present." >&2
    exit 1
  fi
  if [ ! -d "$INDEXER_DIR/node_modules" ]; then
    echo "Error: $INDEXER_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-indexer"
  echo "═══════════════════════════════════════════════════════════════"

  echo "[a] wrangler deploy"
  ( cd "$INDEXER_DIR" && pnpm exec wrangler deploy )

  echo
  echo "[b] D1 migrations apply (vaipakam-archive)"
  # Idempotent — wrangler skips already-applied entries. Without this
  # the indexer returns 500 D1_ERROR (no such table) on every
  # /offers/recent / /loans/byParticipant query.
  ( cd "$INDEXER_DIR" && pnpm exec wrangler d1 migrations apply vaipakam-archive --remote )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "[c] RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$INDEXER_DIR" "vaipakam-indexer" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  mark_phase_done "cf-indexer"
}

# ── Phase: cf-agent ───────────────────────────────────────────────────
# Deploys apps/agent — notifications + Farcaster frames + agent
# endpoints. Stateless: signs Telegram + Push notification dispatches,
# hosts the natural-language agent surface. Reads RPC + signing keys
# from per-Worker wrangler secrets; no D1 writes.

phase_cf_agent() {
  if [ ! -d "$AGENT_DIR" ]; then
    echo "Error: $AGENT_DIR not present." >&2
    exit 1
  fi
  if [ ! -d "$AGENT_DIR/node_modules" ]; then
    echo "Error: $AGENT_DIR/node_modules missing — run \`pnpm install\` at the monorepo root first." >&2
    exit 1
  fi
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — cf-agent"
  echo "═══════════════════════════════════════════════════════════════"

  echo "[a] wrangler deploy"
  ( cd "$AGENT_DIR" && pnpm exec wrangler deploy )

  if [ -n "$EXPECTED_RPC_SECRET" ]; then
    echo
    echo "[b] RPC-secret check for chainId=$CHAIN_ID"
    verify_rpc_secret_on_worker "$AGENT_DIR" "vaipakam-agent" \
      "$EXPECTED_RPC_SECRET" "$CHAIN_ID" || exit 1
  fi

  mark_phase_done "cf-agent"
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
  preflight)     phase_preflight ;;
  contracts)     phase_contracts ;;
  lz-config)     phase_lz_config ;;
  swap-adapters) phase_swap_adapters ;;
  abi-sync)      phase_abi_sync ;;
  cf-defi)       phase_cf_defi ;;
  cf-www)        phase_cf_www ;;
  cf-keeper)     phase_cf_keeper ;;
  cf-indexer)    phase_cf_indexer ;;
  cf-agent)      phase_cf_agent ;;
  verify)        phase_verify ;;
  pause-rehearsal)
    cat >&2 <<EOF
Refusing --phase pause-rehearsal on mainnet.

This phase is testnet-only — it lives in deploy-testnet.sh as a
sub-5-minute N-chain simultaneous-pause drill (Penpie-style defense
rehearsal). On MAINNET a pause is a real incident lever: never a
drill, never a deploy-script step. If you genuinely need to pause
production, run pause-all-chains.sh from the operator runbook.

  bash contracts/script/deploy-testnet.sh <slug> --phase pause-rehearsal   # rehearsal
  bash contracts/script/pause-all-chains.sh                                # real incident
EOF
    exit 1
    ;;
  cf-frontend|cf-watcher)
    cat >&2 <<EOF
Phase '$PHASE' was retired in the Stage 3/4 source-tree split.

Replacement phases (run them in order):
  --phase cf-defi       (apps/defi  — the dApp)
  --phase cf-www        (apps/www   — marketing site)
  --phase cf-keeper     (apps/keeper  — autonomous keeper)
  --phase cf-indexer    (apps/indexer — D1 indexer + migrations)
  --phase cf-agent      (apps/agent   — notifications, frames)
EOF
    exit 1
    ;;
  *)
    echo "Unknown phase: $PHASE" >&2
    exit 1
    ;;
esac
