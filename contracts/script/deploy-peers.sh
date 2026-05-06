#!/usr/bin/env bash
#
# deploy-peers.sh — cross-chain LayerZero peer wiring.
#
# Run ONCE after `deploy-chain.sh` has landed on every chain in your
# topology. This script reads each `contracts/deployments/<slug>/
# addresses.json`, walks the (source, OApp, destination) matrix, and
# fires `setPeer` on each leg via `WireVPFIPeers.s.sol`.
#
# Why this lives here, not in `deploy-chain.sh`:
#   - `setPeer` requires the REMOTE peer's address to exist on the
#     remote chain. If you set peer A→B before chain B is deployed,
#     you'd be peering at `address(0)` and have to redo the call.
#   - The natural shape is: deploy every chain (each self-contained),
#     then sweep peers across the matrix in one pass.
#
# Topology (auto-detected from addresses.json `isCanonicalVPFI`):
#
#   VPFI lane (canonical OFTAdapter ↔ each mirror's VPFIMirror):
#     - canonical.vpfiOftAdapter ←→ each mirror.vpfiMirror
#       (bidirectional — VPFI flows both ways)
#
#   Buy lane (mirror BuyAdapter → canonical BuyReceiver):
#     - canonical.vpfiBuyReceiver ←→ each mirror.vpfiBuyAdapter
#       (bidirectional — request goes mirror→canonical, ack comes back)
#
#   Reward lane (full mesh — every chain to every other):
#     - chainA.rewardOApp ←→ chainB.rewardOApp for every (A, B) pair
#
# Env requirements:
#   - PRIVATE_KEY (signs setPeer txs — must be the OApp owner on each
#     chain, i.e. the deployer or the address you'll later renounce
#     to a multisig)
#   - <CHAIN>_RPC_URL for every chain present in deployments/
#
# Usage:
#   bash contracts/script/deploy-peers.sh [--dry-run] [--only-chains slug1,slug2,...]
#
#   --dry-run        — print the wiring plan, don't broadcast
#   --only-chains    — restrict to a comma-separated subset (handy when
#                       re-running after a partial-fail; safe to repeat
#                       since `setPeer` is idempotent)
#   --include-stale  — include chains whose deployment_source.json is
#                       older than the most-recent chain's. Off by
#                       default — when running peer-wiring after a
#                       fresh rehearsal, you want to wire ONLY the
#                       chains you just deployed. The auto-filter
#                       skips legacy `deployments/<slug>/` directories
#                       from prior rehearsals (e.g. `bnb-testnet`,
#                       `sepolia`) without forcing the operator to
#                       enumerate them via --only-chains.
#
# Authority note (load-bearing):
#   `setPeer` is owner-gated on each OApp. The DeployVPFI* /
#   DeployRewardOAppCreate2 scripts transfer ownership of the OApps
#   to ADMIN_ADDRESS at the end. So this script overrides
#   PRIVATE_KEY → ADMIN_PRIVATE_KEY for the duration of the run.
#   Without that override, every setPeer reverts with
#   `OwnableUnauthorizedAccount(<deployer>)`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$CONTRACTS_DIR"

# ── Args ──────────────────────────────────────────────────────────────

DRY_RUN=0
ONLY_CHAINS=""
INCLUDE_STALE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)       DRY_RUN=1 ;;
    --only-chains)   shift; ONLY_CHAINS="$1" ;;
    --include-stale) INCLUDE_STALE=1 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# ── Load .env ─────────────────────────────────────────────────────────

if [ -f "$CONTRACTS_DIR/.env" ]; then
  set -a; source "$CONTRACTS_DIR/.env"; set +a
else
  echo "Error: $CONTRACTS_DIR/.env not found." >&2
  exit 1
fi

if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "Error: PRIVATE_KEY required in .env." >&2
  exit 1
fi

# OApp ownership transfers to ADMIN_ADDRESS at the end of each
# DeployVPFI*/DeployRewardOAppCreate2 script. So `setPeer` calls
# need to be signed by the admin key, not the deployer key. The
# WireVPFIPeers.s.sol script reads `PRIVATE_KEY` from env, so we
# override it here for the duration of this script with the admin
# key. The original deployer key is restored at the end.
if [ -z "${ADMIN_PRIVATE_KEY:-}" ]; then
  echo "Error: ADMIN_PRIVATE_KEY required in .env (admin owns the OApps post-deploy)." >&2
  exit 1
fi
ORIGINAL_PRIVATE_KEY="$PRIVATE_KEY"
export PRIVATE_KEY="$ADMIN_PRIVATE_KEY"
trap 'export PRIVATE_KEY="$ORIGINAL_PRIVATE_KEY"' EXIT

# ── Chain registry (slug → RPC env var) ───────────────────────────────
# Keep in sync with deploy-chain.sh + deploy-mainnet.sh.

rpc_var_for_slug() {
  case "$1" in
    base-sepolia)   echo "BASE_SEPOLIA_RPC_URL" ;;
    sepolia)        echo "SEPOLIA_RPC_URL" ;;
    arb-sepolia)    echo "ARB_SEPOLIA_RPC_URL" ;;
    op-sepolia)     echo "OP_SEPOLIA_RPC_URL" ;;
    bnb-testnet)    echo "BNB_TESTNET_RPC_URL" ;;
    polygon-amoy)   echo "POLYGON_AMOY_RPC_URL" ;;
    ethereum)       echo "ETHEREUM_RPC_URL" ;;
    base)           echo "BASE_RPC_URL" ;;
    arbitrum)       echo "ARBITRUM_RPC_URL" ;;
    optimism)       echo "OPTIMISM_RPC_URL" ;;
    polygon-zkevm)  echo "POLYGON_ZKEVM_RPC_URL" ;;
    bnb)            echo "BNB_RPC_URL" ;;
    polygon)        echo "POLYGON_RPC_URL" ;;
    *)              echo "" ;;
  esac
}

# ── Discover deployed chains ──────────────────────────────────────────

declare -a CHAINS=()
declare -a INCLUDED_FILTER=()
if [ -n "$ONLY_CHAINS" ]; then
  IFS=',' read -ra INCLUDED_FILTER <<< "$ONLY_CHAINS"
fi

for dir in "$CONTRACTS_DIR/deployments"/*/; do
  [ -d "$dir" ] || continue
  slug="$(basename "$dir")"
  [ "$slug" = "anvil" ] && continue
  [ ! -f "$dir/addresses.json" ] && continue

  if [ ${#INCLUDED_FILTER[@]} -gt 0 ]; then
    found=0
    for f in "${INCLUDED_FILTER[@]}"; do
      [ "$f" = "$slug" ] && found=1
    done
    [ "$found" = "0" ] && continue
  fi

  CHAINS+=("$slug")
done

# Stale-chain auto-skip: when there are deployment_source.json files
# from multiple rehearsals on disk (e.g. legacy `bnb-testnet/` +
# `sepolia/` from prior testnet runs alongside today's
# `base-sepolia/`, `arb-sepolia/`, `op-sepolia/`), default to wiring
# ONLY the chains whose deployment_source.json is within 1 hour of
# the freshest one. This keeps `bash deploy-peers.sh` (no flags)
# safe-by-default after a fresh rehearsal — the operator doesn't
# need to enumerate today's chains via --only-chains. Pass
# --include-stale to bypass the filter (e.g. when re-wiring an
# established multi-chain topology that wasn't all redeployed today).
if [ "$INCLUDE_STALE" = "0" ] && [ ${#INCLUDED_FILTER[@]} -eq 0 ]; then
  declare -A SOURCE_MTIME
  MAX_MTIME=0
  for slug in "${CHAINS[@]}"; do
    src="$CONTRACTS_DIR/deployments/$slug/deployment_source.json"
    if [ -f "$src" ]; then
      mt=$(stat -c %Y "$src" 2>/dev/null || echo 0)
    else
      mt=0
    fi
    SOURCE_MTIME[$slug]=$mt
    if [ "$mt" -gt "$MAX_MTIME" ]; then MAX_MTIME=$mt; fi
  done
  if [ "$MAX_MTIME" -gt 0 ]; then
    FRESH_THRESHOLD=$((MAX_MTIME - 3600))  # within 1 hour of the freshest
    declare -a FRESH_CHAINS=()
    declare -a SKIPPED_STALE=()
    for slug in "${CHAINS[@]}"; do
      mt=${SOURCE_MTIME[$slug]:-0}
      if [ "$mt" -ge "$FRESH_THRESHOLD" ]; then
        FRESH_CHAINS+=("$slug")
      else
        SKIPPED_STALE+=("$slug")
      fi
    done
    if [ ${#SKIPPED_STALE[@]} -gt 0 ]; then
      echo "  Skipping stale chains (deployment_source.json older than 1h" \
           "before the freshest deploy): ${SKIPPED_STALE[*]}"
      echo "  Pass --include-stale to wire them anyway, or --only-chains" \
           "to override explicitly."
    fi
    CHAINS=("${FRESH_CHAINS[@]}")
  fi
fi

if [ ${#CHAINS[@]} -lt 2 ]; then
  echo "Error: need at least 2 deployed chains for peer wiring; found ${#CHAINS[@]}: ${CHAINS[*]:-}" >&2
  exit 1
fi

echo "═══════════════════════════════════════════════════════════════"
echo "deploy-peers.sh — cross-chain peer wiring"
if [ "$DRY_RUN" = "1" ]; then
  echo "  mode:    DRY RUN (no broadcasts)"
fi
echo "  chains:  ${CHAINS[*]}"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── Pull each chain's addresses + RPC + lzEid ─────────────────────────

declare -A LZEID
declare -A RPC
declare -A IS_CANONICAL_VPFI
declare -A VPFI_OFT_ADAPTER
declare -A VPFI_MIRROR
declare -A VPFI_BUY_RECEIVER
declare -A VPFI_BUY_ADAPTER
declare -A REWARD_OAPP

for slug in "${CHAINS[@]}"; do
  json="$CONTRACTS_DIR/deployments/$slug/addresses.json"
  rpc_var="$(rpc_var_for_slug "$slug")"
  if [ -z "$rpc_var" ]; then
    echo "FAIL: unknown chain-slug '$slug' — no RPC mapping." >&2
    exit 1
  fi
  rpc="${!rpc_var:-}"
  if [ -z "$rpc" ]; then
    echo "FAIL: \$$rpc_var not set in .env (required for $slug)." >&2
    exit 1
  fi
  RPC[$slug]="$rpc"

  LZEID[$slug]="$(jq -r '.lzEid // empty' "$json")"
  IS_CANONICAL_VPFI[$slug]="$(jq -r '.isCanonicalVPFI // false' "$json")"
  VPFI_OFT_ADAPTER[$slug]="$(jq -r '.vpfiOftAdapter // empty' "$json")"
  VPFI_MIRROR[$slug]="$(jq -r '.vpfiMirror // empty' "$json")"
  VPFI_BUY_RECEIVER[$slug]="$(jq -r '.vpfiBuyReceiver // empty' "$json")"
  VPFI_BUY_ADAPTER[$slug]="$(jq -r '.vpfiBuyAdapter // empty' "$json")"
  REWARD_OAPP[$slug]="$(jq -r '.rewardOApp // empty' "$json")"

  if [ -z "${LZEID[$slug]}" ]; then
    echo "FAIL: lzEid missing in $json — was DeployVPFICanonical/Mirror run?" >&2
    exit 1
  fi
done

# Sanity: exactly one canonical chain.
canonical_count=0
CANONICAL=""
for slug in "${CHAINS[@]}"; do
  if [ "${IS_CANONICAL_VPFI[$slug]}" = "true" ]; then
    canonical_count=$((canonical_count + 1))
    CANONICAL="$slug"
  fi
done
if [ "$canonical_count" != "1" ]; then
  echo "FAIL: expected exactly 1 canonical-VPFI chain; found $canonical_count." >&2
  exit 1
fi
echo "  canonical:  $CANONICAL  (lzEid=${LZEID[$CANONICAL]})"
for slug in "${CHAINS[@]}"; do
  [ "$slug" = "$CANONICAL" ] && continue
  echo "  mirror:     $slug          (lzEid=${LZEID[$slug]})"
done
echo

# ── Wire one peer (helper) ────────────────────────────────────────────
# Each `setPeer` invocation goes through WireVPFIPeers.s.sol with
# LOCAL_OAPP / REMOTE_EID / REMOTE_PEER set in the env. The script
# itself is idempotent — running setPeer for the same (oapp, eid)
# pair twice is a no-op state write.

wire_peer() {
  local label="$1"
  local local_chain="$2"
  local local_oapp="$3"
  local remote_chain="$4"
  local remote_oapp="$5"

  if [ -z "$local_oapp" ] || [ "$local_oapp" = "0x0000000000000000000000000000000000000000" ]; then
    echo "  ⚠  $label: $local_chain has no $label OApp — skipping"
    return 0
  fi
  if [ -z "$remote_oapp" ] || [ "$remote_oapp" = "0x0000000000000000000000000000000000000000" ]; then
    echo "  ⚠  $label: $remote_chain has no $label OApp — skipping"
    return 0
  fi

  local local_rpc="${RPC[$local_chain]}"
  local remote_eid="${LZEID[$remote_chain]}"

  echo "  setPeer  $label  $local_chain($local_oapp) → $remote_chain(eid=$remote_eid, peer=$remote_oapp)"

  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi

  LOCAL_OAPP="$local_oapp" REMOTE_EID="$remote_eid" REMOTE_PEER="$remote_oapp" \
    forge script script/WireVPFIPeers.s.sol \
    --rpc-url "$local_rpc" \
    --broadcast \
    --slow \
    >/dev/null
}

# ── Pass 1: VPFI lane (canonical OFTAdapter ↔ each mirror VPFIMirror) ─

echo "[1] VPFI lane — canonical OFTAdapter ↔ mirror VPFIMirror (bidirectional)"
for slug in "${CHAINS[@]}"; do
  [ "$slug" = "$CANONICAL" ] && continue
  wire_peer "VPFI" "$CANONICAL" "${VPFI_OFT_ADAPTER[$CANONICAL]}" \
                   "$slug"      "${VPFI_MIRROR[$slug]}"
  wire_peer "VPFI" "$slug"      "${VPFI_MIRROR[$slug]}" \
                   "$CANONICAL" "${VPFI_OFT_ADAPTER[$CANONICAL]}"
done

# ── Pass 2: Buy lane (canonical BuyReceiver ↔ each mirror BuyAdapter) ──
# Buy request flows mirror→canonical; ack comes back canonical→mirror.
# Both legs need setPeer so the LZ message router can deliver.

echo
echo "[2] Buy lane — canonical BuyReceiver ↔ mirror BuyAdapter (bidirectional)"
for slug in "${CHAINS[@]}"; do
  [ "$slug" = "$CANONICAL" ] && continue
  wire_peer "Buy" "$CANONICAL" "${VPFI_BUY_RECEIVER[$CANONICAL]}" \
                  "$slug"      "${VPFI_BUY_ADAPTER[$slug]}"
  wire_peer "Buy" "$slug"      "${VPFI_BUY_ADAPTER[$slug]}" \
                  "$CANONICAL" "${VPFI_BUY_RECEIVER[$CANONICAL]}"
done

# ── Pass 3: Reward OApp (full mesh) ───────────────────────────────────
# Reward OApps mesh-connect — each chain reports usage to its peers,
# canonical aggregates and emits the unified rate. Mirror-to-mirror
# peers carry per-chain reward state for the shared rate computation.

echo
echo "[3] Reward OApp — full mesh"
for src in "${CHAINS[@]}"; do
  for dst in "${CHAINS[@]}"; do
    [ "$src" = "$dst" ] && continue
    wire_peer "Reward" "$src" "${REWARD_OAPP[$src]}" \
                       "$dst" "${REWARD_OAPP[$dst]}"
  done
done

echo
echo "═══════════════════════════════════════════════════════════════"
if [ "$DRY_RUN" = "1" ]; then
  echo "deploy-peers.sh — ✓ dry-run done (no broadcasts fired)"
else
  echo "deploy-peers.sh — ✓ peers wired"
fi
echo
echo "Verify (per-chain) with:"
echo "  cast call <local-oapp> 'peers(uint32)(bytes32)' <remote-eid> --rpc-url <local-rpc>"
echo "═══════════════════════════════════════════════════════════════"
