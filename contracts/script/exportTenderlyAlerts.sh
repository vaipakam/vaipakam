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
# A path that did not start with the repo root is OUTSIDE the repository, and
# an absolute path is not a valid repo pathspec — git exits 128, which this
# negated call with discarded stderr would silently read as "dirty" forever
# (Codex #1495 r8 P2). Nothing outside the repo can be working-tree drift, so
# there is simply nothing to exclude in that case.
_prov_excl() {
  local abs="$1"
  case "$abs" in
    "$_PROV_ROOT"/*) printf '%s' ":(exclude)${abs#"$_PROV_ROOT"/}" ;;
    *) : ;;
  esac
}
# Built as an ARRAY so an omitted exclusion contributes NO argument
# (Codex #1495 r9 P2). Filtering the VALUE was not enough: a quoted
# command substitution that expands to nothing still passes an EMPTY
# argument, git rejects it with "empty string is not a valid pathspec",
# and this negated call with discarded stderr turned that into a
# permanent "(dirty)" — reproduced end-to-end from a clean tree.
_prov_paths=(.)
_prov_e="$(_prov_excl "$OUT_DIR")"; [ -n "$_prov_e" ] && _prov_paths+=("$_prov_e")
if ! git -C "$_PROV_ROOT" diff --quiet HEAD -- "${_prov_paths[@]}" 2>/dev/null; then
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

COMMIT_HASH="$TREE_COMMIT_AT_START"
COMMIT_DIRTY="$TREE_DIRTY_AT_START"
GENERATED_AT=$(date +%Y-%m-%dT%H:%M:%S%z)
EMITTED=0
SKIPPED=()

# Manifests are STAGED, never written straight to their live paths
# (Codex #1495 r14 P2). Three rounds tried to make the abort path clean up
# correctly and each was still destructive, because the run had already
# overwritten live files by the time it could know it was allowed to. The
# fix is to stop creating the mess: nothing touches `generated/` until the
# HEAD check has passed, so a failed run leaves the previous manifests
# exactly as it found them and there is nothing to undo.
#
# The stage lives INSIDE $OUT_DIR so the publish step is a same-filesystem
# rename (atomic per file), and so the dirty-tree probe's existing
# $OUT_DIR exclusion already covers it.
STAGE_DIR="$(mktemp -d "$OUT_DIR/.staging.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT

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

  OUT_FILE="$STAGE_DIR/alerts-$slug.yaml"

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

done

# HEAD must not have moved across the whole generation (Codex #1495 r9/r10).
# Checked ONCE here, after every template and address read, and BEFORE any
# generated file reaches its live path.
#
# Two earlier attempts were worse. Before the loop it checked the one moment
# nothing could have changed. Per-iteration it gave `COMMIT_DIRTY` a second
# assignment, which this repo's own pre-deploy guard rejects — so the gate
# failed unconditionally on a clean checkout — and it STILL ran before each
# iteration's template read, leaving the race it was added for.
#
# Failing is the right answer rather than annotating: a manifest carrying a
# commit that no longer describes its inputs is worse than no new manifest,
# and the run is trivially repeatable from a stable checkout.
if [ "$(git -C "$_PROV_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')" \
     != "$TREE_COMMIT_AT_START" ]; then
  echo "Error: HEAD moved during generation (started $TREE_COMMIT_AT_START)." >&2
  echo "The generated manifests would carry a commit that no longer describes" >&2
  echo "the inputs they were built from. Re-run from a stable checkout." >&2
  echo "Nothing was published — the previous manifests are untouched." >&2
  exit 1
fi

# Publish. Past this line the provenance is known-good, so the staged files
# replace the live ones one atomic rename at a time.
#
# Driven by what is ACTUALLY on the stage, not by a list of what the loop
# meant to put there (Codex #1495 r15 P2). A parallel array is a second
# claim about the contents of a directory, and the two diverge: a slug
# passed twice appended two entries for one file, so the second rename
# found no source and `set -e` aborted the run HALFWAY THROUGH PUBLISHING
# — the one outcome staging exists to prevent. Globbing cannot disagree
# with the filesystem, and duplicates collapse on their own because the
# generation loop simply overwrites its own staged file.
shopt -s nullglob
for staged in "$STAGE_DIR"/alerts-*.yaml; do
  base="$(basename "$staged")"
  slug="${base#alerts-}"; slug="${slug%.yaml}"
  mv -f "$staged" "$OUT_DIR/$base"
  echo "  ✓ $slug → ops/tenderly/generated/$base"
  EMITTED=$((EMITTED + 1))
done
shopt -u nullglob

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
