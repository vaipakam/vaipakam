#!/usr/bin/env bash
#
# deploy-testnet.sh — testnet rehearsal-grade tiered deploy.
#
# Mirrors deploy-mainnet.sh phase-for-phase so a testnet rehearsal
# exercises the SAME ceremony, the SAME confirm-flag friction, and
# the SAME operator muscle memory as the eventual mainnet day. The
# only deltas:
#   1. Testnet chain registry (Anvil + Sepolias + BNB testnet + Amoy)
#      instead of mainnet slugs.
#   2. `--phase pause-rehearsal` is ENABLED — Penpie-style sub-5-minute
#      N-chain simultaneous-pause drill. Refused on the mainnet script
#      (where pause is a real incident lever, not a drill).
#   3. The dirty-tree refusal in `--phase contracts` is LIFTED —
#      testnet rehearsals routinely iterate on uncommitted local
#      changes, and the reproducibility property mainnet needs
#      (commit→bytecode equivalence for post-incident forensics)
#      doesn't apply.
#
# Everything else — phase ordering, confirm flags, multisig-ready
# gate, DVN-policy-reviewed gate, swap-adapter Settler env-var
# requirement, RPC-secret hard-fail — is identical to mainnet.
# Practising the friction is the whole point.
#
# This script does NOT chain phases together; the operator runs each
# phase explicitly, eyeballs the diff, then moves to the next.
#
# Tiered flow:
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase preflight
#       Reads .env, verifies RPC chainId, balance, expected env vars.
#       Read-only — no broadcasts. Run before any other phase.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase contracts \
#                                           --confirm-i-have-multisig-ready
#       Deploys Diamond + Timelock + VPFI lane + Reward OApp.
#       The confirm flag is a deliberate friction — without it, the
#       script refuses. The flag asserts: governance multisig is
#       reachable for the role-rotation ceremony at the end of the
#       deploy day, and the operator has eyeballed the .env one more
#       time.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase lz-config \
#                                           --confirm-dvn-policy-reviewed
#       Runs ConfigureLZConfig.s.sol — the DVN set + confirmations
#       must already be set in .env (DVN_REQUIRED_1/2/3,
#       DVN_OPTIONAL_1/2, CONFIRMATIONS, REMOTE_EIDS, OAPP, SEND_LIB,
#       RECV_LIB). The confirm flag asserts the operator has reviewed
#       the policy against contracts/README.md "Cross-Chain Security"
#       (3-required + 2-optional, threshold 1-of-2, operator
#       diversity).
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase swap-adapters
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
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase configure
#       Runs DiamondConfigSpell.s.sol — same composition as mainnet:
#       ConfigureOracle + ConfigureRewardReporter + ConfigureVPFIBuy +
#       ConfigureNFTImageURIs in one operator-action. Practising the
#       spell on testnet under the same flow as mainnet is the whole
#       point of the rehearsal.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase handover \
#                                           --confirm-i-have-multisig-ready
#       Runs Handover.s.sol — same role / ownership rotation as
#       mainnet (DEFAULT_ADMIN_ROLE → governance Safe direct, five
#       Timelock-bound roles → Timelock, PAUSER_ROLE → Pauser Safe
#       direct, ERC-173 + every OApp's Ownable2Step → governance
#       Safe). Practising this on testnet is the whole point of the
#       rehearsal.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase abi-sync
#       Runs the three export scripts. No on-chain effect — safe to
#       re-run. Usually run after `--phase contracts` lands.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-defi
#       Builds apps/defi (the dApp) and deploys to Cloudflare Workers
#       Static Assets via wrangler. Requires the monorepo's `pnpm
#       install` to have populated `apps/defi/node_modules`.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-www
#       Builds apps/www (the marketing site) and deploys via wrangler.
#       Same install prerequisite as cf-defi.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-keeper
#       Deploys apps/keeper (autonomous HF-liquidation Worker) via
#       wrangler. Stateless — reads RPC + signing key from per-Worker
#       wrangler secrets. The phase verifies the chain-specific RPC
#       secret is present on the Worker before claiming success.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-indexer
#       Deploys apps/indexer (D1 indexer + read-only API) via
#       wrangler, then applies any pending D1 migrations to the shared
#       `vaipakam-archive` database. The indexer is the only Worker
#       that owns migrations — keeper + agent are stateless. Seeds
#       indexer_cursor at safe head if `--seed-cursor` is passed
#       alongside this phase (skipped by default — mainnet redeploys
#       almost always preserve the diamond and its prior cursor).
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-agent
#       Deploys apps/agent (notifications + frames + agent surfaces)
#       via wrangler. Stateless; same per-Worker RPC-secret check as
#       cf-keeper.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase verify
#       Read-only smoke checks against the deployed Diamond.
#
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase pause-rehearsal
#       Penpie-style sub-5-minute N-chain simultaneous-pause drill.
#       Reads addresses.json on this chain, prints the `pause()`
#       calldata for the Diamond + every LZ OApp/OFT (VPFIOFTAdapter,
#       VPFIMirror, VPFIBuyAdapter, VPFIBuyReceiver, VaipakamRewardOApp)
#       so the operator can sign through the Pauser Safe UI on this
#       chain and the same set across every other chain in parallel.
#       After the drill, re-run with `--mode check` to read paused()
#       on every contract and report elapsed time vs the 5-minute
#       budget. `--mode unpause-calldata` prints the inverse calldata.
#       Mainnet refuses this phase outright — pause there is an
#       incident lever, not a drill.
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
  bash contracts/script/deploy-testnet.sh <chain-slug> --phase <phase> [confirm-flags]

Testnet chain-slugs:
  base-sepolia  sepolia  arb-sepolia  op-sepolia  bnb-testnet  polygon-amoy
  (anvil delegates to deploy-chain.sh / anvil-bootstrap.sh)

Phases (mirror mainnet phase-for-phase except pause-rehearsal):
  preflight        — Read-only, run first. No broadcasts.
  contracts        — Diamond + Timelock + VPFI lane + Reward OApp.
                     Requires --confirm-i-have-multisig-ready
  lz-config        — DVN policy via ConfigureLZConfig.s.sol.
                     Requires --confirm-dvn-policy-reviewed
  swap-adapters    — Phase 7a aggregator adapters via
                     DeploySwapAdapters.s.sol. Requires
                     INITIAL_SETTLERS env var.
  configure        — DiamondConfigSpell: ConfigureOracle +
                     ConfigureRewardReporter + ConfigureVPFIBuy +
                     ConfigureNFTImageURIs in one operator-action.
  handover         — Rotate roles + ownership to governance topology.
                     Requires --confirm-i-have-multisig-ready
  abi-sync         — packages/contracts ABI + deployments.json sync
                     + sibling keeper-bot repo (when present).
  cf-defi          — Build + wrangler deploy apps/defi (the dApp).
  cf-www           — Build + wrangler deploy apps/www (marketing).
  cf-keeper        — wrangler deploy apps/keeper (autonomous keeper).
  cf-indexer       — wrangler deploy apps/indexer + D1 migrations
                     on the shared \`vaipakam-archive\` database.
  cf-agent         — wrangler deploy apps/agent (notifications, frames).
  verify           — Read-only smoke checks.
  pause-rehearsal  — TESTNET-ONLY Penpie-style sub-5-min pause drill.
                     --mode {calldata|check|unpause-calldata}

For mainnet, use deploy-mainnet.sh (refuses pause-rehearsal).
For Anvil + dev quick-iteration, use deploy-chain.sh.
EOF
  exit 1
fi

CHAIN_SLUG="$1"; shift

PHASE=""
CONFIRM_MULTISIG=0
CONFIRM_DVN=0
FRESH=0
# --mode is only consulted by --phase pause-rehearsal. Defaults to
# "calldata" (print pause() calldata for the operator to sign through
# the Pauser Safe UI). "check" reads paused() on every contract and
# reports elapsed time vs the 5-min budget. "unpause-calldata" prints
# the inverse calldata for the rehearsal cleanup.
PAUSE_MODE="calldata"

while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      shift
      PHASE="$1"
      ;;
    --confirm-i-have-multisig-ready) CONFIRM_MULTISIG=1 ;;
    --confirm-dvn-policy-reviewed)   CONFIRM_DVN=1 ;;
    --fresh)                         FRESH=1 ;;
    --mode)
      shift
      PAUSE_MODE="$1"
      ;;
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

# ── Testnet chain registry ────────────────────────────────────────────
# Mirrors deploy-mainnet.sh's registry shape (CHAIN_ID + RPC_VAR +
# IS_CANONICAL + LZ_EID + LZ_ENDPOINT_VAR + WETH_PULL_VAR) so every
# downstream phase can stay phase-for-phase identical to mainnet.
#
# WETH-pull policy on testnets: per CLAUDE.md "VPFIBuyAdapter — payment-
# token mode by chain", BNB Smart Chain Testnet (97) and Polygon Amoy
# (80002) are exempt from the strict-WETH-pull requirement that applies
# to their mainnets. Native-gas mode is acceptable here (the testnet
# rate is symbolic; gas tokens have no real value). The mainnet
# equivalents WILL require WETH-pull — that's exercised in
# deploy-mainnet.sh.

case "$CHAIN_SLUG" in
  base-sepolia)
    CHAIN_ID=84532;     RPC_VAR="BASE_SEPOLIA_RPC_URL";   IS_CANONICAL=1; LZ_EID=40245
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_BASE_SEPOLIA";  WETH_PULL_VAR="" ;;
  sepolia)
    CHAIN_ID=11155111;  RPC_VAR="SEPOLIA_RPC_URL";        IS_CANONICAL=0; LZ_EID=40161
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_SEPOLIA";       WETH_PULL_VAR="" ;;
  arb-sepolia)
    CHAIN_ID=421614;    RPC_VAR="ARB_SEPOLIA_RPC_URL";    IS_CANONICAL=0; LZ_EID=40231
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_ARB_SEPOLIA";   WETH_PULL_VAR="" ;;
  op-sepolia)
    CHAIN_ID=11155420;  RPC_VAR="OP_SEPOLIA_RPC_URL";     IS_CANONICAL=0; LZ_EID=40232
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_OP_SEPOLIA";    WETH_PULL_VAR="" ;;
  bnb-testnet)
    CHAIN_ID=97;        RPC_VAR="BNB_TESTNET_RPC_URL";    IS_CANONICAL=0; LZ_EID=40102
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_BNB_TESTNET";   WETH_PULL_VAR="" ;;
  polygon-amoy)
    CHAIN_ID=80002;     RPC_VAR="POLYGON_AMOY_RPC_URL";   IS_CANONICAL=0; LZ_EID=40267
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_POLYGON_AMOY";  WETH_PULL_VAR="" ;;
  anvil)
    cat >&2 <<EOF
Refusing to run anvil from deploy-testnet.sh — the tiered phase model
makes no sense against a local devnet that gets wiped between runs.
Use deploy-chain.sh anvil — it delegates to anvil-bootstrap.sh which
mocks + flag-flips + seeds offers in one shot.
EOF
    exit 1
    ;;
  ethereum|base|arbitrum|optimism|polygon-zkevm|bnb|polygon)
    cat >&2 <<EOF
Refusing to run mainnet chain '$CHAIN_SLUG' from deploy-testnet.sh.
Use deploy-mainnet.sh — same tiered phase model, but with mainnet
chain slugs and dirty-tree refusal active.
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

# Per-chain LZ_ENDPOINT dispatch — same shape as deploy-chain.sh. The
# RewardOApp / VPFI deploy scripts read a single `LZ_ENDPOINT` env
# var, but the V2 endpoint differs per chain on mainnet AND on
# testnets that lift past the legacy LZ V1 single-endpoint shape.
# Override LZ_ENDPOINT here from LZ_ENDPOINT_<SLUG> so the same .env
# works on every chain without manual editing.
if [ -n "${!LZ_ENDPOINT_VAR:-}" ]; then
  export LZ_ENDPOINT="${!LZ_ENDPOINT_VAR}"
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
  echo "deploy-testnet.sh — preflight  ($CHAIN_SLUG / $CHAIN_ID)"
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

# ── Helper: archive existing chain state under .archive/<ISO-8601>/ ──
# Moves addresses.json, deployment_source.json, .markers/, .history/,
# and any prior addresses.prior-rehearsal.* sidecars into a single
# timestamped subdirectory so the operator can inspect the prior
# attempt forensically (mid-flight reverts, unexpected addresses,
# etc.). Called by `phase_contracts` when --fresh is passed against
# a chain dir that already has a deploy.
#
# Why a sibling .archive/<ISO>/ inside the chain dir (not a sibling
# folder one level up): keeps related artefacts together, fits the
# existing .markers/ + .history/ layout, and a single .gitignore
# entry (`contracts/deployments/*/.archive/`) covers every chain.
archive_chain_state() {
  local chain_slug="$1"
  local deploy_dir="$CONTRACTS_DIR/deployments/$chain_slug"
  local stamp
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  local archive="$deploy_dir/.archive/$stamp"

  mkdir -p "$archive"

  # Move every chain-state file/dir we know about. The `2>/dev/null`
  # tolerates missing entries (e.g. .history/ may not exist on a
  # half-failed deploy).
  for entry in addresses.json deployment_source.json .markers .history; do
    if [ -e "$deploy_dir/$entry" ]; then
      mv "$deploy_dir/$entry" "$archive/" 2>/dev/null || true
    fi
  done

  # Sweep any addresses.prior-rehearsal.<unix-ts>.json sidecars from
  # earlier `--fresh`-equivalent runs. They're already gitignored;
  # moving them into the new archive consolidates the chronological
  # record under one timestamp.
  for prior in "$deploy_dir"/addresses.prior-rehearsal.*.json; do
    [ -f "$prior" ] && mv "$prior" "$archive/" 2>/dev/null || true
  done

  # Re-create the empty top-level scaffolding that the deploy expects.
  mkdir -p "$deploy_dir/.markers" "$deploy_dir/.history"

  echo "  ✓ archived prior chain state -> $(realpath --relative-to="$CONTRACTS_DIR" "$archive")/"
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

  # ── Detect-and-refuse: a chain dir with a `diamond` key in
  # addresses.json indicates a prior deploy. Re-running --phase
  # contracts without --fresh would either (a) collide on a CREATE2
  # address (Reward OApp proxy at the same REWARD_VERSION salt) or
  # (b) silently overwrite the addresses.json's CREATE-deployed keys
  # (Diamond, Timelock, VPFI lane impls) with NEW addresses while
  # keeping the prior CREATE2 keys, leaving a mixed-state set the
  # operator can't tell at a glance is internally consistent. Refuse
  # with --fresh as the explicit opt-in; with --fresh, archive the
  # prior state to .archive/<ISO-8601>/ before wiping.
  local existing_diamond
  existing_diamond=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  if [ -n "$existing_diamond" ] && [ "$existing_diamond" != "null" ]; then
    if [ "$FRESH" != "1" ]; then
      cat >&2 <<EOF
Refusing --phase contracts: $DEPLOY_DIR/addresses.json already has a
deployed Diamond at $existing_diamond.

A re-run without --fresh would either:
  - Collide on the deterministic Reward OApp proxy CREATE2 address
    (same REWARD_VERSION -> same salt -> CreateCollision in
    DeployRewardOAppCreate2). The F1 base-sepolia rehearsal hit
    this exact failure on 2026-05-10.
  - Silently overwrite the CREATE-deployed addresses.json keys
    (Diamond, Timelock, VPFI lane impls) with new addresses while
    keeping the CREATE2 keys, leaving a mixed-state set the
    operator can't tell is internally consistent.

To proceed, pass --fresh:
  bash contracts/script/deploy-testnet.sh $CHAIN_SLUG --phase contracts \\
    --confirm-i-have-multisig-ready --fresh

--fresh archives the prior chain state under
$DEPLOY_DIR/.archive/<ISO-8601>/ and reminds you to bump
REWARD_VERSION in .env so the new Reward OApp proxy lands at a
fresh CREATE2 address.
EOF
      exit 1
    fi
    # --fresh: archive + wipe.
    echo "[0a] --fresh: archiving prior chain state for $CHAIN_SLUG"
    archive_chain_state "$CHAIN_SLUG"
    echo
    echo "  ⚠ Bump REWARD_VERSION in .env before this re-deploy lands. The"
    echo "    Reward OApp proxy is CREATE2-addressed off REWARD_VERSION;"
    echo "    keeping the same value would either re-use the old (now-stale)"
    echo "    proxy or hit a CreateCollision against the prior deploy's"
    echo "    bytecode. Current REWARD_VERSION: ${REWARD_VERSION:-(unset)}"
    echo "    Suggested next: v$(date -u +%Y%m%d)-rehearsal"
    echo
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

  # Dirty-tree check is INTENTIONALLY LIFTED on testnet (deploy-mainnet.sh
  # keeps it). Testnet rehearsals routinely iterate on uncommitted
  # local changes — refusing each iteration would make the rehearsal
  # cycle unbearable. The deployment_source.json still records the
  # commit hash with a "(dirty)" suffix when the tree has uncommitted
  # changes, so post-rehearsal forensics still see the right shape;
  # the difference is that on mainnet a dirty record is unacceptable
  # (commit→bytecode equivalence is load-bearing for incident
  # response), where on testnet it's just informational.

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — contracts  ($CHAIN_SLUG)"
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
    # The RewardOApp contract enforces BASE_EID=0 on the canonical
    # chain (it IS the base, so there's no peer eid to point at).
    # The .env carries BASE_EID=40245 (the canonical eid) so mirror
    # chains can target it; override here when running on the
    # canonical itself. Mirrors deploy-chain.sh's pattern — the
    # F1 base-sepolia rehearsal hit this gap as a "Canonical chain
    # must pass BASE_EID=0" revert in DeployRewardOAppCreate2.
    export BASE_EID=0
  else
    echo
    echo "[4a] DeployVPFIMirror.s.sol"
    forge script script/DeployVPFIMirror.s.sol --rpc-url "$RPC" --broadcast --slow

    echo
    echo "[4b] DeployVPFIBuyAdapter.s.sol  (T-036 WETH-pull pre-flight enforced)"
    forge script script/DeployVPFIBuyAdapter.s.sol --rpc-url "$RPC" --broadcast --slow

    export IS_CANONICAL_REWARD=false
    # Mirror chains: BASE_EID points at the canonical's lzEid. The
    # .env value (40245 for Base Sepolia rehearsal) is correct for
    # mirrors so no override is strictly needed — set explicitly
    # for clarity rather than rely on .env being right.
    export BASE_EID=40245
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
  echo "deploy-testnet.sh — lz-config  ($CHAIN_SLUG)"
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
    bash contracts/script/deploy-testnet.sh $CHAIN_SLUG --phase swap-adapters

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
  echo "deploy-testnet.sh — swap-adapters  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"
  echo "  INITIAL_SETTLERS:           $INITIAL_SETTLERS"
  echo "  ALLOWANCE_HOLDER_OVERRIDE:  ${ALLOWANCE_HOLDER_OVERRIDE:-(default 0x…2734)}"
  echo "  ONEINCH_ROUTER_OVERRIDE:    ${ONEINCH_ROUTER_OVERRIDE:-(default 0x…2A65)}"
  echo
  forge script script/DeploySwapAdapters.s.sol --rpc-url "$RPC" --broadcast --slow
  mark_phase_done "swap-adapters"
}

# ── Phase: configure ──────────────────────────────────────────────────
# Same shape as deploy-mainnet.sh's configure phase — composes the
# four Diamond-side configure scripts via DiamondConfigSpell.s.sol.
# Practising the spell on testnet exercises the same operator-action
# count + the same ADMIN signer surface as mainnet day.

phase_configure() {
  if phase_already_done "configure"; then
    cat >&2 <<EOF
Refusing --phase configure: marker file exists at
  $MARKERS_DIR/phase-configure.done
The four configures already landed for $CHAIN_SLUG. Re-running would
re-broadcast every set*-call against the Diamond. If a re-run is
genuinely needed, remove the marker manually:
  rm $MARKERS_DIR/phase-configure.done
then re-run.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — configure  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"

  forge script script/DiamondConfigSpell.s.sol \
    --rpc-url "$RPC" --broadcast --slow

  mark_phase_done "configure"
}

# ── Phase: handover ───────────────────────────────────────────────────
# Same shape as deploy-mainnet.sh's handover phase (see Handover.s.sol
# for the full rationale). Practising it on testnet under the same
# confirm-flag friction is the whole point of the rehearsal: any
# misconfig in DEFAULT_ADMIN_ADDRESS / PAUSER_ADDRESS / Timelock
# gets caught here, where the only cost is faucet ETH.

phase_handover() {
  if [ "$CONFIRM_MULTISIG" != "1" ]; then
    cat >&2 <<EOF
Refusing --phase handover without --confirm-i-have-multisig-ready.

This phase rotates DEFAULT_ADMIN_ROLE / Timelock-bound roles /
PAUSER_ROLE / ERC-173 ownership / OApp ownership off ADMIN. The
multi-party Safe ceremony that follows (acceptOwnership on each
OApp + DeployerZeroRolesTest as exit gate) MUST run within the
Ownable2Step pending-owner window — i.e. the multisig signers
need to be reachable.

Re-run with --confirm-i-have-multisig-ready once they are.
EOF
    exit 1
  fi

  if phase_already_done "handover"; then
    cat >&2 <<EOF
Refusing --phase handover: marker file exists at
  $MARKERS_DIR/phase-handover.done
indicating roles + ownership were already rotated. If the marker
is stale (script aborted mid-flight), inspect addresses.json +
on-chain state, then either remove the marker manually or run a
corrective script.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — handover  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"

  CHAIN_SLUG="$CHAIN_SLUG" forge script script/Handover.s.sol \
    --rpc-url "$RPC" --broadcast --slow

  snapshot_addresses "post-handover"
  mark_phase_done "handover"

  echo
  echo "✓ handover phase done. Multi-sig follow-up:"
  echo "  1. acceptOwnership() on each OApp via the governance Safe UI"
  echo "     — calldata + addresses are printed above."
  echo "  2. Run DeployerZeroRolesTest as the hard exit gate:"
  echo "       forge test --match-path test/DeployerZeroRolesTest.t.sol \\"
  echo "         --fork-url \$$RPC_VAR"
  echo "     The test must pass before this chain is considered handed-off."
}

# ── Phase: abi-sync ───────────────────────────────────────────────────

phase_abi_sync() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — abi-sync"
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
  # name (lz-watcher's mainnet-only shortKey filter, etc.). The
  # lz-watcher emitter writes to a gitignored sidecar; it never
  # auto-applies (secrets-bearing wrangler-secret-put commands stay
  # a deliberate operator action). Practising this auto-export step
  # on testnet is part of the "no surprises on mainnet" rehearsal.
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
  echo "deploy-testnet.sh — cf-defi"
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
  echo "deploy-testnet.sh — cf-www"
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
    echo "  RPC secrets are operator-curated wrangler secrets, never in the repo."
    echo "  For testnet rehearsals a free-tier RPC URL is acceptable (Alchemy /"
    echo "  Infura free tier work fine); on mainnet, paid-tier API keys are"
    echo "  required per CLAUDE.md so the cron isn't throttled mid-broadcast."
    return 1
  fi
  echo "  ✓ $secret_name is set on $worker_name"
  return 0
}

# Map testnet chain-slug → expected RPC secret name. Same secret name
# on each Worker (each Worker has its own copy in its own Cloudflare
# secret store; the name is shared but the values are scoped per Worker).
# Mirrors deploy-chain.sh's mapping so a Worker's secret store is the
# same shape no matter which deploy script populates it.
case "$CHAIN_SLUG" in
  base-sepolia)  EXPECTED_RPC_SECRET="RPC_BASE_SEPOLIA" ;;
  sepolia)       EXPECTED_RPC_SECRET="RPC_SEPOLIA" ;;
  arb-sepolia)   EXPECTED_RPC_SECRET="RPC_ARB_SEPOLIA" ;;
  op-sepolia)    EXPECTED_RPC_SECRET="RPC_OP_SEPOLIA" ;;
  bnb-testnet)   EXPECTED_RPC_SECRET="RPC_BNB_TESTNET" ;;
  polygon-amoy)  EXPECTED_RPC_SECRET="RPC_POLYGON_AMOY" ;;
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
  echo "deploy-testnet.sh — cf-keeper"
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
  echo "deploy-testnet.sh — cf-indexer"
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
  echo "deploy-testnet.sh — cf-agent"
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
  echo "deploy-testnet.sh — verify  ($CHAIN_SLUG)"
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

# ── Phase: pause-rehearsal (testnet-only) ─────────────────────────────
# Penpie-style sub-5-minute simultaneous-pause drill. Reads
# addresses.json on this chain, picks out every Vaipakam-controlled
# contract that exposes `pause()` (Diamond + every LZ OApp/OFT), and
# either prints calldata for the operator's Pauser Safe to sign, or
# reads paused() across all of them to verify the drill landed in
# under 5 minutes, or prints the inverse calldata for the rehearsal
# cleanup.
#
# This is intentionally a "print + read" surface, not "broadcast":
#   - The Pauser Safe is the on-chain authority. The script never has
#     a private key for it; it just supplies the calldata.
#   - Practising the calldata-paste path on testnet is exactly what
#     the operator will do on mainnet during a real incident.
#
# Contracts pauseable on this chain (resolved from addresses.json):
#   - diamond            (Diamond — PausableFacet.pause())
#   - rewardOApp         (RewardOApp — Pausable inherited)
#   - vpfiOftAdapter     (canonical VPFI lane only)  OR
#     vpfiMirror         (mirror VPFI lane only)
#   - vpfiBuyReceiver    (canonical VPFI buy receiver only)  OR
#     vpfiBuyAdapter     (mirror VPFI buy adapter only)
#
# Sentinel file (records drill start time):
#   $DEPLOY_DIR/.markers/pause-rehearsal-$slug-started.epoch

phase_pause_rehearsal() {
  if [ ! -f "$DEPLOY_DIR/addresses.json" ]; then
    echo "Error: $DEPLOY_DIR/addresses.json not found — was --phase contracts run?" >&2
    exit 1
  fi

  # Discover pauseable contracts by intersecting addresses.json keys
  # with the known-pauseable set. Skip null / missing entries cleanly
  # so canonical chains skip the mirror keys and vice versa.
  local PAUSE_TARGETS=()
  for KEY in diamond rewardOApp vpfiOftAdapter vpfiMirror vpfiBuyReceiver vpfiBuyAdapter; do
    local ADDR=$(jq -r --arg k "$KEY" '.[$k] // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null)
    if [ -n "$ADDR" ] && [ "$ADDR" != "null" ]; then
      PAUSE_TARGETS+=("$KEY:$ADDR")
    fi
  done

  if [ ${#PAUSE_TARGETS[@]} -eq 0 ]; then
    echo "Error: no pauseable contracts found in $DEPLOY_DIR/addresses.json." >&2
    echo "       Run --phase contracts first."
    exit 1
  fi

  local SENTINEL="$MARKERS_DIR/pause-rehearsal-$CHAIN_SLUG-started.epoch"
  local PAUSE_BUDGET_S=300   # 5-minute hard budget (Penpie post-mortem)

  case "$PAUSE_MODE" in
    calldata)
      echo "═══════════════════════════════════════════════════════════════"
      echo "deploy-testnet.sh — pause-rehearsal  ($CHAIN_SLUG / $CHAIN_ID)"
      echo "  THIS IS A DRILL. Practising the Pauser-Safe sign path."
      echo "  Hard budget: ${PAUSE_BUDGET_S}s wall-clock from this banner"
      echo "  to all contracts paused on this chain."
      echo "═══════════════════════════════════════════════════════════════"
      echo
      # `pause()` selector = 0x8456cb59 (keccak256("pause()") truncated).
      # No args, so calldata is the bare 4-byte selector.
      local PAUSE_SELECTOR
      PAUSE_SELECTOR=$(cast sig 'pause()' 2>/dev/null || echo "0x8456cb59")
      echo "Sign these via Pauser Safe (UI → New Transaction → Contract Interaction):"
      echo
      printf "  %-22s %s\n" "Contract" "to / data"
      printf "  %-22s %s\n" "----------------------" "-------------------------------------------"
      for ENTRY in "${PAUSE_TARGETS[@]}"; do
        local KEY="${ENTRY%%:*}"
        local ADDR="${ENTRY#*:}"
        printf "  %-22s to=%s\n" "$KEY" "$ADDR"
        printf "  %-22s data=%s\n" "" "$PAUSE_SELECTOR"
        echo
      done
      date +%s > "$SENTINEL"
      echo "Drill started at $(date -d "@$(cat "$SENTINEL")" '+%Y-%m-%d %H:%M:%S %Z')"
      echo "When the Safe-signed pause txs land, re-run with:"
      echo "  bash contracts/script/deploy-testnet.sh $CHAIN_SLUG --phase pause-rehearsal --mode check"
      ;;

    check)
      if [ ! -f "$SENTINEL" ]; then
        echo "Error: no drill-start sentinel at $SENTINEL." >&2
        echo "       Run --phase pause-rehearsal --mode calldata first." >&2
        exit 1
      fi
      local STARTED_AT
      STARTED_AT=$(cat "$SENTINEL")
      local NOW=$(date +%s)
      local ELAPSED=$((NOW - STARTED_AT))

      echo "═══════════════════════════════════════════════════════════════"
      echo "deploy-testnet.sh — pause-rehearsal CHECK  ($CHAIN_SLUG)"
      echo "  Drill started:   $(date -d "@$STARTED_AT" '+%Y-%m-%d %H:%M:%S %Z')"
      echo "  Elapsed:         ${ELAPSED}s   (budget: ${PAUSE_BUDGET_S}s)"
      echo "═══════════════════════════════════════════════════════════════"

      local ALL_PAUSED=1
      for ENTRY in "${PAUSE_TARGETS[@]}"; do
        local KEY="${ENTRY%%:*}"
        local ADDR="${ENTRY#*:}"
        local PAUSED
        PAUSED=$(cast call "$ADDR" 'paused()(bool)' --rpc-url "$RPC" 2>/dev/null || echo "?")
        if [ "$PAUSED" = "true" ]; then
          printf "  ✓ %-22s paused=true   ($ADDR)\n" "$KEY"
        else
          printf "  ✗ %-22s paused=%s  ($ADDR)\n" "$KEY" "$PAUSED"
          ALL_PAUSED=0
        fi
      done

      echo
      if [ "$ALL_PAUSED" = "1" ] && [ "$ELAPSED" -le "$PAUSE_BUDGET_S" ]; then
        echo "✓ DRILL PASS — every contract paused, ${ELAPSED}s ≤ ${PAUSE_BUDGET_S}s budget."
        echo "  Next: --mode unpause-calldata to clean up."
      elif [ "$ALL_PAUSED" = "1" ]; then
        echo "⚠ DRILL OVER-BUDGET — every contract paused, but ${ELAPSED}s > ${PAUSE_BUDGET_S}s."
        echo "  On mainnet this would mean drainable contracts during the gap."
        echo "  Investigate: Pauser Safe quorum, signer availability, Safe UI"
        echo "  latency, RPC latency. Re-rehearse until under budget."
      else
        echo "✗ DRILL FAIL — at least one contract is NOT paused."
        echo "  Investigate the unpaused contract above. Did the Safe tx revert?"
        echo "  Did the Pauser Safe lack PAUSER_ROLE on this chain? Did the"
        echo "  operator paste the wrong calldata?"
        exit 1
      fi
      ;;

    unpause-calldata)
      echo "═══════════════════════════════════════════════════════════════"
      echo "deploy-testnet.sh — pause-rehearsal UNPAUSE-CALLDATA  ($CHAIN_SLUG)"
      echo "  Cleanup phase. Sign these via Pauser Safe to unpause."
      echo "═══════════════════════════════════════════════════════════════"
      echo
      local UNPAUSE_SELECTOR
      UNPAUSE_SELECTOR=$(cast sig 'unpause()' 2>/dev/null || echo "0x3f4ba83a")
      printf "  %-22s %s\n" "Contract" "to / data"
      printf "  %-22s %s\n" "----------------------" "-------------------------------------------"
      for ENTRY in "${PAUSE_TARGETS[@]}"; do
        local KEY="${ENTRY%%:*}"
        local ADDR="${ENTRY#*:}"
        printf "  %-22s to=%s\n" "$KEY" "$ADDR"
        printf "  %-22s data=%s\n" "" "$UNPAUSE_SELECTOR"
        echo
      done
      # Clear the sentinel so a future drill starts fresh.
      rm -f "$SENTINEL"
      ;;

    *)
      echo "Error: --mode '$PAUSE_MODE' not recognized." >&2
      echo "       Valid modes: calldata (default), check, unpause-calldata" >&2
      exit 1
      ;;
  esac
}

# ── Dispatch ──────────────────────────────────────────────────────────

case "$PHASE" in
  preflight)        phase_preflight ;;
  contracts)        phase_contracts ;;
  lz-config)        phase_lz_config ;;
  swap-adapters)    phase_swap_adapters ;;
  configure)        phase_configure ;;
  handover)         phase_handover ;;
  abi-sync)         phase_abi_sync ;;
  cf-defi)          phase_cf_defi ;;
  cf-www)           phase_cf_www ;;
  cf-keeper)        phase_cf_keeper ;;
  cf-indexer)       phase_cf_indexer ;;
  cf-agent)         phase_cf_agent ;;
  verify)           phase_verify ;;
  pause-rehearsal)  phase_pause_rehearsal ;;
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
