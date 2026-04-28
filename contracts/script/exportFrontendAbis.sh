#!/usr/bin/env bash
#
# exportFrontendAbis.sh — frontend ABI sync.
#
# Runs `forge inspect <Facet> abi --json` for every facet the
# frontend imports, and writes the resulting JSON files into
# `frontend/src/contracts/abis/`. Keeps the frontend's hand-imported
# ABIs in lockstep with the contract source so the
# stale-ABI-vs-deployed-contract drift that bit us once (Phase 6
# removed `keeperAccessEnabled` from `CreateOfferParams` but the
# frontend kept sending it, causing Base RPCs to wrap the revert as
# "exceeds max transaction gas limit") doesn't recur.
#
# Usage:
#   bash contracts/script/exportFrontendAbis.sh
#       # defaults to FRONTEND_DIR=../frontend (this repo's frontend)
#
#   FRONTEND_DIR=/abs/path/to/frontend bash contracts/script/exportFrontendAbis.sh
#
# When to run:
#   - After every contract change that adds/modifies/removes any
#     selector the frontend reads or writes — i.e. essentially every
#     facet edit, since the frontend imports the full surface.
#   - Before pushing a contract change that the frontend depends on.
#
# What it does NOT do:
#   - Doesn't commit anything. The script only writes files; review
#     the diff with `git diff frontend/src/contracts/abis/` and
#     commit alongside the contract change.
#   - Doesn't run `forge build` first. Assumes you've run
#     `forge build` in `contracts/` since the last edit.
#   - Doesn't touch `index.ts` (the re-export barrel). If you add a
#     brand-new facet, add it to FACETS below AND wire it into
#     `frontend/src/contracts/abis/index.ts` manually.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default sibling layout: monorepo at /work/vaipakam, frontend at
# /work/vaipakam/frontend. Override by exporting FRONTEND_DIR.
FRONTEND_DIR="${FRONTEND_DIR:-$CONTRACTS_DIR/../frontend}"

if [ ! -d "$FRONTEND_DIR" ]; then
  echo "Error: frontend dir not found at: $FRONTEND_DIR" >&2
  echo "" >&2
  echo "Override the path:" >&2
  echo "  FRONTEND_DIR=/abs/path bash contracts/script/exportFrontendAbis.sh" >&2
  exit 1
fi

FRONTEND_DIR="$(cd "$FRONTEND_DIR" && pwd)"
OUT_DIR="$FRONTEND_DIR/src/contracts/abis"

if [ ! -d "$OUT_DIR" ]; then
  echo "Error: ABI output dir not found: $OUT_DIR" >&2
  echo "Expected the frontend to already have src/contracts/abis/." >&2
  exit 1
fi

cd "$CONTRACTS_DIR"

if ! command -v forge >/dev/null 2>&1; then
  echo "Error: forge not in PATH. Install Foundry: https://book.getfoundry.sh/getting-started/installation" >&2
  exit 1
fi

# Every facet / standalone contract the frontend imports an ABI for.
# Mirrors the contents of frontend/src/contracts/abis/ minus the
# index.ts barrel. When you add a facet to the frontend, add it
# here AND wire it into index.ts.
FACETS=(
  "AddCollateralFacet"
  "AdminFacet"
  "ClaimFacet"
  "ConfigFacet"
  "DefaultedFacet"
  "DiamondLoupeFacet"
  "EarlyWithdrawalFacet"
  "EscrowFactoryFacet"
  "InteractionRewardsFacet"
  "LegalFacet"
  "LoanFacet"
  "MetricsFacet"
  "OfferFacet"
  "OracleAdminFacet"
  "OracleFacet"
  "PartialWithdrawalFacet"
  "PrecloseFacet"
  "ProfileFacet"
  "RefinanceFacet"
  "RepayFacet"
  "RiskFacet"
  "StakingRewardsFacet"
  "TreasuryFacet"
  "VaipakamNFTFacet"
  "VPFIBuyAdapter"
  "VPFIDiscountFacet"
  "VPFITokenFacet"
)

echo "Exporting ABIs to $OUT_DIR"
fail=0
for facet in "${FACETS[@]}"; do
  out="$OUT_DIR/$facet.json"
  if ! forge inspect "$facet" abi --json > "$out.tmp" 2>/dev/null; then
    echo "  ✗ $facet — forge inspect failed (missing artifact? run 'forge build' first)" >&2
    rm -f "$out.tmp"
    fail=1
    continue
  fi
  mv "$out.tmp" "$out"
  echo "  ✓ $facet"
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "One or more facets failed to export. Fix the missing artifact(s) and re-run." >&2
  exit 1
fi

# Stamp output dir with the monorepo commit so a frontend build can
# be correlated against a specific contracts state.
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
DIRTY=""
if ! git diff --quiet HEAD 2>/dev/null; then
  DIRTY=" (dirty)"
fi
cat > "$OUT_DIR/_source.json" <<EOF
{
  "monorepoCommit": "$COMMIT$DIRTY",
  "exportedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "facets": [$(printf '"%s",' "${FACETS[@]}" | sed 's/,$//')]
}
EOF
echo "  source stamp -> $OUT_DIR/_source.json"

echo ""
echo "Done. Next steps:"
echo "  git diff frontend/src/contracts/abis/   # review the change"
echo "  cd $FRONTEND_DIR && node_modules/.bin/tsc -b --noEmit   # confirm frontend still typechecks"
echo "  git commit -am 'Sync frontend ABIs with contracts@${COMMIT:0:7}'"
