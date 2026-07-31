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
_PROV_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
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
# Only the GENERATED files, never the directory (Codex #1495 r11 P2).
# `index.ts` lives here too — a hand-maintained barrel this script
# explicitly does NOT write, which the package re-exports and consumers
# assemble `DIAMOND_ABI` from. Excluding the directory hid uncommitted
# edits to it, so the bundle could stamp clean while the effective ABI
# surface differed from the recorded commit. Fourth instance of
# over-exclusion in this PR, and the first at file granularity.
_prov_e="$(_prov_excl "$OUT_DIR")"
[ -n "$_prov_e" ] && _prov_paths+=("${_prov_e}/*.json")
if ! git -C "$_PROV_ROOT" diff --quiet HEAD -- "${_prov_paths[@]}" 2>/dev/null; then
  TREE_DIRTY_AT_START=" (dirty)"
fi

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
  "NumeraireConfigFacet"
  "DefaultedFacet"
  "DiamondLoupeFacet"
  "EarlyWithdrawalFacet"
  "VaultFactoryFacet"
  "InteractionRewardsFacet"
  "RewardClaimFacet"
  "InteractionRewardsLensFacet"
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
  # #594 — standalone holder-only consolidation entry points
  # (consolidateCollateralToHolder / consolidatePrincipalToHolder) + the
  # ConsolidationNotAllowed error. ReceiverFacet is internal plumbing (no
  # frontend/keeper consumer), so it is intentionally NOT exported.
  "ConsolidationFacet"
  # #671 — self-sovereign progressive risk-access setters + EIP-712
  # self-submit + views (the frontend pre-flights the gate + drives the
  # tier opt-up / per-pair consent flows from this surface).
  "RiskAccessFacet"
  # #1104 — RiskPreviewFacet: the read-only risk preview cluster
  # (previewOfferAcceptBlock / previewCreatorBlock / previewIntent /
  # previewMatchRiskBlock / acceptMidTierAckPair) + the two cross-facet gate
  # asserts, split off RiskAccessFacet. The frontend reads the preview views
  # from THIS facet after the split.
  "RiskPreviewFacet"
  # #1212 (E-10 Claim-All) — generic best-effort delegatecall batcher. The
  # frontend reads this ABI to encode the Call[] for the one-click Claim All.
  "MulticallFacet"
  "OfferAcceptFacet"
  "OfferPreviewFacet"
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
  "FeeEntitlementFacet"
  "RefinanceFacet"
  "RepayFacet"
  "RepayPeriodicFacet"
  "PayrollFacet"
  "RewardReporterFacet"
  "RewardAggregatorFacet"
  "RewardRemittanceFacet"
  "RewardCommitmentFacet"
  "RiskFacet"
  "RiskMatchLiquidationFacet"
  "RiskSplitLiquidationFacet"
  "SwapToRepayFacet"
  "SwapToRepayIntentFacet"
  "IntentDispatchFacet"
  "AutoLifecycleFacet"
  "EncumbranceMutateFacet"
  "IntentConfigFacet"
  "TreasuryFacet"
  "VaipakamNFTFacet"
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
  # #394 Lever B — standalone dual-factor risk-premium rate model
  # (an `IRateModel` registered via `AdminFacet.setRateModel`). NOT a
  # diamond facet, so deliberately NOT spread into `DIAMOND_ABI` in the
  # barrel; admin tooling / keeper construct calls (setTierPremiumBps,
  # getTierPremiums, …) to it directly by named ABI export.
  "RiskPremiumRateModel"
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
# HEAD moved between the snapshot and the stamp — the pair would be
# inconsistent, so say so rather than publish a confident wrong answer.
if [ "$(git -C "$CONTRACTS_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')" \
     != "$TREE_COMMIT_AT_START" ]; then
  TREE_DIRTY_AT_START=" (dirty)"
fi
# Pinned WITH the snapshot, not re-read here (Codex #1495 r3 P2). A commit
# landing between the snapshot and this line would otherwise pair a NEW hash
# with the CLEAN state observed earlier, attributing output to a commit that
# did not produce it. The window is small for an exporter and not zero, and
# the deploy scripts already had to solve exactly this — one idiom, no
# special cases.
COMMIT="$TREE_COMMIT_AT_START"
DIRTY="$TREE_DIRTY_AT_START"
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
