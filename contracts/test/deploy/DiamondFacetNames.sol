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
    /// @dev The 36 facets cut into the Diamond by `DeployDiamond.run()`.
    function cutFacetNames() internal pure returns (string[36] memory) {
        return [
            "AccessControlFacet",
            "AddCollateralFacet",
            "AdminFacet",
            "ClaimFacet",
            "ConfigFacet",
            "DefaultedFacet",
            "DiamondLoupeFacet",
            "EarlyWithdrawalFacet",
            "EscrowFactoryFacet",
            "InteractionRewardsFacet",
            "LegalFacet",
            "LoanFacet",
            "MetricsDashboardFacet",
            "MetricsFacet",
            "OfferAcceptFacet",
            "OfferCancelFacet",
            "OfferCreateFacet",
            "OfferMatchFacet",
            "OracleAdminFacet",
            "OracleFacet",
            "OwnershipFacet",
            "PartialWithdrawalFacet",
            "PayrollFacet",
            "PrecloseFacet",
            "ProfileFacet",
            "RefinanceFacet",
            "RepayFacet",
            "RewardAggregatorFacet",
            "RewardReporterFacet",
            "RiskFacet",
            "RiskMatchLiquidationFacet",
            "StakingRewardsFacet",
            "TreasuryFacet",
            "VaipakamNFTFacet",
            "VPFIDiscountFacet",
            "VPFITokenFacet"
        ];
    }
}
