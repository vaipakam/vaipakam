// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  DiamondFacetNames
 * @notice Single source of truth for the set of facets cut into the
 *         Vaipakam Diamond — consumed by every test in the `test/deploy/`
 *         deploy-sanity suite so the suite's facet lists cannot drift
 *         apart from one another.
 *
 * @dev    Mirrors the `cuts[]` array of `script/DeployDiamond.s.sol`.
 *         When a facet is added to or removed from the Diamond, update
 *         `cutFacetNames()` here — and only here — and both the EIP-170
 *         size guardrail and the selector-coverage guardrail pick the
 *         change up. Keeping the list in one place is deliberate: a
 *         per-test hand-list would let a facet escape one guardrail
 *         while still passing the other.
 *
 *         `DiamondCutFacet` is intentionally NOT in this list: it is
 *         installed by the `VaipakamDiamond` constructor, not via a
 *         `_get*Selectors()` cut list. `FacetSizeLimitTest` size-checks
 *         it as an explicit extra; `SelectorCoverageTest` does not
 *         selector-check it (it has no hand-maintained cut list that
 *         could drift).
 */
abstract contract DiamondFacetNames {
    /// @dev The 42 facets cut into the Diamond by `DeployDiamond.run()`.
    ///      (37 → 38 in T-086 step 5 with `PrepayListingFacet`;
    ///      38 → 39 in T-086 step 6 with `NFTPrepayListingFacet`;
    ///      39 → 40 in T-086 Round-5 Block B with
    ///      `NFTPrepayDutchListingFacet`;
    ///      40 → 41 in T-086 Round-6 / Block D (#345) with
    ///      `NFTPrepayListingAtomicFacet`;
    ///      41 → 42 in T-086 Round-7 (#355) with
    ///      `NFTPrepayAutoListFacet`.)
    function cutFacetNames() internal pure returns (string[48] memory) {
        return [
            "AccessControlFacet",
            "AddCollateralFacet",
            "AdminFacet",
            "ClaimFacet",
            "ConfigFacet",
            "DefaultedFacet",
            "DiamondLoupeFacet",
            "EarlyWithdrawalFacet",
            "VaultFactoryFacet",
            "IntentConfigFacet",
            "InteractionRewardsFacet",
            "LegalFacet",
            "LoanFacet",
            "MetricsDashboardFacet",
            "MetricsFacet",
            "OfferAcceptFacet",
            "OfferCancelFacet",
            "OfferCreateFacet",
            "OfferMatchFacet",
            // #193 — in-place offer modification entry points
            // (setOfferAmount / setOfferRate / setOfferCollateral +
            // combined modifyOffer). Carved out into its own facet
            // mirroring the OfferCancel / OfferMatch precedent.
            "OfferMutateFacet",
            // T-086 Round-8 (#358) — borrow-OR-sell parallel-sale
            // entry points (postParallelSaleListing +
            // releaseParallelSaleLock). Carved off OfferCreateFacet so
            // solc's viaIR jump-table reservation stays under the
            // "Tag too large" ICE ceiling.
            "OfferParallelSaleFacet",
            "OracleAdminFacet",
            "OracleFacet",
            "OwnershipFacet",
            "PartialWithdrawalFacet",
            "PayrollFacet",
            "PrecloseFacet",
            "PrepayListingFacet",
            "NFTPrepayListingFacet",
            // T-086 Round-5 Block B (#309) — Dutch-decay entry points
            // live on a sibling facet so the combined facet bytecode
            // stays within solc's jump-table reservation budget. See
            // {NFTPrepayDutchListingFacet.sol} natspec for the split
            // rationale.
            "NFTPrepayDutchListingFacet",
            // T-086 Round-6 / Block D (#345) — atomic match-rotation
            // via Seaport `matchAdvancedOrders`. Lives on its own
            // sibling facet for the same EIP-170 budget reasons + so
            // the new bidder-bytes verification + matchOrders surface
            // is a focused audit pass. See
            // {NFTPrepayListingAtomicFacet.sol} contract-level
            // natspec for the §17 design-doc track.
            "NFTPrepayListingAtomicFacet",
            // T-086 Round-7 (#355) — permissionless
            // `autoListAtFloorOnGrace` entry point. Lives on its own
            // facet so {LibAutoList}'s B-cond gate math + the Case A
            // (fresh post) and Case B (rotation) orchestration stay
            // within EIP-170 alongside the existing
            // `NFTPrepayListingFacet` borrower-driven flow. See
            // {NFTPrepayAutoListFacet.sol} natspec + design doc §18.
            "NFTPrepayAutoListFacet",
            "ProfileFacet",
            "RefinanceFacet",
            "RepayFacet",
            "RewardAggregatorFacet",
            "RewardReporterFacet",
            "RiskFacet",
            "RiskMatchLiquidationFacet",
            "StakingRewardsFacet",
            "SwapToRepayFacet",
            "SwapToRepayIntentFacet",
            "TreasuryFacet",
            "VaipakamNFTFacet",
            "VPFIDiscountFacet",
            // T-087 Sub 1.B — single-home facet for the heavy
            // ring-buffer + lifecycle math the new VPFI discount
            // accumulator depends on. Carved off `LibVPFIDiscount` so
            // settlement facets (Repay / Preclose / Refinance) stay
            // under EIP-170 instead of inlining ~2 kB per consumer.
            "VPFIDiscountAccumulatorFacet",
            "VPFITokenFacet",
            // T-087 Sub 2.C — mirror-side Diamond ingress for the
            // cross-chain tier push. The Diamond's `userTierCache` +
            // `currentTierTableVersion` writers live here; the
            // `VaipakamRewardMessenger` contract's inbound handler
            // forwards `MSG_TYPE_TIER_UPDATED` / `MSG_TYPE_VERSION_BUMPED`
            // into this facet.
            "MirrorTierReceiverFacet"
        ];
    }
}
