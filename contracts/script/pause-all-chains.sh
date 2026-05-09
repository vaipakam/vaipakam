#!/usr/bin/env bash
#
# pause-all-chains.sh — production-grade simultaneous-pause helper.
#
# Scope: a real incident lever. Walks every chain under
# `contracts/deployments/` and emits the `pause()` calldata for every
# pauseable contract on every chain (Diamond + LZ OApps/OFTs), so the
# operator can fan out across N Pauser-Safe UIs in parallel.
#
# This script does NOT broadcast. The Pauser Safe is the on-chain
# authority; this script just produces the calldata + addresses. The
# value-add is generating that material from a single source
# (addresses.json) at the moment of incident, when every second
# spent looking up addresses widens the drainable window.
#
# Why standalone (not a deploy-script phase): pausing on mainnet is
# never a deploy-script side-effect; it's its own ceremony with its
# own runbook. The testnet rehearsal of this same flow lives at
# `deploy-testnet.sh --phase pause-rehearsal --mode {calldata,check,
# unpause-calldata}` so the operator practises THIS exact UX before
# they ever need it on mainnet.
#
# Penpie (Sept 2024) lost ~$621k on Arbitrum in the gap between an
# incident detection and a sequential Safe-pause across chains. The
# 5-minute budget in the rehearsal phase encodes the learnings from
# that post-mortem; this script makes it physically possible by
# eliminating the addresses-lookup step from the critical path.
#
# Usage:
#   bash contracts/script/pause-all-chains.sh                    # all chains, calldata mode
#   bash contracts/script/pause-all-chains.sh --check            # read paused() across all chains
#   bash contracts/script/pause-all-chains.sh --unpause-calldata # inverse, post-incident cleanup
#   bash contracts/script/pause-all-chains.sh --chains base,ethereum  # subset
#
# Required env (sourced from contracts/.env if present):
#   <CHAIN>_RPC_URL  — for --check mode RPC reads. Calldata mode
#                       needs no RPC; --unpause-calldata also needs
#                       none.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ROOT="$CONTRACTS_DIR/deployments"
SENTINEL_DIR="$CONTRACTS_DIR/.pause-runs"
PAUSE_BUDGET_S=300

mkdir -p "$SENTINEL_DIR"

# ── Args ──────────────────────────────────────────────────────────────

MODE="calldata"
CHAINS_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)             MODE="check" ;;
    --unpause-calldata)  MODE="unpause" ;;
    --chains)            shift; CHAINS_FILTER="$1" ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Load .env if present so --check has the RPC URLs. .env is optional;
# calldata + unpause modes don't need it. The --check branch
# enforces presence per-chain.
if [ -f "$CONTRACTS_DIR/.env" ]; then
  set -a; source "$CONTRACTS_DIR/.env"; set +a
fi

# Map chain-slug → RPC env var. Mirrors deploy-{chain,mainnet,
# testnet}.sh so naming stays consistent across every script that
# touches a chain.
chain_rpc_var() {
  case "$1" in
    ethereum)        echo "ETHEREUM_RPC_URL" ;;
    base)            echo "BASE_RPC_URL" ;;
    arbitrum)        echo "ARBITRUM_RPC_URL" ;;
    optimism)        echo "OPTIMISM_RPC_URL" ;;
    polygon-zkevm)   echo "POLYGON_ZKEVM_RPC_URL" ;;
    bnb)             echo "BNB_RPC_URL" ;;
    polygon)         echo "POLYGON_RPC_URL" ;;
    base-sepolia)    echo "BASE_SEPOLIA_RPC_URL" ;;
    sepolia)         echo "SEPOLIA_RPC_URL" ;;
    arb-sepolia)     echo "ARB_SEPOLIA_RPC_URL" ;;
    op-sepolia)      echo "OP_SEPOLIA_RPC_URL" ;;
    bnb-testnet)     echo "BNB_TESTNET_RPC_URL" ;;
    polygon-amoy)    echo "POLYGON_AMOY_RPC_URL" ;;
    *)               echo "" ;;
  esac
}

# ── Resolve chain list ────────────────────────────────────────────────

ALL_CHAINS=()
if [ -d "$DEPLOY_ROOT" ]; then
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    ALL_CHAINS+=("$(basename "$d")")
  done < <(find "$DEPLOY_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
fi

if [ -n "$CHAINS_FILTER" ]; then
  IFS=',' read -ra CHAINS <<< "$CHAINS_FILTER"
else
  CHAINS=("${ALL_CHAINS[@]}")
fi

if [ ${#CHAINS[@]} -eq 0 ]; then
  echo "Error: no chains found under $DEPLOY_ROOT/ — has any deploy landed?" >&2
  exit 1
fi

# ── Helper: enumerate pauseable targets for a chain ───────────────────
# Echoes "key:address" lines, one per pauseable contract present in
# the chain's addresses.json. Skips canonical/mirror keys that don't
# apply to that chain (per CLAUDE.md "omit-keys policy").

list_pause_targets() {
  local slug="$1"
  local addr_file="$DEPLOY_ROOT/$slug/addresses.json"
  [ ! -f "$addr_file" ] && return 1
  for KEY in diamond rewardOApp vpfiOftAdapter vpfiMirror vpfiBuyReceiver vpfiBuyAdapter; do
    local ADDR=$(jq -r --arg k "$KEY" '.[$k] // empty' "$addr_file" 2>/dev/null)
    if [ -n "$ADDR" ] && [ "$ADDR" != "null" ]; then
      echo "$KEY:$ADDR"
    fi
  done
}

# ── Mode dispatch ─────────────────────────────────────────────────────

case "$MODE" in
  calldata)
    cat <<'BANNER'
╔══════════════════════════════════════════════════════════════════════╗
║  pause-all-chains.sh — PRODUCTION INCIDENT LEVER                     ║
║                                                                      ║
║  Sign EVERY tx below via the Pauser Safe on its respective chain.    ║
║  Fan out across N Safe UIs in parallel — DO NOT serialize.           ║
║  Budget: 5 minutes from this banner to all contracts paused.         ║
║                                                                      ║
║  After the incident is resolved, run:                                ║
║    bash contracts/script/pause-all-chains.sh --check                 ║
║      (verify all paused, confirm sub-5-min)                          ║
║    bash contracts/script/pause-all-chains.sh --unpause-calldata      ║
║      (cleanup once root cause is fixed)                              ║
╚══════════════════════════════════════════════════════════════════════╝
BANNER
    PAUSE_SELECTOR=$(cast sig 'pause()' 2>/dev/null || echo "0x8456cb59")
    RUN_ID="$(date +%Y%m%dT%H%M%S)"
    echo
    echo "Run ID:        $RUN_ID"
    echo "Started at:    $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "Pauser Safe:   ${PAUSER_ADDRESS:-(not in .env — confirm against runbook)}"
    echo "Selector:      pause()  =  $PAUSE_SELECTOR"
    echo

    for slug in "${CHAINS[@]}"; do
      local_addr_file="$DEPLOY_ROOT/$slug/addresses.json"
      if [ ! -f "$local_addr_file" ]; then
        echo "── $slug — SKIPPED (no addresses.json) ──────────────────"
        continue
      fi
      echo "── $slug ───────────────────────────────────────────────────"
      while IFS=: read -r key addr; do
        printf "  %-22s to=%s data=%s\n" "$key" "$addr" "$PAUSE_SELECTOR"
      done < <(list_pause_targets "$slug")
      echo
    done

    # Stamp a sentinel so --check knows when this run started. One
    # sentinel per run — keeps the audit trail across multiple
    # incidents.
    SENTINEL="$SENTINEL_DIR/run-$RUN_ID.epoch"
    date +%s > "$SENTINEL"
    {
      echo "ranAt=$(date +%Y-%m-%dT%H:%M:%S%z)"
      echo "chains=${CHAINS[*]}"
    } >> "$SENTINEL"
    echo "Sentinel: $(realpath --relative-to="$CONTRACTS_DIR" "$SENTINEL")"
    echo
    echo "When all Safe txs land, run:"
    echo "  bash contracts/script/pause-all-chains.sh --check"
    ;;

  check)
    # Find the most recent sentinel — that's the run we're checking.
    LATEST=$(find "$SENTINEL_DIR" -maxdepth 1 -name 'run-*.epoch' -print 2>/dev/null \
      | sort | tail -n 1)
    if [ -z "$LATEST" ]; then
      echo "Error: no pause-run sentinel under $SENTINEL_DIR." >&2
      echo "       Did you run --calldata mode first?" >&2
      exit 1
    fi
    STARTED_AT=$(head -1 "$LATEST")
    NOW=$(date +%s)
    ELAPSED=$((NOW - STARTED_AT))

    echo "═══════════════════════════════════════════════════════════════"
    echo "pause-all-chains.sh — CHECK"
    echo "  Run sentinel:  $(basename "$LATEST")"
    echo "  Started at:    $(date -d "@$STARTED_AT" '+%Y-%m-%d %H:%M:%S %Z')"
    echo "  Elapsed:       ${ELAPSED}s   (budget: ${PAUSE_BUDGET_S}s)"
    echo "═══════════════════════════════════════════════════════════════"

    OVERALL_OK=1
    for slug in "${CHAINS[@]}"; do
      RPC_VAR=$(chain_rpc_var "$slug")
      if [ -z "$RPC_VAR" ]; then
        echo "── $slug — skipped (no RPC mapping) ───────────────────"
        continue
      fi
      RPC_URL="${!RPC_VAR:-}"
      if [ -z "$RPC_URL" ]; then
        echo "── $slug — skipped ($RPC_VAR not set in .env) ─────────"
        OVERALL_OK=0
        continue
      fi
      echo "── $slug  (via \$$RPC_VAR) ─────────────────────────────"
      while IFS=: read -r key addr; do
        PAUSED=$(cast call "$addr" 'paused()(bool)' --rpc-url "$RPC_URL" 2>/dev/null || echo "?")
        if [ "$PAUSED" = "true" ]; then
          printf "  ✓ %-22s paused=true   ($addr)\n" "$key"
        else
          printf "  ✗ %-22s paused=%s  ($addr)\n" "$key" "$PAUSED"
          OVERALL_OK=0
        fi
      done < <(list_pause_targets "$slug")
      echo
    done

    if [ "$OVERALL_OK" = "1" ] && [ "$ELAPSED" -le "$PAUSE_BUDGET_S" ]; then
      echo "✓ ALL PAUSED, ${ELAPSED}s ≤ ${PAUSE_BUDGET_S}s budget. Incident contained."
    elif [ "$OVERALL_OK" = "1" ]; then
      echo "⚠ ALL PAUSED but ${ELAPSED}s > ${PAUSE_BUDGET_S}s budget."
      echo "  The drainable window during the over-budget gap is documented in"
      echo "  the post-incident review. Tighten Safe-quorum / RPC latency before"
      echo "  the next rehearsal."
    else
      echo "✗ NOT ALL PAUSED. Investigate the unpaused contracts above."
      echo "  - Did the Safe tx revert? Check the Safe's tx history."
      echo "  - Did the Pauser Safe lack PAUSER_ROLE on this chain? Check"
      echo "    AccessControlFacet.hasRole(PAUSER_ROLE, <safe>)."
      echo "  - Did the operator paste the wrong calldata? Re-run --calldata"
      echo "    mode and compare."
      exit 1
    fi
    ;;

  unpause)
    cat <<'BANNER'
╔══════════════════════════════════════════════════════════════════════╗
║  pause-all-chains.sh — UNPAUSE (post-incident cleanup)               ║
║                                                                      ║
║  Sign EVERY tx below via the Pauser Safe on its respective chain.    ║
║  ONLY run this once root cause is confirmed fixed and reviewed by    ║
║  the security on-call. There is no "unpause budget" — go slow,       ║
║  verify each chain comes back healthy before unpausing the next.     ║
╚══════════════════════════════════════════════════════════════════════╝
BANNER
    UNPAUSE_SELECTOR=$(cast sig 'unpause()' 2>/dev/null || echo "0x3f4ba83a")
    echo
    echo "Pauser Safe:   ${PAUSER_ADDRESS:-(not in .env — confirm against runbook)}"
    echo "Selector:      unpause()  =  $UNPAUSE_SELECTOR"
    echo

    for slug in "${CHAINS[@]}"; do
      if [ ! -f "$DEPLOY_ROOT/$slug/addresses.json" ]; then
        echo "── $slug — SKIPPED (no addresses.json) ──────────────────"
        continue
      fi
      echo "── $slug ───────────────────────────────────────────────────"
      while IFS=: read -r key addr; do
        printf "  %-22s to=%s data=%s\n" "$key" "$addr" "$UNPAUSE_SELECTOR"
      done < <(list_pause_targets "$slug")
      echo
    done
    ;;
esac
