// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibEntitlement} from "../src/libraries/LibEntitlement.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ForcedSaleFacet} from "../src/facets/ForcedSaleFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {RiskSplitLiquidationFacet} from "../src/facets/RiskSplitLiquidationFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ForcedSaleTerminalTest
/// @notice #2796 — the Health-Factor liquidation (single and split route) and
///         the liquid time-based default sell through the shared forced-sale
///         host: the least collateral whose worst-case proceeds cover the debt
///         plus the two charges on it, the lender paid first, the fee only
///         after the lender, the unsold collateral left liened in the
///         borrower's vault for the claim and the extra held there with it.
///         The caller names the amount sold, inside the plan's range.
///         Design: docs/DesignsAndPlans/ForcedSaleSizingDesign.md §3.1a, §4.1,
///         §5.1, §6, §11.
contract ForcedSaleTerminalTest is SetupTest {
    uint256 internal constant LOAN = 1;
    uint256 internal constant ADAPTER_IDX = 1; // index 0 is SetupTest's legacy shim
    uint256 internal constant PLEDGED = 5000 ether;

    MockSwapAdapter internal adapter;
    address internal keeper = makeAddr("forced-sale-keeper");
    uint256 internal startTs;

    function setUp() public {
        setupHelper();
        // Both legs at $1,000 (18 decimals): one collateral unit sells for
        // one principal unit at the oracle rate.
        _price(1_000 * 1e8);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);

        adapter = new MockSwapAdapter("terminal");
        ERC20Mock(mockERC20).mint(address(adapter), 1_000_000 ether);
        AdminFacet(address(diamond)).addSwapAdapter(address(adapter));
        adapter.setTokenPrice(mockERC20, 1_000 * 1e8);

        _createLoan();
        startTs = uint256(LoanFacet(address(diamond)).getLoanDetails(LOAN).startTime);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _createLoan() internal {
        vm.prank(lender);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: 1000 ether,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: PLEDGED,
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
                interestRateBpsMax: 500,
                collateralAmountMax: PLEDGED,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
        _signAndAcceptOffer(borrower, borrowerPk, offerId);
    }

    /// @dev The collateral's price on the oracle and at the adapter alike, so
    ///      a sale fills at the oracle rate (zero slippage).
    function _price(uint256 price8) internal {
        mockOraclePrice(mockCollateralERC20, price8, 8);
        if (address(adapter) != address(0)) adapter.setTokenPrice(mockCollateralERC20, price8);
    }

    /// @dev Price the collateral so 5,000 units are worth `k` (in 1e4) times
    ///      the 1,000-unit principal, and make the loan liquidatable.
    ///      `SetupTest` mocks every health-factor read to 2.0, so the
    ///      liquidation gate's read of THIS loan is mocked below 1; the sale
    ///      itself is sized from the oracle prices set here, which no mock
    ///      touches.
    function _collateralWorth(uint256 kBps) internal {
        // 5,000 × p = k × 1,000 × $1,000  →  p = k × $200.
        _price((kBps * 200 * 1e8) / 10_000);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, LOAN),
            abi.encode(uint256(0.9e18))
        );
    }

    function _calls() internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({adapterIdx: ADAPTER_IDX, data: ""});
    }

    function _plan(ForcedSaleFacet.ForcedSaleKind kind)
        internal
        view
        returns (ForcedSaleFacet.ForcedSalePlan memory)
    {
        return ForcedSaleFacet(address(diamond)).previewForcedSale(LOAN, kind);
    }

    function _pastGrace() internal {
        vm.warp(startTs + 90 days + LibVaipakam.gracePeriod(90) + 1);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _vaultOf(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _held() internal view returns (uint256 amount) {
        (, amount, ) = ClaimFacet(address(diamond)).getBorrowerSurplusClaim(LOAN);
    }

    function _flag(address who) internal {
        MockSanctionsList list = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(list));
        list.setFlagged(who, true);
    }

    // ─── Time-based default ───────────────────────────────────────────────

    /// @dev §4.1: a covered default sells only the least covering amount; the
    ///      rest stays liened in the borrower's vault, named on the borrower's
    ///      claim, and the extra is held on the surplus row. The claim pays
    ///      both.
    function test_default_covered_unsoldStaysLienedAndClaimable() public {
        _pastGrace();
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        assertTrue(p.covered, "5,000 units cover the debt");
        assertLt(p.sell, PLEDGED, "only a slice is sold");
        uint256 d = p.debt;
        uint256 bonus = (d * 300) / 10_000;
        uint256 fee = (d * 200) / 10_000;
        uint256 extra = p.sell - bonus - d - fee; // 1:1, zero slippage

        address bVault = _vaultOf(borrower);
        uint256 vaultCol0 = _bal(mockCollateralERC20, bVault);
        uint256 keeper0 = _bal(mockERC20, keeper);
        vm.prank(keeper);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, p.sell, _calls());

        assertEq(_bal(mockERC20, keeper) - keeper0, bonus, "bonus 3% of the debt");
        assertEq(vaultCol0 - _bal(mockCollateralERC20, bVault), p.sell, "only the quote left the vault");
        (address colAsset, uint256 colAmount, bool colClaimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAsset, mockCollateralERC20);
        assertEq(colAmount, PLEDGED - p.sell, "the borrower's claim names the unsold collateral");
        assertFalse(colClaimed);
        assertEq(_held(), extra, "the extra is held on the surplus row");
        (, uint256 lenderAmount, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertLe(lenderAmount, d, "the lender is owed at most the debt");
        assertGe(lenderAmount, 1000 ether, "and at least the principal");

        uint256 col0 = _bal(mockCollateralERC20, borrower);
        uint256 pr0 = _bal(mockERC20, borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        assertEq(_bal(mockCollateralERC20, borrower) - col0, PLEDGED - p.sell, "unsold collateral paid");
        assertEq(_bal(mockERC20, borrower) - pr0, extra, "extra paid");
    }

    /// @dev §3.3: a sanctioned caller may still trigger the default (Tier-2)
    ///      but earns no bonus; it stays in the waterfall for the borrower.
    function test_default_sanctionedCaller_earnsNoBonus() public {
        _pastGrace();
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        uint256 d = p.debt;
        uint256 fee = (d * 200) / 10_000;
        _flag(keeper);

        uint256 keeper0 = _bal(mockERC20, keeper);
        vm.prank(keeper);
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, p.sell, _calls());

        assertEq(_bal(mockERC20, keeper), keeper0, "no bonus for a flagged caller");
        assertEq(_held(), p.sell - d - fee, "the withheld bonus is the borrower's");
    }

    // ─── The quote ────────────────────────────────────────────────────────

    /// @dev §3.1a: below the least covering amount is refused before
    ///      anything moves.
    function test_quote_belowLeast_refused() public {
        _pastGrace();
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        vm.expectRevert(
            abi.encodeWithSelector(
                ForcedSaleFacet.ForcedSaleQuoteOutOfRange.selector, LOAN, p.sell - 1, p.sell, p.maxSell
            )
        );
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, p.sell - 1, _calls());
    }

    /// @dev §3.1a: above the margin is refused; the top of the range sells.
    function test_quote_marginIsTheTopOfTheRange() public {
        _pastGrace();
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
        assertEq(p.maxSell, p.sell + (p.sell * 200) / 10_000, "2% above the least amount");

        vm.expectRevert(
            abi.encodeWithSelector(
                ForcedSaleFacet.ForcedSaleQuoteOutOfRange.selector, LOAN, p.maxSell + 1, p.sell, p.maxSell
            )
        );
        DefaultedFacet(address(diamond)).triggerDefault(LOAN, p.maxSell + 1, _calls());

        DefaultedFacet(address(diamond)).triggerDefault(LOAN, p.maxSell, _calls());
        (, uint256 colAmount, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAmount, PLEDGED - p.maxSell, "the quoted amount was sold");
        uint256 d = p.debt;
        assertEq(
            _held(),
            p.maxSell - (d * 300) / 10_000 - d - (d * 200) / 10_000,
            "the margin's proceeds are the borrower's"
        );
    }

    // ─── Health-Factor liquidation ────────────────────────────────────────

    /// @dev §3.2: a covered liquidation whose range reaches the whole
    ///      collateral may sell all of it; the borrower's claim is then the
    ///      held extra alone (the collateral row is written claimed with 0).
    function test_liquidation_sellsAllWithExtra_surplusOnlyClaim() public {
        _collateralWorth(11_250); // covered, but the margin reaches all of it
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        assertTrue(p.covered, "fixture: covered");
        assertEq(p.maxSell, PLEDGED, "fixture: the range reaches all the collateral");

        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, PLEDGED, _calls());

        (, uint256 colAmount, bool colClaimed) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAmount, 0, "nothing of the collateral left");
        assertTrue(colClaimed, "the empty collateral row is written claimed");
        uint256 held = _held();
        assertGt(held, 0, "an extra is held");

        uint256 pr0 = _bal(mockERC20, borrower);
        vm.prank(borrower);
        ClaimFacet(address(diamond)).claimAsBorrower(LOAN);
        assertEq(_bal(mockERC20, borrower) - pr0, held, "the surplus-only claim pays the extra");
    }

    /// @dev §3.2: an uncovered liquidation must quote all the collateral, and
    ///      the lender is paid first from what it raised.
    function test_liquidation_uncovered_sellsAll_lenderFirst() public {
        _collateralWorth(11_000); // floor 94% × 1.10 D < 1.05 D
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        assertFalse(p.covered, "fixture: uncovered");
        assertEq(p.sell, PLEDGED);
        assertEq(p.maxSell, PLEDGED, "exactly all of it");

        vm.expectRevert(
            abi.encodeWithSelector(
                ForcedSaleFacet.ForcedSaleQuoteOutOfRange.selector, LOAN, PLEDGED - 1, PLEDGED, PLEDGED
            )
        );
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, PLEDGED - 1, _calls());

        uint256 keeper0 = _bal(mockERC20, keeper);
        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, PLEDGED, _calls());
        // Zero slippage: proceeds = 1.10 D, above the debt, so the lender and
        // the bonus are paid in full and the fee takes what is left.
        uint256 d = p.debt;
        assertEq(_bal(mockERC20, keeper) - keeper0, (d * 300) / 10_000, "bonus on the debt");
        (, uint256 lenderAmount, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, true);
        assertGe(lenderAmount, 1000 ether, "the lender recovers at least the principal");
    }

    /// @dev §5.1 step 5: when every route fails, the whole collateral enters
    ///      the fallback, as before the rule.
    function test_liquidation_allRoutesFail_fallbackTakesWholeCollateral() public {
        _collateralWorth(11_500);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        assertLt(p.sell, PLEDGED, "fixture: the plan sells a slice");
        adapter.setShouldRevert(true);

        vm.prank(keeper);
        RiskFacet(address(diamond)).triggerLiquidation(LOAN, p.sell, _calls());

        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(LOAN);
        assertEq(uint256(l.status), uint256(LibVaipakam.LoanStatus.FallbackPending), "in the fallback");
        assertEq(l.collateralAmount, PLEDGED, "the fallback holds the whole collateral");
        (,,,,, bool active, ) = ClaimFacet(address(diamond)).getFallbackSnapshot(LOAN);
        assertTrue(active, "a fallback snapshot exists");
        assertEq(_bal(mockERC20, keeper), 0, "nothing paid");
    }

    // ─── Split route ──────────────────────────────────────────────────────

    /// @dev §3.1a: the split route's quote is the sum of its legs.
    function test_split_quoteIsTheSumOfTheLegs() public {
        _collateralWorth(11_500);
        ForcedSaleFacet.ForcedSalePlan memory p = _plan(ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
        uint256 half = p.sell / 2;

        LibSwap.SplitCall[] memory legs = new LibSwap.SplitCall[](2);
        legs[0] = LibSwap.SplitCall({adapterIdx: ADAPTER_IDX, splitAmount: half, data: ""});
        legs[1] = LibSwap.SplitCall({adapterIdx: ADAPTER_IDX, splitAmount: half - 1, data: ""});
        uint256 shortSum = half + half - 1;
        if (shortSum >= p.sell) legs[1].splitAmount = p.sell - half - 1; // keep it one short
        shortSum = legs[0].splitAmount + legs[1].splitAmount;
        vm.expectRevert(
            abi.encodeWithSelector(
                ForcedSaleFacet.ForcedSaleQuoteOutOfRange.selector, LOAN, shortSum, p.sell, p.maxSell
            )
        );
        RiskSplitLiquidationFacet(address(diamond)).triggerLiquidationSplit(LOAN, legs);

        legs[1].splitAmount = p.sell - half;
        vm.prank(keeper);
        RiskSplitLiquidationFacet(address(diamond)).triggerLiquidationSplit(LOAN, legs);
        (, uint256 colAmount, ) = ClaimFacet(address(diamond)).getClaimableAmount(LOAN, false);
        assertEq(colAmount, PLEDGED - p.sell, "the legs' sum was sold, the rest is claimable");
    }

    // ─── Partial liquidation: the charge rule ─────────────────────────────

    /// @dev §6: the incentive and the fee are shares of the amount repaid,
    ///      and the three add up to the proceeds.
    function test_partialChargeRule_chargesAreSharesOfTheRepaid() public pure {
        uint256 proceeds = 1_050 ether;
        (uint256 repaid, uint256 bonus, uint256 fee) = LibEntitlement.chargesOnRepaid(proceeds, 300, 200);
        assertEq(repaid, 1_000 ether, "1,050 = 1,000 repaid + 3% + 2% of it");
        assertEq(bonus, 30 ether);
        assertEq(fee, 20 ether);
        assertEq(repaid + bonus + fee, proceeds);

        (repaid, bonus, fee) = LibEntitlement.chargesOnRepaid(1_000_003, 250, 200);
        assertEq(repaid + bonus + fee, 1_000_003, "nothing lost to rounding");
        assertEq(bonus, (repaid * 250) / 10_000);
        assertGe(fee, (repaid * 200) / 10_000, "rounding goes to the treasury");
    }
}
