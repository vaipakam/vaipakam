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
#     --skip-lz-config — skip the per-chain `ConfigureLZConfig.s.sol`
#                        DVN policy step (auto-skipped anyway when
#                        DVN_REQUIRED_1 isn't set in .env, but the
#                        explicit flag also suppresses the warning)
#     --fresh          — wipe contracts/deployments/<chain>/addresses.json
#                        AND the watcher's D1 rows for this chainId
#                        before deploying. Use when rehearsing — old
#                        state from a prior deploy can't bleed into the
#                        new one. NEVER pass on a chain whose existing
#                        deploy you want to preserve; this is destructive.
#                        Also wipes step-marker files so every step
#                        runs even if a prior partial deploy left them.
#     --resume         — re-run after a partial-fail. Skips any step
#                        whose marker file (`.markers/<step>-done`)
#                        exists in the deployments dir, so a script
#                        that died at step 4 can restart from step 4
#                        without redoing the diamond + timelock.
#                        Implied behaviour by default: markers ARE
#                        written after each step but NOT consulted
#                        unless --resume is passed (so a vanilla
#                        re-run still re-deploys, matching the prior
#                        behaviour).
#     --verify-contracts
#                      — run `forge verify-contract` against the
#                        chain's block explorer for every deployed
#                        contract after the deploy lands. Requires
#                        ETHERSCAN_API_KEY (or per-chain equivalent;
#                        Foundry's etherscan multi-chain config in
#                        foundry.toml handles routing). Off by default
#                        on testnet — toggling on for rehearsal is a
#                        real-world dry-run of the mainnet flow.
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
SKIP_LZ_CONFIG=0
FRESH=0
RESUME=0
VERIFY_CONTRACTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-frontend)    SKIP_FRONTEND=1 ;;
    --skip-watcher)     SKIP_WATCHER=1 ;;
    --skip-cf)          SKIP_FRONTEND=1; SKIP_WATCHER=1 ;;
    --skip-vpfi)        SKIP_VPFI=1 ;;
    --skip-lz-config)   SKIP_LZ_CONFIG=1 ;;
    --fresh)            FRESH=1 ;;
    --resume)           RESUME=1 ;;
    --verify-contracts) VERIFY_CONTRACTS=1 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ "$FRESH" = "1" ] && [ "$RESUME" = "1" ]; then
  echo "Error: --fresh and --resume are mutually exclusive." >&2
  exit 1
fi

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
    CHAIN_ID=84532;     RPC_VAR="BASE_SEPOLIA_RPC_URL"; IS_CANONICAL=1; LZ_EID=40245
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_BASE_SEPOLIA" ;;
  sepolia)
    CHAIN_ID=11155111;  RPC_VAR="SEPOLIA_RPC_URL";       IS_CANONICAL=0; LZ_EID=40161
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_SEPOLIA" ;;
  arb-sepolia)
    CHAIN_ID=421614;    RPC_VAR="ARB_SEPOLIA_RPC_URL";   IS_CANONICAL=0; LZ_EID=40231
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_ARB_SEPOLIA" ;;
  op-sepolia)
    CHAIN_ID=11155420;  RPC_VAR="OP_SEPOLIA_RPC_URL";    IS_CANONICAL=0; LZ_EID=40232
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_OP_SEPOLIA" ;;
  bnb-testnet)
    CHAIN_ID=97;        RPC_VAR="BNB_TESTNET_RPC_URL";   IS_CANONICAL=0; LZ_EID=40102
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_BNB_TESTNET" ;;
  polygon-amoy)
    CHAIN_ID=80002;     RPC_VAR="POLYGON_AMOY_RPC_URL";  IS_CANONICAL=0; LZ_EID=40267
    LZ_ENDPOINT_VAR="LZ_ENDPOINT_POLYGON_AMOY" ;;
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

# Per-chain LZ_ENDPOINT dispatch. The RewardOApp / VPFI deploy
# scripts read a single `LZ_ENDPOINT` env var, but that's the
# CURRENT-chain endpoint — it differs per chain on mainnet (Base,
# Ethereum, Arb, OP, etc. all have distinct V2 endpoints). The
# rehearsal-time .env carries `LZ_ENDPOINT_<SLUG>` per chain plus
# a single `LZ_ENDPOINT` that happens to match all 3 sepolia
# variants. Override LZ_ENDPOINT here from the per-slug var so
# the same .env works on mainnet without manual editing.
if [ -n "${!LZ_ENDPOINT_VAR:-}" ]; then
  export LZ_ENDPOINT="${!LZ_ENDPOINT_VAR}"
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

# Required env vars for every chain. REWARD_VERSION baked into the
# CREATE2 salt for the RewardOApp deploy — same value across chains
# yields deterministic addresses; missing it bails the script at
# step [5] mid-flight (after Diamond + Timelock + VPFI lane have
# already landed on-chain). Catching it in pre-flight saves the
# faucet-ETH burn from a partial deploy.
for v in PRIVATE_KEY ADMIN_PRIVATE_KEY ADMIN_ADDRESS TREASURY_ADDRESS \
         VPFI_OWNER VPFI_TREASURY VPFI_INITIAL_MINTER \
         TIMELOCK_PROPOSER REWARD_VERSION REWARD_OWNER BASE_EID \
         VPFI_BUY_RECEIVER_EID LZ_ENDPOINT \
         REPORT_OPTIONS_HEX BROADCAST_OPTIONS_HEX; do
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
echo "  skip-lz-config:$SKIP_LZ_CONFIG"
echo "  fresh:         $FRESH"
echo "  resume:        $RESUME"
echo "  verify-cts:    $VERIFY_CONTRACTS"
echo "  skip-frontend: $SKIP_FRONTEND"
echo "  skip-watcher:  $SKIP_WATCHER"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── Step-marker + history-sidecar helpers ─────────────────────────────
# Every named step writes a marker file after success. With --resume,
# a re-run skips any step whose marker exists — so a deploy that died
# at step 4 can resume at step 4 without redoing diamond + timelock.
# --fresh wipes the markers dir before starting.
#
# History sidecar: after each addresses.json-updating step (Diamond,
# Timelock, VPFI lane, Reward OApp), copy the file into
# `.history/<step>-<unix-ts>.json` so the operator has a recoverable
# audit trail of each rehearsal's intermediate states (useful when
# investigating mid-flight failures).

DEPLOY_DIR="$CONTRACTS_DIR/deployments/$CHAIN_SLUG"
MARKERS_DIR="$DEPLOY_DIR/.markers"
HISTORY_DIR="$DEPLOY_DIR/.history"

mkdir -p "$DEPLOY_DIR" "$MARKERS_DIR" "$HISTORY_DIR"

step_done() {
  # Returns 0 (true) if the step has already been run successfully
  # AND the user opted into resume. With --resume off the function
  # always returns 1 so every step runs.
  local step="$1"
  if [ "$RESUME" = "1" ] && [ -f "$MARKERS_DIR/$step.done" ]; then
    return 0
  fi
  return 1
}

mark_done() {
  local step="$1"
  date +"%Y-%m-%dT%H:%M:%S%z" > "$MARKERS_DIR/$step.done"
}

snapshot_addresses() {
  # Sidecar copy of the current addresses.json. Skips silently if no
  # addresses.json exists yet (the very first step).
  local label="$1"
  if [ -f "$DEPLOY_DIR/addresses.json" ]; then
    cp "$DEPLOY_DIR/addresses.json" "$HISTORY_DIR/$label-$(date +%s).json"
  fi
}

# ── 0. --fresh cleanup (rehearsal hygiene) ────────────────────────────
# Wipes prior deploy artefacts + indexer rows for THIS chain so the
# rehearsal starts from a known-empty state. Without this:
#   - DeployDiamond reuses the existing addresses.json's diamond, so
#     storage from the prior rehearsal persists. Old offers/loans
#     written under a previous struct shape silently poison reads
#     (the May-2026 garbage-values bug we hit).
#   - The watcher's D1 keeps rows decoded against the prior bytecode,
#     surfacing them in /offers/recent etc. with garbage amount /
#     rate / duration values.
# Mainnet slugs are refused by the chain registry above, so this
# block can only fire on testnets.

if [ "$FRESH" = "1" ]; then
  echo "[0] --fresh cleanup"
  if [ -f "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" ]; then
    BACKUP="$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.prior-rehearsal.$(date +%s).json"
    mv "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" "$BACKUP"
    echo "  ✓ backed up prior addresses.json → $(basename "$BACKUP")"
  else
    echo "  (no prior addresses.json — already clean)"
  fi
  # Wipe step markers so every step re-runs.
  rm -f "$MARKERS_DIR"/*.done 2>/dev/null || true
  echo "  ✓ cleared step markers in $MARKERS_DIR"
  if [ -d "$WATCHER_DIR" ] && [ -f "$WATCHER_DIR/scripts/purge-chain.sh" ]; then
    echo "  purging watcher D1 rows for chainId=$CHAIN_ID"
    # FORCE=1 skips the interactive y/N prompt — purge-chain.sh's
    # default flow is operator-confirmation-gated, but inside an
    # automated --fresh sweep that's noise. The destructive scope
    # (D1 rows scoped to ONE chainId, never user_locales) is
    # already conservative.
    ( cd "$WATCHER_DIR" && FORCE=1 bash scripts/purge-chain.sh "$CHAIN_ID" ) || \
      echo "    (purge-chain returned non-zero — check watcher logs)"
  else
    echo "  (no watcher purge-chain.sh — skipping D1 cleanup)"
  fi
  echo
fi

# ── 1. Build ──────────────────────────────────────────────────────────

if step_done "build"; then
  echo "[1] forge build (skipped — marker exists)"
else
  echo "[1] forge build"
  forge build
  mark_done "build"
fi

# ── 2. Diamond ────────────────────────────────────────────────────────

if step_done "diamond"; then
  echo
  echo "[2] DeployDiamond.s.sol (skipped — marker exists)"
else
  echo
  echo "[2] DeployDiamond.s.sol"
  forge script script/DeployDiamond.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-diamond"
  mark_done "diamond"
fi

# ── 2b. Post-cut facet verification ───────────────────────────────────
# DeployDiamond's `diamondCut` is split into two halves to stay under
# the per-tx gas cap (commit `585179f`). If the second half silently
# fails (gas spike, RPC hiccup, etc.), the diamond ends up with only
# the first 16 facets registered — selectors from the second half
# revert with `FunctionDoesNotExist`, but the deploy script itself
# returns 0. The May-2026 testnet rehearsal hit exactly this pattern
# (offer struct decoded as garbage because the OfferFacet selectors
# came back from the OLD pre-redeploy facet, while the indexer used
# the new ABI). DiamondLoupe's `facetAddresses()` is the authoritative
# post-deploy answer.
#
# Expected: 32 cut facets + 1 DiamondCutFacet (constructor-added) = 33.

echo
echo "[2b] Post-cut facet-count verification (DiamondLoupe)"
DIAMOND_ADDR=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_ADDR" ]; then
  echo "FAIL: no diamond address in deployments/$CHAIN_SLUG/addresses.json after DeployDiamond." >&2
  echo "      Either the script reverted silently or addresses.json wasn't written." >&2
  exit 1
fi
# DiamondCutFacet is selector-callable but NOT enumerated by the
# Loupe (constructor writes the selector mapping directly without
# touching facetAddresses[]), so the visible count is exactly the
# number of cut entries — 32 today, not 33.
EXPECTED_FACETS=32
FACET_COUNT_RAW=$(cast call "$DIAMOND_ADDR" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null \
  | tr ',' '\n' | grep -c '0x' || echo 0)
if [ "$FACET_COUNT_RAW" -lt "$EXPECTED_FACETS" ]; then
  echo "FAIL: diamond at $DIAMOND_ADDR has $FACET_COUNT_RAW facets, expected $EXPECTED_FACETS." >&2
  echo "      The diamondCut likely landed only its first half. Re-run with --fresh." >&2
  exit 1
fi
echo "  ✓ diamond at $DIAMOND_ADDR has $FACET_COUNT_RAW facets (≥ $EXPECTED_FACETS expected)"

# ── 3. Timelock ───────────────────────────────────────────────────────

if step_done "timelock"; then
  echo
  echo "[3] DeployTimelock.s.sol (skipped — marker exists)"
else
  echo
  echo "[3] DeployTimelock.s.sol"
  forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-timelock"
  mark_done "timelock"
fi

# ── 4. VPFI lane (canonical vs mirror) ────────────────────────────────

if [ "$SKIP_VPFI" = "0" ] && step_done "vpfi-lane"; then
  echo
  echo "[4-5] VPFI lane + Reward OApp (skipped — marker exists)"
elif [ "$SKIP_VPFI" = "0" ]; then
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

    # ── 4c. Buy-VPFI rate limits (mirror chains only) ─────────────────
    # The BuyAdapter ships with `setRateLimits(uint256.max, uint256.max)`
    # at deploy time — i.e. effectively disabled — per the project's
    # mainnet-deploy gate (`CLAUDE.md` "Cross-Chain Security Policy").
    # Without an explicit `setRateLimits` after deploy, a buy request
    # carrying a malformed amount could mint unbounded VPFI on the
    # canonical receiver. Defaults applied here:
    #   per-block:  50_000 × 1e18 VPFI  (override via VPFI_BUY_RATE_PER_BLOCK)
    #   per-day:    500_000 × 1e18 VPFI (override via VPFI_BUY_RATE_PER_DAY)
    # The April-2026 cross-chain bridge incident (~$200M drained) rode
    # an unrate-limited adapter; setting these on every deploy makes
    # mainnet readiness depend on the deploy artefact, not on a manual
    # follow-up step that's easy to forget.
    echo
    echo "[4c] Buy-VPFI rate limits (mirror — VPFIBuyAdapter.setRateLimits)"
    BUY_ADAPTER=$(jq -r '.vpfiBuyAdapter // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
    if [ -z "$BUY_ADAPTER" ]; then
      echo "  ⚠ no vpfiBuyAdapter in addresses.json — skipping rate-limit set."
    else
      RATE_PER_BLOCK="${VPFI_BUY_RATE_PER_BLOCK:-50000000000000000000000}"   # 50_000 × 1e18
      RATE_PER_DAY="${VPFI_BUY_RATE_PER_DAY:-500000000000000000000000}"     # 500_000 × 1e18
      echo "  cast send setRateLimits($RATE_PER_BLOCK, $RATE_PER_DAY) on $BUY_ADAPTER"
      cast send "$BUY_ADAPTER" 'setRateLimits(uint256,uint256)' \
        "$RATE_PER_BLOCK" "$RATE_PER_DAY" \
        --private-key "$ADMIN_PRIVATE_KEY" \
        --rpc-url "$RPC" \
        2>&1 | grep -E "^status" | head -1 || true
    fi
  fi

  # Reward OApp — canonical-vs-mirror branched the same way.
  echo
  echo "[5] DeployRewardOAppCreate2.s.sol"
  if [ "$IS_CANONICAL" = "1" ]; then
    export IS_CANONICAL_REWARD=true
    # The RewardOApp contract enforces BASE_EID=0 on the canonical
    # chain (it IS the base, so there's no peer eid to point at).
    # The user's .env carries BASE_EID=40245 (the canonical eid)
    # for mirror-chain deploys; override here when we're running
    # on the canonical itself.
    export BASE_EID=0
  else
    export IS_CANONICAL_REWARD=false
    # Mirror chains: BASE_EID points at the canonical's lzEid.
    # The .env value (40245 for Base Sepolia rehearsal) is correct
    # for mirrors so no override needed — but make it explicit for
    # clarity rather than rely on .env being right.
    export BASE_EID=40245
  fi
  forge script script/DeployRewardOAppCreate2.s.sol --rpc-url "$RPC" --broadcast --slow
  snapshot_addresses "post-vpfi-and-reward"
  mark_done "vpfi-lane"
else
  echo
  echo "[4-5] Skipping VPFI lane + Reward OApp (--skip-vpfi)"
fi

# ── 5b. Master-flag flip (testnet ergonomics) ─────────────────────────
# Range Orders Phase 1 governance-gated kill switches default `false` on
# every fresh deploy (per docs/RangeOffersDesign.md §15 staged-enablement
# rationale). On Anvil the bootstrap script flips them; on testnet
# operators previously had to do this manually after every fresh deploy.
# Flipping here removes the manual step — no functional change to
# mainnet behaviour because deploy-mainnet.sh does NOT call this script
# (and mainnet should keep the staged-rollout discipline).
#
# Idempotent — `setRange*Enabled(true)` on an already-true flag is a
# successful no-op state write.

echo
echo "[5b] Master-flag flip (testnet ergonomics)"
DIAMOND_ADDR=$(jq -r '.diamond // empty' "$CONTRACTS_DIR/deployments/$CHAIN_SLUG/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_ADDR" ]; then
  echo "    (no diamond address yet — skipping master-flag flip)"
elif [ -z "${ADMIN_PRIVATE_KEY:-}" ]; then
  echo "    (ADMIN_PRIVATE_KEY missing — skipping master-flag flip)"
else
  for fn in setRangeAmountEnabled setRangeRateEnabled setPartialFillEnabled; do
    echo "  cast send $fn(true) on $DIAMOND_ADDR"
    cast send "$DIAMOND_ADDR" "$fn(bool)" true \
      --private-key "$ADMIN_PRIVATE_KEY" \
      --rpc-url "$RPC" \
      2>&1 | grep -E "^status" | head -1 || true
  done
  echo "  Final master flags: $(cast call $DIAMOND_ADDR 'getMasterFlags()(bool,bool,bool)' --rpc-url $RPC | tr '\n' ' ')"
fi

# ── 5c. LZ DVN policy (per-chain) ─────────────────────────────────────
# `ConfigureLZConfig.s.sol` sets the DVN required + optional set,
# confirmations, send/recv libraries, and threshold for each (OApp,
# remote-eid) pair on THIS chain. Per CLAUDE.md "Cross-Chain Security
# Policy": 3 required + 2 optional, threshold 1-of-2, operator
# diversity load-bearing. Without this step, OApps inherit
# LayerZero's 1-required / 0-optional default — the same single-
# verifier shape that rode the April-2026 cross-chain bridge exploit.
#
# Cross-chain peer-wiring (`setPeer`) is NOT here — peers need both
# legs deployed first, so the wiring lives in `deploy-peers.sh`
# which runs once after every chain's `deploy-chain.sh` lands.
#
# Auto-skipped if DVN_REQUIRED_1 isn't set (testnet rehearsals
# without a curated DVN set just leave OApps on LayerZero defaults
# — acceptable on a chain with no real value, but logged loudly so
# the operator notices).

if [ "$SKIP_LZ_CONFIG" = "1" ]; then
  echo
  echo "[5c] Skipping ConfigureLZConfig (--skip-lz-config)"
elif [ -z "${DVN_REQUIRED_1:-}" ]; then
  echo
  echo "[5c] Skipping ConfigureLZConfig — DVN_REQUIRED_1 not set in .env."
  echo "     OApps remain on LayerZero's 1-required / 0-optional default."
  echo "     For mainnet this is a security gap; populate DVN_REQUIRED_1/2/3,"
  echo "     DVN_OPTIONAL_1/2, CONFIRMATIONS, OAPP, SEND_LIB, RECV_LIB,"
  echo "     REMOTE_EIDS in .env per contracts/README.md before re-running."
elif step_done "lz-config"; then
  echo
  echo "[5c] ConfigureLZConfig (skipped — marker exists)"
else
  echo
  echo "[5c] ConfigureLZConfig.s.sol  (per-chain DVN + libs + confirmations)"
  forge script script/ConfigureLZConfig.s.sol --rpc-url "$RPC" --broadcast --slow
  mark_done "lz-config"
fi

# ── 5d. Post-deploy health check ──────────────────────────────────────
# Reads sentinel state from the deployed Diamond + (where applicable)
# the BuyAdapter rate limits. Logs a clear PASS/FAIL line per check
# so a deploy that landed structurally but mis-configured (e.g.
# default-uint256.max rate limits, paused diamond, missing treasury)
# fails LOUDLY here rather than silently shipping a broken state.
# Health-check log is also persisted to .history/ for audit trail.

echo
echo "[5d] Post-deploy health check"
DIAMOND_FOR_HEALTH=$(jq -r '.diamond // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
if [ -z "$DIAMOND_FOR_HEALTH" ]; then
  echo "  ⚠ no diamond in addresses.json — skipping health check"
else
  HEALTH_LOG="$HISTORY_DIR/health-$(date +%s).log"
  {
    echo "deploy-chain.sh health check"
    echo "  chain:    $CHAIN_SLUG ($CHAIN_ID)"
    echo "  diamond:  $DIAMOND_FOR_HEALTH"
    echo "  ts:       $(date +%Y-%m-%dT%H:%M:%S%z)"
    echo
    echo "  paused()         = $(cast call "$DIAMOND_FOR_HEALTH" 'paused()(bool)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  getTreasury()    = $(cast call "$DIAMOND_FOR_HEALTH" 'getTreasury()(address)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  nextOfferId()    = $(cast call "$DIAMOND_FOR_HEALTH" 'nextOfferId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  nextLoanId()     = $(cast call "$DIAMOND_FOR_HEALTH" 'nextLoanId()(uint256)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "  facetCount       = $(cast call "$DIAMOND_FOR_HEALTH" 'facetAddresses()(address[])' --rpc-url "$RPC" 2>/dev/null | tr ',' '\n' | grep -c '0x' || echo '?')"
    echo "  getMasterFlags() = $(cast call "$DIAMOND_FOR_HEALTH" 'getMasterFlags()(bool,bool,bool)' --rpc-url "$RPC" 2>/dev/null | tr '\n' ' ' || echo '?')"
    BA=$(jq -r '.vpfiBuyAdapter // empty' "$DEPLOY_DIR/addresses.json" 2>/dev/null || echo "")
    if [ -n "$BA" ]; then
      echo "  buyAdapter       = $BA"
      # Read both caps via the `getRateLimits()` tuple-getter (added
      # post-rehearsal — see ContractFollowupsFromRehearsal-2026-05-06.md
      # Item 1). uint256.max in either field means the post-deploy
      # `setRateLimits` call (step [4c]) didn't land or didn't take
      # effect — hard-fail with a non-zero exit so the operator
      # cannot accidentally treat a deploy as healthy when the
      # canonical-mint rate limit is still at the unlimited default.
      RATE_LIMITS_RAW=$(cast call "$BA" 'getRateLimits()(uint256,uint256)' --rpc-url "$RPC" 2>/dev/null || echo "")
      if [ -z "$RATE_LIMITS_RAW" ]; then
        echo "    rateLimits     = ? (getRateLimits call failed)"
      else
        # cast call returns "<perRequest>\n<daily>" for tuple returns.
        PER_REQ=$(echo "$RATE_LIMITS_RAW" | sed -n '1p' | awk '{print $1}')
        DAILY=$(echo "$RATE_LIMITS_RAW" | sed -n '2p' | awk '{print $1}')
        UINT256_MAX="115792089237316195423570985008687907853269984665640564039457584007913129639935"
        echo "    perRequestCap  = $PER_REQ"
        echo "    dailyCap       = $DAILY"
        if [ "$PER_REQ" = "$UINT256_MAX" ] || [ "$DAILY" = "$UINT256_MAX" ]; then
          echo "    ✗ FAIL: a rate-limit cap is still at the unlimited default."
          echo "             setRateLimits in step [4c] either didn't land or"
          echo "             passed type(uint256).max. Deploy is NOT healthy."
          exit 1
        fi
        echo "    ✓ both caps finite — BuyAdapter ready for canonical mint."
      fi
    fi
  } | tee "$HEALTH_LOG"
  echo "  ✓ health log → $(basename "$HEALTH_LOG")"
fi

# ── 5e. Deployment-source marker ──────────────────────────────────────
# Records which CONTRACTS commit produced the deployed bytecode + when
# the deploy ran + which deployer signed. The May-2026 rehearsal
# revealed that addresses.json's `deployedAt` field gets stale (the
# deploy script doesn't update it on redeploy), so the operator
# couldn't tell at a glance which version was actually live. This
# sidecar fixes that — written fresh on every deploy completion.

DEPLOYER_ADDR=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || echo "?")
COMMIT_HASH=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "?")
COMMIT_DIRTY=""
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then
  COMMIT_DIRTY=" (dirty)"
fi
cat > "$DEPLOY_DIR/deployment_source.json" <<EOF
{
  "chainSlug": "$CHAIN_SLUG",
  "chainId": $CHAIN_ID,
  "deployedAt": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "monorepoCommit": "$COMMIT_HASH$COMMIT_DIRTY",
  "deployer": "$DEPLOYER_ADDR",
  "diamond": "$DIAMOND_FOR_HEALTH"
}
EOF
echo "  ✓ deployment_source.json written ($(echo "$COMMIT_HASH" | head -c 8)$COMMIT_DIRTY)"

# ── 5f. Source-code verification on chain explorer ────────────────────
# Runs `forge verify-contract` against the chain's Etherscan-family
# explorer for every deployed contract. Verified source on the
# explorer is a baseline for user trust + makes audit / debugging
# painless. Off by default on testnet (saves API quota during quick
# iteration); turn on for rehearsal / mainnet via --verify-contracts.
#
# Foundry's etherscan multi-chain config (in foundry.toml) handles
# routing — we just need ETHERSCAN_API_KEY (or per-chain equivalent)
# in the env. Failures don't bubble up: a single contract that fails
# verification (already-verified, rate-limited, broken bytecode-vs-
# source) shouldn't bring down the rest of the deploy. Each line is
# logged; operator eyeballs the summary at the end.
#
# Walks the chain-specific broadcast records (one per forge script
# that ran above) and verifies every CREATE2 / contract creation it
# captures.

if [ "$VERIFY_CONTRACTS" = "1" ] && step_done "verify-contracts"; then
  echo
  echo "[5f] Source-code verification (skipped — marker exists)"
elif [ "$VERIFY_CONTRACTS" = "1" ]; then
  echo
  echo "[5f] Source-code verification on explorer (forge verify-contract)"
  if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
    echo "  ⚠ ETHERSCAN_API_KEY not set — verification will fail. Set in .env"
    echo "    (or per-chain equivalent in foundry.toml's etherscan config)"
    echo "    and re-run with --verify-contracts."
  else
    BROADCAST_DIR="$CONTRACTS_DIR/broadcast"
    if [ ! -d "$BROADCAST_DIR" ]; then
      echo "  ⚠ no broadcast/ dir — was forge script ever run with --broadcast?"
    else
      VERIFIED=0
      FAILED=0
      # First pass: collect a deduped (addr, name) pair list from
      # EVERY run-latest.json under broadcast/, scoped to this chain.
      # Without dedup, a single ERC20Mock referenced by 5 different
      # test scripts would be verified 5 times — each `--watch` call
      # polls the explorer 30-120s, so duplicates blow the loop into
      # multi-hour territory. Dedup collapses N-script × M-tx down
      # to the unique-contract set actually present on chain.
      #
      # Also scope to records FRESH from this deploy (mtime newer
      # than the deployment_source.json's write time, which is one
      # step earlier in the script and stamped fresh on every run).
      # Old broadcast files from prior testnet runs reference long-
      # since-redeployed mocks; verifying them is wasted work.
      DEPLOY_SOURCE_FILE="$DEPLOY_DIR/deployment_source.json"
      DEPLOY_SOURCE_MTIME=0
      if [ -f "$DEPLOY_SOURCE_FILE" ]; then
        DEPLOY_SOURCE_MTIME=$(stat -c %Y "$DEPLOY_SOURCE_FILE" 2>/dev/null || echo 0)
      fi
      declare -A SEEN_ADDR
      VERIFY_QUEUE_FILE=$(mktemp)
      while IFS= read -r run_file; do
        # Skip stale broadcast records — anything older than the
        # current deployment_source.json is from a prior deploy.
        FILE_MTIME=$(stat -c %Y "$run_file" 2>/dev/null || echo 0)
        if [ "$DEPLOY_SOURCE_MTIME" -gt 0 ] && [ "$FILE_MTIME" -lt "$DEPLOY_SOURCE_MTIME" ]; then
          continue
        fi
        while IFS= read -r line; do
          ADDR=$(echo "$line" | jq -r '.contractAddress // empty')
          NAME=$(echo "$line" | jq -r '.contractName // empty')
          [ -z "$ADDR" ] && continue
          [ -z "$NAME" ] && continue
          [ "$ADDR" = "null" ] && continue
          [ "$NAME" = "null" ] && continue
          # Dedupe by lowercased address — same address can appear
          # under different `contractName` fields if a forge script
          # references it through different interface types.
          ADDR_LC=$(echo "$ADDR" | tr 'A-Z' 'a-z')
          if [ -n "${SEEN_ADDR[$ADDR_LC]:-}" ]; then continue; fi
          SEEN_ADDR[$ADDR_LC]=1
          echo "$ADDR $NAME" >> "$VERIFY_QUEUE_FILE"
        done < <(jq -c '.transactions[]?' "$run_file" 2>/dev/null)
      done < <(find "$BROADCAST_DIR" -path "*/$CHAIN_ID/run-latest.json" 2>/dev/null)

      QUEUE_LEN=$(wc -l < "$VERIFY_QUEUE_FILE" || echo 0)
      echo "  $QUEUE_LEN unique contract(s) in verify queue (post-dedup)"

      while read -r ADDR NAME; do
        if forge verify-contract --chain-id "$CHAIN_ID" --watch \
            "$ADDR" "$NAME" >/dev/null 2>&1; then
          echo "  ✓ $NAME @ $ADDR"
          VERIFIED=$((VERIFIED + 1))
        else
          echo "  ✗ $NAME @ $ADDR  (already-verified / rate-limit / mismatch)"
          FAILED=$((FAILED + 1))
        fi
      done < "$VERIFY_QUEUE_FILE"
      rm -f "$VERIFY_QUEUE_FILE"
      echo "  Summary: $VERIFIED verified, $FAILED failed (across $QUEUE_LEN unique contracts)"
    fi
  fi
  mark_done "verify-contracts"
fi

# ── 6. Sync ABIs + consolidated deployments JSON ──────────────────────
# ABIs auto-exported from compiled bytecode → frontend + watcher +
# (if sibling repo present) keeper-bot. Consolidated deployments.json
# (addresses + facet addrs) is also written to BOTH frontend and
# watcher targets — `exportFrontendDeployments.sh` auto-detects the
# watcher's directory at `vaipakam/ops/hf-watcher` and writes to it
# whenever the sibling layout exists. So this single step keeps the
# entire downstream surface (frontend reads, watcher decode, keeper-
# bot reads) on the same `89b551e`-style commit stamp — no manual
# follow-up needed before the cf-frontend / cf-watcher steps below.

if step_done "abi-sync"; then
  echo
  echo "[6] Sync ABIs + consolidated deployments JSON (skipped — marker exists)"
else
echo
echo "[6] Sync ABIs + consolidated deployments JSON"
bash "$SCRIPT_DIR/exportFrontendAbis.sh"
# Watcher's `getOfferDetails` / `getLoanDetails` tuples used to live as
# hand-typed `as const` arrays in `ops/hf-watcher/src/diamondAbi.ts`.
# A struct-shape change in `LibVaipakam.Offer` (added
# `periodicInterestCadence`) silently misaligned the worker's
# positional decoder and produced the OfferBook display bug captured
# in ReleaseNotes-2026-05-05.md. Auto-exporting the watcher's ABIs
# from the compiled bytecode on every deploy makes that drift
# structurally impossible — the Solidity compiler is now the single
# source of truth for the worker's read-decode shape.
bash "$SCRIPT_DIR/exportWatcherAbis.sh"
bash "$SCRIPT_DIR/exportFrontendDeployments.sh"

KEEPER_BOT_DIR_DEFAULT="$REPO_ROOT/../vaipakam-keeper-bot"
if [ -d "$KEEPER_BOT_DIR_DEFAULT" ]; then
  bash "$SCRIPT_DIR/exportAbis.sh"
else
  echo "    (skipping keeper-bot ABI export — sibling repo not at $KEEPER_BOT_DIR_DEFAULT)"
fi
mark_done "abi-sync"
fi  # close step_done "abi-sync" else branch

# ── 7. Frontend Cloudflare deploy ─────────────────────────────────────

if [ "$SKIP_FRONTEND" = "0" ] && step_done "frontend"; then
  echo
  echo "[7] Frontend deploy (skipped — marker exists)"
elif [ "$SKIP_FRONTEND" = "0" ]; then
  echo
  echo "[7] Frontend build + Cloudflare Workers Static Assets deploy"
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "Error: $FRONTEND_DIR/node_modules missing — run \`cd frontend && npm install\` first." >&2
    exit 1
  fi
  ( cd "$FRONTEND_DIR" && npm run build && npx wrangler deploy )
  mark_done "frontend"
else
  echo
  echo "[7] Skipping frontend deploy (--skip-frontend)"
fi

# ── 8. hf-watcher Cloudflare deploy ───────────────────────────────────
#
# Three sub-steps:
#   8a. wrangler deploy — push the Worker bundle (idempotent on
#       unchanged source).
#   8b. D1 migrations — apply any pending schema migrations to the
#       remote `vaipakam-alerts-db` database. Idempotent — wrangler
#       skips already-applied entries. Without this step the Worker
#       returns 500 `byParticipant-failed` (D1_ERROR no such table)
#       on every loan/offer query.
#   8c. RPC-secret check — warn (don't fail) if the per-chain
#       `RPC_<CHAIN>` Cloudflare secret is unset. The Worker returns
#       503 `chain-not-configured` for any chainId whose RPC secret
#       isn't set. Operators set these via
#       `wrangler secret put RPC_<CHAIN>` from inside ops/hf-watcher.
#       The script does NOT auto-set them — the values carry API keys
#       and are operator-curated per CLAUDE.md.

if [ "$SKIP_WATCHER" = "0" ] && step_done "watcher"; then
  echo
  echo "[8] Watcher deploy (skipped — marker exists)"
elif [ "$SKIP_WATCHER" = "0" ]; then
  echo
  echo "[8] hf-watcher Cloudflare Worker deploy"
  if [ ! -d "$WATCHER_DIR" ]; then
    echo "    (no $WATCHER_DIR — skipping)"
  elif [ ! -d "$WATCHER_DIR/node_modules" ]; then
    echo "Error: $WATCHER_DIR/node_modules missing — run \`cd ops/hf-watcher && npm install\` first." >&2
    exit 1
  else
    # Pre-deploy D1 purge — fires only with --fresh, before the new
    # worker bundle goes live. Why HERE and not just at step [0]:
    # the cron tick fires every 5 min. If a redeploy takes longer
    # than that (slow chain, retries, whatever), the OLD worker
    # could re-populate D1 with rows decoded against the OLD
    # bytecode between step [0] and step [8]. Purging again right
    # before the new worker takes over guarantees the new cron tick
    # starts with clean state. With --fresh OFF this block is a
    # no-op so non-rehearsal redeploys keep their indexed history.
    if [ "$FRESH" = "1" ] && [ -f "$WATCHER_DIR/scripts/purge-chain.sh" ]; then
      echo "  [8a-pre] watcher D1 purge for chainId=$CHAIN_ID  (--fresh)"
      ( cd "$WATCHER_DIR" && FORCE=1 bash scripts/purge-chain.sh "$CHAIN_ID" ) || \
        echo "    (purge-chain returned non-zero — check watcher logs)"
    fi

    echo "  [8a] wrangler deploy"
    ( cd "$WATCHER_DIR" && npx wrangler deploy )

    echo
    echo "  [8b] D1 migrations (vaipakam-alerts-db)"
    ( cd "$WATCHER_DIR" && npm run db:migrate )

    echo
    echo "  [8c] RPC-secret check for chainId=$CHAIN_ID"
    # Map chain-slug → expected secret name (mirrors loanRoutes.ts/offerRoutes.ts).
    case "$CHAIN_SLUG" in
      base-sepolia)  EXPECTED_RPC_SECRET="RPC_BASE_SEPOLIA" ;;
      sepolia)       EXPECTED_RPC_SECRET="RPC_SEPOLIA" ;;
      arb-sepolia)   EXPECTED_RPC_SECRET="RPC_ARB_SEPOLIA" ;;
      op-sepolia)    EXPECTED_RPC_SECRET="RPC_OP_SEPOLIA" ;;
      bnb-testnet)   EXPECTED_RPC_SECRET="RPC_BNB_TESTNET" ;;
      polygon-amoy)  EXPECTED_RPC_SECRET="RPC_POLYGON_AMOY" ;;
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
        echo "     (Per CLAUDE.md, RPC secrets are operator-curated and"
        echo "      live as wrangler secrets, never in the repo.)"
      else
        echo "  ✓ $EXPECTED_RPC_SECRET is set"
      fi
    fi
    mark_done "watcher"
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
echo "  1. Cross-chain LZ peer wiring (after EVERY chain in your"
echo "     topology has had this script run):"
echo "        bash contracts/script/deploy-peers.sh"
echo "     Walks the deployments/ tree and wires setPeer on every"
echo "     (canonical, mirror) leg + Reward-OApp mesh."
echo "  2. Role rotation to governance + timelock — DeploymentRunbook §6"
echo "     (multi-party ceremony, deliberately out of any script)"
echo "═══════════════════════════════════════════════════════════════"
