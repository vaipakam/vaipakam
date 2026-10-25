// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../src/facets/RepayPeriodicFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../src/facets/NumeraireConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {ConsolidationFacet} from "../src/facets/ConsolidationFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibCloseoutFreeze} from "../src/libraries/LibCloseoutFreeze.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ForcedSalePeriodicTest
/// @notice #2795 — the periodic-interest auto-liquidation sells through the
///         shared forced-sale host: the sale is sized to the missed interest
///         plus the two charges on it, the lender is paid at most what was
///         owed, and the extra goes to the borrower (wallet, or held for the
///         claim when the holder is flagged or the wallet refuses).
///         Design: docs/DesignsAndPlans/ForcedSaleSizingDesign.md §11.
contract ForcedSalePeriodicTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant ADAPTER_IDX = 1; // index 0 is SetupTest's legacy shim

    MockSwapAdapter internal adapter;
    address internal settler = makeAddr("periodic-settler");
    uint256 internal startTs;

    function setUp() public {
        setupHelper();
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        // Both legs at $1,000 (18 decimals): one collateral unit sells for
        // one principal unit at the oracle rate.
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);

        adapter = new MockSwapAdapter("periodic");
        ERC20Mock(mockERC20).mint(address(adapter), 1_000_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));

        _createMonthlyLoan();
        startTs = uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).startTime);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _createMonthlyLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 1200,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: 90,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: 1200,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.Monthly,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    function _calls() internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: ADAPTER_IDX, data: ""});
    }

    function _toPeriodEnd(uint256 n) internal {
        vm.warp(startTs + n * 30 days + 1 days + 1);
    }

    function _plan() internal view returns (ForcedSaleFacet.ForcedSalePlan memory) {
        return ForcedSaleFacet(address(diamond)).previewForcedSale(
            LOAN, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement
        );
    }

    function _settle() internal {
        vm.prank(settler);
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(LOAN, _calls());
    }

    function _bal(address who) internal view returns (uint256) {
        return IERC20(mockERC20).balanceOf(who);
    }

    function _vaultOf(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _held() internal view returns (uint256 amount) {
        (, amount, ) = ClaimFacet(address(diamond)).getBorrowerSurplusClaim(LOAN);
    }

    /// @dev A wallet that refuses the principal token: every `transfer` to
    ///      `who` reverts. Matches on the calldata prefix, so any amount.
    function _walletRefuses(address who) internal {
        vm.mockCallRevert(
            mockERC20,
            abi.encodeWithSelector(IERC20.transfer.selector, who),
            "wallet refuses"
        );
    }

    // ─── The plan ─────────────────────────────────────────────────────────

    function test_plan_needIsDebtPlusChargesOnTheDebt() public {
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        assertGt(p.debt, 0, "a missed period is owed");
        uint256 fee = Math.mulDiv(p.debt, 200, 10_000, Math.Rounding.Ceil);
        uint256 bonus = Math.mulDiv(p.debt, 300, 10_000, Math.Rounding.Ceil);
        assertEq(p.need, p.debt + fee + bonus, "need = D + ceil(2% D) + ceil(3% D)");
        assertTrue(p.covered, "5,000 units of collateral cover one period");
        assertGe(p.floor, p.need, "the floor covers the need");
        // The least amount: one unit less would not cover the need at the
        // 6% cap (1:1 oracle rate).
        assertLt(((p.sell - 1) * 9_400) / 10_000, p.need, "least amount sold");
        assertLt(p.sell, 5000 ether, "only a slice is sold");
    }

    function test_plan_zeroWhenNothingOwed() public view {
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        assertEq(p.debt, 0);
        assertEq(p.sell, 0);
    }

    function test_plan_perAssetBonusCeilingLowersTheNeed() public {
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 100);
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        uint256 fee = Math.mulDiv(p.debt, 200, 10_000, Math.Rounding.Ceil);
        uint256 bonus = Math.mulDiv(p.debt, 100, 10_000, Math.Rounding.Ceil);
        assertEq(p.need, p.debt + fee + bonus, "bMax is the per-asset 1%");
    }

    // ─── The sale and the split ───────────────────────────────────────────

    function test_zeroSlippage_lenderGetsTheDebt_extraToBorrowerWallet() public {
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        uint256 d = p.debt;
        uint256 bonus = (d * 300) / 10_000;
        uint256 fee = (d * 200) / 10_000;
        uint256 extra = p.sell - bonus - d - fee; // 1:1 at zero slippage

        uint256 lender0 = _bal(lender);
        uint256 borrower0 = _bal(borrower);
        uint256 settler0 = _bal(settler);
        uint256 diamond0 = _bal(address(diamond)); // the treasury in tests
        uint256 collateral0 = LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount;

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ForcedSaleFacet.ForcedSaleSettled(
            LOAN, 0, d, p.need, p.sell, p.sell, d, fee, bonus, extra, false,
            collateral0 - p.sell, true, settler
        );
        _settle();

        assertEq(_bal(lender) - lender0, d, "lender paid exactly the debt");
        assertEq(_bal(settler) - settler0, bonus, "bonus 3% of the debt");
        assertEq(_bal(address(diamond)) - diamond0, fee, "fee 2% of the debt");
        assertEq(_bal(borrower) - borrower0, extra, "extra to the borrower wallet");
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(LOAN);
        assertEq(l.collateralAmount, collateral0 - p.sell, "only the slice left the loan");
        assertEq(l.interestSettled, d, "interestSettled rises by what the lender got");
        assertEq(_held(), 0, "nothing held");
    }

    function test_atFloor_noBonus_extraIsTheUnusedReserve() public {
        adapter.setOutputMultiplierBps(9_400);
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        uint256 d = p.debt;
        uint256 proceeds = (p.sell * 9_400) / 10_000;
        uint256 fee = (d * 200) / 10_000;

        uint256 lender0 = _bal(lender);
        uint256 borrower0 = _bal(borrower);
        uint256 settler0 = _bal(settler);
        _settle();

        assertEq(_bal(lender) - lender0, d, "lender still paid the debt in full");
        assertEq(_bal(settler) - settler0, 0, "no bonus at the slippage cap");
        uint256 extra = _bal(borrower) - borrower0;
        assertEq(extra, proceeds - d - fee, "the rest is the borrower's");
        assertGe(extra, Math.mulDiv(d, 300, 10_000, Math.Rounding.Ceil), "unused bonus reserve");
        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).interestSettled, d);
    }

    function test_belowFloor_everyRouteFails_nothingMoves() public {
        adapter.setOutputMultiplierBps(9_300);
        _toPeriodEnd(1);
        uint256 collateral0 = LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount;
        uint256 lender0 = _bal(lender);
        vm.expectPartialRevert(IVaipakamErrors.PeriodicSettleSwapFailed.selector);
        _settle();
        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).collateralAmount, collateral0);
        assertEq(_bal(lender), lender0);
    }

    function test_collateralBelowNeed_sellsAll_lenderFirst() public {
        // Collateral now worth $1 a unit: 5,000 units = 5 principal units at
        // the oracle rate, under one period's need.
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        adapter.setTokenPrice(mockCollateralERC20, 1e8);
        adapter.setTokenPrice(mockERC20, 1_000 * 1e8);
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        assertFalse(p.covered, "the collateral cannot cover the need");
        assertEq(p.sell, 5000 ether, "sells all of it");
        assertLt(p.sell / 1000, p.debt, "proceeds below the debt");

        uint256 proceeds = p.sell / 1000; // fair price
        uint256 bonus = (proceeds * 300) / 10_000; // b on min(D, P) = P
        uint256 lender0 = _bal(lender);
        uint256 borrower0 = _bal(borrower);
        _settle();

        assertEq(_bal(lender) - lender0, proceeds - bonus, "lender takes all after the bonus");
        assertEq(_bal(borrower), borrower0, "no extra");
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(LOAN);
        assertEq(l.collateralAmount, 0);
        assertEq(l.interestSettled, proceeds - bonus, "credited what arrived, not the debt");
    }

    function test_perAssetBonusCeiling_appliesToTheBonusPaid() public {
        RiskFacet(address(diamond)).updateRiskParams(mockCollateralERC20, 8000, 100);
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        uint256 settler0 = _bal(settler);
        _settle();
        assertEq(_bal(settler) - settler0, (p.debt * 100) / 10_000, "bonus at the 1% ceiling");
    }

    // ─── The held extra ──────────────────────────────────────────────────

    function test_walletRefuses_extraHeld_settlementSucceeds() public {
        _toPeriodEnd(1);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan();
        uint256 d = p.debt;
        uint256 extra = p.sell - (d * 300) / 10_000 - d - (d * 200) / 10_000;
        address vault = _vaultOf(borrower);
        uint256 vault0 = _bal(vault);
        _walletRefuses(borrower);
        _settle();

        assertEq(_held(), extra, "held on the surplus row");
        assertEq(_bal(vault) - vault0, extra, "in the borrower's vault");
    }

    function test_flaggedHolder_heldAcrossTwoPeriods_paidAtClaim() public {
        MockSanctionsList list = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(list));
        list.setFlagged(borrower, true);

        _toPeriodEnd(1);
        _settle();
        uint256 first = _held();
        assertGt(first, 0, "first extra held for the flagged holder");

        _toPeriodEnd(2);
        _settle();
        uint256 total = _held();
        assertGt(total, first, "the row adds, it never overwrites");

        // De-listed, the borrower repays and claims: the held extras come with
        // the collateral.
        list.setFlagged(borrower, false);
        ERC20Mock(mockERC20).mint(borrower, 2_000 ether);
        vm.startPrank(borrower);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        RepayFacet(address(diamond)).repayLoan(LOAN);
        uint256 borrower0 = _bal(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        vm.stopPrank();
        assertEq(_bal(borrower) - borrower0, total, "held extras paid with the claim");
        (, , bool claimed) = ClaimFacet(address(diamond)).getBorrowerSurplusClaim(LOAN);
        assertTrue(claimed);
    }

    function test_consolidation_movesTheHeldExtraToTheNewHolder() public {
        _toPeriodEnd(1);
        _walletRefuses(borrower);
        _settle();
        uint256 held = _held();
        assertGt(held, 0);

        address newHolder = makeAddr("new-borrower-holder");
        uint256 tokenId = LoanFacet(address(diamond)).getLoanDetails(LOAN).borrowerTokenId;
        vm.prank(borrower);
        IERC721(address(diamond)).transferFrom(borrower, newHolder, tokenId);
        vm.prank(newHolder);
        ConsolidationFacet(address(diamond)).consolidateCollateralToHolder(LOAN);

        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).borrower, newHolder);
        assertEq(_bal(_vaultOf(newHolder)), held, "the held extra moved with the position");
        assertEq(_held(), held, "the row is unchanged");
    }

    /// @dev Hold an extra while the borrower is flagged, then de-list them:
    ///      the row carries the fail-closed marker, re-checked at any payout.
    function _heldWhileFlaggedThenDelisted() internal returns (uint256 held) {
        MockSanctionsList list = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(list));
        list.setFlagged(borrower, true);
        _toPeriodEnd(1);
        _settle();
        held = _held();
        assertGt(held, 0);
        list.setFlagged(borrower, false);
    }

    /// @dev A standing borrower offer a replacement borrower funds, taken by
    ///      `transferObligationViaOffer`.
    function _incomingBorrowerOffer() internal returns (address incoming, uint256 offerId) {
        incoming = _provisionFundedActor("incoming-borrower", mockCollateralERC20, 10_000 ether);
        vm.prank(incoming);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 1200,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 5000 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 1000 ether,
                interestRateBpsMax: 1200,
                collateralAmountMax: 5000 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        ERC20Mock(mockERC20).mint(borrower, 2_000 ether);
    }

    function test_handover_paysTheHeldExtraToTheExitingHolder() public {
        uint256 held = _heldWhileFlaggedThenDelisted();
        (address incoming, uint256 offerId) = _incomingBorrowerOffer();

        address vault = _vaultOf(borrower);
        uint256 vault0 = _bal(vault);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LibCloseoutFreeze.BorrowerHeldExtraPaid(LOAN, borrower, mockERC20, held);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(LOAN, offerId);

        assertEq(LoanFacet(address(diamond)).getLoanDetails(LOAN).borrower, incoming);
        assertEq(_held(), 0, "the held row is spent");
        assertEq(vault0 - _bal(vault), held, "paid out of the exiting holder's vault");
    }

    /// @dev When what leaves the exiting holder's vault on a handover is VPFI
    ///      (here the principal asset, so the held extra), that vault owner is
    ///      re-stamped so no fee-tier credit stays on VPFI no longer vaulted.
    function test_handover_restampsTheExitingHolderWhenVpfiLeaves() public {
        _heldWhileFlaggedThenDelisted();
        (, uint256 offerId) = _incomingBorrowerOffer();
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);

        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(ConsolidationFacet.restampUserVpfiInternal.selector, borrower)
        );
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(LOAN, offerId);
        assertEq(_held(), 0);
    }

    /// @dev #2795 root rule at the claim: a held extra survives a later
    ///      terminal that leaves the borrower nothing of the collateral (and
    ///      so writes the collateral row claimed). The lender's claim does not
    ///      settle the loan over it, and the borrower's claim pays it.
    function test_zeroSurplusDefault_heldExtraStaysClaimable() public {
        uint256 held = _heldWhileFlaggedThenDelisted();

        // Past maturity and grace, the collateral is worth a little less than
        // the debt (LTV above 100% but below the 110% collapse line), so the
        // liquid default sells it all and leaves the borrower no surplus.
        vm.warp(startTs + 90 days + LibVaipakam.gracePeriod(90) + 1);
        mockOraclePrice(mockCollateralERC20, 199 * 1e8, 8);
        adapter.setOutputMultiplierBps(1990);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, _calls());

        (, uint256 colAmount, bool colClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAmount, 0, "no collateral surplus");
        assertTrue(colClaimed, "the terminal wrote the collateral row claimed");
        assertEq(_held(), held, "the held extra is still on its row");

        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(LOAN);
        assertTrue(
            LoanFacet(address(diamond)).getLoanDetails(LOAN).status != LibVaipakam.LoanStatus.Settled,
            "the lender's claim leaves the borrower lane open"
        );

        uint256 borrower0 = _bal(borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        assertEq(_bal(borrower) - borrower0, held, "the held extra is paid at the claim");
        assertEq(
            uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).status),
            uint256(LibVaipakam.LoanStatus.Settled)
        );

        vm.prank(borrower);
        vm.expectRevert(IVaipakamErrors.InvalidLoanStatus.selector);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
    }

    /// @dev The in-kind default (illiquid collateral) writes only the
    ///      lender's claim, leaving the borrower's collateral row unwritten.
    ///      The claim pays the held extra and skips that empty row, rather
    ///      than withdrawing an unset asset.
    function test_inKindDefault_heldExtraPaid_emptyCollateralRowSkipped() public {
        uint256 held = _heldWhileFlaggedThenDelisted();

        vm.warp(startTs + 90 days + LibVaipakam.gracePeriod(90) + 1);
        // Illiquid collateral takes the in-kind branch (both parties consented).
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.checkLiquidityOnActiveNetwork.selector, mockCollateralERC20),
            abi.encode(LibVaipakam.LiquidityStatus.Illiquid)
        );
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, _calls());

        (address colAsset, uint256 colAmount, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAsset, address(0), "no borrower collateral row written");
        assertEq(colAmount, 0);

        uint256 borrower0 = _bal(borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        assertEq(_bal(borrower) - borrower0, held, "the held extra is paid at the claim");
    }

    /// @dev On a VPFI-principal loan, holding the extra in the stored
    ///      borrower's vault re-stamps them, so the VPFI they now hold counts.
    function test_heldVpfiExtra_restampsTheStoredBorrower() public {
        _toPeriodEnd(1);
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        _walletRefuses(borrower);
        vm.expectCall(
            address(diamond),
            abi.encodeWithSelector(ConsolidationFacet.restampUserVpfiInternal.selector, borrower)
        );
        _settle();
        assertGt(_held(), 0);
    }
}
