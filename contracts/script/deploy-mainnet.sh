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
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase ccip-wire
#       Runs ConfigureCcip.s.sol — wires CCIP chain selectors, remote
#       messengers, the vpfi-buy / vpfi-reward channel peers, the
#       per-lane TokenPool rate limits (via VpfiPoolRateGovernor), and
#       the TokenAdminRegistry CCT registration. Reads every chain's
#       addresses.json, so run it only after --phase contracts has
#       landed on EVERY chain in the topology. CCIP_LANE_CHAIN_IDS must
#       list the remote chains. CCIP has no DVN policy to review —
#       Chainlink operates a uniform committing/executing DON + RMN.
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
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase configure
#       Runs DiamondConfigSpell.s.sol — composes the four Diamond-side
#       configure scripts (ConfigureOracle / ConfigureRewardReporter /
#       ConfigureVPFIBuy / ConfigureNFTImageURIs) into a single
#       operator-action that lands all four sequentially. Each child
#       broadcasts as ADMIN_PRIVATE_KEY; if any reverts, Foundry stops
#       the script so the operator can't accidentally skip the failed
#       subset. Run BEFORE --phase handover so the configs land while
#       ADMIN still holds every Diamond role.
#
#   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase handover \
#                                           --confirm-i-have-multisig-ready
#       Runs Handover.s.sol — rotates DEFAULT_ADMIN_ROLE → governance
#       Safe (direct, no Timelock delay), the five Timelock-bound
#       roles → Timelock, PAUSER_ROLE → Pauser Safe (direct, fast
#       incident lever), ERC-173 Diamond ownership → Timelock, and
#       every LZ OApp's Ownable2Step ownership → governance Safe
#       (first leg only — the Safe must call acceptOwnership() on
#       each before the transfer takes effect; the script prints the
#       calldata to paste into the Safe UI). Then ADMIN renounces
#       every role it held except WATCHER + NOTIF_BILLER (those get
#       rotated to per-bot EOAs separately via the keeper-auth flow).
#       The DeployerZeroRolesTest hard exit gate runs after the
#       multisig accepts every OApp's pending ownership.
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
#       sub-5-minute N-chain simultaneous-pause drill (cross-chain-incident-style
#       defense rehearsal). On mainnet a pause is a real incident
#       lever and runs from `pause-all-chains.sh`, not from a deploy
#       script.
#
# What this script does NOT do (and never should):
#   - Role rotation to multisig + timelock — multi-party ceremony.
#     See DeploymentRunbook §6. The signers run grantRole +
#     renounceRole one at a time after this script lands `--phase
#     contracts`.
#   - CCIP lane / channel wiring across chains is the `ccip-wire`
#     phase — but it must run AFTER --phase contracts has landed on
#     every chain in the topology (ConfigureCcip reads each chain's
#     addresses.json), so it is a deliberate post-all-chains pass.
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
  ethereum  base  arbitrum  optimism  bnb  polygon

Phases:
  preflight       — Read-only, run first. No broadcasts.
  contracts       — Diamond + Timelock + CCIP cross-chain stack.
                    Requires --confirm-i-have-multisig-ready
  ccip-wire       — CCIP lane / channel wiring via ConfigureCcip.s.sol.
                    Run after `contracts` has landed on every chain.
  swap-adapters   — Phase 7a aggregator adapters via
                    DeploySwapAdapters.s.sol. Requires
                    INITIAL_SETTLERS env var.
  configure       — DiamondConfigSpell: ConfigureOracle +
                    ConfigureRewardReporter + ConfigureVPFIBuy +
                    ConfigureNFTImageURIs in one operator-action.
  handover        — Rotate roles + ownership to governance topology.
                    Requires --confirm-i-have-multisig-ready
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
CONFIRM_ORPHANS=0
FRESH=0
CONFIRM_PURGE_MAINNET=0
CONFIRM_HW_SIGNER=0
CONFIRM_DEADLINE_RESET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      shift
      PHASE="$1"
      ;;
    --confirm-i-have-multisig-ready) CONFIRM_MULTISIG=1 ;;
    --fresh)                         FRESH=1 ;;
    # MAINNET-only second gate. --fresh on mainnet wipes the
    # canonical deploy from this chain's directory; this confirm
    # asserts the operator has reviewed the archived state and
    # genuinely intends to abandon the prior on-chain deploy.
    --confirm-purging-prior-mainnet-deploy) CONFIRM_PURGE_MAINNET=1 ;;
    --confirm-orphans-prior-onchain-state)  CONFIRM_ORPHANS=1 ;;
    # Ratified 2026-05-14 — operator's signed statement that the
    # Admin EOA's signing path is a hardware wallet, not a .env
    # hot key. The script can't verify the signing path directly,
    # but the flag's presence is recorded in .markers/ for the
    # audit trail.
    --confirm-mainnet-hardware-signer) CONFIRM_HW_SIGNER=1 ;;
    # Operator's intentional override of the 48h handover deadline
    # (e.g. config truly took longer than 48h for legitimate
    # reasons — a chain bridge outage, an LZ DVN re-config).
    # Resetting the timestamp restarts the 48h window. Logged in
    # .markers/ for the audit trail.
    --reset-handover-deadline) CONFIRM_DEADLINE_RESET=1 ;;
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
# (#687-A removed the cross-chain VPFI buy adapter; the per-chain
# WETH-pull payment-token column it required is gone.)

case "$CHAIN_SLUG" in
  ethereum)
    CHAIN_ID=1;       RPC_VAR="ETHEREUM_RPC_URL";      IS_CANONICAL=0; CCIP_SLUG="ETHEREUM" ;;
  base)
    CHAIN_ID=8453;    RPC_VAR="BASE_RPC_URL";          IS_CANONICAL=1; CCIP_SLUG="BASE" ;;
  arbitrum)
    CHAIN_ID=42161;   RPC_VAR="ARBITRUM_RPC_URL";      IS_CANONICAL=0; CCIP_SLUG="ARBITRUM" ;;
  optimism)
    CHAIN_ID=10;      RPC_VAR="OPTIMISM_RPC_URL";      IS_CANONICAL=0; CCIP_SLUG="OPTIMISM" ;;
  polygon-zkevm)
    cat >&2 <<EOF
Refusing to run 'polygon-zkevm' from deploy-mainnet.sh.

zk-rollup chains are excluded from Vaipakam's cross-chain set by operator
decision — see LayerZeroToChainlinkCcipMigration.md §10. There is no CCIP
chain selector for chain 1101, so the 'ccip-wire' phase could not wire it;
the chain is intentionally not a deploy target.
EOF
    exit 1
    ;;
  bnb)
    CHAIN_ID=56;      RPC_VAR="BNB_RPC_URL";           IS_CANONICAL=0; CCIP_SLUG="BNB" ;;
  polygon)
    CHAIN_ID=137;     RPC_VAR="POLYGON_RPC_URL";       IS_CANONICAL=0; CCIP_SLUG="POLYGON" ;;
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

# Per-chain CCIP infrastructure dispatch. The CCIP scripts read a
# single CCIP_ROUTER / CCIP_RMN_PROXY (the `contracts` phase) and
# CCIP_TOKEN_ADMIN_REGISTRY / CCIP_REGISTRY_MODULE_OWNER_CUSTOM (the
# `ccip-wire` phase), each the active chain's. All four differ per
# chain — Ethereum, Base, Arbitrum, Optimism, BNB, Polygon each have a
# distinct CCIP Router / RMN proxy / registry — so the .env carries a
# `<VAR>_<SLUG>` entry per chain and the active chain's set is resolved
# here.
#
# On mainnet a bare `CCIP_*` is NOT a safe fallback: if the per-slug var
# for the selected chain is missing, that bare value silently applies
# SOME OTHER chain's router / registry to this deploy — a miswired
# cross-chain lane that preflight (presence-only) would not catch. So a
# bare `CCIP_*` with no matching `<VAR>_<SLUG>` is a hard error here.
for _ccip_var in CCIP_ROUTER CCIP_RMN_PROXY \
                 CCIP_TOKEN_ADMIN_REGISTRY CCIP_REGISTRY_MODULE_OWNER_CUSTOM; do
  _ccip_slug_var="${_ccip_var}_${CCIP_SLUG}"
  if [ -n "${!_ccip_slug_var:-}" ]; then
    export "$_ccip_var"="${!_ccip_slug_var}"
  elif [ -n "${!_ccip_var:-}" ]; then
    echo "Error: $_ccip_slug_var is not set in .env, but a bare $_ccip_var is —" >&2
    echo "       that would wire the WRONG chain's CCIP address into the" >&2
    echo "       $CHAIN_SLUG deploy. Set $_ccip_slug_var explicitly." >&2
    exit 1
  fi
  # If neither is set, $_ccip_var stays unset — the env preflight / the
  # phase's own checks report it as a plain missing var.
done

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

# ── Preflight gate ────────────────────────────────────────────────────
# The phase dispatcher does NOT enforce that `--phase preflight` ran
# before a broadcasting phase — an operator can invoke `contracts`,
# `ccip-wire`, `swap-adapters`, `configure` or `handover` directly. So
# the two safety checks that MUST hold before any broadcast — the RPC
# actually serves the expected chain, and the mainnet hardware-signer
# attestation — are factored here and re-run at the top of every
# broadcasting phase. `phase_preflight` calls the same gate, then adds
# its fuller (env-presence / balance / WETH) checks.

_assert_rpc_chain() {
  # A mispointed RPC URL is the single most dangerous deploy mistake —
  # broadcasting a chain's deploy against the wrong network. Re-checked
  # before every broadcast, not just in the optional preflight phase.
  local hex dec
  hex=$(curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" \
    | sed -E 's/.*"result":"([^"]+)".*/\1/' || true)
  dec=$(printf "%d\n" "$hex" 2>/dev/null || echo 0)
  if [ "$dec" != "$CHAIN_ID" ]; then
    echo "FAIL: $RPC_VAR points at chainId=$dec, expected $CHAIN_ID for '$CHAIN_SLUG'." >&2
    exit 1
  fi
  echo "  ✓ RPC chainId matches  ($CHAIN_ID)"
}

_assert_mainnet_hw_signer() {
  # The Admin EOA holds ADMIN_ROLE / ORACLE_ADMIN_ROLE / etc. through
  # the entire config window between `--phase contracts` and `--phase
  # handover` (hours-to-days). A hot .env key compromised in that window
  # = full protocol control to the attacker. Refuse to broadcast on
  # mainnet unless the operator has attested to a hardware signer — the
  # `--confirm-mainnet-hardware-signer` flag is that signed statement
  # (the script can't verify the signing path directly; `.markers/`
  # records the flag was passed).
  if [ "$CONFIRM_HW_SIGNER" != "1" ]; then
    cat >&2 <<EOF

FAIL: mainnet broadcast requires the hardware-wallet attestation.

Refusing to broadcast with ADMIN_PRIVATE_KEY sourced from .env on
MAINNET. Re-run with --confirm-mainnet-hardware-signer once the Admin
EOA's signing path is a hardware wallet (Ledger / Trezor / Frame / …).
EOF
    exit 1
  fi
  echo "  ✓ Mainnet hardware-signer attestation passed"
}

# The critical gate every broadcasting phase runs first.
_preflight_gate() {
  _assert_rpc_chain
  _assert_mainnet_hw_signer
}

# ── Phase: preflight ──────────────────────────────────────────────────

phase_preflight() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — preflight  ($CHAIN_SLUG / $CHAIN_ID)"
  echo "═══════════════════════════════════════════════════════════════"

  # 1. The critical gate — RPC chain match + mainnet hardware-signer.
  _preflight_gate

  # 2. Required env vars
  MISSING=()
  for v in DEPLOYER_PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
           VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER \
           TIMELOCK_PROPOSER CCIP_ROUTER CCIP_RMN_PROXY; do
    if [ -z "${!v:-}" ]; then MISSING+=("$v"); fi
  done
  # Mirror chains need BASE_CHAIN_ID — canonical Base's EVM chain id —
  # for DeployCrosschain to wire the reward flow back to Base.
  if [ "$IS_CANONICAL" = "0" ] && [ -z "${BASE_CHAIN_ID:-}" ]; then
    MISSING+=("BASE_CHAIN_ID  (REQUIRED on mirror chains — canonical Base chain id, 8453)")
  fi
  if [ ${#MISSING[@]} -ne 0 ]; then
    echo "FAIL: required env vars missing in .env:"
    for v in "${MISSING[@]}"; do echo "    - $v"; done
    exit 1
  fi
  echo "  ✓ Required env vars present"

  # 3. Deployer balance
  DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null || echo "?")
  BAL=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC" 2>/dev/null || echo "?")
  echo "  ✓ Deployer:  $DEPLOYER_ADDR    balance: $BAL wei"

  echo
  echo "preflight OK. Next: --phase contracts --confirm-i-have-multisig-ready"
}

# ── Helper: archive existing chain state under .archive/<ISO-8601>/ ──
# Same shape as deploy-testnet.sh's archive_chain_state — moves the
# state surface (addresses.json + deployment_source.json + .markers
# + .history + addresses.prior-rehearsal.* sidecars) into a single
# timestamped subdirectory, then re-creates empty .markers + .history
# scaffolding. On MAINNET this is a high-blast-radius action: it
# logically abandons the prior on-chain deploy. Gated behind
# --fresh + --confirm-purging-prior-mainnet-deploy so a typo on
# mainnet day cannot rotate the diamond.
archive_chain_state() {
  local chain_slug="$1"
  local deploy_dir="$CONTRACTS_DIR/deployments/$chain_slug"
  local stamp
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  local archive="$deploy_dir/.archive/$stamp"

  mkdir -p "$archive"
  for entry in addresses.json deployment_source.json .markers .history; do
    if [ -e "$deploy_dir/$entry" ]; then
      mv "$deploy_dir/$entry" "$archive/" 2>/dev/null || true
    fi
  done
  for prior in "$deploy_dir"/addresses.prior-rehearsal.*.json; do
    [ -f "$prior" ] && mv "$prior" "$archive/" 2>/dev/null || true
  done
  mkdir -p "$deploy_dir/.markers" "$deploy_dir/.history"

  echo "  ✓ archived prior chain state -> $(realpath --relative-to="$CONTRACTS_DIR" "$archive")/"
}

# ── Phase: contracts ──────────────────────────────────────────────────

phase_contracts() {
  _preflight_gate
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

  # ── VPFI re-mint preflight (#853 Codex P2) ──────────────────────
  # DeployVPFIToken's [3b] no-overwrite guard aborts (correctly) when a canonical
  # `.vpfiToken` is already recorded — but [3b] runs AFTER [2] Diamond + [3]
  # Timelock broadcast, so a late abort would leave a PARTIAL mainnet deploy.
  # Catch every one of [3b]'s abort conditions HERE, before any broadcast AND
  # before the --fresh archive wipes the artifact: a canonical chain whose
  # addresses.json already carries `.vpfiToken` must opt into a rotation to
  # re-mint, else refuse up-front. Covers BOTH the --fresh re-deploy and the
  # pre-seeded-token (`.vpfiToken` present, no `.diamond` yet) cases. On --fresh
  # WITH the force flag the [0a] archive clears `.vpfiToken`, so [3b] then mints
  # the rotated token cleanly.
  if [ "$IS_CANONICAL" = "1" ]; then
    local preseeded_vpfi
    preseeded_vpfi=$(jq -r '.vpfiToken // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
    if [ -n "$preseeded_vpfi" ] && [ "$preseeded_vpfi" != "null" ] && [ "${VPFI_TOKEN_FORCE_REDEPLOY:-0}" != "1" ]; then
      echo "ERROR: a canonical VPFI token ($preseeded_vpfi) is already recorded on $CHAIN_SLUG." >&2
      echo "       Proceeding would run [3b] DeployVPFIToken, whose no-overwrite guard aborts" >&2
      echo "       AFTER Diamond + Timelock broadcast — a partial deploy. Refusing up-front." >&2
      echo "       To deliberately rotate the canonical token re-run with" >&2
      echo "       VPFI_TOKEN_FORCE_REDEPLOY=1; otherwise carry the existing token forward." >&2
      exit 1
    fi
  fi

  # ── Detect-and-refuse on a chain dir with a deployed Diamond ─────
  # Same shape as deploy-testnet.sh's gate but with a SECOND mainnet-
  # only confirm flag (--confirm-purging-prior-mainnet-deploy) on top
  # of --fresh. On mainnet, --fresh + the second confirm is the
  # operator's affirmative "yes, I am abandoning the prior on-chain
  # deploy and I have reviewed the archive". Without both, the
  # script refuses.
  local existing_diamond
  existing_diamond=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  if [ -n "$existing_diamond" ] && [ "$existing_diamond" != "null" ]; then
    if [ "$FRESH" != "1" ] || [ "$CONFIRM_PURGE_MAINNET" != "1" ]; then
      cat >&2 <<EOF
Refusing --phase contracts: $DEPLOY_DIR/addresses.json already has a
deployed Diamond at $existing_diamond.

A re-run without the --fresh dance would silently overwrite the
deployed addresses.json keys (Diamond, Timelock, CCIP-stack proxies)
with new addresses, leaving a mixed-state artifact the operator can't
tell at a glance is internally consistent.

To proceed (HIGH BLAST RADIUS — abandons the prior on-chain deploy):
  bash contracts/script/deploy-mainnet.sh $CHAIN_SLUG --phase contracts \\
    --confirm-i-have-multisig-ready \\
    --fresh \\
    --confirm-purging-prior-mainnet-deploy

Both --fresh AND --confirm-purging-prior-mainnet-deploy are required
on mainnet. --fresh archives the prior chain state under
$DEPLOY_DIR/.archive/<ISO-8601>/. The second confirm asserts you
have reviewed the archive and genuinely intend to walk away from the
prior on-chain deploy.

Bump REWARD_VERSION in .env before re-running so the new Reward OApp
proxy lands at a fresh CREATE2 address. Current REWARD_VERSION:
${REWARD_VERSION:-(unset)}
EOF
      exit 1
    fi
    # ── Orphan-state guard (mirror of deploy-testnet.sh:617) ────
    # Mainnet: refuse --fresh if the existing on-chain Diamond has
    # live offers/loans, unless the operator explicitly opts in.
    # Same bug class as the 2026-05-11 arb-sepolia incident — but on
    # mainnet the consequence is real-money offers/loans going
    # invisible to every off-chain consumer.
    PRIOR_DIAMOND=""
    if [ -f "$DEPLOY_DIR/addresses.json" ]; then
      PRIOR_DIAMOND=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null)
    fi
    if [ -n "$PRIOR_DIAMOND" ] && [ "$PRIOR_DIAMOND" != "null" ]; then
      ACTIVE_OFFERS=$(cast call "$PRIOR_DIAMOND" 'getActiveOffersCount()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo "?")
      ACTIVE_LOANS=$(cast call "$PRIOR_DIAMOND" 'getActiveLoansCount()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo "?")
      if [ "$ACTIVE_OFFERS" != "0" ] && [ "$ACTIVE_OFFERS" != "?" ] && [ -n "$ACTIVE_OFFERS" ] || \
         [ "$ACTIVE_LOANS" != "0" ] && [ "$ACTIVE_LOANS" != "?" ] && [ -n "$ACTIVE_LOANS" ]; then
        if [ "$CONFIRM_ORPHANS" != "1" ]; then
          cat >&2 <<EOF
Refusing mainnet --fresh for $CHAIN_SLUG: prior Diamond at $PRIOR_DIAMOND
has live on-chain state.

  Active offers: $ACTIVE_OFFERS
  Active loans:  $ACTIVE_LOANS

THIS IS REAL-MONEY MAINNET STATE. A --fresh archives off-chain
artifacts but cannot wipe Diamond storage. Post-deploy, those
offers/loans still exist on the prior Diamond, but every off-chain
consumer (indexer, frontend, keeper) is now pointed at the NEW
Diamond. User-visible result: "my offer disappeared, my loan
balance is gone" — followed by a support escalation.

If this is a planned migration where users have been notified and
the prior Diamond's state is being intentionally walked away from,
re-run with all three flags:
  --fresh
  --confirm-purging-prior-mainnet-deploy
  --confirm-orphans-prior-onchain-state

The third flag exists so that "yes, I am orphaning $ACTIVE_OFFERS
real offers and $ACTIVE_LOANS real loans on $CHAIN_SLUG mainnet" is
a deliberate three-step operator action.
EOF
          exit 1
        fi
        echo "  ⚠ MAINNET orphan: $ACTIVE_OFFERS active offer(s) + $ACTIVE_LOANS active loan(s)"
        echo "    on prior Diamond $PRIOR_DIAMOND will become invisible to off-chain consumers"
        echo "    (operator confirmed via --confirm-orphans-prior-onchain-state)"
      fi
    fi
    # (The canonical VPFI re-mint refusal ran in preflight above, before any
    # broadcast AND before this archive — see the "VPFI re-mint preflight" gate.)
    echo "[0a] --fresh + --confirm-purging-prior-mainnet-deploy: archiving prior chain state for $CHAIN_SLUG"
    archive_chain_state "$CHAIN_SLUG"
    echo
    echo "  ⚠ Bump REWARD_VERSION in .env before this re-deploy lands."
    echo "    Current REWARD_VERSION: ${REWARD_VERSION:-(unset)}"
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
  echo "[1b] Pre-deploy sanity check"
  # Deploy-sanity forge suite (facet sizes + selector coverage) + deploy
  # shell-script lint + committed-ABI sync. `--full` additionally runs
  # the entire regression suite — a mainnet deploy must not ship red
  # contracts. A failure aborts the deploy before any broadcast.
  bash "$SCRIPT_DIR/predeploy-check.sh" --full

  # Arbitrum L2-block override (#853 Codex P2): forge sim can't emulate
  # `ArbSys(0x64)`, so `Deployments.currentL2Block()` reverts on Arbitrum unless
  # `ARB_L2_DEPLOY_BLOCK` is set. Derive it from THIS chain's RPC (returns the L2
  # head on Arbitrum) BEFORE the broadcast so the diamond can't land and then
  # abort before `addresses.json` is written.
  if [ "$CHAIN_ID" = "42161" ]; then
    ARB_L2_DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)"
    if [ -z "$ARB_L2_DEPLOY_BLOCK" ]; then
      echo "ERROR: could not fetch Arbitrum L2 block from \$RPC for ARB_L2_DEPLOY_BLOCK" >&2
      exit 1
    fi
    export ARB_L2_DEPLOY_BLOCK
    echo "[2·arb] ARB_L2_DEPLOY_BLOCK=$ARB_L2_DEPLOY_BLOCK (forge-sim ArbSys fallback)"
  fi

  echo
  echo "[2] DeployDiamond.s.sol"
  forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow

  echo
  echo "[3] DeployTimelock.s.sol"
  forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow

  # [3b] Canonical VPFI token — MUST land BEFORE DeployCrosschain, whose
  # canonical branch (Base) reads `.vpfiToken` to wrap the existing token in the
  # CCIP LockRelease pool; nothing upstream mints it, so a fresh Base mainnet run
  # fails at [4] without this step (#853 Codex P1). Mirror chains skip it — they
  # mint their own Burn/Mint VPFIMirrorToken inside [4]. DeployVPFIToken itself
  # hard-guards to canonical chain ids, so this IS_CANONICAL gate is
  # belt-and-suspenders. The duplicate-mint refusal for a --fresh re-deploy is
  # enforced in the "VPFI re-mint preflight" gate, before any broadcast — refusing here
  # would leave a partial deploy since [2]/[3] already landed (#853 Codex P2).
  if [ "$IS_CANONICAL" = "1" ]; then
    echo
    echo "[3b] DeployVPFIToken.s.sol  (canonical VPFI — before crosschain)"
    forge script script/DeployVPFIToken.s.sol --rpc-url "$RPC" --broadcast --slow
  fi

  # DeployCrosschain.s.sol deploys the whole T-068 CCIP stack for this
  # chain in one run — CcipMessenger, the VPFI CCIP TokenPool
  # (lock/release on canonical Base, burn/mint on a mirror), the
  # VpfiPoolRateGovernor, the VaipakamRewardMessenger, and the buy
  # receiver (canonical) or mirror VPFI + buy adapter (mirror). It
  # selects canonical-vs-mirror from block.chainid.
  #
  # CCIP rate limits are a per-lane TokenPool concern, set via the
  # bounds-checked VpfiPoolRateGovernor in the `ccip-wire` phase — there
  # is no per-adapter setRateLimits step any more.
  echo
  echo "[4] DeployCrosschain.s.sol  (CCIP cross-chain stack)"
  forge script script/DeployCrosschain.s.sol --rpc-url "$RPC" --broadcast --slow

  echo
  echo "✓ contracts phase done."
  snapshot_addresses "post-contracts"
  # Write deployment_source.json (commit + deployer + timestamp) —
  # same shape as deploy-chain.sh writes, so the operator can see
  # at a glance which monorepo commit is live on this chain.
  DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY" 2>/dev/null || echo "?")
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

  # Ratified 2026-05-14 — 48h Admin EOA → Multisig handover deadline.
  # Write the timestamp at which the Admin EOA TOOK OWNERSHIP of the
  # newly-deployed Diamond. From here forward, the entire config
  # window (LZ wiring, oracle config, peer protocols, NFT URIs, VPFI
  # buy, swap adapters) runs against this hot Admin EOA; the
  # planned `--phase handover` step rotates ownership off it onto
  # the Timelock + Pauser Safe.
  #
  # The deadline is enforced at the top of `phase_handover` — if
  # more than 48 hours have elapsed without `--phase handover`
  # landing, the script refuses to proceed. Either the operator
  # finishes within the window (industry-standard practice) OR
  # they pass `--reset-handover-deadline` after reviewing why
  # the window slipped (e.g. an LZ DVN config failure that needed
  # a rebroadcast, a bridge outage). The marker write itself
  # is the audit-trail anchor — the timestamp is human-readable
  # ISO-8601 to make the audit obvious.
  date +"%s" > "$MARKERS_DIR/handover-deadline-start.ts"
  date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/handover-deadline-start.iso"
  echo "  ✓ Handover deadline clock started:"
  echo "    Admin EOA owns the Diamond as of $(cat "$MARKERS_DIR/handover-deadline-start.iso")"
  echo "    --phase handover MUST land within 48 hours."

  echo
  echo "Next:"
  echo "  1. --phase abi-sync   (sync the freshly-written addresses.json)"
  echo "  2. --phase ccip-wire   (after EVERY chain's contracts phase lands)"
  echo "  3. --phase verify   (sentinel reads + facet count + rate-limit check)"
  echo "  4. Role rotation ceremony per DeploymentRunbook §6"
}

# ── Phase: ccip-wire ──────────────────────────────────────────────────
# Cross-chain CCIP wiring — chain selectors, remote messengers, the
# vpfi-buy / vpfi-reward channel peers, the per-lane TokenPool rate
# limits (set through the bounds-checked VpfiPoolRateGovernor — the
# CLAUDE.md "Cross-Chain Security Policy" mainnet gate), and the
# TokenAdminRegistry CCT registration. `ConfigureCcip.s.sol` reads
# EVERY chain's addresses.json, so run this phase only after the
# `contracts` phase has landed on every chain in the topology.
#
# CCIP has no per-chain DVN policy to review — Chainlink operates a
# uniform committing DON + executing DON + an independent Risk
# Management Network for every integrator (CLAUDE.md "Cross-Chain
# Security Policy"). The LayerZero DVN-curation gate is therefore gone.

phase_ccip_wire() {
  _preflight_gate
  if [ -z "${CCIP_LANE_CHAIN_IDS:-}" ]; then
    cat >&2 <<EOF
Refusing --phase ccip-wire: CCIP_LANE_CHAIN_IDS unset in .env.

ConfigureCcip.s.sol wires a CCIP TokenPool lane to every REMOTE chain
in the topology. Set CCIP_LANE_CHAIN_IDS to a comma-separated list of
the OTHER chains' EVM chain ids, e.g.:

  CCIP_LANE_CHAIN_IDS=1,42161,10   # on Base (the canonical hub)
  CCIP_LANE_CHAIN_IDS=8453         # on a mirror (hub-spoke)

Every listed chain must already have had its \`contracts\` phase land —
ConfigureCcip reads each chain's deployments/<slug>/addresses.json to
resolve lane + channel peers. It also needs CCIP_TOKEN_ADMIN_REGISTRY
and CCIP_REGISTRY_MODULE_OWNER_CUSTOM (resolved per-slug from .env).

Mainnet gate (CLAUDE.md "Cross-Chain Security Policy"): the per-lane
rate limits this phase sets, and the CCT TokenAdminRegistry admin, are
load-bearing — confirm CCIP_RATE_CAPACITY / CCIP_RATE_REFILL match the
design §10 starting values before broadcasting.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — ccip-wire  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"
  forge script script/ConfigureCcip.s.sol --rpc-url "$RPC" --broadcast --slow
  mark_phase_done "ccip-wire"
}

# ── Phase: swap-adapters ──────────────────────────────────────────────

phase_swap_adapters() {
  _preflight_gate
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

# ── Phase: configure ──────────────────────────────────────────────────
# Atomic composition of the four Diamond-side configure scripts via
# DiamondConfigSpell.s.sol. See the spell's header doc for the full
# rationale. Sequenced BEFORE --phase handover so the spell's
# ADMIN_PRIVATE_KEY broadcasts still have the role surface they need.

phase_configure() {
  _preflight_gate
  if phase_already_done "configure"; then
    cat >&2 <<EOF
Refusing --phase configure: marker file exists at
  $MARKERS_DIR/phase-configure.done
The four configures already landed for $CHAIN_SLUG. Re-running would
re-broadcast every set*-call against the Diamond. Most are idempotent
(same value -> same state), but ConfigureOracle's risk-param writes
overwrite any in-flight tweaks the operator made via the multisig
between the original spell run and now — undoing manual config.

If a re-run is genuinely needed, remove the marker manually:
  rm $MARKERS_DIR/phase-configure.done
then re-run.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — configure  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"

  # ConfigureRewardReporter (one of the spell's children) needs
  # BASE_CHAIN_ID — the EVM chain id of canonical Base, the reward
  # flow's hub. On mainnet that is always Base (8453), whether this
  # chain is the canonical itself or a mirror. Derived here so the
  # .env needs no per-chain entry.
  export BASE_CHAIN_ID=8453
  # DeployCrosschain records the reward contract under `.rewardMessenger`.
  # Hand ConfigureRewardReporter that address explicitly via the legacy
  # env-var name `REWARD_OAPP_PROXY` (kept for back-compat). Pre-PR-#272
  # artifacts store the same address under `.rewardOApp`; fall back to it.
  #
  # IMPORTANT: explicitly unset `REWARD_OAPP_PROXY` before the read so a
  # stale carry-over from a prior chain's run in a multi-chain loop
  # cannot silently override this chain's correct artifact resolution.
  # Mirror of the same fix on `deploy-testnet.sh`'s phase_configure.
  unset REWARD_OAPP_PROXY
  REWARD_MSGR=$(jq -r '.rewardMessenger // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  if [ -z "$REWARD_MSGR" ]; then
    REWARD_MSGR=$(jq -r '.rewardOApp // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  fi
  if [ -n "$REWARD_MSGR" ]; then
    export REWARD_OAPP_PROXY="$REWARD_MSGR"
  fi
  # If both keys missed, REWARD_OAPP_PROXY stays unset; ConfigureRewardReporter
  # then falls through to `Deployments.readRewardMessenger()` which has
  # its own library-level fallback (and reverts loudly if it also misses).

  forge script script/DiamondConfigSpell.s.sol \
    --rpc-url "$RPC" --broadcast --slow

  mark_phase_done "configure"
}

# ── Phase: handover ───────────────────────────────────────────────────
# Rotates DEFAULT_ADMIN_ROLE / Timelock-bound roles / PAUSER_ROLE /
# ERC-173 Diamond ownership / OApp Ownable2Step ownership off ADMIN.
# See script/Handover.s.sol for the full rationale + ordering. After
# this lands, the governance Safe must call `acceptOwnership()` on
# every OApp printed in the script's tail before the
# DeployerZeroRolesTest hard exit gate can pass.

phase_handover() {
  _preflight_gate
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

  # ── 48h Admin EOA → Multisig handover deadline (ratified 2026-05-14) ──
  # The hot Admin EOA holds ADMIN_ROLE during the entire config
  # window between `--phase contracts` (when the timestamp was
  # written) and now. On mainnet that window is real-value exposure
  # — hard-cap at 48h to bound key-compromise blast radius.
  # Operator overrides via --reset-handover-deadline only after
  # documenting WHY the window slipped (DVN reconfig, bridge
  # outage, etc.) in their incident log.
  if [ -f "$MARKERS_DIR/handover-deadline-start.ts" ]; then
    DEADLINE_START=$(cat "$MARKERS_DIR/handover-deadline-start.ts")
    NOW_TS=$(date +"%s")
    ELAPSED=$((NOW_TS - DEADLINE_START))
    DEADLINE_SECS=$((48 * 3600))
    if [ "$ELAPSED" -gt "$DEADLINE_SECS" ]; then
      ELAPSED_HOURS=$((ELAPSED / 3600))
      if [ "$CONFIRM_DEADLINE_RESET" != "1" ]; then
        cat >&2 <<EOF

FAIL: Admin EOA → Multisig handover deadline EXCEEDED (mainnet).

Elapsed: ${ELAPSED_HOURS}h since the deadline clock started at:
  $(cat "$MARKERS_DIR/handover-deadline-start.iso")

The 48h cap exists to bound the hot Admin EOA's key-compromise
blast radius. Refusing to proceed.

If the slippage is legitimate (LZ DVN reconfig forced a
rebroadcast, a bridge outage, a multisig signer scheduling
issue), document the reason in your incident log and re-run with
--reset-handover-deadline to acknowledge the override. The
override is logged in .markers/handover-deadline.log for the
audit trail.

If the slippage is NOT legitimate (key may be exposed; deploy
was paused for unrelated reasons; etc.), you should ABORT this
mainnet deploy and start fresh:
  1. Have governance pause the still-pending Diamond.
  2. transferOwnership to a fresh Admin EOA (or directly to
     Multisig if the config is unsalvageable).
  3. Re-deploy from scratch on the next mainnet window.

EOF
        exit 1
      fi
      echo "  ⚠ Handover deadline EXCEEDED (${ELAPSED_HOURS}h)"
      echo "  ✓ --reset-handover-deadline acknowledged — proceeding"
      date +"%Y-%m-%dT%H:%M:%S%z elapsed=${ELAPSED_HOURS}h reset=ack" \
        >> "$MARKERS_DIR/handover-deadline.log"
    else
      ELAPSED_HOURS=$((ELAPSED / 3600))
      echo "  ✓ Handover deadline OK: ${ELAPSED_HOURS}h elapsed of 48h budget"
    fi
  fi

  # ── Multisig-bytecode preflight ─────────────────────────────────
  # Refuse if any of the three Safe addresses has no contract code
  # on this chain. Granting a Diamond role to a Safe address with
  # no Safe behind it permanently bricks that role. On mainnet the
  # blast radius is real value, so this gate is non-negotiable.
  # See deploy-testnet.sh's identical helper for the rationale.
  local missing=()
  for label in DEFAULT_ADMIN_ADDRESS PAUSER_ADDRESS TIMELOCK_PROPOSER; do
    local addr="${!label:-}"
    if [ -z "$addr" ]; then
      missing+=("$label (env var unset)")
      continue
    fi
    local code
    code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || echo "")
    if [ -z "$code" ] || [ "$code" = "0x" ]; then
      missing+=("$label=$addr (no contract on $CHAIN_SLUG)")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    cat >&2 <<EOF
Refusing --phase handover on MAINNET: multi-sig bytecode preflight failed.

The following multi-sig addresses do NOT have a deployed Safe (or
any contract) on $CHAIN_SLUG:

$(for m in "${missing[@]}"; do echo "  - $m"; done)

On mainnet this is a hard NO. Granting a Diamond role to an address
with no contract behind it permanently bricks that role; combined
with ADMIN's renounce, the role surface becomes inaccessible. There
is no recovery path on mainnet — every signer who could sign the
Safe transaction does not exist.

Deploy the Safe to the matching deterministic CREATE2 address on
$CHAIN_SLUG via the Safe SDK BEFORE running --phase handover. The
Safe contract layer is chain-agnostic; the same (singleton + factory
+ initializer) tuple lands at the same address on every chain.
EOF
    exit 1
  fi

  if phase_already_done "handover"; then
    cat >&2 <<EOF
Refusing --phase handover: marker file exists at
  $MARKERS_DIR/phase-handover.done
indicating roles + ownership were already rotated. Re-running would
attempt grantRole on a Safe that already holds the role (idempotent
no-op) AND renounceRole from ADMIN (which would revert
NotARoleHolder). If the marker is stale (script aborted mid-flight,
on-chain effect incomplete), inspect addresses.json + on-chain
state, then either remove the marker manually or run a corrective
script.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-mainnet.sh — handover  ($CHAIN_SLUG)"
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
  # DiamondCutFacet is callable but not loupe-enumerated, so the loupe
  # count equals the cut-entry count exactly. DeployDiamond records the
  # authoritative count in addresses.json (.facetCount, Issue #69) —
  # read it and require an EXACT match; a `>=` floor would green-light
  # a stale / half-cut diamond that is MISSING a facet.
  EXPECTED_FACETS=$(jq -r '.facetCount // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  if [ -z "$EXPECTED_FACETS" ]; then
    echo "  FAIL: .facetCount missing from $DEPLOY_DIR/addresses.json — re-run --phase contracts." >&2
    exit 1
  fi
  FACET_COUNT_RAW=$(cast call "$DIAMOND" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null \
    | tr ',' '\n' | grep -c '0x' || echo 0)
  if [ "$FACET_COUNT_RAW" -ne "$EXPECTED_FACETS" ]; then
    echo "  FAIL: $FACET_COUNT_RAW facets registered, expected exactly $EXPECTED_FACETS (stale / half-cut diamond)." >&2
    echo "        Run --phase contracts again before any other phase." >&2
    exit 1
  fi
  echo "  ✓ all $FACET_COUNT_RAW expected facets registered"

  echo
  echo "[3] Master flag state"
  echo "  getMasterFlags() = $(cast call "$DIAMOND" 'getMasterFlags()(bool,bool,bool)' --rpc-url "$RPC" 2>/dev/null | tr '\n' ' ' || echo '?')"

  # CCIP per-lane rate limits live on the VPFI TokenPool and are set
  # through the bounds-checked VpfiPoolRateGovernor — the CLAUDE.md
  # "Cross-Chain Security Policy" mainnet gate. Verify the wiring is in
  # place: the governor must be the pool's rateLimitAdmin, and at least
  # one CCIP lane must be configured (per-lane limits cannot exist
  # without a lane). A missing or wrong wiring means `--phase ccip-wire`
  # has not run — fail-hard and refuse to mark verify done.
  POOL=$(jq -r '.vpfiTokenPool // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
  GOVERNOR=$(jq -r '.vpfiPoolRateGovernor // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
  echo
  echo "[4] CCIP TokenPool rate-limit wiring"
  # The contracts phase deploys the TokenPool + governor on EVERY chain,
  # so a missing key is not "n/a" — it means the phase did not land (or a
  # stale pre-CCIP artifact is in place). Fail hard rather than skip the
  # checks and still print a green verify.
  if [ -z "$POOL" ] || [ -z "$GOVERNOR" ]; then
    echo "  ✗ FAIL: vpfiTokenPool / vpfiPoolRateGovernor missing from"
    echo "          deployments/$CHAIN_SLUG/addresses.json — the contracts phase"
    echo "          did not land. Re-run --phase contracts before verify."
    exit 1
  fi
  RL_ADMIN=$(cast call "$POOL" 'getRateLimitAdmin()(address)' --rpc-url "$RPC" 2>/dev/null || echo "")
  SUPPORTED=$(cast call "$POOL" 'getSupportedChains()(uint64[])' --rpc-url "$RPC" 2>/dev/null || echo "")
  echo "  rateLimitAdmin   = $RL_ADMIN"
  echo "  supported lanes  = $SUPPORTED"
  if [ -z "$RL_ADMIN" ]; then
    echo "  ✗ getRateLimitAdmin() call failed — pool may not be deployed at $POOL."
    exit 1
  fi
  # cast returns checksummed addresses — lowercase both sides to compare.
  if [ "$(echo "$RL_ADMIN" | tr 'A-F' 'a-f')" != "$(echo "$GOVERNOR" | tr 'A-F' 'a-f')" ]; then
    echo "  ✗ FAIL: the pool's rateLimitAdmin is not the VpfiPoolRateGovernor."
    echo "          The bounded rate-limit path is not wired — run --phase"
    echo "          ccip-wire before declaring the deploy ready."
    exit 1
  fi
  if [ -z "$SUPPORTED" ] || [ "$SUPPORTED" = "[]" ]; then
    echo "  ✗ FAIL: the pool has no CCIP lanes configured. Per-lane rate"
    echo "          limits cannot exist without a lane — run --phase ccip-wire."
    exit 1
  fi
  echo "  ✓ governor is rateLimitAdmin + lanes present — rate limits enforced."

  echo
  echo "verify OK. Continue with the role-rotation ceremony (DeploymentRunbook §6)."
  mark_phase_done "verify"
}

# ── Dispatch ──────────────────────────────────────────────────────────

case "$PHASE" in
  preflight)     phase_preflight ;;
  contracts)     phase_contracts ;;
  ccip-wire)     phase_ccip_wire ;;
  swap-adapters) phase_swap_adapters ;;
  configure)     phase_configure ;;
  handover)      phase_handover ;;
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
sub-5-minute N-chain simultaneous-pause drill (cross-chain-incident-style defense
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
