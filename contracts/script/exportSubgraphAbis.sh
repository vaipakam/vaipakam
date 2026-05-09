#!/usr/bin/env bash
#
# exportSubgraphAbis.sh — sync subgraph ABI bundle + per-chain manifest.
#
# `ops/subgraph/subgraph.yaml` carries hand-substituted address +
# startBlock + network fields with a "# replace per chain" comment —
# fine for one chain, untenable for the 6+ chain mesh this protocol
# targets. This script closes that loose end:
#
#   1. ABI bundle: runs `forge inspect <Facet> abi --json` on every
#      facet that emits a subgraph-relevant event, concatenates them
#      into a single `ops/subgraph/abis/Diamond.json`, and stamps a
#      `_source.json` provenance record next to it.
#
#   2. Per-chain manifests: walks every `contracts/deployments/<slug>/
#      addresses.json`, fills in `address` + `network` + `startBlock`
#      (from addresses.json's `deployBlock` field when present, else
#      0 with a warning), and writes the result to
#      `ops/subgraph/generated/subgraph.<slug>.yaml`.
#
# The base template `ops/subgraph/subgraph.yaml` stays committed; the
# per-chain expansions are reproducible build artefacts.
#
# Subgraph-relevant events (per subgraph.yaml's eventHandlers list):
#   - LoanInitiated, LoanRepaid, LoanDefaulted, LoanLiquidated,
#     LiquidationFallback
# Source facets:
#   LoanFacet (LoanInitiated), RepayFacet (LoanRepaid),
#   DefaultedFacet (LoanDefaulted), RiskFacet (LoanLiquidated +
#   LiquidationFallback). If a future event lands on a different
#   facet, add it to FACETS below AND to the subgraph manifest's
#   eventHandlers list.
#
# Usage:
#   bash contracts/script/exportSubgraphAbis.sh                 # all chains
#   bash contracts/script/exportSubgraphAbis.sh base-sepolia    # specific chain(s)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
DEPLOY_ROOT="$CONTRACTS_DIR/deployments"
SUBGRAPH_DIR="$REPO_ROOT/ops/subgraph"
TEMPLATE="$SUBGRAPH_DIR/subgraph.yaml"
ABI_DIR="$SUBGRAPH_DIR/abis"
OUT_DIR="$SUBGRAPH_DIR/generated"

if [ ! -f "$TEMPLATE" ]; then
  echo "Error: $TEMPLATE not found." >&2
  exit 1
fi

if ! command -v forge >/dev/null 2>&1; then
  echo "Error: forge not in PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq not in PATH (project dependency)." >&2
  exit 1
fi

mkdir -p "$ABI_DIR" "$OUT_DIR"

cd "$CONTRACTS_DIR"

# Map deploy-script chain-slug → The Graph's network identifier (the
# value used in `dataSources[].network`). The hosted service / Studio
# uses these canonical names; mismatches make the deploy fail with a
# cryptic "no compatible network" error.
chain_to_subgraph_network() {
  case "$1" in
    ethereum)        echo "mainnet" ;;
    base)            echo "base" ;;
    arbitrum)        echo "arbitrum-one" ;;
    optimism)        echo "optimism" ;;
    polygon-zkevm)   echo "polygon-zkevm" ;;
    bnb)             echo "bsc" ;;
    polygon)         echo "matic" ;;
    base-sepolia)    echo "base-sepolia" ;;
    sepolia)         echo "sepolia" ;;
    arb-sepolia)     echo "arbitrum-sepolia" ;;
    op-sepolia)      echo "optimism-sepolia" ;;
    bnb-testnet)     echo "chapel" ;;
    polygon-amoy)    echo "matic-amoy" ;;
    *)               echo "" ;;
  esac
}

# ── Step 1: Diamond.json ABI bundle ───────────────────────────────────

FACETS=(
  "LoanFacet"
  "RepayFacet"
  "DefaultedFacet"
  "RiskFacet"
)

echo "[1/2] Building consolidated subgraph ABI from ${#FACETS[@]} facet(s)…"

# Concatenate the JSON arrays from each facet. `jq -s 'add'` merges
# the slurped arrays in order; dupe entries (e.g. ABI inputs that
# are common across facets — not events, never collide) are left
# in place because The Graph keys events by signature, not array
# position, and ignores non-event entries entirely.
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

for facet in "${FACETS[@]}"; do
  ABI_JSON=$(forge inspect "$facet" abi --json 2>/dev/null || echo "")
  if [ -z "$ABI_JSON" ] || [ "$ABI_JSON" = "null" ]; then
    echo "  ⚠ forge inspect $facet abi --json returned empty — facet missing or build stale?"
    echo "    Run \`forge build\` and try again."
    exit 1
  fi
  echo "$ABI_JSON" > "$TMPDIR/$facet.json"
  echo "  + $facet"
done

# Slurp every facet's ABI array and flatten into one. Preserves entry
# order (LoanFacet first, then Repay/Defaulted/Risk) so the output
# diff is deterministic across runs.
jq -s 'add' "$TMPDIR"/*.json > "$ABI_DIR/Diamond.json"

# Provenance sidecar: which monorepo commit produced this bundle, so
# the operator (and the on-call investigating a misfired alert) can
# trace exactly which contract source line corresponds to each event
# signature here.
COMMIT_HASH=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "?")
COMMIT_DIRTY=""
if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then COMMIT_DIRTY=" (dirty)"; fi
cat > "$ABI_DIR/_source.json" <<EOF
{
  "monorepoCommit": "$COMMIT_HASH$COMMIT_DIRTY",
  "generatedAt": "$(date +%Y-%m-%dT%H:%M:%S%z)",
  "facets": $(printf '%s\n' "${FACETS[@]}" | jq -R . | jq -s .)
}
EOF
echo "  ✓ wrote $(realpath --relative-to="$REPO_ROOT" "$ABI_DIR/Diamond.json") (commit $(echo "$COMMIT_HASH" | head -c 8)$COMMIT_DIRTY)"

# ── Step 2: per-chain subgraph.<slug>.yaml manifests ──────────────────

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
  echo
  echo "[2/2] No chains found under $DEPLOY_ROOT/ — ABI bundle only."
  exit 0
fi

echo
echo "[2/2] Writing per-chain subgraph manifests (${#CHAINS[@]} chain(s))…"

EMITTED=0
SKIPPED=()
for slug in "${CHAINS[@]}"; do
  NETWORK=$(chain_to_subgraph_network "$slug")
  if [ -z "$NETWORK" ]; then
    SKIPPED+=("$slug (no subgraph network mapping)")
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

  # Best-effort startBlock resolution. Order of preference:
  #   (a) addresses.json `.deployBlock` field (deploy script writes
  #       this when the broadcast records carry blockNumber).
  #   (b) Foundry's broadcast/<chainId>/run-latest.json — it carries
  #       blockNumber per receipt; we pick the LOWEST block among
  #       Diamond-creating txs.
  #   (c) 0 with a loud warning (safe but burns time on first sync —
  #       The Graph scans from block 0 to head).
  START_BLOCK=$(jq -r '.deployBlock // empty' "$ADDR_FILE" 2>/dev/null || echo "")
  if [ -z "$START_BLOCK" ] || [ "$START_BLOCK" = "null" ]; then
    # CHAIN_ID lookup for broadcast path. addresses.json may already
    # carry chainId — try that first; else compute from the slug.
    CID=$(jq -r '.chainId // empty' "$ADDR_FILE" 2>/dev/null || echo "")
    if [ -z "$CID" ] || [ "$CID" = "null" ]; then
      case "$slug" in
        ethereum) CID=1 ;; base) CID=8453 ;; arbitrum) CID=42161 ;;
        optimism) CID=10 ;; polygon-zkevm) CID=1101 ;; bnb) CID=56 ;;
        polygon) CID=137 ;;
        base-sepolia) CID=84532 ;; sepolia) CID=11155111 ;;
        arb-sepolia) CID=421614 ;; op-sepolia) CID=11155420 ;;
        bnb-testnet) CID=97 ;; polygon-amoy) CID=80002 ;;
        *) CID="" ;;
      esac
    fi
    BROADCAST_FILE="$CONTRACTS_DIR/broadcast/DeployDiamond.s.sol/$CID/run-latest.json"
    if [ -n "$CID" ] && [ -f "$BROADCAST_FILE" ]; then
      # Pull the smallest blockNumber among CREATE transactions in
      # this run-latest. The CREATE for the Diamond itself is the
      # earliest CREATE in the run — anything earlier would have
      # been a CREATE2 helper, but DeployDiamond.s.sol only does
      # straight CREATEs.
      START_BLOCK=$(jq -r '
        [ .receipts[]?.blockNumber // empty
          | tonumber? // empty
        ] | min // empty
      ' "$BROADCAST_FILE" 2>/dev/null || echo "")
    fi
  fi
  if [ -z "$START_BLOCK" ] || [ "$START_BLOCK" = "null" ]; then
    START_BLOCK=0
    echo "  ⚠ $slug: no deployBlock anywhere — defaulting to 0 (slow first-sync)"
  fi

  OUT_FILE="$OUT_DIR/subgraph.$slug.yaml"
  {
    echo "# Generated by contracts/script/exportSubgraphAbis.sh"
    echo "# monorepoCommit: $COMMIT_HASH$COMMIT_DIRTY"
    echo "# generatedAt:    $(date +%Y-%m-%dT%H:%M:%S%z)"
    echo "# chainSlug:      $slug"
    echo "# subgraphNet:    $NETWORK"
    echo "# diamond:        $DIAMOND"
    echo "# startBlock:     $START_BLOCK"
    echo "# DO NOT EDIT — regenerate via the export script."
    echo
  } > "$OUT_FILE"

  # Substitute three fields in the template:
  #   network: base-sepolia            → network: <NETWORK>
  #   address: "0x000…0"               → address: "<DIAMOND>"
  #   startBlock: 0                    → startBlock: <START_BLOCK>
  # Only the FIRST match of each line shape is rewritten — the
  # template only has one of each, but a defensive `sed` form
  # avoids accidental rewrites if a future template grows additional
  # network/address blocks.
  sed -e "s|^    network: .*$|    network: $NETWORK|" \
      -e "s|^      address: \".*\".*$|      address: \"$DIAMOND\"|" \
      -e "s|^      startBlock: .*$|      startBlock: $START_BLOCK|" \
      "$TEMPLATE" >> "$OUT_FILE"

  echo "  ✓ $slug → $(realpath --relative-to="$REPO_ROOT" "$OUT_FILE")  (block=$START_BLOCK)"
  EMITTED=$((EMITTED + 1))
done

echo
echo "Emitted $EMITTED manifest(s) into $(realpath --relative-to="$REPO_ROOT" "$OUT_DIR")/"
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "Skipped:"
  for s in "${SKIPPED[@]}"; do echo "  - $s"; done
fi

echo
echo "Deploy a chain's subgraph via:"
echo "  cd ops/subgraph"
echo "  cp generated/subgraph.<slug>.yaml subgraph.yaml   # graph CLI reads this name"
echo "  npx graph codegen && npx graph build"
echo "  npx graph deploy --product hosted-service vaipakam/vaipakam-<slug>"
echo
echo "(Or feed each generated/subgraph.<slug>.yaml directly via"
echo " \`graph deploy --manifest generated/subgraph.<slug>.yaml ...\` if your"
echo " graph-cli version supports the --manifest flag.)"
