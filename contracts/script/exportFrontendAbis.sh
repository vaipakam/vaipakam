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
#       # defaults to CONTRACTS_PKG_DIR=../packages/contracts (this
#       # monorepo's @vaipakam/contracts package).
#
#   CONTRACTS_PKG_DIR=/abs/path/to/contracts-pkg bash contracts/script/exportFrontendAbis.sh
#
# When to run:
#   - After every contract change that adds/modifies/removes any
#     selector the frontend reads or writes — i.e. essentially every
#     facet edit, since the frontend imports the full surface.
#   - Before pushing a contract change that the frontend depends on.
#
# What it does NOT do:
#   - Doesn't commit anything. The script only writes files; review
#     the diff with `git diff packages/contracts/src/abis/` and
#     commit alongside the contract change.
#   - Doesn't run `forge build` first. Assumes you've run
#     `forge build` in `contracts/` since the last edit.
#   - Doesn't touch `index.ts` (the re-export barrel). If you add a
#     brand-new facet, add it to FACETS below AND wire it into
#     `packages/contracts/src/abis/index.ts` manually.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default workspace layout: monorepo at /work/vaipakam, ABI bundle at
# /work/vaipakam/packages/contracts/src/abis (Stage 1b moved the ABIs
# into the @vaipakam/contracts workspace package so every app shares
# one copy). Override CONTRACTS_PKG_DIR for a bespoke layout.
CONTRACTS_PKG_DIR="${CONTRACTS_PKG_DIR:-$CONTRACTS_DIR/../packages/contracts}"

if [ ! -d "$CONTRACTS_PKG_DIR" ]; then
  echo "Error: contracts package dir not found at: $CONTRACTS_PKG_DIR" >&2
  echo "" >&2
  echo "Override the path:" >&2
  echo "  CONTRACTS_PKG_DIR=/abs/path bash contracts/script/exportFrontendAbis.sh" >&2
  exit 1
fi

CONTRACTS_PKG_DIR="$(cd "$CONTRACTS_PKG_DIR" && pwd)"
OUT_DIR="$CONTRACTS_PKG_DIR/src/abis"

if [ ! -d "$OUT_DIR" ]; then
  echo "Error: ABI output dir not found: $OUT_DIR" >&2
  echo "Expected packages/contracts/src/abis/ to exist." >&2
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
  "VaultFactoryFacet"
  "InteractionRewardsFacet"
  "LegalFacet"
  "LoanFacet"
  "MetricsFacet"
  "MetricsDashboardFacet"
  "OfferCancelFacet"
  "OfferCreateFacet"
  # #396 v0.5 — gasless signed off-chain offer book fill surface.
  "SignedOfferFacet"
  # #393 v1 — LenderIntentVault standing-terms surface.
  "LenderIntentFacet"
  # #398 v1.5 — ERC-4626 aggregator adapter factory + the adapter impl (the
  # adapter is a standalone per-aggregator contract, not a facet, but the dapp
  # needs its ABI to interact with adapter instances).
  "AggregatorAdapterFactoryFacet"
  "AggregatorAdapterImplementation"
  # #399 v2.5 — backstop facet (Diamond) + the standalone treasury BackstopVault.
  "BackstopFacet"
  "BackstopVaultImplementation"
  "OfferAcceptFacet"
  "OfferMatchFacet"
  "OfferMutateFacet"
  # T-086 Round-8 (#358) — borrow-OR-sell parallel-sale entry +
  # non-destructive unwind. Carved off OfferCreateFacet so solc's
  # viaIR jump-table reservation stays under the "Tag too large" ICE
  # ceiling.
  "OfferParallelSaleFacet"
  "OracleAdminFacet"
  "OracleFacet"
  "PartialWithdrawalFacet"
  "PrecloseFacet"
  "PrepayListingFacet"
  "NFTPrepayListingFacet"
  "NFTPrepayDutchListingFacet"
  "NFTPrepayListingAtomicFacet"
  "NFTPrepayAutoListFacet"
  "ProfileFacet"
  "RefinanceFacet"
  "RepayFacet"
  "RepayPeriodicFacet"
  "PayrollFacet"
  "RewardReporterFacet"
  "RiskFacet"
  "RiskMatchLiquidationFacet"
  "RiskSplitLiquidationFacet"
  "StakingRewardsFacet"
  "SwapToRepayFacet"
  "SwapToRepayIntentFacet"
  "IntentDispatchFacet"
  "AutoLifecycleFacet"
  "EncumbranceMutateFacet"
  "IntentConfigFacet"
  "TreasuryFacet"
  "VaipakamNFTFacet"
  "VpfiBuyAdapter"
  "VpfiBuyReceiver"
  "VPFIDiscountFacet"
  "VPFIDiscountAccumulatorFacet"
  "VPFITokenFacet"
  # T-087 Sub 2.C — mirror-side tier-push receiver. Live on every
  # diamond (canonical Base writes nothing into it; mirrors receive
  # the CCIP-forwarded tier push here).
  "MirrorTierReceiverFacet"
  # T-087 Sub 2.D — protocol-funded mirror broadcast orchestrator.
  # Admin / budget surface + the rollup-driven trigger.
  "ProtocolBroadcastFacet"
  # FlashLoanLiquidationPath.md Phase 3 — standalone reference
  # receiver contract for `RiskFacet.triggerLiquidationDiscounted`.
  # NOT a diamond facet, so deliberately NOT spread into
  # `DIAMOND_ABI` in the barrel; the keeper bot in `apps/keeper`
  # constructs calls to it directly by named ABI export.
  "FlashLoanLiquidator"
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
echo "  git diff packages/contracts/src/abis/   # review the change"
echo "  pnpm --filter @vaipakam/defi exec tsc -b --noEmit   # confirm consumers still typecheck"
echo "  git commit -am 'Sync ABIs with contracts@${COMMIT:0:7}'"
