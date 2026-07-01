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
#   2. `--phase pause-rehearsal` is ENABLED — sub-5-minute N-chain
#      simultaneous-pause drill. Refused on the mainnet script
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
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase ccip-wire
#       Runs ConfigureCcip.s.sol — wires CCIP chain selectors, remote
#       messengers, the vpfi-buy / vpfi-reward channel peers, the
#       TokenPool lanes + rate limits, and the TokenAdminRegistry CCT
#       registration. Reads every chain's addresses.json, so run it
#       only after `--phase contracts` has landed on EVERY chain in
#       the topology. CCIP_LANE_CHAIN_IDS must list the remote chains
#       (see the phase's own refusal message). CCIP has no DVN policy
#       to review — Chainlink operates a uniform DON + RMN set.
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
#   bash contracts/script/deploy-testnet.sh <chain-slug> --phase cf-indexer [--fresh]
#       Deploys apps/indexer (D1 indexer + read-only API) via
#       wrangler, then applies any pending D1 migrations to the shared
#       `vaipakam-archive` database. The indexer is the only Worker
#       that owns migrations — keeper + agent are stateless. With
#       `--fresh` (i.e. after a fresh contract redeploy that changed the
#       diamond address) it ALSO purges this chain's stale D1 rows
#       (offers/loans/activity/cursor/…) so the reindex starts clean from
#       the new deployBlock. Without `--fresh` the D1 is left intact
#       (mainnet redeploys almost always preserve the diamond + history).
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
#       sub-5-minute N-chain simultaneous-pause drill.
#       Reads addresses.json on this chain, prints the `pause()`
#       calldata for the Diamond + every GuardianPausable CCIP contract
#       (CcipMessenger, VaipakamRewardMessenger) so the operator can
#       sign through the Pauser Safe UI on this
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
#   - CCIP lane / channel wiring across chains is the `ccip-wire`
#     phase — but it must run AFTER `--phase contracts` has landed on
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
  bash contracts/script/deploy-testnet.sh <chain-slug> --phase <phase> [confirm-flags]

Testnet chain-slugs:
  base-sepolia  sepolia  arb-sepolia  op-sepolia  bnb-testnet  polygon-amoy
  (anvil delegates to deploy-chain.sh / anvil-bootstrap.sh)

Phases (mirror mainnet phase-for-phase except pause-rehearsal):
  preflight        — Read-only, run first. No broadcasts.
  contracts        — Diamond + Timelock + CCIP cross-chain stack.
                     Requires --confirm-i-have-multisig-ready
  ccip-wire        — CCIP lane / channel wiring via ConfigureCcip.s.sol.
                     Run after `contracts` has landed on every chain.
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
  pause-rehearsal  — TESTNET-ONLY sub-5-min pause drill.
                     --mode {calldata|check|unpause-calldata}

For mainnet, use deploy-mainnet.sh (refuses pause-rehearsal).
For Anvil + dev quick-iteration, use deploy-chain.sh.
EOF
  exit 1
fi

CHAIN_SLUG="$1"; shift

PHASE=""
CONFIRM_MULTISIG=0
CONFIRM_ORPHANS=0
FRESH=0
# Ratified 2026-05-14 — the rehearsal SHAPE must mirror mainnet's
# friction so operator muscle memory carries over. Both flags are
# WARN-mode here (not hard-fail like mainnet) because (a) testnet
# rehearsals don't need a real hardware wallet and (b) rehearsals
# legitimately drag past 48h when iterating. The script logs the
# flag presence to .markers/ regardless so the audit trail records
# what the operator practised.
CONFIRM_HW_SIGNER=0
CONFIRM_DEADLINE_RESET=0
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
    --confirm-orphans-prior-onchain-state) CONFIRM_ORPHANS=1 ;;
    --fresh)                         FRESH=1 ;;
    # Same flag shape as mainnet, WARN-only on testnet.
    --confirm-mainnet-hardware-signer) CONFIRM_HW_SIGNER=1 ;;
    --reset-handover-deadline) CONFIRM_DEADLINE_RESET=1 ;;
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
# IS_CANONICAL + CCIP_SLUG) so every downstream phase can stay
# phase-for-phase identical to mainnet.
# (#687-A removed the cross-chain VPFI buy adapter and its per-chain
# WETH-pull payment-token column.)

case "$CHAIN_SLUG" in
  base-sepolia)
    CHAIN_ID=84532;     RPC_VAR="BASE_SEPOLIA_RPC_URL";   IS_CANONICAL=1
    CCIP_SLUG="BASE_SEPOLIA" ;;
  sepolia)
    CHAIN_ID=11155111;  RPC_VAR="SEPOLIA_RPC_URL";        IS_CANONICAL=0
    CCIP_SLUG="SEPOLIA" ;;
  arb-sepolia)
    CHAIN_ID=421614;    RPC_VAR="ARB_SEPOLIA_RPC_URL";    IS_CANONICAL=0
    CCIP_SLUG="ARB_SEPOLIA" ;;
  op-sepolia)
    CHAIN_ID=11155420;  RPC_VAR="OP_SEPOLIA_RPC_URL";     IS_CANONICAL=0
    CCIP_SLUG="OP_SEPOLIA" ;;
  bnb-testnet)
    CHAIN_ID=97;        RPC_VAR="BNB_TESTNET_RPC_URL";    IS_CANONICAL=0
    CCIP_SLUG="BNB_TESTNET" ;;
  polygon-amoy)
    CHAIN_ID=80002;     RPC_VAR="POLYGON_AMOY_RPC_URL";   IS_CANONICAL=0
    CCIP_SLUG="POLYGON_AMOY" ;;
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

# Per-chain CCIP infrastructure dispatch — same shape as
# deploy-chain.sh. The CCIP scripts read a single CCIP_ROUTER /
# CCIP_RMN_PROXY (the `contracts` phase) and CCIP_TOKEN_ADMIN_REGISTRY
# / CCIP_REGISTRY_MODULE_OWNER_CUSTOM (the `ccip-wire` phase), each the
# active chain's; all four differ per chain, so the .env carries a
# `<VAR>_<SLUG>` entry per chain and the active chain's set is resolved
# here so one .env serves every chain without manual editing.
#
# A bare `CCIP_*` is NOT a safe fallback when a per-slug var is missing:
# it would silently apply some OTHER chain's router / registry to this
# rehearsal. Mirroring deploy-mainnet.sh, a bare `CCIP_*` with no
# matching `<VAR>_<SLUG>` is a hard error.
for _ccip_var in CCIP_ROUTER CCIP_RMN_PROXY \
                 CCIP_TOKEN_ADMIN_REGISTRY CCIP_REGISTRY_MODULE_OWNER_CUSTOM; do
  _ccip_slug_var="${_ccip_var}_${CCIP_SLUG}"
  if [ -n "${!_ccip_slug_var:-}" ]; then
    export "$_ccip_var"="${!_ccip_slug_var}"
  elif [ -n "${!_ccip_var:-}" ]; then
    echo "Error: $_ccip_slug_var is not set in .env, but a bare $_ccip_var is —" >&2
    echo "       that would wire the WRONG chain's CCIP address into the" >&2
    echo "       $CHAIN_SLUG rehearsal. Set $_ccip_slug_var explicitly." >&2
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
# `ccip-wire`, `swap-adapters`, `configure` or `handover` directly. The
# one safety check that MUST hold before any broadcast — the RPC
# actually serves the expected chain — is factored here and re-run at
# the top of every broadcasting phase. (The mainnet hardware-signer
# attestation has no testnet analogue; deploy-mainnet.sh's gate adds
# it. `phase_preflight` calls this gate, then its fuller checks.)

_assert_rpc_chain() {
  # A mispointed RPC URL is the single most dangerous deploy mistake —
  # broadcasting a chain's deploy against the wrong network.
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

# The critical gate every broadcasting phase runs first.
_preflight_gate() {
  _assert_rpc_chain
}

# ── Phase: preflight ──────────────────────────────────────────────────

phase_preflight() {
  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — preflight  ($CHAIN_SLUG / $CHAIN_ID)"
  echo "═══════════════════════════════════════════════════════════════"

  # 1. The critical gate — RPC chain match.
  _preflight_gate

  # 2. Required env vars
  MISSING=()
  for v in DEPLOYER_PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
           VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER \
           TIMELOCK_PROPOSER CCIP_ROUTER CCIP_RMN_PROXY; do
    if [ -z "${!v:-}" ]; then MISSING+=("$v"); fi
  done
  # Mirror chains need BASE_CHAIN_ID — the canonical Base EVM chain id —
  # for DeployCrosschain to wire the reward flow back to Base.
  if [ "$IS_CANONICAL" = "0" ] && [ -z "${BASE_CHAIN_ID:-}" ]; then
    MISSING+=("BASE_CHAIN_ID  (REQUIRED on mirror chains — canonical Base chain id)")
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

  # Mainnet-parity rehearsal signal: WARN-only, log presence to .markers/.
  # The mainnet equivalent HARD-FAILS on missing flag; testnet WARNS so
  # rehearsals stay fast while still surfacing the muscle-memory cue.
  if [ "$CONFIRM_HW_SIGNER" = "1" ]; then
    echo "  ✓ Mainnet hardware-signer attestation acknowledged (testnet rehearsal)"
    date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/hw-signer-attestation.iso"
  else
    echo "  ⚠ --confirm-mainnet-hardware-signer NOT set (testnet OK; mainnet HARD-FAILS)"
    echo "    Rehearsal tip: pass the flag here too to build muscle memory."
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

# Helper: purge D1 indexer rows for THIS chain's chainId. Extracted from
# archive_chain_state so it can fire under --fresh regardless of whether
# the on-disk addresses.json is present. (The prior coupling let stale
# D1 rows persist past a --fresh whenever the on-disk artifacts had
# already been archived in an earlier half-failed run — the chain-state
# files were gone, the script saw "nothing to archive", and silently
# skipped the D1 purge too. New Diamond + stale rows = exactly the
# pollution --fresh is supposed to prevent.)
#
# Chain-scoped: every DELETE has WHERE chain_id = $CHAIN_ID. Other
# chains' rows are never touched.
#
# Best-effort: silent skip when apps/indexer/ isn't present (alternate
# trees) or wrangler isn't authenticated (operator's CI runner may not
# have CF auth).
purge_chain_d1() {
  local indexer_dir="$REPO_ROOT/apps/indexer"
  if [ ! -d "$indexer_dir" ]; then
    echo "    (skipping D1 purge — apps/indexer/ not present)"
    return 0
  fi
  local cid="$CHAIN_ID"
  if [ -z "$cid" ]; then
    echo "    (skipping D1 purge — CHAIN_ID unset)"
    return 0
  fi
  echo "  purging D1 rows for chainId=$cid in vaipakam-archive..."
  # Enumerate EVERY chain-scoped table DYNAMICALLY — any table carrying a
  # `chain_id` column — instead of a hardcoded list. Indexer routes read
  # loan-scoped tables by (chain_id, loan_id); a new loan reusing a retired
  # diamond's id would otherwise inherit stale prepay-listing / swap-intent
  # rows or have pre-grace notifications deduped from the old deploy. A fixed
  # list silently drifts as the schema grows (prepay_listings,
  # swap_to_repay_intents, pre_grace_notify_state, liquidity_confidence, …
  # were all missing). Introspecting the live schema means tables added later
  # are purged automatically — the list can't go stale (#853 Codex P2).
  #
  # EXCLUDE user-subscription tables. `user_thresholds` (per-user per-chain HF
  # alert config) and `telegram_links` (a user's notification rail) also carry a
  # `chain_id` column, but they are USER-authored preferences, not stale
  # Diamond-derived index data — a fresh contract redeploy must NOT wipe a
  # subscriber's saved thresholds / notification rails (#853 Codex P2). The old
  # hardcoded purge preserved them (it only cleared `notify_state`); keep that.
  local introspect="SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p ON p.name = 'chain_id' WHERE m.type = 'table' AND m.name NOT IN ('user_thresholds', 'telegram_links');"
  local tables
  # Best-effort under `set -euo pipefail`: a failed / non-JSON `wrangler`
  # (operator unauthenticated, D1 unreachable) must yield an EMPTY list and hit
  # the warn-and-skip path below — NOT abort the whole deploy via the failing
  # command substitution (#853 Codex P2). The trailing `|| true` neutralises the
  # pipeline's exit status for the assignment.
  tables=$( { cd "$indexer_dir" && pnpm exec wrangler d1 execute vaipakam-archive \
    --remote --json --command "$introspect" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); rows=(d[0] if isinstance(d,list) else d).get('results',[]); print('\n'.join(r['name'] for r in rows))" 2>/dev/null ; } || true )
  if [ -z "$tables" ]; then
    echo "    ⚠ could not introspect chain-scoped tables (wrangler not authenticated, or D1 unreachable). Skipping purge; re-run via the indexer dir if needed."
    return 0
  fi
  local sql="" n=0
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    sql="${sql}DELETE FROM \"$t\" WHERE chain_id = $cid; "
    n=$((n + 1))
  done <<< "$tables"
  echo "    purging $n chain-scoped table(s): $(echo "$tables" | tr '\n' ' ')"
  ( cd "$indexer_dir" && pnpm exec wrangler d1 execute vaipakam-archive \
    --remote --command "$sql" 2>&1 | grep -E "Executed|Error" | head -3 ) || \
    echo "    ⚠ D1 purge returned non-zero — wrangler not authenticated, or D1 unreachable. Re-run via the indexer dir if needed."
}

# Helper: re-seed indexer_cursor at the chain's safe head. Called
# at the END of phase_contracts under --fresh so the indexer cron's
# next tick starts at head instead of replaying the empty pre-deploy
# block range. Misses any events emitted between deployBlock and
# seed-time, which on a fresh deploy is just admin role-grant /
# init calls — not user-facing offer/loan events. Trade-off
# matches deploy-chain.sh's [8d] step.
seed_indexer_cursor_safe_head() {
  local chain_id="$1"
  local rpc="$2"
  local indexer_dir="$REPO_ROOT/apps/indexer"
  if [ ! -d "$indexer_dir" ]; then
    return 0
  fi
  if [ -z "$chain_id" ] || [ -z "$rpc" ]; then
    return 0
  fi
  local head
  head=$(cast block-number --rpc-url "$rpc" --tag safe 2>/dev/null \
    || cast block-number --rpc-url "$rpc" 2>/dev/null \
    || echo "")
  if [ -z "$head" ]; then
    echo "    ⚠ cast block-number failed for chainId=$chain_id — skipping cursor seed"
    return 0
  fi
  local now_ts
  now_ts=$(date +%s)
  ( cd "$indexer_dir" && pnpm exec wrangler d1 execute vaipakam-archive --remote --command \
    "INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
     VALUES ($chain_id, 'diamond', $head, $now_ts)
     ON CONFLICT(chain_id, kind) DO UPDATE SET
       last_block = excluded.last_block,
       updated_at = excluded.updated_at;" 2>&1 | grep -E "Executed|Error" | head -1 ) || \
    echo "    ⚠ wrangler d1 execute failed — cursor not seeded for chainId=$chain_id"
  echo "  ✓ indexer_cursor seeded at safe-head=$head for chainId=$chain_id"
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

  # #857 — reject a ZERO VPFI_TOKEN_REUSE_ADDRESS up-front (a non-empty zero
  # value would satisfy the reuse-exemption below yet DeployVPFIToken parses it
  # as address(0), skips reuse mode, and hits its no-overwrite guard only at [3b]
  # after broadcast — a partial deploy).
  if [ -n "${VPFI_TOKEN_REUSE_ADDRESS:-}" ] && [ "${VPFI_TOKEN_REUSE_ADDRESS}" = "0x0000000000000000000000000000000000000000" ]; then
    echo "ERROR: VPFI_TOKEN_REUSE_ADDRESS is the zero address — unset it, or set the real canonical VPFI token." >&2
    exit 1
  fi

  # #857 — validate a reuse address PRE-broadcast (DeployVPFIToken's symbol/
  # decimals check runs only at [3b], after Diamond+Timelock broadcast). (a) if
  # `.vpfiToken` is already recorded the reuse MUST equal it; (b) on-chain, the
  # reuse must be an 18-decimal ERC20 whose symbol is "VPFI".
  if [ -n "${VPFI_TOKEN_REUSE_ADDRESS:-}" ] && [ "$IS_CANONICAL" = "1" ]; then
    _recorded_vpfi=$(jq -r '.vpfiToken // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
    if [ -n "$_recorded_vpfi" ] && [ "$_recorded_vpfi" != "null" ] && \
       [ "$(printf '%s' "$_recorded_vpfi" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$VPFI_TOKEN_REUSE_ADDRESS" | tr 'A-Z' 'a-z')" ]; then
      echo "ERROR: VPFI_TOKEN_REUSE_ADDRESS ($VPFI_TOKEN_REUSE_ADDRESS) != recorded .vpfiToken ($_recorded_vpfi) — refusing before broadcast." >&2
      exit 1
    fi
    _reuse_sym=$(cast call "$VPFI_TOKEN_REUSE_ADDRESS" "symbol()(string)" --rpc-url "$RPC" 2>/dev/null | tr -d '"' || echo "")
    _reuse_dec=$(cast call "$VPFI_TOKEN_REUSE_ADDRESS" "decimals()(uint8)" --rpc-url "$RPC" 2>/dev/null || echo "")
    if [ "$_reuse_sym" != "VPFI" ] || [ "$_reuse_dec" != "18" ]; then
      echo "ERROR: VPFI_TOKEN_REUSE_ADDRESS is not a canonical VPFI token (symbol='$_reuse_sym' decimals='$_reuse_dec'; expected VPFI / 18)." >&2
      exit 1
    fi
  fi

  # ── VPFI re-mint preflight (#853 Codex P2) ──────────────────────
  # DeployVPFIToken's [3b] no-overwrite guard aborts when a canonical
  # `.vpfiToken` is already recorded — but [3b] runs AFTER [2] Diamond + [3]
  # Timelock broadcast, so a late abort leaves a PARTIAL deploy. The
  # existing-diamond gate below only catches a prior `.diamond`; a PRE-SEEDED
  # `.vpfiToken` with no `.diamond` yet slips through to [3b]. Refuse that here,
  # before any broadcast. --fresh is exempt: it archives addresses.json (clearing
  # `.vpfiToken`) and the [3b] step re-mints under the FRESH-derived force flag.
  if [ "$IS_CANONICAL" = "1" ] && [ "$FRESH" != "1" ] && [ "${VPFI_TOKEN_FORCE_REDEPLOY:-0}" != "1" ] && [ -z "${VPFI_TOKEN_REUSE_ADDRESS:-}" ]; then
    local preseeded_vpfi
    preseeded_vpfi=$(jq -r '.vpfiToken // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
    if [ -n "$preseeded_vpfi" ] && [ "$preseeded_vpfi" != "null" ]; then
      echo "ERROR: a canonical VPFI token ($preseeded_vpfi) is already recorded on $CHAIN_SLUG." >&2
      echo "       Proceeding would run [3b] DeployVPFIToken, whose no-overwrite guard aborts" >&2
      echo "       AFTER Diamond + Timelock broadcast — a partial deploy. Refusing up-front." >&2
      echo "       Re-deploy with --fresh (archives + re-mints) or set VPFI_TOKEN_FORCE_REDEPLOY=1." >&2
      exit 1
    fi
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

A re-run without --fresh would silently overwrite the deployed
addresses.json keys (Diamond, Timelock, CCIP-stack proxies) with new
addresses, leaving a mixed-state artifact the operator can't tell is
internally consistent.

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
    # ── Pre-archive guard: refuse if the existing on-chain Diamond
    #    has live offers / loans, unless the operator explicitly opts
    #    in to orphaning them. This catches the "rehearse over a
    #    chain that already has user-visible state" foot-gun (hit on
    #    2026-05-11 with arb-sepolia: 8 active offers + 14 active
    #    loans went invisible to the indexer after a --fresh). The
    #    archive moves the OFF-chain artifacts out of the way, but
    #    the ON-chain Diamond retains its storage — those offers
    #    keep existing, the indexer just stops seeing them once the
    #    cursor row is wiped + reseeded forward.
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
Refusing --fresh for $CHAIN_SLUG: prior Diamond at $PRIOR_DIAMOND
has live on-chain state.

  Active offers: $ACTIVE_OFFERS
  Active loans:  $ACTIVE_LOANS

A --fresh archives the OFF-chain artifacts (addresses.json,
.markers/, indexer rows) but cannot wipe ON-chain Diamond
storage. After the new deploy lands, those offers/loans still
exist on the prior Diamond, but every off-chain consumer
(indexer, frontend, keeper) is now pointed at the NEW Diamond.
The user-visible result is "my offer disappeared from the UI"
plus an orphaned Diamond holding live state until manually
cancelled / settled.

Re-run with both flags if you genuinely intend this:
  bash contracts/script/deploy-testnet.sh $CHAIN_SLUG --phase contracts \\
    --confirm-i-have-multisig-ready --fresh \\
    --confirm-orphans-prior-onchain-state

The --confirm-orphans-prior-onchain-state flag exists so that
"yes, I know I'm orphaning $ACTIVE_OFFERS offers + $ACTIVE_LOANS
loans on the prior Diamond" is a deliberate operator action and
not a typo on a chain where someone forgot to wind down state.
EOF
          exit 1
        fi
        echo "  ⚠ orphaning $ACTIVE_OFFERS active offer(s) + $ACTIVE_LOANS active loan(s)"
        echo "    on prior Diamond $PRIOR_DIAMOND (operator confirmed via --confirm-orphans-prior-onchain-state)"
      fi
    fi
    echo "[0a] --fresh: archiving prior chain state for $CHAIN_SLUG"
    archive_chain_state "$CHAIN_SLUG"
    echo "[0b] --fresh: purging D1 rows for chainId=$CHAIN_ID"
    purge_chain_d1
    echo
    echo "  ⚠ Bump REWARD_VERSION in .env before this re-deploy lands. The"
    echo "    Reward OApp proxy is CREATE2-addressed off REWARD_VERSION;"
    echo "    keeping the same value would either re-use the old (now-stale)"
    echo "    proxy or hit a CreateCollision against the prior deploy's"
    echo "    bytecode. Current REWARD_VERSION: ${REWARD_VERSION:-(unset)}"
    echo "    Suggested next: v$(date -u +%Y%m%d)-rehearsal"
    echo
  elif [ "$FRESH" = "1" ]; then
    # --fresh with no on-disk addresses.json. Could be a clean first
    # deploy (no D1 rows either — no-op), OR a re-run after an earlier
    # half-failed --fresh archived the artifacts but didn't manage to
    # purge D1. Either way, calling purge_chain_d1 is safe (chain-scoped
    # DELETE on rows that may not exist) and is the only reliable way
    # to guarantee no stale rows survive into the new deploy. Without
    # this branch, a stale-rows-with-no-addresses.json scenario would
    # silently pollute the indexer with prior-Diamond decode shapes.
    echo "[0] --fresh: no addresses.json present — purging D1 rows for chainId=$CHAIN_ID anyway"
    purge_chain_d1
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
  echo "[1b] Pre-deploy sanity check"
  # Deploy-sanity forge suite (facet sizes + selector coverage) + deploy
  # shell-script lint. A failure aborts the deploy before any broadcast.
  bash "$SCRIPT_DIR/predeploy-check.sh"

  # Broadcast robustness posture (#853 Codex P2): `--slow` sequences one tx
  # at a time (waiting for each receipt, avoiding nonce races) and
  # `--gas-estimate-multiplier` (default 130%) pads the per-tx gas limit so a
  # batched diamondCut clears the drpc per-tx gas ceiling. There is NO
  # send-retry flag here — forge's `--retries`/`--delay` govern VERIFICATION
  # retries only, not `eth_sendRawTransaction`, so they were removed rather than
  # left as misleading knobs. A transient RPC 5xx on send aborts the phase; the
  # recovery is to re-run it — with `--broadcast --resume` forge replays the
  # saved broadcast and skips already-landed txs, or (on a --fresh testnet run)
  # simply re-run the phase from a clean state.
  # Arbitrum L2-block override (#853 Codex P2). On Arbitrum `block.number`
  # returns the L1 block; the artifact writer uses `ArbSys(0x64).arbBlockNumber()`
  # for the real L2 block, but forge's SIMULATION doesn't emulate that precompile,
  # so `Deployments.currentL2Block()` reverts unless `ARB_L2_DEPLOY_BLOCK` is set.
  # Derive it from THIS chain's RPC (on Arbitrum `cast block-number` returns the
  # L2 head) BEFORE the broadcast, so the diamond can't land on-chain and then
  # abort before `addresses.json` is written. Fail loudly if the fetch fails —
  # better than a mid-run revert after a successful broadcast.
  if [ "$CHAIN_ID" = "421614" ] || [ "$CHAIN_ID" = "42161" ]; then
    ARB_L2_DEPLOY_BLOCK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)"
    if [ -z "$ARB_L2_DEPLOY_BLOCK" ]; then
      echo "ERROR: could not fetch Arbitrum L2 block from \$RPC for ARB_L2_DEPLOY_BLOCK" >&2
      echo "       (needed because forge sim can't emulate ArbSys). Aborting before broadcast." >&2
      exit 1
    fi
    export ARB_L2_DEPLOY_BLOCK
    echo "[2·arb] ARB_L2_DEPLOY_BLOCK=$ARB_L2_DEPLOY_BLOCK (forge-sim ArbSys fallback)"
  fi

  echo
  echo "[2] DeployDiamond.s.sol"
  forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"

  echo
  echo "[3] DeployTimelock.s.sol"
  forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"

  # [3b] Canonical VPFI token — MUST land BEFORE DeployCrosschain. On the
  # canonical chain (Base / Base Sepolia) DeployCrosschain's canonical branch
  # reads `.vpfiToken` to wrap the existing token in the CCIP LockRelease pool;
  # nothing upstream mints it, so without this step a fresh canonical run fails
  # at [4] unless a token was hand-deployed first (#853 Codex P1). Mirror chains
  # skip it — they mint their own Burn/Mint VPFIMirrorToken inside [4]. The
  # DeployVPFIToken script itself hard-guards to canonical chain ids, so this
  # IS_CANONICAL gate is belt-and-suspenders. On a --fresh redeploy the prior
  # `.vpfiToken` artifact is intentionally orphaned, so authorize the overwrite;
  # otherwise the script refuses to mint a second 23M canonical supply.
  if [ "$IS_CANONICAL" = "1" ]; then
    echo
    echo "[3b] DeployVPFIToken.s.sol  (canonical VPFI — before crosschain)"
    VPFI_TOKEN_FORCE_REDEPLOY="$([ "$FRESH" = "1" ] && echo 1 || echo "${VPFI_TOKEN_FORCE_REDEPLOY:-0}")" \
      forge script script/DeployVPFIToken.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"
  fi

  # DeployCrosschain.s.sol deploys the whole T-068 CCIP stack for this
  # chain in one run — CcipMessenger, the VPFI CCIP TokenPool
  # (lock/release on canonical Base, burn/mint on a mirror), the
  # VpfiPoolRateGovernor, the VaipakamRewardMessenger, and the buy
  # receiver (canonical) or mirror VPFI + buy adapter (mirror). It
  # selects canonical-vs-mirror from block.chainid. CCIP rate limits
  # are a TokenPool concern set via the governor in the lane-wiring
  # phase — there is no per-adapter setRateLimits step any more.
  echo
  echo "[4] DeployCrosschain.s.sol  (CCIP cross-chain stack)"
  forge script script/DeployCrosschain.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"

  # ── Master-flag flip (testnet ergonomics) ───────────────────────
  # Range Orders Phase 1 governance-gated kill switches default
  # `false` on every fresh deploy (per docs/RangeOffersDesign.md §15
  # staged-enablement rationale). Mainnet keeps them dormant —
  # deploy-mainnet.sh does NOT call this block. On testnet, the
  # PositiveFlows / PartialFlows scenarios assume the flags are ON
  # (Anvil's BootstrapAnvil flips them; testnet deploy-chain.sh
  # flips them at step [5b]). Flipping here mirrors that ergonomic.
  # Idempotent: setRangeXxxEnabled(true) on an already-true flag is
  # a successful no-op state write.
  echo
  echo "[5b] Master-flag flip (testnet ergonomics)"
  DIAMOND_FOR_FLAGS=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
  if [ -z "$DIAMOND_FOR_FLAGS" ]; then
    echo "    (no diamond address yet — skipping master-flag flip)"
  elif [ -z "${ADMIN_PRIVATE_KEY:-}" ]; then
    echo "    (ADMIN_PRIVATE_KEY missing — skipping master-flag flip)"
  else
    for fn in setRangeAmountEnabled setRangeRateEnabled setPartialFillEnabled; do
      echo "  cast send $fn(true) on $DIAMOND_FOR_FLAGS"
      cast send "$DIAMOND_FOR_FLAGS" "$fn(bool)" true \
        --private-key "$ADMIN_PRIVATE_KEY" \
        --rpc-url "$RPC" \
        2>&1 | grep -E "^status" | head -1 || true
    done
    echo "  Final master flags: $(cast call $DIAMOND_FOR_FLAGS 'getMasterFlags()(bool,bool,bool)' --rpc-url $RPC | tr '\n' ' ')"
  fi

  # ── Indexer-cursor: trust the natural fallback ──────────────────
  # archive_chain_state above wiped the prior `indexer_cursor` row.
  # The next indexer cron tick will see no cursor row and fall back
  # to `lastBlock = deployBlock - 1n` (apps/indexer/src/chainIndexer.ts:242),
  # then scan forward from deployBlock. Two reasons we no longer
  # auto-seed at safe-head here:
  #
  #   1. The natural fallback is correct on a TRUE fresh deploy too:
  #      deployBlock ≈ current safe-head (only the deploy txns sit
  #      between them), so the cron's `scanFrom > head` short-circuit
  #      fires and the chain is reported caught-up after one ~30-block
  #      scan that picks up admin role-grants + init calls. Zero
  #      wasted work; previously the seed-step's claim of "skipping
  #      empty backfill" was over-stated.
  #
  #   2. Auto-seed-at-safe-head is ACTIVELY HARMFUL when --fresh runs
  #      against a chain that has pre-existing on-chain state from a
  #      previous deploy / flow-test session — the seed jumps the
  #      cursor PAST any events emitted before now, orphaning them
  #      to that indexer instance forever. Hit on 2026-05-11: 8
  #      arb-sepolia offers + 14 loans from yesterday's F2 rehearsal
  #      went invisible to the indexer after this step ran following
  #      a manual D1 purge. Diagnosis in
  #      docs/ReleaseNotes/ReleaseNotes-2026-05-11.md.
  #
  # If a future operator genuinely wants the seed-at-safe-head shape
  # for a deploy where they're CERTAIN no orphan-able events exist,
  # the `seed_indexer_cursor_safe_head` helper below is still in the
  # script — call it manually. The default --fresh path no longer
  # auto-invokes it.

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

  # Mainnet-parity rehearsal — same Admin-EOA-took-ownership
  # timestamp write as mainnet. The 48h handover-deadline check
  # at `phase_handover` is WARN-only on testnet (mainnet HARD-FAILS).
  # Rehearsals legitimately drag past 48h when iterating; the warn
  # still trains the operator's awareness of the deadline without
  # blocking testnet progress.
  date +"%s" > "$MARKERS_DIR/handover-deadline-start.ts"
  date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/handover-deadline-start.iso"
  echo "  ✓ Handover deadline clock started (testnet rehearsal):"
  echo "    Admin EOA owns the Diamond as of $(cat "$MARKERS_DIR/handover-deadline-start.iso")"
  echo "    Mainnet WOULD enforce a 48h deadline; testnet WARNS only."

  echo
  echo "Next:"
  echo "  1. --phase abi-sync   (sync the freshly-written addresses.json)"
  echo "  2. --phase ccip-wire   (after EVERY chain's contracts phase lands)"
  echo "  3. --phase verify   (sentinel reads + facet count + rate-limit check)"
  echo "  4. Role rotation ceremony per DeploymentRunbook §6"
}

# ── Phase: ccip-wire ──────────────────────────────────────────────────
# Cross-chain CCIP wiring — chain selectors, remote messengers, the
# vpfi-buy / vpfi-reward channel peers, the TokenPool lanes + rate
# limits, and the TokenAdminRegistry CCT registration.
# `ConfigureCcip.s.sol` reads EVERY chain's addresses.json, so run this
# phase only after the `contracts` phase has landed on every chain in
# the topology. Run it once per chain.
#
# CCIP has no per-chain DVN policy — Chainlink operates a uniform
# committing DON + executing DON + an independent Risk Management
# Network for every integrator (per CLAUDE.md "Cross-Chain Security
# Policy"), so the old --confirm-dvn-policy-reviewed gate is gone.

phase_ccip_wire() {
  _preflight_gate
  if [ -z "${CCIP_LANE_CHAIN_IDS:-}" ]; then
    cat >&2 <<EOF
Refusing --phase ccip-wire: CCIP_LANE_CHAIN_IDS unset in .env.

ConfigureCcip.s.sol wires a CCIP TokenPool lane to every REMOTE chain
in the topology. Set CCIP_LANE_CHAIN_IDS to a comma-separated list of
the OTHER chains' EVM chain ids, e.g.:

  CCIP_LANE_CHAIN_IDS=421614   # on Base Sepolia (the hub) — the active mirror(s)
  CCIP_LANE_CHAIN_IDS=84532             # on a mirror (hub-spoke)

Every listed chain must already have had its \`contracts\` phase land —
ConfigureCcip reads each chain's deployments/<slug>/addresses.json to
resolve lane + channel peers. It also needs CCIP_TOKEN_ADMIN_REGISTRY
and CCIP_REGISTRY_MODULE_OWNER_CUSTOM (resolved per-slug from .env).
EOF
    exit 1
  fi

  # #855 — CCIP_GUARDIAN is REQUIRED for ccip-wire. ConfigureCcip._setGuardians
  # SKIPS silently when it's unset, leaving every GuardianPausable cross-chain
  # contract (CcipMessenger / RewardMessenger / mirror VPFI) with NO guardian.
  # Setting a guardian is owner-only, so once handover moves ownership to the
  # timelock the fast Pauser-Safe pause lever (pause-all-chains.sh) can no longer
  # freeze those contracts during an incident — it MUST be wired now, while ADMIN
  # still owns them. The guardian is a single global address (the incident
  # guardian, typically the Pauser Safe), the same on every chain.
  if [ -z "${CCIP_GUARDIAN:-}" ] || [ "${CCIP_GUARDIAN:-}" = "0x0000000000000000000000000000000000000000" ]; then
    cat >&2 <<EOF
Refusing --phase ccip-wire: CCIP_GUARDIAN unset (or zero) in .env.

ConfigureCcip wires the incident guardian onto every GuardianPausable
cross-chain contract. Left unset they get NO guardian, and after handover
only the governance timelock can pause them — defeating pause-all-chains.sh's
fast containment path. Set CCIP_GUARDIAN to the incident guardian address
(typically the Pauser Safe) before running ccip-wire.
EOF
    exit 1
  fi

  echo "═══════════════════════════════════════════════════════════════"
  echo "deploy-testnet.sh — ccip-wire  ($CHAIN_SLUG)"
  echo "═══════════════════════════════════════════════════════════════"
  forge script script/ConfigureCcip.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"
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
  forge script script/DeploySwapAdapters.s.sol --rpc-url "$RPC" --broadcast --slow --gas-estimate-multiplier "${FORGE_GAS_MULTIPLIER:-130}"
  mark_phase_done "swap-adapters"
}

# ── Phase: configure ──────────────────────────────────────────────────
# Same shape as deploy-mainnet.sh's configure phase — composes the
# four Diamond-side configure scripts via DiamondConfigSpell.s.sol.
# Practising the spell on testnet exercises the same operator-action
# count + the same ADMIN signer surface as mainnet day.

phase_configure() {
  _preflight_gate
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

  # ConfigureRewardReporter (one of the scripts the spell composes)
  # needs BASE_CHAIN_ID — the EVM chain id of canonical Base, the
  # reward flow's hub. Derive it here so the .env needs no per-chain
  # entry: on a canonical chain it is this chain; on a mirror it is
  # the canonical testnet (Base Sepolia, 84532).
  if [ "$IS_CANONICAL" = "1" ]; then
    export BASE_CHAIN_ID="$CHAIN_ID"
  else
    export BASE_CHAIN_ID=84532
  fi
  # DeployCrosschain records the reward contract under `.rewardMessenger`.
  # Hand ConfigureRewardReporter that address explicitly via the legacy
  # env-var name `REWARD_OAPP_PROXY` (kept for back-compat). Pre-PR-#272
  # artifacts store the same address under `.rewardOApp`; fall back to it.
  #
  # IMPORTANT: explicitly unset `REWARD_OAPP_PROXY` before the read so a
  # stale carry-over from a prior chain's run in a multi-chain loop
  # cannot silently override this chain's correct artifact resolution.
  # Without the reset, chain B would inherit chain A's exported value if
  # chain B's addresses.json happens to be missing both keys — pointing
  # at the wrong-chain messenger silently.
  # Flagged in the second-round external review of PR #272.
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
# Same shape as deploy-mainnet.sh's handover phase (see Handover.s.sol
# for the full rationale). Practising it on testnet under the same
# confirm-flag friction is the whole point of the rehearsal: any
# misconfig in DEFAULT_ADMIN_ADDRESS / PAUSER_ADDRESS / Timelock
# gets caught here, where the only cost is faucet ETH.

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

  # 48h handover-deadline check — WARN-only on testnet (mainnet
  # HARD-FAILS). Logs to .markers/ regardless so the rehearsal
  # records what would have happened on mainnet.
  if [ -f "$MARKERS_DIR/handover-deadline-start.ts" ]; then
    DEADLINE_START=$(cat "$MARKERS_DIR/handover-deadline-start.ts")
    NOW_TS=$(date +"%s")
    ELAPSED=$((NOW_TS - DEADLINE_START))
    DEADLINE_SECS=$((48 * 3600))
    if [ "$ELAPSED" -gt "$DEADLINE_SECS" ]; then
      ELAPSED_HOURS=$((ELAPSED / 3600))
      echo "  ⚠ Admin EOA → Multisig handover deadline EXCEEDED on testnet"
      echo "    Elapsed: ${ELAPSED_HOURS}h since the deadline clock started."
      echo "    Mainnet would HARD-FAIL here — testnet WARNS only."
      if [ "$CONFIRM_DEADLINE_RESET" = "1" ]; then
        echo "  ✓ --reset-handover-deadline acknowledged — proceeding."
        date +"%Y-%m-%dT%H:%M:%S%z elapsed=${ELAPSED_HOURS}h reset=ack" \
          >> "$MARKERS_DIR/handover-deadline.log"
      else
        echo "    Rehearsal tip: pass --reset-handover-deadline here too"
        echo "    so the mainnet day muscle memory is built."
        date +"%Y-%m-%dT%H:%M:%S%z elapsed=${ELAPSED_HOURS}h reset=missing" \
          >> "$MARKERS_DIR/handover-deadline.log"
      fi
    else
      ELAPSED_HOURS=$((ELAPSED / 3600))
      echo "  ✓ Handover deadline OK (testnet): ${ELAPSED_HOURS}h elapsed of 48h budget"
    fi
  fi

  # ── Multisig-bytecode preflight ─────────────────────────────────
  # Refuse if any of the three Safe addresses (DEFAULT_ADMIN,
  # PAUSER, TIMELOCK_PROPOSER) has no contract code on this chain.
  # Granting a Diamond role to an EOA-shaped address that has no
  # Safe behind it permanently bricks that role: the only entity
  # that can call as that address is the Safe at that address, and
  # it doesn't exist. Combined with ADMIN's renounce step that
  # follows, the role surface becomes inaccessible.
  #
  # Safe support gap: as of 2026-05-10 Safe's testnet UI supports
  # Ethereum Sepolia + Base Sepolia but NOT Arbitrum Sepolia. A
  # handover on Arb Sepolia (without first deploying the Safe
  # singletons there via the SDK to the same deterministic CREATE2
  # address) would land roles on dead addresses. This gate catches
  # that out of the box.
  local missing=()
  for label in DEFAULT_ADMIN_ADDRESS PAUSER_ADDRESS TIMELOCK_PROPOSER; do
    local addr="${!label:-}"
    if [ -z "$addr" ]; then
      missing+=("$label (env var unset)")
      continue
    fi
    # cast code returns "0x" for EOAs / addresses without bytecode.
    local code
    code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || echo "")
    if [ -z "$code" ] || [ "$code" = "0x" ]; then
      missing+=("$label=$addr (no contract on $CHAIN_SLUG)")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    cat >&2 <<EOF
Refusing --phase handover: multi-sig bytecode preflight failed.

The following multi-sig addresses do NOT have a deployed Safe (or
any contract) on $CHAIN_SLUG:

$(for m in "${missing[@]}"; do echo "  - $m"; done)

Granting a Diamond role to an address with no contract behind it
permanently bricks that role — the only entity that can sign as
that address is the Safe at that address, and it doesn't exist.
ADMIN's renounce step at the end of handover would then make the
role surface inaccessible.

Recovery options:
  1. Deploy the Safe singletons to the same deterministic CREATE2
     address on $CHAIN_SLUG via the Safe SDK (works even on chains
     where Safe's UI doesn't expose support — Safe contracts are
     chain-agnostic).
  2. Choose a different recipient for that role on this chain
     (e.g. a chain-local custom multisig). Update .env's *_ADDRESS
     for that role to the new recipient and re-run.
  3. Skip --phase handover on this chain. The Diamond stays under
     ADMIN's ownership; rotation can happen later.

If option 3, the abi-sync + cf-* + verify phases can still run
post-deploy. Operator-side note: the Diamond on this chain is NOT
production-ready until the multi-sig governance topology is wired.
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

  # [d] Fresh-deploy D1 hygiene — automated so operators don't hand-run it.
  # After a `--fresh` contract redeploy the diamond address changed, but the
  # D1 rows key by chain_id, so the retired diamond's offers/loans would still
  # surface. Purge this chain's rows (offers/loans/activity/cursor/etc.) here,
  # right after the indexer is redeployed with the NEW bundle. Deleting
  # indexer_cursor makes the cron fall back to `deployBlock - 1` and re-scan
  # forward from the new diamond's deploy block — a clean fresh index. Runs
  # ONLY under `--fresh`; a normal redeploy (same diamond) preserves history.
  if [ "$FRESH" = "1" ]; then
    echo
    echo "[d] --fresh D1 purge for chainId=$CHAIN_ID (stale rows from the retired diamond)"
    purge_chain_d1
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
  # "Cross-Chain Security Policy" gate. Verify the wiring is in place:
  # the governor must be the pool's rateLimitAdmin, and at least one
  # CCIP lane must be configured (per-lane limits cannot exist without
  # a lane). A missing or wrong wiring means `--phase ccip-wire` has
  # not run — fail-hard and refuse to mark verify done.
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

# ── Phase: pause-rehearsal (testnet-only) ─────────────────────────────
# sub-5-minute simultaneous-pause drill. Reads
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
#   - ccipMessenger      (CCIP adapter — GuardianPausable, both paths)
#   - rewardMessenger    (VaipakamRewardMessenger — GuardianPausable)
# (#687-A removed the VPFI fixed-rate buy receiver/adapter — no longer a
#  pause target on any chain.)
# The VPFI CCIP TokenPool carries no pause — its blast radius is bounded
# by the per-lane CCIP rate limits + the Risk Management Network.
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
  for KEY in diamond ccipMessenger rewardMessenger; do
    local ADDR=$(jq -r --arg k "$KEY" '.[$k] // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null)
    # Legacy fallback: pre-PR #272 artifacts stored the reward messenger
    # under the LayerZero-era key `rewardOApp`. Same pattern as
    # `pause-all-chains.sh`. Without this, the pause rehearsal
    # SILENTLY omits the messenger on legacy artifacts — the very
    # contract the 5-minute containment path depends on.
    if [ "$KEY" = "rewardMessenger" ] && { [ -z "$ADDR" ] || [ "$ADDR" = "null" ]; }; then
      ADDR=$(jq -r '.rewardOApp // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null)
    fi
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
  local PAUSE_BUDGET_S=300   # 5-minute hard budget (cross-chain incident post-mortem)

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
  ccip-wire)        phase_ccip_wire ;;
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
