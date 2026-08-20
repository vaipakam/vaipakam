// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {RiskPreviewFacet} from "../../src/facets/RiskPreviewFacet.sol";
import {OfferPreviewFacet} from "../../src/facets/OfferPreviewFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {EncumbranceMutateFacet} from "../../src/facets/EncumbranceMutateFacet.sol";

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

    /// @notice Full external selector surface of {VaultFactoryFacet} (32).
    /// @dev    Sourced from the compiled ABI (`forge inspect VaultFactoryFacet
    ///         methodIdentifiers`), NOT from any prior hand-list — the parallel
    ///         lists in HelperTest / the scripts were both missing
    ///         `getDiamondAddress` and `vaultSetNFTUser1155` (the exact drift
    ///         #778 warns about). The parity test keeps this list == the ABI.
    function vaultFactory() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](32);
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
        // RL-1 — Diamond-funded vault credit primitive (reward
        // claim-to-vault delivery).
        s[31] = VaultFactoryFacet.vaultCreditFromDiamondERC20.selector;
    }

    /// @notice Full external selector surface of {ProfileFacet} (31).
    function profile() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](31);
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
        // #1123 — confirmed-flagged registry sync + read + self-only movement-gate host.
        s[25] = ProfileFacet.refreshSanctionsFlag.selector;
        s[26] = ProfileFacet.isSanctionsConfirmedFlagged.selector;
        s[27] = ProfileFacet.enforcePositionMoveNotSanctioned.selector;
        s[28] = ProfileFacet.enforcePositionSaleMove.selector;
        // #1144 — registry-aware prepay-sale fill bar (read by CollateralListingExecutor).
        s[29] = ProfileFacet.isRecipientBarred.selector;
        // #1347 — per-offer creator Full VPFI tariff opt-in.
        s[30] = ProfileFacet.setOfferCreatorFullTariff.selector;
    }

    /// @notice Full external selector surface of {VaipakamNFTFacet} (29) — mirrors
    ///         `DeployDiamond._getNFTSelectors`. #1123 wires the fail-closed
    ///         movement gate INLINE into `transferFrom`/`safeTransferFrom`, so a
    ///         curated redeploy MUST re-cut this facet or raw transfers stay on the
    ///         old fail-open bytecode.
    function vaipakamNFT() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](29);
        s[0] = VaipakamNFTFacet.mintNFT.selector;
        s[1] = VaipakamNFTFacet.updateNFTStatus.selector;
        s[2] = VaipakamNFTFacet.burnNFT.selector;
        s[3] = VaipakamNFTFacet.tokenURI.selector;
        s[4] = VaipakamNFTFacet.initializeNFT.selector;
        s[5] = bytes4(keccak256("ownerOf(uint256)"));
        s[6] = VaipakamNFTFacet.contractURI.selector;
        s[7] = VaipakamNFTFacet.setContractImageURI.selector;
        s[8] = VaipakamNFTFacet.royaltyInfo.selector;
        s[9] = VaipakamNFTFacet.setDefaultRoyalty.selector;
        s[10] = VaipakamNFTFacet.setImageURIForStatus.selector;
        s[11] = VaipakamNFTFacet.name.selector;
        s[12] = VaipakamNFTFacet.symbol.selector;
        s[13] = VaipakamNFTFacet.balanceOf.selector;
        s[14] = VaipakamNFTFacet.approve.selector;
        s[15] = VaipakamNFTFacet.getApproved.selector;
        s[16] = VaipakamNFTFacet.setApprovalForAll.selector;
        s[17] = VaipakamNFTFacet.isApprovedForAll.selector;
        s[18] = VaipakamNFTFacet.transferFrom.selector;
        s[19] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        s[20] = bytes4(keccak256("safeTransferFrom(address,address,uint256,bytes)"));
        s[21] = VaipakamNFTFacet.positionLock.selector;
        s[22] = bytes4(keccak256("totalSupply()"));
        s[23] = bytes4(keccak256("tokenByIndex(uint256)"));
        s[24] = bytes4(keccak256("tokenOfOwnerByIndex(address,uint256)"));
        s[25] = VaipakamNFTFacet.nftStatusOf.selector;
        s[26] = VaipakamNFTFacet.setExternalUrlBase.selector;
        s[27] = VaipakamNFTFacet.setDefaultImage.selector;
        s[28] = VaipakamNFTFacet.getImageURIFor.selector;
    }

    /// @notice Full external selector surface of {RiskPreviewFacet} (9) —
    ///         mirrors `DeployDiamond._getRiskPreviewFacetSelectors`.
    ///
    /// @dev    #1649. This facet is not itself refreshed for its own sake by the
    ///         curated scripts; it is here because OTHER facets they refresh
    ///         cross-call it. THREE sale hosts route their sale paths through
    ///         `saleAdmission`, added in #1503 — `EarlyWithdrawalFacet` and
    ///         `EarlyWithdrawalDirectFacet` (both RedeployFacets) and
    ///         `OfferAcceptFacet` (ReplaceStaleFacets). Refreshing ANY of those
    ///         hosts WITHOUT routing that selector installs sale entry points
    ///         that cross-call an unrouted selector, so every sale reverts
    ///         `FunctionDoesNotExist` through the Diamond fallback — new code
    ///         live and broken. Same class of dependency the #658 note on
    ///         `ConsolidationFacet` records for the liquidation family.
    ///
    ///         The count is three rather than two since #1780 split the direct
    ///         lender-exit route into its own facet. The cross-call is not made
    ///         by the facets directly — it is inside `LibSaleSolvency`, which
    ///         INLINES into every caller, so the host set is "whoever calls that
    ///         library", not a list any compile checks. Add a sale host and this
    ///         enumeration is what tells you the new curated script must route
    ///         `saleAdmission` too.
    ///
    ///         Consumers partition this list by live routing (Add the unrouted,
    ///         Replace the routed), so it is correct against a pre-#1503 diamond
    ///         and a current one alike.
    function riskPreview() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](10);
        s[0] = RiskPreviewFacet.previewOfferAcceptBlock.selector;
        s[1] = RiskPreviewFacet.assertMatchAllowed.selector;
        s[2] = RiskPreviewFacet.previewMatchRiskBlock.selector;
        s[3] = RiskPreviewFacet.assertObligationTransferAllowed.selector;
        s[4] = RiskPreviewFacet.acceptMidTierAckPair.selector;
        s[5] = RiskPreviewFacet.previewCreatorBlock.selector;
        s[6] = RiskPreviewFacet.previewIntent.selector;
        s[7] = RiskPreviewFacet.saleAdmission.selector;
        // #1503 item 28 — the seller's forfeiture window. Same reason the whole
        // facet is enumerated here: a `Replace` cut must carry the WHOLE routed
        // surface, so omitting a new selector leaves it pointed at stale
        // bytecode after a curated refresh.
        s[8] = RiskPreviewFacet.sellerForfeitureWindow.selector;
        // #1503 item 4 — listing bounds quote. Same `Replace`-completeness
        // reason as the line above.
        s[9] = RiskPreviewFacet.quoteSellerBounds.selector;
    }

    /// @notice Full external selector surface of {RepayPeriodicFacet} (4).
    ///
    /// @dev    #1503 item 28. This facet is here for the same reason
    ///         {riskPreview} is — not for its own sake, but because a curated
    ///         refresh that leaves it behind produces a HALF-UPGRADED protocol.
    ///         The refreshed sale routes READ `lenderInterestDeliveredThroughAt`;
    ///         this facet is what WRITES it, by passing the settled period
    ///         boundary down to the pay-or-freeze host. Refresh the readers
    ///         alone and the mark is never written on the upgraded Diamond, so
    ///         every periodic payment silently re-opens the seller's forfeiture
    ///         over interest the borrower already paid — the exact bug item 28
    ///         fixes, reintroduced by the upgrade that was meant to deliver it.
    ///
    ///         Its selectors are UNCHANGED by that work; only its bytecode
    ///         moved. It is a plain Replace of the whole surface.
    function repayPeriodic() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](4);
        s[0] = RepayPeriodicFacet.autoDeductDaily.selector;
        s[1] = RepayPeriodicFacet.nextPeriodCheckpoint.selector;
        s[2] = RepayPeriodicFacet.previewPeriodicSettle.selector;
        s[3] = RepayPeriodicFacet.settlePeriodicInterest.selector;
    }

    /// @notice Full external selector surface of {EncumbranceMutateFacet} (19).
    ///
    /// @dev    #1503 item 28, and the other half of {repayPeriodic}: this facet
    ///         hosts `freezeOrPayActiveLenderResident`, which performs the write
    ///         on its clean branch. Same half-upgrade hazard.
    ///
    ///         Unlike its partner this facet's SURFACE changed —
    ///         `freezeOrPayActiveLenderResident` gained the paid-through
    ///         boundary, so the 4-argument selector is new and the 3-argument one
    ///         is retired. A curated refresh therefore Adds the new selector and
    ///         Removes the old, on top of Replacing the rest; leaving the old
    ///         selector routed would keep a live entry point whose callers pass
    ///         one argument too few.
    function encumbranceMutate() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](19);
        s[0] = EncumbranceMutateFacet.assertNotFrozenParty.selector;
        s[1] = EncumbranceMutateFacet.createOfferPrincipalLien.selector;
        s[2] = EncumbranceMutateFacet.decrementCollateralLien.selector;
        s[3] = EncumbranceMutateFacet.decrementOfferPrincipalLien.selector;
        s[4] = EncumbranceMutateFacet.freezeLenderProceeds.selector;
        s[5] = EncumbranceMutateFacet.freezeOrPayActiveLenderFromPayer.selector;
        s[6] = EncumbranceMutateFacet.freezeOrPayActiveLenderFromVault.selector;
        s[7] = EncumbranceMutateFacet.freezeOrPayActiveLenderResident.selector;
        s[8] = EncumbranceMutateFacet.freezeOrPayBorrowerSurplus.selector;
        s[9] = EncumbranceMutateFacet.incrementCollateralLien.selector;
        s[10] = EncumbranceMutateFacet.incrementOfferPrincipalLien.selector;
        s[11] = EncumbranceMutateFacet.parkLenderPayoffAndFreeze.selector;
        s[12] = EncumbranceMutateFacet.recordSanctionsFrozenClaimant.selector;
        s[13] = EncumbranceMutateFacet.recordSanctionsFrozenClaimantBoth.selector;
        s[14] = EncumbranceMutateFacet.recreateCollateralLien.selector;
        s[15] = EncumbranceMutateFacet.releaseCollateralLien.selector;
        s[16] = EncumbranceMutateFacet.releaseOfferPrincipalLien.selector;
        s[17] = EncumbranceMutateFacet.terminalize.selector;
        s[18] = EncumbranceMutateFacet.terminalizeFromAny.selector;
    }

    /// @notice #1503 item 28 — the RETIRED 3-argument
    ///         `freezeOrPayActiveLenderResident` selector, for the Remove leg of
    ///         a curated refresh against a pre-item-28 Diamond.
    /// @dev    Computed from the signature rather than referenced through the
    ///         type, because the 3-argument overload no longer exists in source.
    function retiredResidentPayoutSelector() internal pure returns (bytes4) {
        return bytes4(keccak256("freezeOrPayActiveLenderResident(uint256,address,uint256)"));
    }

    /// @notice Full external selector surface of {OfferPreviewFacet} (1).
    ///
    /// @dev    #1649. Paired with {riskPreview} for the same reason, one step
    ///         milder. `ReplaceStaleFacets` refreshes `OfferAcceptFacet`, which
    ///         after #1503 REFUSES a sale that fails admission. Leaving the
    ///         preview on stale bytecode does not break routing — it quotes the
    ///         accept as fine and lets the transaction revert, which is exactly
    ///         the preview/accept divergence #1503 exists to remove,
    ///         reintroduced by a partial refresh.
    function offerPreview() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](1);
        s[0] = OfferPreviewFacet.previewAccept.selector;
    }
}
