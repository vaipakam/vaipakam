// src/test/HelperTest.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferParallelSaleFacet} from "../src/facets/OfferParallelSaleFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferMutateFacet} from "../src/facets/OfferMutateFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {EarlyWithdrawalFacet} from "../src/facets/EarlyWithdrawalFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {PrepayListingFacet} from "../src/facets/PrepayListingFacet.sol";
import {NFTPrepayListingFacet} from "../src/facets/NFTPrepayListingFacet.sol";
import {NFTPrepayDutchListingFacet} from "../src/facets/NFTPrepayDutchListingFacet.sol";
import {NFTPrepayListingAtomicFacet} from "../src/facets/NFTPrepayListingAtomicFacet.sol";
import {NFTPrepayAutoListFacet} from "../src/facets/NFTPrepayAutoListFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {SwapToRepayFacet} from "../src/facets/SwapToRepayFacet.sol";
import {SwapToRepayIntentFacet} from "../src/facets/SwapToRepayIntentFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {AutoLifecycleFacet} from "../src/facets/AutoLifecycleFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {SignedOfferFacet} from "../src/facets/SignedOfferFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {AggregatorAdapterFactoryFacet} from "../src/facets/AggregatorAdapterFactoryFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {OwnershipFacet} from "../src/facets/OwnershipFacet.sol";
// #229 — the remaining production facets being added to SetupTest's
// 28-facet cut. DiamondLoupeFacet + OracleAdminFacet + LegalFacet
// have no existing import in HelperTest because the prior
// SetupTest.cut[] didn't route them; the 6 other missing facets
// (VPFIDiscountFacet, StakingRewardsFacet, InteractionRewardsFacet,
// RewardReporter/Aggregator, OwnershipFacet) were imported below
// but never wired into the 28-facet cut. After #229 SetupTest is a
// true strict superset of production (+ TestMutatorFacet test-only).
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {LegalFacet} from "../src/facets/LegalFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {PayrollFacet} from "../src/facets/PayrollFacet.sol";
import {PartialWithdrawalFacet} from "../src/facets/PartialWithdrawalFacet.sol";
import {RefinanceFacet} from "../src/facets/RefinanceFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {MetricsDashboardFacet} from "../src/facets/MetricsDashboardFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {MirrorTierReceiverFacet} from "../src/facets/MirrorTierReceiverFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
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
        selectors = new bytes4[](84);
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
        // Vestigial (T-068): writes the deprecated `localEid` legacy
        // slot. The canonical-buy path now keys the per-wallet cap by
        // `block.chainid`, so no stamping is needed — kept only so the
        // 62-entry selector list need not be re-indexed.
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
        // Layout-resilient `loan.liquidationLtvBpsAtInit` writer.
        // PR2 of internal-match work replaced the old
        // `setLiqThresholdBpsRaw` (which wrote the retired per-asset
        // `RiskParams.liqThresholdBps`) with this per-loan snapshot
        // writer. Used by HF tests to stress the
        // `liquidationLtvBpsAtInit == 0` branch.
        selectors[42] = TestMutatorFacet.setLiquidationLtvBpsAtInitRaw.selector;
        // Layout-resilient mapping writers used by EarlyWithdrawal
        // tests to scaffold loan-sale state without slot math.
        selectors[43] = TestMutatorFacet.setOfferIdToLoanIdRaw.selector;
        selectors[44] = TestMutatorFacet.setHeldForLenderRaw.selector;
        // Layout-resilient claim writers used by ClaimFacetTest to
        // exercise the NothingToClaim revert + held-only paths
        // without slot math.
        selectors[45] = TestMutatorFacet.setLenderClaimAmountRaw.selector;
        selectors[46] = TestMutatorFacet.setBorrowerClaimAmountRaw.selector;
        selectors[47] = TestMutatorFacet.setLenderClaimAssetRaw.selector;
        selectors[48] = TestMutatorFacet.setBorrowerClaimAssetRaw.selector;
        // NFT-claim field setters (assetType + tokenId + quantity) for
        // ERC721 / ERC1155 claim-asset coverage tests.
        selectors[49] = TestMutatorFacet.setLenderClaimNFTFieldsRaw.selector;
        selectors[50] = TestMutatorFacet.setBorrowerClaimNFTFieldsRaw.selector;
        // T-048 — layout-resilient treasury IOU writer used by
        // TreasuryFacetTest.
        selectors[51] = TestMutatorFacet.setTreasuryBalanceRaw.selector;
        // Layout-resilient sale/offset/vault-version/min-partial
        // mutators used by the LoanFacet, RefinanceFacet, OfferFacet,
        // VaultFactoryFacet and RepayFacet test suites — replaces
        // the previous `vm.store` + hardcoded slot offset pattern.
        selectors[52] = TestMutatorFacet.setSaleOfferToLoanIdRaw.selector;
        selectors[53] = TestMutatorFacet.setOffsetOfferToLoanIdRaw.selector;
        selectors[54] = TestMutatorFacet.setVaultVersionRaw.selector;
        selectors[55] = TestMutatorFacet.setMinPartialBpsRaw.selector;
        // Layout-resilient read of `s.userVaipakamVaults[user]` for
        // tests that need a user's vault address bypassing the
        // mandatory-version check on the production getter.
        selectors[56] = TestMutatorFacet.getUserVaipakamVaultRaw.selector;
        // FlashLoanLiquidationPath.md — flip the discount-path master
        // kill-switch in fixtures that don't cut ConfigFacet.
        selectors[57] = TestMutatorFacet.setDiscountPathEnabledRaw.selector;
        // MarketRateWidgetAndDepthTieredLTV.md — same pattern for the
        // depth-tiered-LTV master kill-switch. Refinance / Preclose /
        // OfferMatch test fixtures use this to assert both regimes
        // (switch ON tier-aware caps + relaxed HF floor; switch OFF
        // legacy `LTV ≤ loanInitMaxLtvBps` + `HF ≥ 1.5`) without cutting
        // ConfigFacet into their minimal diamonds.
        selectors[58] = TestMutatorFacet.setDepthTieredLtvEnabledRaw.selector;
        // PR2 of internal-match work — per-tier liquidation-LTV
        // direct-write helper for fixtures that don't cut
        // ConfigFacet. Used in test setUps to pin all three tiers
        // to a single value (e.g. 8500) and preserve legacy HF math
        // that assumed an 85% per-asset threshold.
        selectors[59] = TestMutatorFacet.setTierLiquidationLtvBpsAllRaw.selector;
        // PR5 — direct write to `protocolTrackedVaultBalance` so
        // execution-body tests can scaffold loans without running
        // the `initiateLoan` flow.
        selectors[60] = TestMutatorFacet.setProtocolTrackedVaultBalanceRaw.selector;
        // EC-003 Phase 1 — direct write to `fallbackSnapshot[loanId]`
        // so FallbackPending fixtures can scaffold the snap (lender /
        // treasury / borrower entitlements + active flag) without
        // running the full at-fallback liquidation flow.
        selectors[61] = TestMutatorFacet.setFallbackSnapshotRaw.selector;
        // LibERC721 lock-state + mint direct manipulators — exposed for
        // the focused setApprovalForAll-during-lock unit test. Names
        // intentionally avoid the `test*` prefix so Foundry's test
        // discovery doesn't try to run these as fuzz cases.
        selectors[62] = TestMutatorFacet.mintNFTRaw.selector;
        selectors[63] = TestMutatorFacet.lockNFTRaw.selector;
        selectors[64] = TestMutatorFacet.unlockNFTRaw.selector;
        selectors[65] = TestMutatorFacet.getLockedTokenCount.selector;
        // Burn + epoch readers — Codex P1 follow-ups on the
        // setApprovalForAll-during-lock hardening (PR #282, L145 burn
        // counter drift; L151 pre-lock operator approval survives the
        // lock/unlock cycle).
        selectors[66] = TestMutatorFacet.burnNFTRaw.selector;
        selectors[67] = TestMutatorFacet.getOperatorApprovalEpoch.selector;
        selectors[68] = TestMutatorFacet.getOperatorApprovalGrantEpoch.selector;
        // Codex P1 round-2 follow-up — direct `locks[tokenId]` writer
        // that skips the counter increment, used to simulate a
        // pre-PR-#282 diamond upgrade state where a token is locked but
        // the owner's `lockedTokenCount` is 0.
        selectors[69] = TestMutatorFacet.forceSetLockWithoutCounter.selector;
        // T-086 step 3 — LibCollateralSettlement view proxies + raw
        // treasury-fee setter for the focused floor-formula tests.
        selectors[70] = TestMutatorFacet.getLiveFloor.selector;
        selectors[71] = TestMutatorFacet.getPrincipalPlusAccruedInterest.selector;
        selectors[72] = TestMutatorFacet.getTreasuryAndPrecloseFee.selector;
        selectors[73] = TestMutatorFacet.setTreasuryFeeBpsRaw.selector;
        // T-086 step 10 — test-only direct invoke of LibPrepayCleanup.
        selectors[74] = TestMutatorFacet.invokePrepayCleanup.selector;
        // T-086 Round-7 (#355) — auto-list state mutators.
        selectors[75] = TestMutatorFacet.setPrepayListingOrderHash.selector;
        selectors[76] = TestMutatorFacet.setPrepayListingExecutor.selector;
        selectors[77] = TestMutatorFacet.setPrepayListingAutoListOptedOut.selector;
        // (getPrepayListingAutoListOptedOut removed — production reads
        // it via NFTPrepayListingFacet.getPrepayListingAutoListOptedOut
        // after the Codex round-13 P2 #3 follow-up.)
        selectors[78] = TestMutatorFacet.getPrepayListingAutoListNonce.selector;
        // #407 PR 4 (T-407-B, 2026-06-12) — direct write to the
        // encumbrance aggregate so the withdraw-guard tests can pin
        // the lien state without driving the full loan-init lifecycle.
        selectors[79] = TestMutatorFacet.setEncumberedRaw.selector;
        // #569 Codex #572 round-4 P2 — encumbrance-aggregate reader so
        // lifecycle tests can assert the lien is HELD across a proper-
        // close terminal and RELEASED only at `claimAsBorrower`.
        selectors[80] = TestMutatorFacet.getEncumberedRaw.selector;
        // #577 — loan-collateral lien row setter/reader for internal-match
        // residual tests (drain-block + claimability).
        selectors[81] = TestMutatorFacet.setLoanCollateralLienRaw.selector;
        selectors[82] = TestMutatorFacet.getLoanCollateralLienAmount.selector;
        // #399 backstop v0 Role B — isolate the absorb insufficient-cash guard.
        selectors[83] = TestMutatorFacet.setBackstopAbsorbCashRaw.selector;
        return selectors;
    }

    // Facet-specific selector getters (list all public/external manually)
    /// @dev `OfferFacet` was split into `OfferCreateFacet` /
    ///      `OfferAcceptFacet` (Issue #67 — EIP-170 headroom). The seven
    ///      former `getOfferFacetSelectors()` entries are partitioned
    ///      across the two getters below; the selector VALUES are
    ///      unchanged (a selector is the keccak of the signature,
    ///      independent of which facet hosts it).
    function getOfferCreateFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](6);
        selectors[0] = OfferCreateFacet.createOffer.selector;
        selectors[1] = OfferCreateFacet.getUserVault.selector;
        // Phase 8b.1 Permit2 addition.
        selectors[2] = OfferCreateFacet.createOfferWithPermit.selector;
        // Cross-facet entry consumed by PrecloseFacet.offsetWithNewOffer
        // (Option 3 offset flow) — address(this)-only gating.
        selectors[3] = OfferCreateFacet.createOfferInternal.selector;
        // #396 v0.5 — cross-facet materialize entries used by
        // `SignedOfferFacet` to mint a normal on-chain offer from a
        // signed off-chain offer (vault-backed + wallet-backed Permit2).
        selectors[4] = OfferCreateFacet.createSignedOfferVault.selector;
        selectors[5] = OfferCreateFacet.createSignedOfferWallet.selector;
        return selectors;
    }

    /// @dev T-086 Round-8 (#358) — the two parallel-sale selectors live
    ///      on `OfferParallelSaleFacet` (carved off OfferCreateFacet so
    ///      solc's viaIR jump-table reservation stays under the
    ///      "Tag too large" ICE ceiling).
    function getOfferParallelSaleFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = OfferParallelSaleFacet.postParallelSaleListing.selector;
        selectors[1] = OfferParallelSaleFacet.releaseParallelSaleLock.selector;
        return selectors;
    }

    function getOfferAcceptFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](5);
        // Single `acceptOffer(uint256,bool)` signature — the VPFI discount
        // path is governed by the platform-level consent flag set via
        // VPFIDiscountFacet.setVPFIDiscountConsent, not a per-call boolean.
        selectors[0] = bytes4(keccak256("acceptOffer(uint256,bool)"));
        // Phase 8b.1 Permit2 addition.
        selectors[1] = OfferAcceptFacet.acceptOfferWithPermit.selector;
        // Cross-facet entry consumed by OfferMatchFacet.matchOffers
        // (Range Orders Phase 1 EIP-170 split) — address(this)-only.
        selectors[2] = OfferAcceptFacet.acceptOfferInternal.selector;
        // #196 — contract-side dry-run for the frontend / indexer /
        // keeper. Pure view; consumers `staticcall` it from the
        // OfferDetails + AcceptOffer modal.
        selectors[3] = OfferAcceptFacet.previewAccept.selector;
        // #627 — public KYC-value view (aggregator adapter principal screen).
        selectors[4] = OfferAcceptFacet.calculateTransactionValueNumeraire.selector;
        return selectors;
    }

    /// @dev OfferCancelFacet — cancellation + read views carved out
    ///      of OfferFacet for the second EIP-170 split. Selectors land
    ///      on the diamond identically; this is just where the
    ///      bytecode lives.
    function getOfferCancelFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = OfferCancelFacet.cancelOffer.selector;
        selectors[1] = OfferCancelFacet.getCompatibleOffers.selector;
        selectors[2] = OfferCancelFacet.getOffer.selector;
        selectors[3] = OfferCancelFacet.getOfferDetails.selector;
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
        selectors = new bytes4[](4);
        selectors[0] = OfferMatchFacet.matchOffers.selector;
        selectors[1] = OfferMatchFacet.previewMatch.selector;
        selectors[2] = OfferMatchFacet.matchSignedOffer.selector;
        selectors[3] = OfferMatchFacet.matchIntent.selector;
        return selectors;
    }

    /// @dev OfferMutateFacet — #193 in-place modification surface.
    ///      Three per-field setters plus the atomic combined helper.
    function getOfferMutateFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = OfferMutateFacet.setOfferAmount.selector;
        selectors[1] = OfferMutateFacet.setOfferRate.selector;
        selectors[2] = OfferMutateFacet.setOfferCollateral.selector;
        selectors[3] = OfferMutateFacet.modifyOffer.selector;
        return selectors;
    }


    function getAdminFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](39);
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
        // Depth-tiered LTV (Piece B follow-up b) — Uni-V2-fork family
        // setters/getters. Configured per chain by ADMIN_ROLE; zero
        // factory ⇒ that leg of the route search is skipped.
        selectors[22] = AdminFacet.setUniswapV2Factory.selector;
        selectors[23] = AdminFacet.getUniswapV2Factory.selector;
        selectors[24] = AdminFacet.setSushiswapV2Factory.selector;
        selectors[25] = AdminFacet.getSushiswapV2Factory.selector;
        selectors[26] = AdminFacet.setPancakeswapV2Factory.selector;
        selectors[27] = AdminFacet.getPancakeswapV2Factory.selector;
        // T-092 (#508) — auto-lifecycle admin kill switches.
        selectors[28] = AdminFacet.setAutoLendEnabled.selector;
        selectors[29] = AdminFacet.setAutoRefinanceEnabled.selector;
        selectors[30] = AdminFacet.setAutoExtendEnabled.selector;
        // Codex round-1 P2 — getters.
        selectors[31] = AdminFacet.getAutoLendEnabled.selector;
        selectors[32] = AdminFacet.getAutoRefinanceEnabled.selector;
        selectors[33] = AdminFacet.getAutoExtendEnabled.selector;
        // #633 — per-venue swap-adapter pause + feature kill-switches.
        selectors[34] = AdminFacet.setSwapAdapterDisabled.selector;
        selectors[35] = AdminFacet.isSwapAdapterDisabled.selector;
        selectors[36] = AdminFacet.setAggregatorAdaptersPaused.selector;
        selectors[37] = AdminFacet.setKeepersPaused.selector;
        selectors[38] = AdminFacet.setPeerLtvReadsPaused.selector;
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
        selectors = new bytes4[](17);
        selectors[0] = OracleFacet.checkLiquidity.selector;
        selectors[1] = OracleFacet.getAssetPrice.selector;
        selectors[2] = OracleFacet.calculateLTV.selector;
        selectors[3] = OracleFacet.checkLiquidityOnActiveNetwork.selector;
        selectors[4] = OracleFacet.getAssetRiskProfile.selector;
        selectors[5] = OracleFacet.getIlliquidAssets.selector;
        selectors[6] = OracleFacet.isAssetSupported.selector;
        selectors[7] = OracleFacet.getSequencerUptimeFeed.selector;
        selectors[8] = OracleFacet.sequencerHealthy.selector;
        // AnalyticalGettersDesign §3.4 — daily price-snapshot ring
        // buffer for historical TVL reconstruction.
        selectors[9] = OracleFacet.captureDailyPriceSnapshot.selector;
        selectors[10] = OracleFacet.getHistoricalAssetPrice.selector;
        // Depth-tiered LTV (Piece B) — liquidity-tier classification views.
        selectors[11] = OracleFacet.getLiquidityTier.selector;
        selectors[12] = OracleFacet.getEffectiveLiquidityTier.selector;
        // Phase 2 of AutonomousLtvAndOracleFallback.md — try-wrapped
        // `getAssetPrice` for callers (LibFallback) that need to detect
        // oracle-quorum unavailability without reverting.
        selectors[13] = OracleFacet.tryGetAssetPrice.selector;
        // Phase 4 of AutonomousLtvAndOracleFallback.md — autonomous
        // tier-LTV cache. `refreshTierLtvCache` is the permissionless
        // refresh; the two views read the cache + the effective value
        // (with library-default fallback when cache is hard-stale).
        selectors[14] = OracleFacet.refreshTierLtvCache.selector;
        selectors[15] = OracleFacet.getTierLtvCacheEntry.selector;
        selectors[16] = OracleFacet.getEffectiveTierMaxInitLtvBps.selector;
        return selectors;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function getVaipakamNFTFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](22);
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
        // ERC721 approval surface + position-lock view — needed by the
        // PR #282 LibERC721LockApprovalTest coverage. Production cuts
        // these as part of DeployDiamond.s.sol; SetupTest historically
        // omitted them because no pre-#282 test exercised approval
        // semantics on the position NFT directly.
        selectors[17] = bytes4(keccak256("approve(address,uint256)"));
        selectors[18] = bytes4(keccak256("getApproved(uint256)"));
        selectors[19] = bytes4(keccak256("setApprovalForAll(address,bool)"));
        selectors[20] = bytes4(keccak256("isApprovedForAll(address,address)"));
        selectors[21] = VaipakamNFTFacet.positionLock.selector;
        return selectors;
    }

    function getVaultFactoryFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](29);
        selectors[0] = VaultFactoryFacet
            .initializeVaultImplementation
            .selector;
        selectors[1] = VaultFactoryFacet.getOrCreateUserVault.selector;
        selectors[2] = VaultFactoryFacet.upgradeVaultImplementation.selector;
        selectors[3] = VaultFactoryFacet.vaultDepositERC20.selector;
        selectors[4] = VaultFactoryFacet.vaultWithdrawERC20.selector;
        selectors[5] = VaultFactoryFacet.vaultDepositERC721.selector;
        selectors[6] = VaultFactoryFacet.vaultWithdrawERC721.selector;
        selectors[7] = VaultFactoryFacet.vaultDepositERC1155.selector;
        selectors[8] = VaultFactoryFacet.vaultWithdrawERC1155.selector;
        selectors[9] = VaultFactoryFacet.vaultApproveNFT721.selector;
        selectors[10] = VaultFactoryFacet.vaultSetNFTUser.selector;
        selectors[11] = VaultFactoryFacet.vaultGetNFTUserOf.selector;
        selectors[12] = VaultFactoryFacet.vaultGetNFTUserExpires.selector;
        selectors[13] = VaultFactoryFacet.getOfferAmount.selector;
        selectors[14] = VaultFactoryFacet
            .getVaipakamVaultImplementationAddress
            .selector;
        selectors[15] = VaultFactoryFacet.setMandatoryVaultUpgrade.selector;
        selectors[16] = VaultFactoryFacet.upgradeUserVault.selector;
        selectors[17] = VaultFactoryFacet.vaultGetNFTQuantity.selector;
        selectors[18] = VaultFactoryFacet.getUserVaultAddress.selector;
        // T-051 / T-054 — counter chokepoint companions.
        selectors[19] = VaultFactoryFacet.vaultDepositERC20From.selector;
        selectors[20] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        selectors[21] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        // T-054 PR-3 — stuck-token recovery.
        selectors[22] = VaultFactoryFacet.recoverStuckERC20.selector;
        selectors[23] = VaultFactoryFacet.disown.selector;
        selectors[24] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        selectors[25] = VaultFactoryFacet.recoveryAckTextHash.selector;
        selectors[26] = VaultFactoryFacet.recoveryNonce.selector;
        selectors[27] = VaultFactoryFacet.vaultBannedSource.selector;
        // #398 — adapter `_withdrawalsBlocked()` reads the vault-upgrade floor.
        selectors[28] = VaultFactoryFacet.getVaultVersionInfo.selector;
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
        selectors = new bytes4[](3); // Adjust count
        selectors[0] = RepayFacet.repayLoan.selector;
        selectors[1] = RepayFacet.repayPartial.selector;
        selectors[2] = RepayFacet.calculateRepaymentAmount.selector;
    }

    /// Issue #66 — periodic-interest + NFT-rental daily-deduction
    /// selectors, split out of RepayFacet into RepayPeriodicFacet to keep
    /// both facets under the EIP-170 runtime-bytecode limit.
    function getRepayPeriodicFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = RepayPeriodicFacet.autoDeductDaily.selector;
        selectors[1] = RepayPeriodicFacet.previewPeriodicSettle.selector;
        selectors[2] = RepayPeriodicFacet.nextPeriodCheckpoint.selector;
        selectors[3] = RepayPeriodicFacet.settlePeriodicInterest.selector;
    }

    /// T-090 — Borrower-initiated swap-to-repay facet selectors.
    function getSwapToRepayFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = SwapToRepayFacet.swapToRepayFull.selector;
        selectors[1] = SwapToRepayFacet.swapToRepayPartial.selector;
    }

    /// T-090 v1.1 (#389) — intent-based swap-to-repay facet selectors.
    /// 3 external borrower entry points + 2 Fusion `LimitOrderProtocol`
    /// hooks + ERC-1271 `isValidSignature` + 1 read-back view.
    /// `getIntentCommit` is the dapp's read-back-then-post entry per
    /// design §6.2.
    function getSwapToRepayIntentFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        // T-087 Sub 3.B — preInteraction / postInteraction /
        // isValidSignature moved to IntentDispatchFacet.
        selectors = new bytes4[](8);
        selectors[0] = SwapToRepayIntentFacet.commitSwapToRepayIntent.selector;
        selectors[1] = SwapToRepayIntentFacet.cancelSwapToRepayIntent.selector;
        selectors[2] = SwapToRepayIntentFacet.cancelExpiredIntent.selector;
        selectors[3] = SwapToRepayIntentFacet.getIntentCommit.selector;
        // §5.8 layer 2 force-cancel surface (onlyDiamondInternal) —
        // wired via crossFacetCall from the HF-liquidation +
        // time-default entry points.
        selectors[4] = SwapToRepayIntentFacet.internalForceCancelIntent.selector;
        selectors[5] = SwapToRepayIntentFacet.forceCancelIntentIfHFBelowOrRevert.selector;
        selectors[6] = SwapToRepayIntentFacet.forceCancelIntentIfPastDefaultOrRevert.selector;
        // Codex round-2 PR #420 P2 — dapp read surface; without
        // routing this through the diamond cut the borrower can't
        // mirror the canonical extension bytes the commit gate
        // requires.
        selectors[7] = SwapToRepayIntentFacet.canonicalExtension.selector;
    }

    /// @notice T-087 Sub 3.B — IntentDispatchFacet selectors.
    function getIntentDispatchFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](3);
        selectors[0] = IntentDispatchFacet.preInteraction.selector;
        selectors[1] = IntentDispatchFacet.postInteraction.selector;
        selectors[2] = IntentDispatchFacet.isValidSignature.selector;
    }

    /// @notice T-092 Phase 1 (#499) — AutoLifecycleFacet selectors.
    function getAutoLifecycleFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](13);
        selectors[0] = AutoLifecycleFacet.setAutoLendConsent.selector;
        selectors[1] = AutoLifecycleFacet.getAutoLendConsent.selector;
        selectors[2] = AutoLifecycleFacet.setAutoOptInOnNewLoan.selector;
        selectors[3] = AutoLifecycleFacet.getAutoOptInOnNewLoan.selector;
        selectors[4] = AutoLifecycleFacet.setDefaultAutoRefinanceCaps.selector;
        selectors[5] = AutoLifecycleFacet.getDefaultAutoRefinanceCaps.selector;
        selectors[6] = AutoLifecycleFacet.setAutoRefinanceCaps.selector;
        selectors[7] = AutoLifecycleFacet.getAutoRefinanceCaps.selector;
        selectors[8] = AutoLifecycleFacet.setAutoExtendBorrowerCaps.selector;
        selectors[9] = AutoLifecycleFacet.getAutoExtendBorrowerCaps.selector;
        selectors[10] = AutoLifecycleFacet.setAutoExtendLenderCaps.selector;
        selectors[11] = AutoLifecycleFacet.getAutoExtendLenderCaps.selector;
        // T-092 Phase 3 (#503) — extendLoanInPlace executor.
        selectors[12] = AutoLifecycleFacet.extendLoanInPlace.selector;
    }

    /// @notice #407 PR 2 (2026-06-12) — encumbrance mutate facet
    ///         selectors. #407 PR 4 round-1 (2026-06-12) — extended
    ///         with decrement/increment selectors that the active-loan
    ///         slice + top-up flows wire through.
    function getEncumbranceMutateFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](8);
        selectors[0] = EncumbranceMutateFacet.releaseCollateralLien.selector;
        selectors[1] = EncumbranceMutateFacet.decrementCollateralLien.selector;
        selectors[2] = EncumbranceMutateFacet.incrementCollateralLien.selector;
        // #569 §4.4 — rekey create-leg for obligation transfer.
        selectors[3] = EncumbranceMutateFacet.recreateCollateralLien.selector;
        // T-407-C (#566) — offer-principal lock (second lien category).
        selectors[4] = EncumbranceMutateFacet.createOfferPrincipalLien.selector;
        selectors[5] = EncumbranceMutateFacet.decrementOfferPrincipalLien.selector;
        selectors[6] = EncumbranceMutateFacet.releaseOfferPrincipalLien.selector;
        selectors[7] = EncumbranceMutateFacet.incrementOfferPrincipalLien.selector;
    }

    /// @notice #396 v0.5 — gasless signed off-chain offer book selectors.
    ///         Two fill entry points, signer-only cancel + batch nonce
    ///         invalidation, and the four read views.
    function getSignedOfferFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](8);
        selectors[0] = SignedOfferFacet.acceptSignedOffer.selector;
        selectors[1] = SignedOfferFacet.acceptSignedOfferWithPermit.selector;
        selectors[2] = SignedOfferFacet.cancelSignedOffer.selector;
        selectors[3] = SignedOfferFacet.invalidateSignedOfferNonce.selector;
        selectors[4] = SignedOfferFacet.hashSignedOffer.selector;
        selectors[5] = SignedOfferFacet.signedOfferOrderHash.selector;
        selectors[6] = SignedOfferFacet.signedOfferFilledAmount.selector;
        selectors[7] = SignedOfferFacet.isSignedOfferNonceUsed.selector;
    }

    function getLenderIntentFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](11);
        selectors[0] = LenderIntentFacet.setLenderIntent.selector;
        selectors[1] = LenderIntentFacet.cancelLenderIntent.selector;
        selectors[2] = LenderIntentFacet.setLenderIntentEnabled.selector;
        selectors[3] = LenderIntentFacet.isLenderIntentEnabled.selector;
        selectors[4] = LenderIntentFacet.getLenderIntent.selector;
        selectors[5] = LenderIntentFacet.getLenderIntentLivePrincipal.selector;
        selectors[6] = LenderIntentFacet.releaseIntentExposure.selector;
        selectors[7] = LenderIntentFacet.fundLenderIntent.selector;
        selectors[8] = LenderIntentFacet.withdrawLenderIntentCapital.selector;
        selectors[9] = LenderIntentFacet.getLenderIntentCapital.selector;
        selectors[10] = LenderIntentFacet.rollIntentLoan.selector;
    }

    function getAggregatorAdapterFactoryFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](11);
        selectors[0] = AggregatorAdapterFactoryFacet.initializeAdapterImplementation.selector;
        selectors[1] = AggregatorAdapterFactoryFacet.createAggregatorAdapter.selector;
        selectors[2] = AggregatorAdapterFactoryFacet.upgradeAdapterImplementation.selector;
        selectors[3] = AggregatorAdapterFactoryFacet.upgradeAggregatorAdapter.selector;
        selectors[4] = AggregatorAdapterFactoryFacet.setMandatoryAdapterUpgrade.selector;
        selectors[5] = AggregatorAdapterFactoryFacet.setAggregatorHaircutBps.selector;
        selectors[6] = AggregatorAdapterFactoryFacet.aggregatorAdapterTemplate.selector;
        selectors[7] = AggregatorAdapterFactoryFacet.currentAggregatorAdapterVersion.selector;
        selectors[8] = AggregatorAdapterFactoryFacet.mandatoryAggregatorAdapterVersion.selector;
        selectors[9] = AggregatorAdapterFactoryFacet.getAggregatorAdapterVersion.selector;
        selectors[10] = AggregatorAdapterFactoryFacet.isAggregatorAdapter.selector;
    }

    function getBackstopFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](23);
        selectors[0] = BackstopFacet.initializeBackstopVaultImplementation.selector;
        selectors[1] = BackstopFacet.provisionBackstopVault.selector;
        selectors[2] = BackstopFacet.upgradeBackstopVault.selector;
        selectors[3] = BackstopFacet.setBackstopIntent.selector;
        selectors[4] = BackstopFacet.seedBackstopOrigination.selector;
        selectors[5] = BackstopFacet.withdrawBackstopToTreasury.selector;
        selectors[6] = BackstopFacet.setOfferBackstopEligible.selector;
        selectors[7] = BackstopFacet.backstopFill.selector;
        selectors[8] = BackstopFacet.backstopClaim.selector;
        selectors[9] = BackstopFacet.sweepBackstopToken.selector;
        selectors[10] = BackstopFacet.sweepBackstopNFT.selector;
        selectors[11] = BackstopFacet.claimBackstopRewards.selector;
        selectors[12] = BackstopFacet.setBackstopEnabled.selector;
        selectors[13] = BackstopFacet.setBackstopFillEnabled.selector;
        selectors[14] = BackstopFacet.setMinBackstopDelay.selector;
        selectors[15] = BackstopFacet.getBackstopVault.selector;
        // #399 backstop v0 Role B — absorb governance.
        selectors[16] = BackstopFacet.setBackstopAbsorbEnabled.selector;
        selectors[17] = BackstopFacet.setBackstopAbsorbCap.selector;
        selectors[18] = BackstopFacet.seedBackstopAbsorb.selector;
        selectors[19] = BackstopFacet.sweepBackstopAbsorbCollateral.selector;
        selectors[20] = BackstopFacet.releaseBackstopAbsorbExposure.selector;
        selectors[21] = BackstopFacet.getBackstopAbsorbInfo.selector;
        selectors[22] = BackstopFacet.withdrawBackstopAbsorbToTreasury.selector;
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
        selectors = new bytes4[](8);
        selectors[0] = RiskFacet.updateRiskParams.selector;
        selectors[1] = RiskFacet.calculateLTV.selector;
        selectors[2] = RiskFacet.calculateHealthFactor.selector;
        selectors[3] = RiskFacet.isCollateralValueCollapsed.selector;
        selectors[4] = RiskFacet.triggerLiquidation.selector;
        // Higher-LTV-aware liquidator (Piece B follow-up — split-route).
        // Sum-to-input multi-route swap via `LibSwap.swapWithSplit`;
        // atomic-revert-on-leg-failure (no soft-failure fallback).
        selectors[5] = RiskFacet.triggerLiquidationSplit.selector;
        // Partial HF-restore liquidator (Piece B follow-up — partials).
        // Sweeps only `fractionBps` of remaining collateral, leaves loan
        // Active with reduced size and unchanged maturity. Strict
        // HF-improves + HF>=1 post-mutation gates.
        selectors[6] = RiskFacet.triggerPartialLiquidation.selector;
        // Flash-loan / liquidator-buys-at-discount path
        // (`docs/DesignsAndPlans/FlashLoanLiquidationPath.md`). Caller
        // pays `totalDebt` in principal-asset; protocol seizes
        // collateral at a per-tier discount and delivers it to
        // `recipient`. Master kill-switch `discountPathEnabled` is off
        // by default — the selector is wired but the entry-point
        // reverts `DiscountPathDisabled` until governance flips it.
        selectors[7] = RiskFacet.triggerLiquidationDiscounted.selector;
    }

    /// @notice Selectors for `RiskMatchLiquidationFacet` — the
    ///         internal-match liquidation cluster extracted from
    ///         `RiskFacet` (Issue #66) so neither facet exceeds the
    ///         EIP-170 size limit.
    ///           - `triggerInternalMatchLiquidation` — permissionless
    ///             2-loan / 3-loan match. Kill-switch defaults `false`.
    ///           - `attemptInternalMatchAutoDispatch` — `onlyDiamondInternal`
    ///             auto-dispatch hook; wired for cross-facet routing,
    ///             not EOA-callable.
    function getRiskMatchLiquidationFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] =
            RiskMatchLiquidationFacet.triggerInternalMatchLiquidation.selector;
        selectors[1] =
            RiskMatchLiquidationFacet.attemptInternalMatchAutoDispatch.selector;
    }

    function getClaimFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](9);
        selectors[0] = ClaimFacet.claimAsLender.selector;
        selectors[1] = ClaimFacet.claimAsBorrower.selector;
        selectors[2] = ClaimFacet.getClaimableAmount.selector;
        selectors[3] = ClaimFacet.getClaimable.selector;
        selectors[4] = ClaimFacet.getBorrowerLifRebate.selector;
        selectors[5] = ClaimFacet.claimAsLenderWithRetry.selector;
        selectors[6] = ClaimFacet.getFallbackSnapshot.selector;
        // #399 backstop v0 Role B — liquidator-of-last-resort.
        selectors[7] = ClaimFacet.setLenderBackstopOptIn.selector;
        selectors[8] = ClaimFacet.claimAsLenderViaBackstop.selector;
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
        selectors = new bytes4[](57);
        selectors[0] = TreasuryFacet.claimTreasuryFees.selector;
        selectors[1] = TreasuryFacet.getTreasuryBalance.selector;
        selectors[2] = TreasuryFacet.mintVPFI.selector;
        selectors[3] = TreasuryFacet.convertTreasuryAsset.selector;
        // T-087 Sub 3.A — buyback remittance + admin + reads.
        selectors[4] = TreasuryFacet.remitBuyback.selector;
        selectors[5] = TreasuryFacet.absorbRemittance.selector;
        selectors[6] = TreasuryFacet.creditBuybackBudget.selector;
        selectors[7] = TreasuryFacet.setBuybackAllowedToken.selector;
        selectors[8] = TreasuryFacet.setBuybackNoConvert.selector;
        selectors[9] = TreasuryFacet.setBuybackDestToken.selector;
        selectors[10] = TreasuryFacet.setBuybackRemittanceReceiver.selector;
        selectors[11] = TreasuryFacet.setCrossChainMessenger.selector;
        selectors[12] = TreasuryFacet.getBuybackBudget.selector;
        selectors[13] = TreasuryFacet.getBaseBuybackBudget.selector;
        selectors[14] = TreasuryFacet.getBuybackDestToken.selector;
        selectors[15] = TreasuryFacet.isBuybackAllowedToken.selector;
        selectors[16] = TreasuryFacet.isBuybackNoConvert.selector;
        selectors[17] = TreasuryFacet.getCrossChainMessenger.selector;
        selectors[18] = TreasuryFacet.getBuybackRemittanceReceiver.selector;
        // T-087 Sub 3.B — buyback intent ledger.
        selectors[19] = TreasuryFacet.commitBuybackIntent.selector;
        selectors[20] = TreasuryFacet.expireBuybackIntent.selector;
        selectors[21] = TreasuryFacet.getBuybackOrder.selector;
        selectors[22] = TreasuryFacet.getOrderHashKind.selector;
        selectors[23] = TreasuryFacet.getStakingPoolBuybackBudget.selector;
        selectors[24] = TreasuryFacet.setBuybackMaxTranche.selector;
        selectors[25] = TreasuryFacet.getBuybackMaxTranche.selector;
        // T-087 Sub 3.C — validated buyback commit + TWAP config.
        selectors[26] = TreasuryFacet.commitBuybackIntentValidated.selector;
        selectors[27] = TreasuryFacet.canonicalBuybackExtension.selector;
        selectors[28] = TreasuryFacet.setBuybackTwapMaxWindowSec.selector;
        selectors[29] = TreasuryFacet.getBuybackTwapMaxWindowSec.selector;
        selectors[30] = TreasuryFacet.isBuybackValidated.selector;
        selectors[31] = TreasuryFacet.getBuybackConsumedSoFar.selector;
        // T-087 Sub 3 add-on #472 — priority router config.
        selectors[32] = TreasuryFacet.setRewardEmissionsTopUpTarget.selector;
        selectors[33] = TreasuryFacet.getRewardEmissionsTopUpTarget.selector;
        selectors[34] = TreasuryFacet.getRewardEmissionsBudget.selector;
        selectors[35] = TreasuryFacet.setKeeperRewardTopUpTarget.selector;
        selectors[36] = TreasuryFacet.getKeeperRewardTopUpTarget.selector;
        selectors[37] = TreasuryFacet.getKeeperRewardBudget.selector;
        // T-087 Sub 3 add-on #473 — productive treasury reserve.
        selectors[38] = TreasuryFacet.setTreasuryYieldVenue.selector;
        selectors[39] = TreasuryFacet.setTreasuryExternalYieldMaxBps.selector;
        selectors[40] = TreasuryFacet.setAaveV3Pool.selector;
        selectors[41] = TreasuryFacet.setLidoStaking.selector;
        selectors[42] = TreasuryFacet.deployTreasuryYield.selector;
        selectors[43] = TreasuryFacet.withdrawTreasuryYield.selector;
        selectors[44] = TreasuryFacet.getTreasuryYieldVenue.selector;
        selectors[45] = TreasuryFacet.getTreasuryDeployedExternal.selector;
        selectors[46] = TreasuryFacet.getTreasuryExternalYieldMaxBps.selector;
        selectors[47] = TreasuryFacet.getAaveV3Pool.selector;
        selectors[48] = TreasuryFacet.getLidoStaking.selector;
        // T-087 Sub 3 add-on #474 — keeper VPFI rewards config.
        selectors[49] = TreasuryFacet.setKeeperRewardMultBps.selector;
        selectors[50] = TreasuryFacet.getKeeperRewardMultBps.selector;
        selectors[51] = TreasuryFacet.setKeeperRewardCashOutSpreadBps.selector;
        selectors[52] = TreasuryFacet.getKeeperRewardCashOutSpreadBps.selector;
        selectors[53] = TreasuryFacet.setKeeperRewardEnabled.selector;
        selectors[54] = TreasuryFacet.getKeeperRewardEnabled.selector;
        selectors[55] = TreasuryFacet.setKeeperRewardTwapMaxAgeSec.selector;
        selectors[56] = TreasuryFacet.getKeeperRewardTwapMaxAgeSec.selector;
        return selectors;
    }

    function getPayrollFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](8);
        selectors[0] = PayrollFacet.createPayrollStream.selector;
        selectors[1] = PayrollFacet.fundPayrollStream.selector;
        selectors[2] = PayrollFacet.setPayrollRate.selector;
        selectors[3] = PayrollFacet.setPayrollStreamPaused.selector;
        selectors[4] = PayrollFacet.withdrawSalary.selector;
        selectors[5] = PayrollFacet.getPayrollStream.selector;
        selectors[6] = PayrollFacet.getWithdrawableSalary.selector;
        selectors[7] = PayrollFacet.getPayrollStreamCount.selector;
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
        selectors = new bytes4[](5);
        selectors[0] = PrecloseFacet.precloseDirect.selector;
        selectors[1] = PrecloseFacet.offsetWithNewOffer.selector;
        selectors[2] = PrecloseFacet.completeOffset.selector;
        selectors[3] = PrecloseFacet.transferObligationViaOffer.selector;
        // Cross-facet entry consumed by OfferFacet._acceptOffer's auto-link.
        selectors[4] = PrecloseFacet.completeOffsetInternal.selector;
        return selectors;
    }

    function getRefinanceFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = RefinanceFacet.refinanceLoan.selector;
        // T-092-H (#549) — atomic accept-and-refinance internal
        // entry; cut so the diamond fallback can route the
        // OfferAcceptFacet / OfferMatchFacet cross-facet calls.
        selectors[1] = RefinanceFacet.refinanceLoanFromAccept.selector;
        return selectors;
    }

    function getAccessControlFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](14);
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
        selectors[13] = AccessControlFacet.transferAdmin.selector;
        return selectors;
    }

    function getMetricsFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](45);
        selectors[0] = MetricsFacet.getProtocolTVL.selector;
        selectors[1] = MetricsFacet.getProtocolStats.selector;
        selectors[2] = MetricsFacet.getUserCount.selector;
        selectors[3] = MetricsFacet.getActiveLoansCount.selector;
        selectors[4] = MetricsFacet.getActiveOffersCount.selector;
        selectors[5] = MetricsFacet.getTotalInterestEarnedNumeraire.selector;
        selectors[6] = MetricsFacet.getTreasuryMetrics.selector;
        // Legacy overload — disambiguated by full signature now that
        // the per-asset overload (added in §A.2) shares the name.
        selectors[7] = bytes4(keccak256("getRevenueStats(uint256)"));
        selectors[8] = MetricsFacet.getActiveLoansPaginated.selector;
        selectors[9] = MetricsFacet.getActiveOffersByAsset.selector;
        selectors[10] = MetricsFacet.getLoanSummary.selector;
        selectors[11] = MetricsFacet.getVaultStats.selector;
        selectors[12] = MetricsFacet.getNFTRentalDetails.selector;
        selectors[13] = MetricsFacet.getTotalNFTsInVaultByCollection.selector;
        selectors[14] = MetricsFacet.getUserSummary.selector;
        selectors[15] = MetricsFacet.getUserActiveLoans.selector;
        selectors[16] = MetricsFacet.getUserActiveOffers.selector;
        selectors[17] = MetricsFacet.getUserNFTsInVault.selector;
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
        // AnalyticalGettersDesign §3.2 — rolling-window per-asset
        // treasury accrual. Overloaded with the legacy
        // `getRevenueStats(uint256)` (index 7); selector is computed
        // from its full signature since `.selector` is ambiguous on
        // overloads.
        selectors[34] = bytes4(keccak256("getRevenueStats(address,uint16)"));
        selectors[35] = MetricsFacet.getActiveOffersByAssetPair.selector;
        selectors[36] = MetricsFacet.getUserAllOffersWithDetails.selector;
        selectors[37] = MetricsFacet.getActiveOffersByAssetPairRanked.selector;
        // PR3 of internal-match work — paginated active-loan view
        // filtered by current LTV. Internal-match bots discover
        // candidates per block via this. Returns empty while
        // `internalMatchEnabled == false`.
        selectors[38] = MetricsFacet.getMatchEligibleLoans.selector;
        // EC-003 Phase 2 — opposing-pair candidate lookup via the
        // `assetPairActiveLoanIds` index. O(K) where K is loans in the
        // exact opposing asset pair. Backs the Phase 3 auto-dispatch.
        selectors[39] = MetricsFacet.hasInternalMatchCandidate.selector;
        // #407 (2026-06-12) — Vault encumbrance views.
        selectors[40] = MetricsFacet.getLoanCollateralLien.selector;
        selectors[41] = MetricsFacet.getOfferPrincipalLien.selector;
        selectors[42] = MetricsFacet.getEncumbered.selector;
        selectors[43] = MetricsFacet.getFreeBalance.selector;
        // #396 v0.6 — open-offer position enumeration (reverse-map keyed).
        // Used by SignedOfferMatcherTest to assert a consumed transient
        // lender slice is de-listed. Already cut in DeployDiamond.s.sol.
        selectors[44] = MetricsFacet.getUserPositionOffers.selector;
        return selectors;
    }

    /// AnalyticalGettersDesign §3.1 — per-user dashboard surface.
    function getMetricsDashboardFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](6);
        selectors[0] = MetricsDashboardFacet.getUserDashboardSnapshot.selector;
        selectors[1] = MetricsDashboardFacet.getUserDashboardLoans.selector;
        selectors[2] = MetricsDashboardFacet.getUserDashboardOffers.selector;
        selectors[3] = MetricsDashboardFacet.getUserDashboardClaimables.selector;
        selectors[4] = MetricsDashboardFacet.getUserDashboardLoansBothSides.selector;
        // `MAX_PAGE_LIMIT` is a `public constant`; its auto-getter has
        // no type-level `.selector`, so the signature is hashed directly.
        selectors[5] = bytes4(keccak256("MAX_PAGE_LIMIT()"));
        return selectors;
    }

    // forge-lint: disable-next-line(mixed-case-function)
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
        selectors[8] = VPFITokenFacet.isCanonicalVpfiChain.selector;
        return selectors;
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function getVPFIDiscountFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](27);
        selectors[0] = VPFIDiscountFacet.buyVPFIWithETH.selector;
        selectors[1] = VPFIDiscountFacet.depositVPFIToVault.selector;
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
        selectors[15] = VPFIDiscountFacet.withdrawVPFIFromVault.selector;
        // #229 Codex round-1 P1 — bridged-buy quartet was missing from
        // the HelperTest mirror of production's _getVpfiDiscountSelectors.
        // Without these four selectors, SetupTest would not actually
        // be a strict superset of production for the bridged-buy
        // surface; calls to setBridgedBuyReceiver / processBridgedBuy
        // / quoteFixedRateBuy through the test diamond would have
        // reverted FunctionDoesNotExist. Indexed alongside the
        // remaining production selectors below.
        selectors[16] = VPFIDiscountFacet.setBridgedBuyReceiver.selector;
        selectors[17] = VPFIDiscountFacet.getBridgedBuyReceiver.selector;
        selectors[18] = VPFIDiscountFacet.processBridgedBuy.selector;
        selectors[19] = VPFIDiscountFacet.quoteFixedRateBuy.selector;
        selectors[20] = VPFIDiscountFacet.getUserVpfiDiscountState.selector;
        // Phase 8b.1 Permit2 addition — signature-transfer variant of
        // {depositVPFIToVault}.
        selectors[21] = VPFIDiscountFacet.depositVPFIToVaultWithPermit.selector;
        // Per-(buyer, originChainId) wallet-cap query. The Phase 1 30K
        // per-wallet cap applies independently per origin chain
        // (docs/TokenomicsTechSpec.md §8a); this selector lets
        // off-chain consumers read each origin bucket explicitly.
        selectors[22] = VPFIDiscountFacet.getVPFISoldToByChainId.selector;
        // T-087 Sub 1.D — post-gate EFFECTIVE_TIER + EFFECTIVE_BPS
        // getter for the dapp's lender-discount preview hook.
        selectors[23] = VPFIDiscountFacet.getEffectiveDiscount.selector;
        // T-087 Sub 4 — balance-mutation-free tier rollup.
        selectors[24] = VPFIDiscountFacet.pokeMyTier.selector;
        // T-087 Sub 4 round-2 P2 — public tracked-balance getter.
        selectors[25] = VPFIDiscountFacet.getTrackedVPFIBalance.selector;
        // T-087 Sub 4 round-3 P2 #1 — tracked-tier getter.
        selectors[26] = VPFIDiscountFacet.getTrackedVPFIDiscountTier.selector;
        return selectors;
    }

    /// T-087 Sub 1.B — single-home accumulator facet (ring-buffer math +
    /// lifecycle bookkeeping). Both selectors gated to
    /// `msg.sender == address(this)`; library wrappers in
    /// {LibVPFIDiscount} reach them via cross-facet calls.
    function getVpfiDiscountAccumulatorFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](3);
        selectors[0] = VPFIDiscountAccumulatorFacet.rollupUserDiscount.selector;
        selectors[1] = VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector;
        // T-087 Sub 2.A — projected tier-expiry view.
        selectors[2] = VPFIDiscountAccumulatorFacet.getTierExpirySec.selector;
        return selectors;
    }

    /// T-087 Sub 2.C — mirror-side tier-push receiver facet.
    function getMirrorTierReceiverFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](4);
        selectors[0] = MirrorTierReceiverFacet.onTierUpdateReceived.selector;
        selectors[1] = MirrorTierReceiverFacet.onVersionBumpedReceived.selector;
        selectors[2] = MirrorTierReceiverFacet.getUserTierCache.selector;
        selectors[3] = MirrorTierReceiverFacet.getCurrentTierTableVersion.selector;
        return selectors;
    }

    /// T-087 Sub 2.D — protocol broadcast orchestrator.
    function getProtocolBroadcastFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](5);
        selectors[0] = ProtocolBroadcastFacet.protocolBroadcastTierUpdate.selector;
        selectors[1] = ProtocolBroadcastFacet.topUpBroadcastBudget.selector;
        selectors[2] = ProtocolBroadcastFacet.withdrawBudget.selector;
        selectors[3] = ProtocolBroadcastFacet.getProtocolBroadcastBudget.selector;
        selectors[4] = ProtocolBroadcastFacet.getUserTierPushNonce.selector;
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
        selectors = new bytes4[](92);
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
        // T-032 / Numeraire generalization (Phase 1) — notification fee knob (now in
        // numeraire-units) + bundled frontend-facing getter. The
        // per-knob `setNotificationFeeUsdOracle` was retired; the
        // protocol's reference currency is the global numeraireOracle
        // (set via setNumeraire below).
        selectors[19] = ConfigFacet.setNotificationFee.selector;
        selectors[20] = ConfigFacet.getNotificationFeeConfig.selector;
        // T-044 — admin-configurable loan-default grace schedule.
        selectors[21] = ConfigFacet.setGraceBuckets.selector;
        selectors[22] = ConfigFacet.clearGraceBuckets.selector;
        selectors[23] = ConfigFacet.getGraceBuckets.selector;
        selectors[24] = ConfigFacet.getEffectiveGraceSeconds.selector;
        selectors[25] = ConfigFacet.getGraceSlotBounds.selector;
        // T-034 — Periodic Interest Payment knobs + master kill-switches.
        selectors[26] = ConfigFacet.setNumeraire.selector;
        selectors[27] = ConfigFacet.setMinPrincipalForFinerCadence.selector;
        selectors[28] = ConfigFacet.setPreNotifyDays.selector;
        selectors[29] = ConfigFacet.setPeriodicInterestEnabled.selector;
        selectors[30] = ConfigFacet.setNumeraireSwapEnabled.selector;
        selectors[31] = ConfigFacet.getPeriodicInterestConfig.selector;
        // Individual getters used by the protocol-console knob card
        // reader (which expects one function per knob). Numeraire generalization (b1) —
        // the per-knob `getNumeraireOracle` was retired (no
        // INumeraireOracle anymore); replaced with feed-side getters
        // (`getNumeraireSymbol`, `getEthNumeraireFeed`) that surface
        // the new numeraire-rotation surface.
        selectors[32] = ConfigFacet.getNumeraireSymbol.selector;
        selectors[33] = ConfigFacet.getEthNumeraireFeed.selector;
        selectors[34] = ConfigFacet.getMinPrincipalForFinerCadence.selector;
        selectors[35] = ConfigFacet.getPreNotifyDays.selector;
        selectors[36] = ConfigFacet.getPeriodicInterestEnabled.selector;
        selectors[37] = ConfigFacet.getNumeraireSwapEnabled.selector;
        // T-048 — Predominantly Available Denominator (PAD).
        // Atomic rotation setter + per-asset numeraire-direct override
        // setter, plus 5 individual getters consumed by the protocol-
        // console knob registry.
        selectors[38] = ConfigFacet.setPredominantDenominator.selector;
        selectors[39] = ConfigFacet.setAssetNumeraireDirectFeedOverride.selector;
        selectors[40] = ConfigFacet.getPredominantDenominator.selector;
        selectors[41] = ConfigFacet.getPredominantDenominatorSymbol.selector;
        selectors[42] = ConfigFacet.getEthPadFeed.selector;
        selectors[43] = ConfigFacet.getPadNumeraireRateFeed.selector;
        selectors[44] = ConfigFacet.getAssetNumeraireDirectFeedOverride.selector;
        // Single-field fee getters added for the protocol-console knob
        // schema (per-knob single-value getters; tuple-returning
        // getFeesConfig doesn't fit the schema).
        selectors[45] = ConfigFacet.getTreasuryFeeBps.selector;
        selectors[46] = ConfigFacet.getLoanInitiationFeeBps.selector;
        selectors[47] = ConfigFacet.getLifMatcherFeeBps.selector;
        // Range Orders Phase 1 master kill-switch flags + companion
        // single-field getters (matches DeployDiamond's full surface).
        selectors[48] = ConfigFacet.setRangeAmountEnabled.selector;
        selectors[49] = ConfigFacet.setRangeRateEnabled.selector;
        selectors[50] = ConfigFacet.setPartialFillEnabled.selector;
        selectors[51] = ConfigFacet.getMasterFlags.selector;
        selectors[52] = ConfigFacet.getRangeAmountEnabled.selector;
        selectors[53] = ConfigFacet.getRangeRateEnabled.selector;
        selectors[54] = ConfigFacet.getPartialFillEnabled.selector;
        // Depth-tiered LTV (Piece B) — governance setters + the
        // liquidity-confidence relay write + getters / bundle.
        selectors[55] = ConfigFacet.setDepthTieredLtvEnabled.selector;
        selectors[56] = ConfigFacet.setLiquiditySlippageBps.selector;
        selectors[57] = ConfigFacet.setTwapGuard.selector;
        selectors[58] = ConfigFacet.setLiquidityTierSizes.selector;
        selectors[59] = ConfigFacet.setTierMaxInitLtvBps.selector;
        selectors[60] = ConfigFacet.setPaaAssets.selector;
        selectors[61] = ConfigFacet.setKeeperTier.selector;
        selectors[62] = ConfigFacet.getDepthTieredLtvEnabled.selector;
        selectors[63] = ConfigFacet.getPaaAssets.selector;
        selectors[64] = ConfigFacet.getKeeperTier.selector;
        selectors[65] = ConfigFacet.getDepthTierConfigBundle.selector;
        // Liquidator hardening (item 2) — close-factor ceiling setter
        // for `RiskFacet.triggerPartialLiquidation`. Default 10_000 = no
        // cap; governance may tighten per docs/RangeOffersDesign.md.
        selectors[66] = ConfigFacet.setMaxPartialLiquidationCloseFactorBps.selector;
        // Phase 7 of AutonomousLtvAndOracleFallback.md — per-tier
        // LTV safety-box parameters (atomic governance setter +
        // bundle getter).
        selectors[67] = ConfigFacet.setTierLtvParams.selector;
        selectors[68] = ConfigFacet.getTierLtvParams.selector;
        // FlashLoanLiquidationPath.md — per-tier liquidator-discount
        // governance setters (master kill-switch +
        // atomic per-tier values + bundle view). All ADMIN_ROLE-
        // gated (TimelockController post-handover); the kill-switch
        // defaults `false` so a fresh deploy ships with the discount
        // path inert.
        selectors[69] = ConfigFacet.setDiscountPathEnabled.selector;
        selectors[70] = ConfigFacet.setTierLiqDiscountBps.selector;
        selectors[71] = ConfigFacet.getTierLiqDiscountBps.selector;
        // PR2 of internal-match work (2026-05-14) — per-tier
        // LIQUIDATION threshold setter + view. Replaces the retired
        // per-asset `RiskParams.liqThresholdBps`.
        selectors[72] = ConfigFacet.setTierLiquidationLtvBps.selector;
        selectors[73] = ConfigFacet.getTierLiquidationLtvBps.selector;
        // PR3 of internal-match work — kill-switch + tunables setter
        // + bundle view for the internal-liquidation match path.
        selectors[74] = ConfigFacet.setInternalMatchEnabled.selector;
        selectors[75] = ConfigFacet.setInternalMatchConfig.selector;
        selectors[76] = ConfigFacet.getInternalMatchConfigBundle.selector;
        // T-600 — treasury-conversion knobs.
        selectors[77] = ConfigFacet.setTreasuryConvertTargets.selector;
        selectors[78] = ConfigFacet.setTreasuryConvertThresholds.selector;
        selectors[79] = ConfigFacet.getTreasuryConvertConfig.selector;
        // Issue #164 — borrower-side collateral range master flag.
        selectors[80] = ConfigFacet.setRangeCollateralEnabled.selector;
        // T-086 step 6 — prepay-listing safety buffer setter.
        selectors[81] = ConfigFacet.setPrepayListingBufferBps.selector;
        // T-086 step 6 — prepay-listing master kill-switch setter.
        selectors[82] = ConfigFacet.setPrepayListingEnabled.selector;
        // T-086 Round-7 (#355) — Dutch B-cond-3b safe-margin + auto-list
        // default conduit-key setters.
        selectors[83] = ConfigFacet.setPrepayListingDutchGraceMarginSec.selector;
        selectors[84] = ConfigFacet.setPrepayListingAutoListConduitKey.selector;
        // T-090 — Borrower-initiated swap-to-repay slippage cap.
        selectors[85] = ConfigFacet.setMaxSwapToRepaySlippageBps.selector;
        selectors[86] = ConfigFacet.getMaxSwapToRepaySlippageBps.selector;
        // T-087 Sub 1.A — ring-buffer TWA + mirror-cache knob setters.
        selectors[87] = ConfigFacet.setTwaRecentDays.selector;
        selectors[88] = ConfigFacet.setTwaWindowDays.selector;
        selectors[89] = ConfigFacet.setTwaRecentWeight.selector;
        selectors[90] = ConfigFacet.setTwaMinStakedDays.selector;
        selectors[91] = ConfigFacet.setMirrorTierMaxAgeSec.selector;
        return selectors;
    }

    /// T-090 v1.1 (#389) — intent-based swap-to-repay config surface.
    /// Carved into its own `IntentConfigFacet` after the 8 v1.1
    /// setter/getter pairs pushed `ConfigFacet` over EIP-170
    /// (round-2 PR #420 CI block).
    function getIntentConfigFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](16);
        selectors[0] = IntentConfigFacet.setIntentSwapToRepayEnabled.selector;
        selectors[1] = IntentConfigFacet.setIntentMinCommitHF.selector;
        selectors[2] = IntentConfigFacet.setIntentMinOutputBufferBps.selector;
        selectors[3] = IntentConfigFacet.setIntentAuctionSecondsBounds.selector;
        selectors[4] = IntentConfigFacet.setIntentCancelGraceSeconds.selector;
        selectors[5] = IntentConfigFacet.setFusionLimitOrderProtocol.selector;
        selectors[6] = IntentConfigFacet.setIntentAllowedPrincipalToken.selector;
        selectors[7] = IntentConfigFacet.setIntentAllowedCollateralToken.selector;
        selectors[8] = IntentConfigFacet.getIntentSwapToRepayEnabled.selector;
        selectors[9] = IntentConfigFacet.getIntentMinCommitHF.selector;
        selectors[10] = IntentConfigFacet.getIntentMinOutputBufferBps.selector;
        selectors[11] = IntentConfigFacet.getIntentAuctionSecondsBounds.selector;
        selectors[12] = IntentConfigFacet.getIntentCancelGraceSeconds.selector;
        selectors[13] = IntentConfigFacet.getFusionLimitOrderProtocol.selector;
        selectors[14] = IntentConfigFacet.getIntentAllowedPrincipalToken.selector;
        selectors[15] = IntentConfigFacet.getIntentAllowedCollateralToken.selector;
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
        selectors[2] = RewardReporterFacet.setRewardMessenger.selector;
        // T-068: `setLocalEid` removed — chain identity is `block.chainid`.
        selectors[3] = RewardReporterFacet.setBaseChainId.selector;
        selectors[4] = RewardReporterFacet.setIsCanonicalRewardChain.selector;
        selectors[5] = RewardReporterFacet.setRewardGraceSeconds.selector;
        selectors[6] = RewardReporterFacet.getLocalChainInterestNumeraire18.selector;
        selectors[7] = RewardReporterFacet.getChainReportSentAt.selector;
        selectors[8] = RewardReporterFacet.getRewardReporterConfig.selector;
        selectors[9] = RewardReporterFacet.getKnownGlobalInterestNumeraire18.selector;
        // Single-field getter for the protocol-console knob registry.
        selectors[10] = RewardReporterFacet.getRewardGraceSeconds.selector;
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
        selectors[4] = RewardAggregatorFacet.setExpectedSourceChainIds.selector;
        selectors[5] = RewardAggregatorFacet.isChainReported.selector;
        selectors[6] = RewardAggregatorFacet.getChainReport.selector;
        selectors[7] = RewardAggregatorFacet.getChainDailyReportCount.selector;
        selectors[8] = RewardAggregatorFacet.getDailyFirstReportAt.selector;
        selectors[9] = RewardAggregatorFacet.getDailyGlobalInterest.selector;
        selectors[10] = RewardAggregatorFacet.getExpectedSourceChainIds.selector;
        selectors[11] = RewardAggregatorFacet.isDayReadyToFinalize.selector;
        return selectors;
    }

    function getVaultFactoryFacetSelectorsExtended()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](31);
        selectors[0] = VaultFactoryFacet.initializeVaultImplementation.selector;
        selectors[1] = VaultFactoryFacet.getOrCreateUserVault.selector;
        selectors[2] = VaultFactoryFacet.upgradeVaultImplementation.selector;
        selectors[3] = VaultFactoryFacet.vaultDepositERC20.selector;
        selectors[4] = VaultFactoryFacet.vaultWithdrawERC20.selector;
        selectors[5] = VaultFactoryFacet.vaultDepositERC721.selector;
        selectors[6] = VaultFactoryFacet.vaultWithdrawERC721.selector;
        selectors[7] = VaultFactoryFacet.vaultDepositERC1155.selector;
        selectors[8] = VaultFactoryFacet.vaultWithdrawERC1155.selector;
        selectors[9] = VaultFactoryFacet.vaultApproveNFT721.selector;
        selectors[10] = VaultFactoryFacet.vaultSetNFTUser.selector;
        selectors[11] = VaultFactoryFacet.vaultGetNFTUserOf.selector;
        selectors[12] = VaultFactoryFacet.vaultGetNFTUserExpires.selector;
        selectors[13] = VaultFactoryFacet.getOfferAmount.selector;
        selectors[14] = VaultFactoryFacet.getVaipakamVaultImplementationAddress.selector;
        selectors[15] = VaultFactoryFacet.getDiamondAddress.selector;
        selectors[16] = VaultFactoryFacet.setMandatoryVaultUpgrade.selector;
        selectors[17] = VaultFactoryFacet.upgradeUserVault.selector;
        selectors[18] = VaultFactoryFacet.vaultGetNFTQuantity.selector;
        selectors[19] = VaultFactoryFacet.vaultSetNFTUser1155.selector;
        selectors[20] = VaultFactoryFacet.getUserVaultAddress.selector;
        // T-051 / T-054 — counter chokepoint companions.
        selectors[21] = VaultFactoryFacet.vaultDepositERC20From.selector;
        selectors[22] = VaultFactoryFacet.recordVaultDepositERC20.selector;
        selectors[23] = VaultFactoryFacet.getProtocolTrackedVaultBalance.selector;
        // T-054 PR-3 — stuck-token recovery.
        selectors[24] = VaultFactoryFacet.recoverStuckERC20.selector;
        selectors[25] = VaultFactoryFacet.disown.selector;
        selectors[26] = VaultFactoryFacet.recoveryDomainSeparator.selector;
        selectors[27] = VaultFactoryFacet.recoveryAckTextHash.selector;
        selectors[28] = VaultFactoryFacet.recoveryNonce.selector;
        selectors[29] = VaultFactoryFacet.vaultBannedSource.selector;
        selectors[30] = VaultFactoryFacet.getVaultVersionInfo.selector;
        return selectors;
    }

    // ─────────────────────────────────────────────────────────────────
    // #229 — selector helpers added so SetupTest can cut every
    // production facet from `DiamondFacetNames.cutFacetNames()`. Each
    // helper mirrors the corresponding `_get*Selectors` block in
    // `contracts/script/DeployDiamond.s.sol`; keep them in sync when
    // a selector is added or removed on the facet.
    // ─────────────────────────────────────────────────────────────────

    /// @dev Mirrors `_getOracleAdminSelectors` at
    ///      `contracts/script/DeployDiamond.s.sol` L743 (34-entry list).
    ///      All admin-gated setters + read-back getters for the
    ///      Chainlink + Tellor + API3 + DIA + Pyth oracle wiring + the
    ///      Phase 3-4 peer-protocol + tier-reference asset registries.
    function getOracleAdminFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](34);
        selectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        selectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        selectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        selectors[3] = OracleAdminFacet.setWethContract.selector;
        selectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        selectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        selectors[6] = OracleAdminFacet.setStableTokenFeed.selector;
        selectors[7] = OracleAdminFacet.setSequencerUptimeFeed.selector;
        selectors[8] = OracleAdminFacet.setFeedOverride.selector;
        selectors[9] = OracleAdminFacet.getFeedOverride.selector;
        selectors[10] = OracleAdminFacet.setTellorOracle.selector;
        selectors[11] = OracleAdminFacet.getTellorOracle.selector;
        selectors[12] = OracleAdminFacet.setApi3ServerV1.selector;
        selectors[13] = OracleAdminFacet.getApi3ServerV1.selector;
        selectors[14] = OracleAdminFacet.setDIAOracleV2.selector;
        selectors[15] = OracleAdminFacet.getDIAOracleV2.selector;
        selectors[16] = OracleAdminFacet.setSecondaryOracleMaxDeviationBps.selector;
        selectors[17] = OracleAdminFacet.getSecondaryOracleMaxDeviationBps.selector;
        selectors[18] = OracleAdminFacet.setSecondaryOracleMaxStaleness.selector;
        selectors[19] = OracleAdminFacet.getSecondaryOracleMaxStaleness.selector;
        selectors[20] = OracleAdminFacet.setPythOracle.selector;
        selectors[21] = OracleAdminFacet.getPythOracle.selector;
        selectors[22] = OracleAdminFacet.setPythCrossCheckFeedId.selector;
        selectors[23] = OracleAdminFacet.getPythNumeraireFeedId.selector;
        selectors[24] = OracleAdminFacet.setPythMaxStalenessSeconds.selector;
        selectors[25] = OracleAdminFacet.getPythMaxStalenessSeconds.selector;
        selectors[26] = OracleAdminFacet.setPythCrossCheckMaxDeviationBps.selector;
        selectors[27] = OracleAdminFacet.getPythNumeraireMaxDeviationBps.selector;
        selectors[28] = OracleAdminFacet.setPythConfidenceMaxBps.selector;
        selectors[29] = OracleAdminFacet.getPythConfidenceMaxBps.selector;
        selectors[30] = OracleAdminFacet.setPeerProtocolAddresses.selector;
        selectors[31] = OracleAdminFacet.getPeerProtocolAddresses.selector;
        selectors[32] = OracleAdminFacet.setTierReferenceAssets.selector;
        selectors[33] = OracleAdminFacet.getTierReferenceAssets.selector;
        return selectors;
    }

    /// @dev Mirrors `_getLegalSelectors` at
    ///      `contracts/script/DeployDiamond.s.sol` L1466 (5-entry list).
    ///      ToS acceptance + admin-side current-ToS pointer
    ///      management.
    function getLegalFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](5);
        selectors[0] = LegalFacet.acceptTerms.selector;
        selectors[1] = LegalFacet.setCurrentTos.selector;
        selectors[2] = LegalFacet.hasAcceptedCurrentTerms.selector;
        selectors[3] = LegalFacet.getCurrentTos.selector;
        selectors[4] = LegalFacet.getUserTosAcceptance.selector;
        return selectors;
    }

    /// @dev T-086 step 5 — `PrepayListingFacet` selectors. Hosts the
    ///      executor↔diamond trust boundary for Seaport prepay
    ///      collateral sales (see
    ///      `contracts/src/seaport/CollateralListingExecutor.sol`).
    ///      Selectors mirror `DeployDiamond._getPrepayListingSelectors`
    ///      verbatim.
    function getPrepayListingFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](7);
        selectors[0] = PrepayListingFacet.getPrepayContext.selector;
        selectors[1] = PrepayListingFacet.executorFinalizePrepaySale.selector;
        selectors[2] = PrepayListingFacet.setCollateralListingExecutor.selector;
        selectors[3] = PrepayListingFacet.getCollateralListingExecutor.selector;
        // T-086 Round-8 (#358) §19.7 — 3 offer-keyed executor→diamond
        // callbacks.
        selectors[4] = PrepayListingFacet.markOfferConsumedBySale.selector;
        selectors[5] = PrepayListingFacet.recordOfferSaleProceeds.selector;
        selectors[6] = PrepayListingFacet.assertOfferFillNotSanctioned.selector;
        return selectors;
    }

    /// @dev T-086 step 6 — `NFTPrepayListingFacet` selectors. Mirrors
    ///      `DeployDiamond._getNFTPrepayListingSelectors`. Two view
    ///      helpers (`getPrepayListingOrderHash`,
    ///      `getPrepayListingBufferBps`) are routed through the
    ///      facet so the frontend can render listing status without
    ///      reading raw storage slots.
    function getNFTPrepayListingFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](9);
        selectors[0] = NFTPrepayListingFacet.postPrepayListing.selector;
        selectors[1] = NFTPrepayListingFacet.updatePrepayListing.selector;
        selectors[2] = NFTPrepayListingFacet.cancelPrepayListing.selector;
        selectors[3] = NFTPrepayListingFacet.cancelExpiredPrepayListing.selector;
        selectors[4] = NFTPrepayListingFacet.getPrepayListingOrderHash.selector;
        selectors[5] = NFTPrepayListingFacet.getPrepayListingBufferBps.selector;
        selectors[6] = NFTPrepayListingFacet.getPrepayListingEnabled.selector;
        // T-086 Round-7 (#355) — borrower-only clearAutoListOptOut.
        selectors[7] = NFTPrepayListingFacet.clearAutoListOptOut.selector;
        // T-086 Round-7 follow-up (Codex round-13 P2 #3) — production
        // getter for the auto-list opt-out flag.
        selectors[8] = NFTPrepayListingFacet.getPrepayListingAutoListOptedOut.selector;
        return selectors;
    }

    /// @dev T-086 Round-5 Block B (#309) — `NFTPrepayDutchListingFacet`
    ///      selectors. Mirrors `DeployDiamond._getNFTPrepayDutchListingSelectors`.
    function getNFTPrepayDutchListingFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](2);
        selectors[0] = NFTPrepayDutchListingFacet.postPrepayDutchListing.selector;
        selectors[1] = NFTPrepayDutchListingFacet.updatePrepayDutchListing.selector;
        return selectors;
    }

    /// @dev T-086 Round-6 / Block D (#345) — `NFTPrepayListingAtomicFacet`
    ///      selectors. ONE selector: `matchOpenSeaOffer`, the
    ///      atomic match-rotation entry point. Mirrors
    ///      `DeployDiamond._getNFTPrepayListingAtomicSelectors`.
    function getNFTPrepayListingAtomicFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](1);
        selectors[0] = NFTPrepayListingAtomicFacet.matchOpenSeaOffer.selector;
        return selectors;
    }

    /// @dev T-086 Round-7 (#355) — `NFTPrepayAutoListFacet` selectors.
    ///      ONE selector: `autoListAtFloorOnGrace`. Mirrors
    ///      `DeployDiamond._getNFTPrepayAutoListSelectors`.
    function getNFTPrepayAutoListFacetSelectors()
        public
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](1);
        selectors[0] = NFTPrepayAutoListFacet.autoListAtFloorOnGrace.selector;
        return selectors;
    }
}
