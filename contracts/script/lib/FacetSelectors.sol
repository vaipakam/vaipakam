// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";

/**
 * @title  FacetSelectors
 * @notice Single source of truth for the FULL external selector set of the
 *         facets that the curated redeploy / replace scripts cut. Findings
 *         #778 (`ReplaceStaleFacets` Oracle 4/18 + VaultFactory 27/29) and
 *         #779 (`RedeployFacets` ProfileFacet 15/25) traced a split-Diamond
 *         hazard to those scripts hand-listing PARTIAL selector subsets that
 *         drifted from the canonical facet surface: a `Replace` cut of a
 *         subset leaves the unlisted selectors pointed at stale bytecode.
 *
 * @dev    A `Replace` cut MUST carry a facet's whole routed surface, so these
 *         getters return the COMPLETE selector list per facet. The upgrade
 *         scripts consume these instead of local arrays, and
 *         `test/deploy/RedeploySelectorParityTest` asserts each list here
 *         equals the facet's compiled-ABI `methodIdentifiers` — so a facet
 *         growing a new external function fails CI until this single list is
 *         updated, rather than silently splitting a live Diamond.
 *
 *         Scope: the facets flagged by #778/#779 (Oracle, VaultFactory,
 *         Profile). `DeployDiamond`/`HelperTest` keep their own lists — each
 *         already pinned to the same compiled-ABI ground truth by
 *         `SelectorCoverageTest` / direct test use, so they cannot drift from
 *         this library. Folding those consumers onto this library too is a
 *         mechanical follow-up (noted in #778/#779).
 */
library FacetSelectors {
    /// @notice Full external selector surface of {OracleFacet} (18).
    function oracle() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](18);
        s[0] = OracleFacet.checkLiquidity.selector;
        s[1] = OracleFacet.getAssetPrice.selector;
        s[2] = OracleFacet.calculateLTV.selector;
        s[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        s[4] = OracleFacet.getAssetRiskProfile.selector;
        s[5] = OracleFacet.getIlliquidAssets.selector;
        s[6] = OracleFacet.isAssetSupported.selector;
        s[7] = OracleFacet.getSequencerUptimeFeed.selector;
        s[8] = OracleFacet.sequencerHealthy.selector;
        s[9] = OracleFacet.captureDailyPriceSnapshot.selector;
        s[10] = OracleFacet.getHistoricalAssetPrice.selector;
        s[11] = OracleFacet.getLiquidityTier.selector;
        s[12] = OracleFacet.getEffectiveLiquidityTier.selector;
        s[13] = OracleFacet.tryGetAssetPrice.selector;
        s[14] = OracleFacet.refreshTierLtvCache.selector;
        s[15] = OracleFacet.getTierLtvCacheEntry.selector;
        s[16] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
        s[17] = OracleFacet.countLiveSecondaryOracleFeeds.selector;
    }

    /// @notice Full external selector surface of {VaultFactoryFacet} (31).
    /// @dev    Sourced from the compiled ABI (`forge inspect VaultFactoryFacet
    ///         methodIdentifiers`), NOT from any prior hand-list — the parallel
    ///         lists in HelperTest / the scripts were both missing
    ///         `getDiamondAddress` and `vaultSetNFTUser1155` (the exact drift
    ///         #778 warns about). The parity test keeps this list == the ABI.
    function vaultFactory() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](31);
        s[0] = VaultFactoryFacet.initializeVaultImplementation.selector;
        s[1] = VaultFactoryFacet.getOrCreateUserVault.selector;
        s[2] = VaultFactoryFacet.upgradeVaultImplementation.selector;
        s[3] = VaultFactoryFacet.vaultDepositERC20.selector;
        s[4] = VaultFactoryFacet.vaultWithdrawERC20.selector;
        s[5] = VaultFactoryFacet.vaultDepositERC721.selector;
        s[6] = VaultFactoryFacet.vaultWithdrawERC721.selector;
        s[7] = VaultFactoryFacet.vaultDepositERC1155.selector;
        s[8] = VaultFactoryFacet.vaultWithdrawERC1155.selector;
        s[9] = VaultFactoryFacet.vaultApproveNFT721.selector;
        s[10] = VaultFactoryFacet.vaultSetNFTUser.selector;
        s[11] = VaultFactoryFacet.vaultSetNFTUser1155.selector;
        s[12] = VaultFactoryFacet.vaultGetNFTUserOf.selector;
        s[13] = VaultFactoryFacet.vaultGetNFTUserExpires.selector;
        s[14] = VaultFactoryFacet.getOfferAmount.selector;
        s[15] = VaultFactoryFacet.getVaipakamVaultImplementationAddress.selector;
        s[16] = VaultFactoryFacet.getDiamondAddress.selector;
        s[17] = VaultFactoryFacet.setMandatoryVaultUpgrade.selector;
        s[18] = VaultFactoryFacet.upgradeUserVault.selector;
        s[19] = VaultFactoryFacet.vaultGetNFTQuantity.selector;
        s[20] = VaultFactoryFacet.getUserVaultAddress.selector;
        s[21] = VaultFactoryFacet.vaultDepositERC20From.selector;
        s[22] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        s[23] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        s[24] = VaultFactoryFacet.recoverStuckERC20.selector;
        s[25] = VaultFactoryFacet.disown.selector;
        s[26] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        s[27] = VaultFactoryFacet.recoveryAckTextHash.selector;
        s[28] = VaultFactoryFacet.recoveryNonce.selector;
        s[29] = VaultFactoryFacet.vaultBannedSource.selector;
        s[30] = VaultFactoryFacet.getVaultVersionInfo.selector;
    }

    /// @notice Full external selector surface of {ProfileFacet} (25).
    function profile() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](25);
        s[0] = ProfileFacet.updateKYCStatus.selector;
        s[1] = ProfileFacet.getUserCountry.selector;
        s[2] = ProfileFacet.isKYCVerified.selector;
        s[3] = ProfileFacet.setTradeAllowance.selector;
        s[4] = ProfileFacet.setUserCountry.selector;
        s[5] = ProfileFacet.updateKYCTier.selector;
        s[6] = ProfileFacet.getKYCTier.selector;
        s[7] = ProfileFacet.meetsKYCRequirement.selector;
        s[8] = ProfileFacet.updateKYCThresholds.selector;
        s[9] = ProfileFacet.getKYCThresholds.selector;
        s[10] = ProfileFacet.setKeeperAccess.selector;
        s[11] = ProfileFacet.getKeeperAccess.selector;
        s[12] = ProfileFacet.approveKeeper.selector;
        s[13] = ProfileFacet.revokeKeeper.selector;
        s[14] = ProfileFacet.isApprovedKeeper.selector;
        s[15] = ProfileFacet.getApprovedKeepers.selector;
        s[16] = ProfileFacet.setLoanKeeperEnabled.selector;
        s[17] = ProfileFacet.setOfferKeeperEnabled.selector;
        s[18] = ProfileFacet.setSanctionsOracle.selector;
        s[19] = ProfileFacet.getSanctionsOracle.selector;
        s[20] = ProfileFacet.isSanctionedAddress.selector;
        s[21] = ProfileFacet.setKeeperActions.selector;
        s[22] = ProfileFacet.getKeeperActions.selector;
        s[23] = ProfileFacet.isLoanKeeperEnabled.selector;
        s[24] = ProfileFacet.isOfferKeeperEnabled.selector;
    }
}
