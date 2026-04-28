// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {OfferFacet} from "../src/facets/OfferFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

/// @title VolatilityLTVTest
/// @notice Pinpoint coverage for the 110% LTV collapse trigger — the
///         abnormal-fallback classifier used by DefaultedFacet in
///         README §7 to route a defaulted liquid loan into the time-based
///         liquidation path when the collateral has crashed below 1/1.1
///         of the borrow value.
///
///         `isCollateralValueCollapsed(loanId)` is the predicate:
///             LTV > VOLATILITY_LTV_THRESHOLD_BPS (11000)  ||  HF < 1e18
///
///         The existing RiskFacetTest has one "LTV much higher" case. This
///         suite locks down the boundary semantics twice — one wei below
///         and one wei above — and isolates the HF branch from the LTV
///         branch so a future refactor can't accidentally flip one while
///         covering only the other.
///
///         Setup tweaks:
///          - SetupTest mocks `RiskFacet.calculateLTV` / `.calculateHealthFactor`
///            for other tests. We clear those so the real math runs.
///          - Oracle liquidity + price mocks are re-applied after the clear
///            so RiskFacet's `_computeUsdValues` returns the expected USD.
contract VolatilityLTVTest is SetupTest, IVaipakamErrors {
    uint256 internal loanId;

    function setUp() public {
        setupHelper();

        // Drop the catch-all RiskFacet mocks; we want real LTV/HF math.
        vm.clearMockedCalls();

        // Re-apply the oracle + liquidity mocks that real RiskFacet needs.
        mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockERC20, 1e8, 8);
        mockOracleLiquidity(mockCollateralERC20, LibVaipakam.LiquidityStatus.Liquid);
        mockOraclePrice(mockCollateralERC20, 1e8, 8);

        // Create a baseline loan: principal=1000, collateral=1800, $1 each
        // → LTV = 5555 bps, HF = 1.53e18 (both well below thresholds).
        loanId = _createLoan(1000 ether, 1800 ether);
    }

    function _createLoan(
        uint256 principal,
        uint256 collateral
    ) internal returns (uint256) {
        vm.prank(lender);
        uint256 offerId = OfferFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: collateral,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorFallbackConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0
            })
        );

        vm.prank(borrower);
        OfferFacet(address(diamond)).acceptOffer(offerId, true);
        return 1;
    }

    function _setPrincipal(uint256 newPrincipal) internal {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.principal = newPrincipal;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    function _setCollateralAmount(uint256 newCollateral) internal {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.collateralAmount = newCollateral;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);
    }

    // ─── LTV branch: boundary around 11000 bps ──────────────────────────────

    /// @dev Baseline sanity: LTV=5555, HF=1.53e18 → NOT collapsed.
    function testHealthyLoanNotCollapsed() public view {
        assertFalse(RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId));
        assertEq(RiskFacet(address(diamond)).calculateLTV(loanId), 5555);
    }

    /// @dev LTV exactly at 11000 bps. The predicate uses strict `>` on LTV,
    ///      so the LTV branch alone does NOT fire at 11000 — but the HF
    ///      branch is already tripped because `liqThresholdBps (8500) <
    ///      LTV (11000)` makes `riskAdjustedCollateral < borrow`. Lock
    ///      that "fail-safe" behavior in: at LTV=11000 the loan is still
    ///      collapsed via HF < 1e18, confirming the two branches compose
    ///      correctly.
    function testLtvAtThresholdStillCollapsesViaHf() public {
        _setPrincipal(1980 ether);
        assertEq(RiskFacet(address(diamond)).calculateLTV(loanId), 11000);
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertLt(hf, 1e18, "HF already underwater at LTV=11000");
        assertTrue(
            RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId),
            "HF branch fires even though LTV strict-less than branch does not"
        );
    }

    /// @dev LTV just above threshold. Principal 1981 / collateral 1800
    ///      → LTV = 11005 bps > 11000 → collapsed.
    function testLtvJustAboveThresholdCollapsed() public {
        _setPrincipal(1981 ether);
        uint256 ltv = RiskFacet(address(diamond)).calculateLTV(loanId);
        assertGt(ltv, LibVaipakam.VOLATILITY_LTV_THRESHOLD_BPS, "precondition");
        assertTrue(
            RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId),
            "LTV > threshold collapses"
        );
    }

    /// @dev LTV well above threshold. Principal 20000 / collateral 1800
    ///      → LTV ≈ 111111 bps → collapsed (matches the existing RiskFacet
    ///      sanity test's extreme case).
    function testLtvFarAboveThresholdCollapsed() public {
        _setPrincipal(20_000 ether);
        assertTrue(RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId));
    }

    // ─── HF branch: boundary around 1e18 ────────────────────────────────────

    /// @dev With collateral=1000, principal=850 and liqThreshold=8500:
    ///      riskAdjusted = 850, hf = 850/850 = 1e18 exactly.
    ///      LTV = 8500 (below 11000). Predicate `hf < 1e18` → false.
    function testHfAtOneExactlyNotCollapsed() public {
        _setCollateralAmount(1000 ether);
        _setPrincipal(850 ether);
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        assertEq(hf, 1e18, "HF at boundary");
        assertFalse(
            RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId),
            "HF == 1e18 stays safe"
        );
    }

    /// @dev HF strictly below 1e18 while LTV stays below 11000. With
    ///      collateral=1000, principal=900 and liqThreshold=8500:
    ///          riskAdjusted = 850, hf = 850 * 1e18 / 900 ≈ 0.944e18
    ///          LTV = 900 * 10000 / 1000 = 9000 (below 11000)
    ///      So the HF branch alone drives the collapse signal.
    function testHfBelowOneCollapsesWithoutLtvBreach() public {
        _setCollateralAmount(1000 ether);
        _setPrincipal(900 ether);
        uint256 hf = RiskFacet(address(diamond)).calculateHealthFactor(loanId);
        uint256 ltv = RiskFacet(address(diamond)).calculateLTV(loanId);
        assertLt(hf, 1e18, "HF below 1");
        assertLe(ltv, LibVaipakam.VOLATILITY_LTV_THRESHOLD_BPS, "LTV below threshold");
        assertTrue(
            RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId),
            "HF < 1e18 alone collapses"
        );
    }

    // ─── Input validation ────────────────────────────────────────────────────

    /// @dev No loan → InvalidLoan (id == 0 guard).
    function testCollapsedPredicateRevertsForUnknownLoan() public {
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).isCollateralValueCollapsed(42);
    }

    /// @dev Zero collateral amount → InvalidLoan (loan.collateralAmount == 0
    ///      guard runs before the liquidity check).
    function testCollapsedPredicateRevertsForZeroCollateralAmount() public {
        _setCollateralAmount(0);
        vm.expectRevert(RiskFacet.InvalidLoan.selector);
        RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId);
    }

    /// @dev Illiquid collateral → NonLiquidAsset. The collapse predicate is
    ///      only defined for the liquid-vs-liquid liquidation path; illiquid
    ///      loans go through DefaultedFacet's direct-transfer route instead.
    function testCollapsedPredicateRevertsForIlliquidCollateral() public {
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.collateralLiquidity = LibVaipakam.LiquidityStatus.Illiquid;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        vm.expectRevert(IVaipakamErrors.IlliquidLoanNoRiskMath.selector);
        RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId);
    }

    /// @dev Zero collateral value (price=0) → ZeroCollateral. This path
    ///      fires AFTER the liquidity check, so both sides must stay
    ///      Liquid; we flip the oracle price to $0 instead.
    function testCollapsedPredicateRevertsForZeroCollateralValue() public {
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(OracleFacet.getAssetPrice.selector, mockCollateralERC20),
            abi.encode(0, 8)
        );
        vm.expectRevert(RiskFacet.ZeroCollateral.selector);
        RiskFacet(address(diamond)).isCollateralValueCollapsed(loanId);
    }
}
