// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";

/**
 * @title FacetSizeLimitTest
 * @notice Issue #66 guardrail — asserts every Diamond facet's runtime
 *         bytecode stays under the EIP-170 24,576-byte contract-size
 *         limit.
 * @dev    A facet over the limit cannot be deployed on anvil or any
 *         real chain — `forge script DeployDiamond --broadcast` reverts.
 *         `forge test` does NOT enforce the EIP-170 *deploy-size* rule,
 *         so without this guardrail an over-size facet stays invisible
 *         until an actual `--broadcast` deploy fails. That is exactly
 *         how RiskFacet's 541-byte breach reached `main` unnoticed
 *         (Issue #66). This test makes the breach fail in the regular
 *         `forge test` run instead.
 *
 *         The runtime bytecode is read with `vm.getDeployedCode` — no
 *         deployment, so the EIP-170 limit is not what's being measured
 *         by the EVM here; the test measures the artifact directly.
 *
 *         When a facet is added to the Diamond (see
 *         `script/DeployDiamond.s.sol`), add it to `_facets()` below —
 *         a missing facet silently escapes the guardrail.
 */
contract FacetSizeLimitTest is Test {
    /// @dev EIP-170 maximum runtime contract size, in bytes.
    uint256 internal constant EIP170_LIMIT = 24_576;

    /// @dev Every facet cut into the Vaipakam Diamond. Mirror of the
    ///      facet set deployed by `DeployDiamond.s.sol`.
    function _facets() internal pure returns (string[36] memory) {
        return [
            "AccessControlFacet",
            "AddCollateralFacet",
            "AdminFacet",
            "ClaimFacet",
            "ConfigFacet",
            "DefaultedFacet",
            "DiamondCutFacet",
            "DiamondLoupeFacet",
            "EarlyWithdrawalFacet",
            "EscrowFactoryFacet",
            "InteractionRewardsFacet",
            "LegalFacet",
            "LoanFacet",
            "MetricsDashboardFacet",
            "MetricsFacet",
            "OfferCancelFacet",
            "OfferFacet",
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

    /// @notice Every facet's runtime bytecode must be within EIP-170.
    function test_EveryFacetUnderEip170SizeLimit() public {
        string[36] memory facets = _facets();
        for (uint256 i; i < facets.length; ++i) {
            bytes memory code = vm.getDeployedCode(
                string.concat(facets[i], ".sol:", facets[i])
            );
            assertGt(code.length, 0, string.concat(facets[i], " artifact not found"));
            assertLe(
                code.length,
                EIP170_LIMIT,
                string.concat(
                    facets[i],
                    " runtime bytecode exceeds the EIP-170 24,576-byte limit"
                )
            );
        }
    }
}
