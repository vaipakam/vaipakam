#!/usr/bin/env bash
#
# exportTenderlyAlerts.sh — generate per-chain Tenderly alerts.yaml
# files from the single template at `ops/tenderly/alerts.yaml`.
#
# `ops/tenderly/alerts.yaml` carries `${CHAIN}` and `${DIAMOND_ADDRESS}`
# placeholders by design — one source of truth for the alert SHAPES
# (severity, signal, runbook link), but the per-chain Diamond address
# has to come from `contracts/deployments/<slug>/addresses.json`. This
# script does the substitution: walks every chain's addresses.json,
# emits `ops/tenderly/generated/alerts-<slug>.yaml`, and prints the
# `tenderly alerts apply` invocation.
#
# Why a generated/ subdirectory (not in-place):
#   - The template stays committed; the per-chain expansions are
#     reproducible build artefacts and can be gitignored.
#   - Re-running this script after a redeploy on chain X rewrites
#     only that chain's expansion.
#
# Why not just `envsubst alerts.yaml > alerts-<slug>.yaml`:
#   - That works and the script does fall back to envsubst when
#     available. We just wrap it in a per-chain loop + stamp a
#     provenance header so the operator can tell which monorepo
#     commit + which addresses.json revision produced this file.
#
# Usage:
#   bash contracts/script/exportTenderlyAlerts.sh                # all chains
#   bash contracts/script/exportTenderlyAlerts.sh base-sepolia   # specific chain(s)
#
# Required tools:
#   - jq (already a project dependency)
#   - envsubst (from the `gettext` package on Linux / Mac).
#     If unavailable, the script falls back to a sed loop that
#     handles only the two placeholders we care about.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"

DEPLOY_ROOT="$CONTRACTS_DIR/deployments"
TENDERLY_DIR="$REPO_ROOT/ops/tenderly"
TEMPLATE="$TENDERLY_DIR/alerts.yaml"
OUT_DIR="$TENDERLY_DIR/generated"

# ── Provenance snapshot — after the OUTPUT PATHS are resolved, before any write ──
# (#1490, and Codex #1495 r7 P2 for the placement.) The exclusion has to name
# this run's ACTUAL output, so the snapshot cannot be taken before the output
# directory is known: a hard-coded default silently excluded the wrong path
# whenever an operator overrode it, counting the real output as source drift
# and recreating the false-dirty stamp for exactly the people who customise.
#
# It still precedes every write — resolving a path is not writing to it — so
# the ordering property #1490 is about is unaffected.
#
# Excludes ONLY what this script writes. NEVER the enclosing directory: doing
# that also hides the tracked TEMPLATE that is consumed to produce the output,
# which turns a real uncommitted edit into a clean reading (r6/r7 found that
# same mistake in three separate scripts).
_PROV_ROOT="$(cd "$REPO_ROOT" && pwd)"
TREE_COMMIT_AT_START="$(git -C "$_PROV_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
TREE_DIRTY_AT_START=""
if ! git -C "$_PROV_ROOT" diff --quiet HEAD -- . ":(exclude)${OUT_DIR#$_PROV_ROOT/}" 2>/dev/null; then
  TREE_DIRTY_AT_START=" (dirty)"
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "Error: $TEMPLATE not found." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Tenderly's CLI uses its own per-chain canonical names; map our
# deploy-script chain-slug into Tenderly's. Mirrors the network
# names used in https://docs.tenderly.co/reference/api#supported-networks.
chain_to_tenderly() {
  case "$1" in
    ethereum)        echo "mainnet" ;;
    base)            echo "base" ;;
    arbitrum)        echo "arbitrum" ;;
    optimism)        echo "optimistic" ;;
    polygon-zkevm)   echo "polygon-zkevm" ;;
    bnb)             echo "bsc" ;;
    polygon)         echo "polygon" ;;
    base-sepolia)    echo "base-sepolia" ;;
    sepolia)         echo "sepolia" ;;
    arb-sepolia)     echo "arbitrum-sepolia" ;;
    op-sepolia)      echo "optimistic-sepolia" ;;
    bnb-testnet)     echo "bsc-testnet" ;;
    polygon-amoy)    echo "polygon-amoy" ;;
    *)               echo "" ;;
  esac
}

if [ $# -eq 0 ]; then
  CHAINS=()
  if [ -d "$DEPLOY_ROOT" ]; then
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      CHAINS+=("$(basename "$d")")
    done < <(find "$DEPLOY_ROOT" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)
  fi
else
  CHAINS=("$@")
fi

if [ ${#CHAINS[@]} -eq 0 ]; then
  echo "No chains found — neither passed as args nor under $DEPLOY_ROOT/." >&2
  exit 0
fi

HAVE_ENVSUBST=0
if command -v envsubst >/dev/null 2>&1; then HAVE_ENVSUBST=1; fi

# HEAD moved between the snapshot and the stamp (Codex #1495 r7 P2). This
# was the only one of the eight stamping scripts without this comparison,
# while the release note claimed every exporter had it.
if [ "$(git -C "$_PROV_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')" \
     != "$TREE_COMMIT_AT_START" ]; then
  TREE_DIRTY_AT_START=" (dirty)"
fi
COMMIT_HASH="$TREE_COMMIT_AT_START"
COMMIT_DIRTY="$TREE_DIRTY_AT_START"
GENERATED_AT=$(date +%Y-%m-%dT%H:%M:%S%z)
EMITTED=0
SKIPPED=()

for slug in "${CHAINS[@]}"; do
  TENDERLY_NETWORK=$(chain_to_tenderly "$slug")
  if [ -z "$TENDERLY_NETWORK" ]; then
    SKIPPED+=("$slug (no Tenderly network mapping)")
    continue
  fi

  ADDR_FILE="$DEPLOY_ROOT/$slug/addresses.json"
  if [ ! -f "$ADDR_FILE" ]; then
    SKIPPED+=("$slug (no addresses.json)")
    continue
  fi

  DIAMOND=$(jq -r '.diamond // empty' "$ADDR_FILE")
  if [ -z "$DIAMOND" ] || [ "$DIAMOND" = "null" ]; then
    SKIPPED+=("$slug (addresses.json has no diamond key)")
    continue
  fi

  OUT_FILE="$OUT_DIR/alerts-$slug.yaml"

  # Provenance header — operator can tell at a glance which monorepo
  # commit + Diamond address produced this expansion. Helps when
  # alerts misfire and the on-call needs to confirm "which version of
  # the alert config is actually live".
  {
    echo "# Generated by contracts/script/exportTenderlyAlerts.sh"
    echo "# monorepoCommit: $COMMIT_HASH$COMMIT_DIRTY"
    echo "# generatedAt:    $GENERATED_AT"
    echo "# chainSlug:      $slug"
    echo "# tenderlyNet:    $TENDERLY_NETWORK"
    echo "# diamond:        $DIAMOND"
    echo "# DO NOT EDIT — regenerate via the export script."
    echo
  } > "$OUT_FILE"

  if [ "$HAVE_ENVSUBST" = "1" ]; then
    CHAIN="$TENDERLY_NETWORK" DIAMOND_ADDRESS="$DIAMOND" \
      envsubst '${CHAIN} ${DIAMOND_ADDRESS}' < "$TEMPLATE" >> "$OUT_FILE"
  else
    # envsubst-less fallback. Only handles the two known placeholders;
    # any other ${VAR} in the template stays literal — by design,
    # because the template should ONLY use these two.
    sed -e "s|\${CHAIN}|$TENDERLY_NETWORK|g" \
        -e "s|\${DIAMOND_ADDRESS}|$DIAMOND|g" \
        "$TEMPLATE" >> "$OUT_FILE"
  fi

  echo "  ✓ $slug → ops/tenderly/generated/alerts-$slug.yaml"
  EMITTED=$((EMITTED + 1))
done

echo
echo "Emitted $EMITTED file(s) into $OUT_DIR/"
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "Skipped:"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi

echo
echo "Apply via:"
echo "  cd ops/tenderly"
echo "  for f in generated/alerts-*.yaml; do"
echo "    tenderly alerts apply --file \"\$f\""
echo "  done"
echo
echo "(Or paste each generated/alerts-<slug>.yaml into the Tenderly UI"
echo "for chain '<slug>' if your project layout uses one Tenderly project"
echo "per chain rather than the unified shape.)"
