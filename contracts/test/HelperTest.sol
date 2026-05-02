// src/test/HelperTest.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {EscrowFactoryFacet} from "../src/facets/EscrowFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {StakingRewardsFacet} from "../src/facets/StakingRewardsFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

contract HelperTest {

    function getTestMutatorFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](42);
        selectors[0] = TestMutatorFacet.setLoan.selector;
        selectors[1] = TestMutatorFacet.setOffer.selector;
        selectors[2] = TestMutatorFacet.setNextLoanId.selector;
        selectors[3] = TestMutatorFacet.setNextOfferId.selector;
        selectors[4] = TestMutatorFacet.setTreasuryAddress.selector;
        selectors[5] = TestMutatorFacet.setKYCEnforcementFlag.selector;
        selectors[6] = TestMutatorFacet.setStakingPoolPaidOut.selector;
        selectors[7] = TestMutatorFacet.setInteractionPoolPaidOut.selector;
        selectors[8] = TestMutatorFacet.setInteractionLastClaimedDay.selector;
        selectors[9] = TestMutatorFacet.setDailyLenderInterest.selector;
        selectors[10] = TestMutatorFacet.setDailyBorrowerInterest.selector;
        selectors[11] = TestMutatorFacet.getStakingRPTStored.selector;
        selectors[12] = TestMutatorFacet.getStakingLastUpdateTime.selector;
        selectors[13] = TestMutatorFacet.getUserStakingPaid.selector;
        selectors[14] = TestMutatorFacet.getUserStakingPending.selector;
        selectors[15] = TestMutatorFacet.setKnownGlobalDailyInterest.selector;
        selectors[16] = TestMutatorFacet.setKnownGlobalSet.selector;
        selectors[17] = TestMutatorFacet.pushUserLoanId.selector;
        selectors[18] = TestMutatorFacet.pushUserOfferId.selector;
        selectors[19] = TestMutatorFacet.setOfferCancelled.selector;
        selectors[20] = TestMutatorFacet.scaffoldActiveLoan.selector;
        selectors[21] = TestMutatorFacet.scaffoldOpenOffer.selector;
        selectors[22] = TestMutatorFacet.scaffoldLoanStatusChange.selector;
        selectors[23] = TestMutatorFacet.getActiveLoanIdsListLength.selector;
        selectors[24] = TestMutatorFacet.getActiveLoanIdAt.selector;
        selectors[25] = TestMutatorFacet.getActiveLoanIdPos.selector;
        selectors[26] = TestMutatorFacet.getActiveOfferIdsListLength.selector;
        selectors[27] = TestMutatorFacet.getActiveOfferIdAt.selector;
        selectors[28] = TestMutatorFacet.getActiveOfferIdPos.selector;
        selectors[29] = TestMutatorFacet.getActiveLoansCounter.selector;
        selectors[30] = TestMutatorFacet.getActiveOffersCounter.selector;
        selectors[31] = TestMutatorFacet.getTotalLoansEverCreatedCounter.selector;
        selectors[32] = TestMutatorFacet.getTerminalBadOrSettledCounter.selector;
        selectors[33] = TestMutatorFacet.getInterestRateBpsSumCounter.selector;
        selectors[34] = TestMutatorFacet.getUniqueUserCounter.selector;
        selectors[35] = TestMutatorFacet.getUserSeenFlag.selector;
        selectors[36] = TestMutatorFacet.setEthUsdFeedRaw.selector;
        selectors[37] = TestMutatorFacet.setInteractionCapVpfiPerEthRaw.selector;
        // Test-only `s.localEid` writer. The on-chain canonical-buy
        // entry point (VPFIDiscountFacet) reverts `VPFICanonicalEidNotSet`
        // when `s.localEid == 0`; tests that exercise direct buys must
        // stamp a non-zero value via this selector during setUp.
        selectors[38] = TestMutatorFacet.setLocalEidForTest.selector;
        selectors[39] = TestMutatorFacet.pushRewardEntry.selector;
        // Gated default-DENY country-pair check — exposed for the
        // industrial-fork coverage in `CountryPairGatedTest`. Retail
        // never calls the gated branch.
        selectors[40] = TestMutatorFacet.canTradeBetweenStorageGated.selector;
        // T-032 — direct `s.wethContract` writer for the
        // `NotificationFeeTest` fixture (OracleAdminFacet isn't cut
        // into the minimal test diamond, so the production
        // owner-gated setter isn't reachable from test setUp).
        selectors[41] = TestMutatorFacet.setWethContractRaw.selector;
        return selectors;
    }

    // Facet-specific selector getters (list all public/external manually)
    function getOfferFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](10);
        selectors[0] = OfferFacet.createOffer.selector;
        // Single `acceptOffer(uint256,bool)` signature — the VPFI discount
        // path is governed by the platform-level consent flag set via
        // VPFIDiscountFacet.setVPFIDiscountConsent, not a per-call boolean.
        selectors[1] = bytes4(keccak256("acceptOffer(uint256,bool)"));
        selectors[2] = OfferFacet.cancelOffer.selector;
        selectors[3] = OfferFacet.getCompatibleOffers.selector;
        selectors[4] = OfferFacet.getUserEscrow.selector;
        selectors[5] = OfferFacet.getOffer.selector;
        selectors[6] = OfferFacet.getOfferDetails.selector;
        // Phase 8b.1 Permit2 additions — additive entries that coexist
        // with the classic `createOffer` / `acceptOffer` paths.
        selectors[7] = OfferFacet.createOfferWithPermit.selector;
        selectors[8] = OfferFacet.acceptOfferWithPermit.selector;
        // Cross-facet entry consumed by OfferMatchFacet.matchOffers
        // (Range Orders Phase 1 EIP-170 split).
        selectors[9] = OfferFacet.acceptOfferInternal.selector;
        return selectors;
    }

    /// @dev OfferMatchFacet — Range Orders Phase 1 matching surface
    ///      carved out of OfferFacet for EIP-170. Tests that exercise
    ///      `matchOffers` / `previewMatch` need this facet cut into
    ///      the test diamond.
    function getOfferMatchFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = OfferMatchFacet.matchOffers.selector;
        selectors[1] = OfferMatchFacet.previewMatch.selector;
        return selectors;
    }


    function getAdminFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](22);
        selectors[0] = AdminFacet.setTreasury.selector;
        selectors[1] = AdminFacet.getTreasury.selector;
        selectors[2] = AdminFacet.setZeroExProxy.selector;
        selectors[3] = AdminFacet.setallowanceTarget.selector;
        selectors[4] = AdminFacet.pause.selector;
        selectors[5] = AdminFacet.unpause.selector;
        selectors[6] = AdminFacet.paused.selector;
        selectors[7] = AdminFacet.setKYCEnforcement.selector;
        selectors[8] = AdminFacet.isKYCEnforcementEnabled.selector;
        selectors[9] = AdminFacet.pauseAsset.selector;
        selectors[10] = AdminFacet.unpauseAsset.selector;
        selectors[11] = AdminFacet.isAssetPaused.selector;
        selectors[12] = AdminFacet.addSwapAdapter.selector;
        selectors[13] = AdminFacet.removeSwapAdapter.selector;
        selectors[14] = AdminFacet.reorderSwapAdapters.selector;
        selectors[15] = AdminFacet.getSwapAdapters.selector;
        selectors[16] = AdminFacet.setPancakeswapV3Factory.selector;
        selectors[17] = AdminFacet.getPancakeswapV3Factory.selector;
        selectors[18] = AdminFacet.setSushiswapV3Factory.selector;
        selectors[19] = AdminFacet.getSushiswapV3Factory.selector;
        // Auto-pause primitive (Phase 1 follow-up).
        selectors[20] = AdminFacet.autoPause.selector;
        selectors[21] = AdminFacet.pausedUntil.selector;
        return selectors;
    }

    function getProfileFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](25);
        selectors[0] = ProfileFacet.updateKYCStatus.selector;
        selectors[1] = ProfileFacet.getUserCountry.selector;
        selectors[2] = ProfileFacet.isKYCVerified.selector;
        selectors[3] = ProfileFacet.setTradeAllowance.selector;
        selectors[4] = ProfileFacet.setUserCountry.selector;
        selectors[5] = ProfileFacet.updateKYCTier.selector;
        selectors[6] = ProfileFacet.getKYCTier.selector;
        selectors[7] = ProfileFacet.meetsKYCRequirement.selector;
        selectors[8] = ProfileFacet.updateKYCThresholds.selector;
        selectors[9] = ProfileFacet.getKYCThresholds.selector;
        selectors[10] = ProfileFacet.setKeeperAccess.selector;
        selectors[11] = ProfileFacet.getKeeperAccess.selector;
        selectors[12] = ProfileFacet.approveKeeper.selector;
        selectors[13] = ProfileFacet.revokeKeeper.selector;
        selectors[14] = ProfileFacet.isApprovedKeeper.selector;
        selectors[15] = ProfileFacet.getApprovedKeepers.selector;
        selectors[16] = ProfileFacet.setLoanKeeperEnabled.selector;
        selectors[17] = ProfileFacet.setOfferKeeperEnabled.selector;
        selectors[18] = ProfileFacet.setSanctionsOracle.selector;
        selectors[19] = ProfileFacet.getSanctionsOracle.selector;
        selectors[20] = ProfileFacet.isSanctionedAddress.selector;
        // Phase 6 additions
        selectors[21] = ProfileFacet.setKeeperActions.selector;
        selectors[22] = ProfileFacet.getKeeperActions.selector;
        selectors[23] = ProfileFacet.isLoanKeeperEnabled.selector;
        selectors[24] = ProfileFacet.isOfferKeeperEnabled.selector;
        return selectors;
    }

    function getOracleFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](9);
        selectors[0] = OracleFacet.checkLiquidity.selector;
        selectors[1] = OracleFacet.getAssetPrice.selector;
        selectors[2] = OracleFacet.calculateLTV.selector;
        selectors[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        selectors[4] = OracleFacet.getAssetRiskProfile.selector;
        selectors[5] = OracleFacet.getIlliquidAssets.selector;
        selectors[6] = OracleFacet.isAssetSupported.selector;
        selectors[7] = OracleFacet.getSequencerUptimeFeed.selector;
        selectors[8] = OracleFacet.sequencerHealthy.selector;
        return selectors;
    }

    function getVaipakamNFTFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](17);
        selectors[0] = VaipakamNFTFacet.mintNFT.selector;
        selectors[1] = VaipakamNFTFacet.updateNFTStatus.selector;
        selectors[2] = VaipakamNFTFacet.burnNFT.selector;
        selectors[3] = VaipakamNFTFacet.tokenURI.selector;
        selectors[4] = VaipakamNFTFacet.initializeNFT.selector;
        selectors[5] = bytes4(keccak256("ownerOf(uint256)")); // ERC721 ownerOf for ClaimFacet
        selectors[6] = VaipakamNFTFacet.contractURI.selector;
        selectors[7] = VaipakamNFTFacet.setContractImageURI.selector;
        selectors[8] = VaipakamNFTFacet.royaltyInfo.selector;
        selectors[9] = VaipakamNFTFacet.setDefaultRoyalty.selector;
        // Status-keyed image URI scheme (replaces the prior 4-slot
        // setLoanImageURIs).
        selectors[10] = VaipakamNFTFacet.setImageURIForStatus.selector;
        // IERC721Enumerable views (totalSupply, tokenByIndex, tokenOfOwnerByIndex)
        selectors[11] = bytes4(keccak256("totalSupply()"));
        selectors[12] = bytes4(keccak256("tokenByIndex(uint256)"));
        selectors[13] = bytes4(keccak256("tokenOfOwnerByIndex(address,uint256)"));
        // OpenSea external_url admin config (Tier 2 metadata polish).
        selectors[14] = VaipakamNFTFacet.setExternalUrlBase.selector;
        // Status-keyed image scheme companions.
        selectors[15] = VaipakamNFTFacet.setDefaultImage.selector;
        selectors[16] = VaipakamNFTFacet.getImageURIFor.selector;
        return selectors;
    }

    function getEscrowFactoryFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](19);
        selectors[0] = EscrowFactoryFacet
            .initializeEscrowImplementation
            .selector;
        selectors[1] = EscrowFactoryFacet.getOrCreateUserEscrow.selector;
        selectors[2] = EscrowFactoryFacet.upgradeEscrowImplementation.selector;
        selectors[3] = EscrowFactoryFacet.escrowDepositERC20.selector;
        selectors[4] = EscrowFactoryFacet.escrowWithdrawERC20.selector;
        selectors[5] = EscrowFactoryFacet.escrowDepositERC721.selector;
        selectors[6] = EscrowFactoryFacet.escrowWithdrawERC721.selector;
        selectors[7] = EscrowFactoryFacet.escrowDepositERC1155.selector;
        selectors[8] = EscrowFactoryFacet.escrowWithdrawERC1155.selector;
        selectors[9] = EscrowFactoryFacet.escrowApproveNFT721.selector;
        selectors[10] = EscrowFactoryFacet.escrowSetNFTUser.selector;
        selectors[11] = EscrowFactoryFacet.escrowGetNFTUserOf.selector;
        selectors[12] = EscrowFactoryFacet.escrowGetNFTUserExpires.selector;
        selectors[13] = EscrowFactoryFacet.getOfferAmount.selector;
        selectors[14] = EscrowFactoryFacet
            .getVaipakamEscrowImplementationAddress
            .selector;
        selectors[15] = EscrowFactoryFacet.setMandatoryEscrowUpgrade.selector;
        selectors[16] = EscrowFactoryFacet.upgradeUserEscrow.selector;
        selectors[17] = EscrowFactoryFacet.escrowGetNFTQuantity.selector;
        selectors[18] = EscrowFactoryFacet.getUserEscrowAddress.selector;
        return selectors;
    }

    function getLoanFacetSelectors() public pure returns (bytes4[] memory) {
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = LoanFacet.initiateLoan.selector;
        selectors[1] = LoanFacet.getLoanDetails.selector;
        selectors[2] = LoanFacet.getLoanConsents.selector;
        // T-032 — NOTIF_BILLER_ROLE-gated entry the watcher calls on
        // first PaidPush-tier notification fired for a loan-side.
        selectors[3] = LoanFacet.markNotifBilled.selector;
        return selectors;
    }

    function getRepayFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4); // Adjust count
        selectors[0] = RepayFacet.repayLoan.selector;
        selectors[1] = RepayFacet.repayPartial.selector;
        selectors[2] = RepayFacet.autoDeductDaily.selector;
        selectors[3] = RepayFacet.calculateRepaymentAmount.selector;
    }

    function getDefaultedFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2); // Adjust count
        selectors[0] = DefaultedFacet.triggerDefault.selector;
        selectors[1] = DefaultedFacet.isLoanDefaultable.selector;
    }

    function getRiskFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](5); // Adjust count
        selectors[0] = RiskFacet.updateRiskParams.selector;
        selectors[1] = RiskFacet.calculateLTV.selector;
        selectors[2] = RiskFacet.calculateHealthFactor.selector;
        selectors[3] = RiskFacet.isCollateralValueCollapsed.selector;
        selectors[4] = RiskFacet.triggerLiquidation.selector;
    }

    function getClaimFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](7);
        selectors[0] = ClaimFacet.claimAsLender.selector;
        selectors[1] = ClaimFacet.claimAsBorrower.selector;
        selectors[2] = ClaimFacet.getClaimableAmount.selector;
        selectors[3] = ClaimFacet.getClaimable.selector;
        selectors[4] = ClaimFacet.getBorrowerLifRebate.selector;
        selectors[5] = ClaimFacet.claimAsLenderWithRetry.selector;
        selectors[6] = ClaimFacet.getFallbackSnapshot.selector;
        return selectors;
    }

    function getAddCollateralFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](1);
        selectors[0] = AddCollateralFacet.addCollateral.selector;
        return selectors;
    }

    function getDiamondLoupeFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](5);
        selectors[0] = bytes4(keccak256("facets()"));
        selectors[1] = bytes4(keccak256("facetFunctionSelectors(address)"));
        selectors[2] = bytes4(keccak256("facetAddresses()"));
        selectors[3] = bytes4(keccak256("facetAddress(bytes4)"));
        selectors[4] = bytes4(keccak256("supportsInterface(bytes4)"));
        return selectors;
    }

    function getOwnershipFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = OwnershipFacet.transferOwnership.selector;
        selectors[1] = OwnershipFacet.owner.selector;
        return selectors;
    }

    function getTreasuryFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](3);
        selectors[0] = TreasuryFacet.claimTreasuryFees.selector;
        selectors[1] = TreasuryFacet.getTreasuryBalance.selector;
        selectors[2] = TreasuryFacet.mintVPFI.selector;
        return selectors;
    }

    function getEarlyWithdrawalFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](3);
        selectors[0] = EarlyWithdrawalFacet.sellLoanViaBuyOffer.selector;
        selectors[1] = EarlyWithdrawalFacet.createLoanSaleOffer.selector;
        selectors[2] = EarlyWithdrawalFacet.completeLoanSale.selector;
        return selectors;
    }

    function getPartialWithdrawalFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = PartialWithdrawalFacet.partialWithdrawCollateral.selector;
        selectors[1] = PartialWithdrawalFacet.calculateMaxWithdrawable.selector;
        return selectors;
    }

    function getPrecloseFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = PrecloseFacet.precloseDirect.selector;
        selectors[1] = PrecloseFacet.offsetWithNewOffer.selector;
        selectors[2] = PrecloseFacet.completeOffset.selector;
        selectors[3] = PrecloseFacet.transferObligationViaOffer.selector;
        return selectors;
    }

    function getRefinanceFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](1);
        selectors[0] = RefinanceFacet.refinanceLoan.selector;
        return selectors;
    }

    function getAccessControlFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](13);
        selectors[0] = AccessControlFacet.initializeAccessControl.selector;
        selectors[1] = AccessControlFacet.grantRole.selector;
        selectors[2] = AccessControlFacet.revokeRole.selector;
        selectors[3] = AccessControlFacet.renounceRole.selector;
        selectors[4] = AccessControlFacet.hasRole.selector;
        selectors[5] = AccessControlFacet.getRoleAdmin.selector;
        selectors[6] = AccessControlFacet.DEFAULT_ADMIN_ROLE.selector;
        selectors[7] = AccessControlFacet.ADMIN_ROLE.selector;
        selectors[8] = AccessControlFacet.PAUSER_ROLE.selector;
        selectors[9] = AccessControlFacet.KYC_ADMIN_ROLE.selector;
        selectors[10] = AccessControlFacet.ORACLE_ADMIN_ROLE.selector;
        selectors[11] = AccessControlFacet.RISK_ADMIN_ROLE.selector;
        selectors[12] = AccessControlFacet.emergencyRevokeRole.selector;
        return selectors;
    }

    function getMetricsFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](34);
        selectors[0] = MetricsFacet.getProtocolTVL.selector;
        selectors[1] = MetricsFacet.getProtocolStats.selector;
        selectors[2] = MetricsFacet.getUserCount.selector;
        selectors[3] = MetricsFacet.getActiveLoansCount.selector;
        selectors[4] = MetricsFacet.getActiveOffersCount.selector;
        selectors[5] = MetricsFacet.getTotalInterestEarnedUSD.selector;
        selectors[6] = MetricsFacet.getTreasuryMetrics.selector;
        selectors[7] = MetricsFacet.getRevenueStats.selector;
        selectors[8] = MetricsFacet.getActiveLoansPaginated.selector;
        selectors[9] = MetricsFacet.getActiveOffersByAsset.selector;
        selectors[10] = MetricsFacet.getLoanSummary.selector;
        selectors[11] = MetricsFacet.getEscrowStats.selector;
        selectors[12] = MetricsFacet.getNFTRentalDetails.selector;
        selectors[13] = MetricsFacet.getTotalNFTsInEscrowByCollection.selector;
        selectors[14] = MetricsFacet.getUserSummary.selector;
        selectors[15] = MetricsFacet.getUserActiveLoans.selector;
        selectors[16] = MetricsFacet.getUserActiveOffers.selector;
        selectors[17] = MetricsFacet.getUserNFTsInEscrow.selector;
        selectors[18] = MetricsFacet.getProtocolHealth.selector;
        selectors[19] = MetricsFacet.getBlockTimestamp.selector;
        // Reverse-index enumeration (no event-scan dependency)
        selectors[20] = MetricsFacet.getGlobalCounts.selector;
        selectors[21] = MetricsFacet.getUserLoanCount.selector;
        selectors[22] = MetricsFacet.getUserOfferCount.selector;
        selectors[23] = MetricsFacet.isOfferCancelled.selector;
        selectors[24] = MetricsFacet.getUserLoansPaginated.selector;
        selectors[25] = MetricsFacet.getUserOffersPaginated.selector;
        selectors[26] = MetricsFacet.getUserLoansByStatusPaginated.selector;
        selectors[27] = MetricsFacet.getUserOffersByStatePaginated.selector;
        selectors[28] = MetricsFacet.getAllLoansPaginated.selector;
        selectors[29] = MetricsFacet.getAllOffersPaginated.selector;
        selectors[30] = MetricsFacet.getLoansByStatusPaginated.selector;
        selectors[31] = MetricsFacet.getOffersByStatePaginated.selector;
        // Range Orders Phase 1 follow-ups: asset-agnostic active-offer
        // pagination (consumed by the keeper-bot matching detector) +
        // NFT position summary (consumed by tokenURI + frontend
        // verifier UI).
        selectors[32] = MetricsFacet.getActiveOffersPaginated.selector;
        selectors[33] = MetricsFacet.getNFTPositionSummary.selector;
        return selectors;
    }

    function getVPFITokenFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](9);
        selectors[0] = VPFITokenFacet.setVPFIToken.selector;
        selectors[1] = VPFITokenFacet.getVPFIToken.selector;
        selectors[2] = VPFITokenFacet.getVPFITotalSupply.selector;
        selectors[3] = VPFITokenFacet.getVPFICap.selector;
        selectors[4] = VPFITokenFacet.getVPFICapHeadroom.selector;
        selectors[5] = VPFITokenFacet.getVPFIMinter.selector;
        selectors[6] = VPFITokenFacet.getVPFIBalanceOf.selector;
        selectors[7] = VPFITokenFacet.setCanonicalVPFIChain.selector;
        selectors[8] = VPFITokenFacet.isCanonicalVPFIChain.selector;
        return selectors;
    }

    function getVPFIDiscountFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](19);
        selectors[0] = VPFIDiscountFacet.buyVPFIWithETH.selector;
        selectors[1] = VPFIDiscountFacet.depositVPFIToEscrow.selector;
        selectors[2] = VPFIDiscountFacet.quoteVPFIDiscount.selector;
        selectors[3] = VPFIDiscountFacet.getVPFIBuyConfig.selector;
        selectors[4] = VPFIDiscountFacet.getVPFISoldTo.selector;
        selectors[5] = VPFIDiscountFacet.setVPFIBuyRate.selector;
        selectors[6] = VPFIDiscountFacet.setVPFIBuyCaps.selector;
        selectors[7] = VPFIDiscountFacet.setVPFIBuyEnabled.selector;
        selectors[8] = VPFIDiscountFacet.setVPFIDiscountETHPriceAsset.selector;
        selectors[9] = VPFIDiscountFacet.emitDiscountApplied.selector;
        selectors[10] = VPFIDiscountFacet.setVPFIDiscountConsent.selector;
        selectors[11] = VPFIDiscountFacet.getVPFIDiscountConsent.selector;
        selectors[12] = VPFIDiscountFacet.emitYieldFeeDiscountApplied.selector;
        selectors[13] = VPFIDiscountFacet.quoteVPFIDiscountFor.selector;
        selectors[14] = VPFIDiscountFacet.getVPFIDiscountTier.selector;
        selectors[15] = VPFIDiscountFacet.withdrawVPFIFromEscrow.selector;
        selectors[16] = VPFIDiscountFacet.getUserVpfiDiscountState.selector;
        // Phase 8b.1 Permit2 addition — signature-transfer variant of
        // {depositVPFIToEscrow}.
        selectors[17] = VPFIDiscountFacet.depositVPFIToEscrowWithPermit.selector;
        // Per-(buyer, originEid) wallet-cap query. The Phase 1 30K
        // per-wallet cap applies independently per origin chain
        // (docs/TokenomicsTechSpec.md §8a); this selector lets
        // off-chain consumers read each origin bucket explicitly.
        selectors[18] = VPFIDiscountFacet.getVPFISoldToByEid.selector;
        return selectors;
    }

    function getStakingRewardsFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](9);
        selectors[0] = StakingRewardsFacet.claimStakingRewards.selector;
        selectors[1] = StakingRewardsFacet.previewStakingRewards.selector;
        selectors[2] = StakingRewardsFacet.getUserStakedVPFI.selector;
        selectors[3] = StakingRewardsFacet.getTotalStakedVPFI.selector;
        selectors[4] = StakingRewardsFacet.getStakingPoolRemaining.selector;
        selectors[5] = StakingRewardsFacet.getStakingPoolPaidOut.selector;
        selectors[6] = StakingRewardsFacet.getStakingAPRBps.selector;
        selectors[7] = StakingRewardsFacet.getStakingSnapshot.selector;
        selectors[8] = StakingRewardsFacet.getStakingRewardPerTokenStored.selector;
        return selectors;
    }

    function getConfigFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](27);
        selectors[0] = ConfigFacet.setFeesConfig.selector;
        selectors[1] = ConfigFacet.setLiquidationConfig.selector;
        selectors[2] = ConfigFacet.setRiskConfig.selector;
        selectors[3] = ConfigFacet.setStakingApr.selector;
        selectors[4] = ConfigFacet.setVpfiTierThresholds.selector;
        selectors[5] = ConfigFacet.setVpfiTierDiscountBps.selector;
        selectors[6] = ConfigFacet.getFeesConfig.selector;
        selectors[7] = ConfigFacet.getLiquidationConfig.selector;
        selectors[8] = ConfigFacet.getRiskConfig.selector;
        selectors[9] = ConfigFacet.getStakingAprBps.selector;
        selectors[10] = ConfigFacet.getVpfiTierThresholds.selector;
        selectors[11] = ConfigFacet.getVpfiTierDiscountBps.selector;
        selectors[12] = ConfigFacet.getProtocolConfigBundle.selector;
        selectors[13] = ConfigFacet.setFallbackSplit.selector;
        selectors[14] = ConfigFacet.getFallbackSplit.selector;
        selectors[15] = ConfigFacet.getProtocolConstants.selector;
        // Range Orders Phase 1 — governance-tunable matcher BPS.
        selectors[16] = ConfigFacet.setLifMatcherFeeBps.selector;
        // Phase 1 follow-up — auto-pause window duration setter.
        selectors[17] = ConfigFacet.setAutoPauseDurationSeconds.selector;
        // Findings 00025 — governance-tunable max loan duration.
        selectors[18] = ConfigFacet.setMaxOfferDurationDays.selector;
        // T-032 — notification fee USD knob + pluggable oracle + bundled
        // frontend-facing getter.
        selectors[19] = ConfigFacet.setNotificationFeeUsd.selector;
        selectors[20] = ConfigFacet.setNotificationFeeUsdOracle.selector;
        selectors[21] = ConfigFacet.getNotificationFeeConfig.selector;
        // T-044 — admin-configurable loan-default grace schedule.
        selectors[22] = ConfigFacet.setGraceBuckets.selector;
        selectors[23] = ConfigFacet.clearGraceBuckets.selector;
        selectors[24] = ConfigFacet.getGraceBuckets.selector;
        selectors[25] = ConfigFacet.getEffectiveGraceSeconds.selector;
        selectors[26] = ConfigFacet.getGraceSlotBounds.selector;
        return selectors;
    }

    function getInteractionRewardsFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](18);
        selectors[0] = InteractionRewardsFacet.claimInteractionRewards.selector;
        selectors[1] = InteractionRewardsFacet.setInteractionLaunchTimestamp.selector;
        selectors[2] = InteractionRewardsFacet.getInteractionLaunchTimestamp.selector;
        selectors[3] = InteractionRewardsFacet.getInteractionCurrentDay.selector;
        selectors[4] = InteractionRewardsFacet.getInteractionAnnualRateBps.selector;
        selectors[5] = InteractionRewardsFacet.getInteractionHalfPoolForDay.selector;
        selectors[6] = InteractionRewardsFacet.getInteractionLastClaimedDay.selector;
        selectors[7] = InteractionRewardsFacet.getInteractionDayEntry.selector;
        selectors[8] = InteractionRewardsFacet.previewInteractionRewards.selector;
        selectors[9] = InteractionRewardsFacet.getInteractionPoolRemaining.selector;
        selectors[10] = InteractionRewardsFacet.getInteractionPoolPaidOut.selector;
        selectors[11] = InteractionRewardsFacet.getInteractionSnapshot.selector;
        selectors[12] = InteractionRewardsFacet.getInteractionClaimability.selector;
        selectors[13] = InteractionRewardsFacet.setInteractionCapVpfiPerEth.selector;
        selectors[14] = InteractionRewardsFacet.getInteractionCapVpfiPerEth.selector;
        selectors[15] = InteractionRewardsFacet.getInteractionCapVpfiPerEthRaw.selector;
        selectors[16] = InteractionRewardsFacet.sweepForfeitedInteractionRewards.selector;
        selectors[17] = InteractionRewardsFacet.getUserRewardEntries.selector;
        return selectors;
    }

    function getRewardReporterFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](11);
        selectors[0] = RewardReporterFacet.closeDay.selector;
        selectors[1] = RewardReporterFacet.onRewardBroadcastReceived.selector;
        selectors[2] = RewardReporterFacet.setRewardOApp.selector;
        selectors[3] = RewardReporterFacet.setLocalEid.selector;
        selectors[4] = RewardReporterFacet.setBaseEid.selector;
        selectors[5] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        selectors[6] = RewardReporterFacet.setRewardGraceSeconds.selector;
        selectors[7] = RewardReporterFacet.getLocalChainInterestUSD18.selector;
        selectors[8] = RewardReporterFacet.getChainReportSentAt.selector;
        selectors[9] = RewardReporterFacet.getRewardReporterConfig.selector;
        selectors[10] = RewardReporterFacet.getKnownGlobalInterestUSD18.selector;
        return selectors;
    }

    function getRewardAggregatorFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](12);
        selectors[0] = RewardAggregatorFacet.onChainReportReceived.selector;
        selectors[1] = RewardAggregatorFacet.finalizeDay.selector;
        selectors[2] = RewardAggregatorFacet.forceFinalizeDay.selector;
        selectors[3] = RewardAggregatorFacet.broadcastGlobal.selector;
        selectors[4] = RewardAggregatorFacet.setExpectedSourceEids.selector;
        selectors[5] = RewardAggregatorFacet.isChainReported.selector;
        selectors[6] = RewardAggregatorFacet.getChainReport.selector;
        selectors[7] = RewardAggregatorFacet.getChainDailyReportCount.selector;
        selectors[8] = RewardAggregatorFacet.getDailyFirstReportAt.selector;
        selectors[9] = RewardAggregatorFacet.getDailyGlobalInterest.selector;
        selectors[10] = RewardAggregatorFacet.getExpectedSourceEids.selector;
        selectors[11] = RewardAggregatorFacet.isDayReadyToFinalize.selector;
        return selectors;
    }

    function getEscrowFactoryFacetSelectorsExtended()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](21);
        selectors[0] = EscrowFactoryFacet.initializeEscrowImplementation.selector;
        selectors[1] = EscrowFactoryFacet.getOrCreateUserEscrow.selector;
        selectors[2] = EscrowFactoryFacet.upgradeEscrowImplementation.selector;
        selectors[3] = EscrowFactoryFacet.escrowDepositERC20.selector;
        selectors[4] = EscrowFactoryFacet.escrowWithdrawERC20.selector;
        selectors[5] = EscrowFactoryFacet.escrowDepositERC721.selector;
        selectors[6] = EscrowFactoryFacet.escrowWithdrawERC721.selector;
        selectors[7] = EscrowFactoryFacet.escrowDepositERC1155.selector;
        selectors[8] = EscrowFactoryFacet.escrowWithdrawERC1155.selector;
        selectors[9] = EscrowFactoryFacet.escrowApproveNFT721.selector;
        selectors[10] = EscrowFactoryFacet.escrowSetNFTUser.selector;
        selectors[11] = EscrowFactoryFacet.escrowGetNFTUserOf.selector;
        selectors[12] = EscrowFactoryFacet.escrowGetNFTUserExpires.selector;
        selectors[13] = EscrowFactoryFacet.getOfferAmount.selector;
        selectors[14] = EscrowFactoryFacet.getVaipakamEscrowImplementationAddress.selector;
        selectors[15] = EscrowFactoryFacet.getDiamondAddress.selector;
        selectors[16] = EscrowFactoryFacet.setMandatoryEscrowUpgrade.selector;
        selectors[17] = EscrowFactoryFacet.upgradeUserEscrow.selector;
        selectors[18] = EscrowFactoryFacet.escrowGetNFTQuantity.selector;
        selectors[19] = EscrowFactoryFacet.escrowSetNFTUser1155.selector;
        selectors[20] = EscrowFactoryFacet.getUserEscrowAddress.selector;
        return selectors;
    }
}
