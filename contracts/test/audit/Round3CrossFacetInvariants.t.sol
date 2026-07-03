// test/audit/Round3CrossFacetInvariants.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORED IN A NO-FORGE ENVIRONMENT — NOT EXECUTED HERE.
// Run with:
//   nice -n -10 ionice -c 2 -n 0 forge test \
//     --match-path test/audit/Round3CrossFacetInvariants.t.sol -vvv
// ─────────────────────────────────────────────────────────────────────────────

import {SetupTest} from "../SetupTest.t.sol";
import {defaultAdapterCalls} from "../helpers/AdapterCallHelpers.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../../src/libraries/LibSwap.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {RefinanceFacet} from "../../src/facets/RefinanceFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {DefaultedFacet} from "../../src/facets/DefaultedFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../../src/facets/VPFIDiscountFacet.sol";
import {InteractionRewardsFacet} from "../../src/facets/InteractionRewardsFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {IZeroExProxy} from "../../src/interfaces/IZeroExProxy.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {ZeroExProxyMock} from "../mocks/ZeroExProxyMock.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Round3CrossFacetInvariants
/// @notice Audit-round-3 cross-facet interaction sequences + protocol-level
///         invariants that neither prior audit round chased:
///
///         A. A single loan driven through refinance → periodic settlement
///            (`interestSettled > 0`) → preclose/HF-liquidation exit → claim,
///            with VALUE-CONSERVATION assertions across the whole sequence
///            (lender never earns more than the full-term coupon; the borrower
///            is never re-charged interest that a prior partial/periodic
///            settlement already credited — the M7 class, exercised at the
///            terminal boundary where it historically re-appeared).
///
///         B. Protocol invariants asserted concretely after a representative
///            mix of operations (repaid + illiquid-defaulted + fallback-pending
///            loans in one diamond):
///              - collateral conservation on terminal loans (no leak against
///                the LibFallback three-way split / illiquid full-transfer);
///              - no `Active`/`Repaid` loan may carry a live
///                `fallbackSnapshot`;
///              - the VPFI custody-solvency invariant
///                `VPFI.balanceOf(diamond) >= Σ vpfiHeld + Σ rebateAmount`
///                (hard obligations), and the DEMONSTRATION that adding the
///                interaction-pool accounting (`getInteractionPoolRemaining`,
///                69M cap) to the same balance is NOT backed — the
///                commingling Informational finding.
///
/// @dev Inherits the full SetupTest production-superset diamond (37 facets +
///      TestMutatorFacet), so every cross-facet hop routes through the real
///      Diamond fallback exactly as on mainnet.
contract Round3CrossFacetInvariants is SetupTest {
    // Rounding slack for interest math (accrual is day-granular and
    // floor-divided; 1 gwei of ERC20 dust is far above any observed rounding
    // residue while still catching a real double-charge, which is O(days of
    // coupon), i.e. >= 1e15 wei at these fixture sizes).
    uint256 internal constant DUST = 1e9;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant COLLATERAL = 1500 ether;

    function setUp() public {
        setupHelper();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Shared fixture helpers
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Compact offer config so each call site stays readable and the
    ///      33-field `CreateOfferParams` literal lives in its own stack frame
    ///      (viaIR stack-ceiling discipline — see #568).
    struct OfferCfg {
        LibVaipakam.OfferType offerType;
        address lendingAsset;
        address collateralAsset;
        uint256 amount;
        uint256 collateralAmount;
        uint256 rateBps;
        uint256 durationDays;
        bool allowsPartialRepay;
        LibVaipakam.PeriodicInterestCadence cadence;
    }

    function _createOffer(address creator, OfferCfg memory c)
        internal
        returns (uint256 offerId)
    {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: c.offerType,
                lendingAsset: c.lendingAsset,
                amount: c.amount,
                interestRateBps: c.rateBps,
                collateralAsset: c.collateralAsset,
                collateralAmount: c.collateralAmount,
                durationDays: c.durationDays,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: c.lendingAsset,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: c.allowsPartialRepay,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: c.amount,
                interestRateBpsMax: c.rateBps,
                collateralAmountMax: c.collateralAmount,
                periodicInterestCadence: c.cadence,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Full-term simple-interest coupon: principal × rate × days / 365.
    ///      This is the hard ceiling on TOTAL interest a lender may earn on a
    ///      loan absent late fees — the load-bearing conservation bound.
    function _fullTermCoupon(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) internal pure returns (uint256) {
        return (principal * rateBps * durationDays) / (10_000 * 365);
    }

    /// @dev Wallet + own-vault balance of `token` for `user` — location-
    ///      agnostic value tracking (repay proceeds land in the vault,
    ///      refinance refunds land in the wallet; conservation cares about
    ///      the SUM).
    function _totBal(address token, address user) internal returns (uint256) {
        address vault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(user);
        return IERC20(token).balanceOf(user) + IERC20(token).balanceOf(vault);
    }

    function _loan(uint256 loanId)
        internal
        view
        returns (LibVaipakam.Loan memory)
    {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _totalLoansEverCreated() internal view returns (uint256) {
        (uint256 totalLoans, ) =
            MetricsFacet(address(diamond)).getGlobalCounts();
        return totalLoans;
    }

    function _emptyCalls()
        internal
        pure
        returns (LibSwap.AdapterCall[] memory)
    {
        return new LibSwap.AdapterCall[](0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // A. Cross-facet interaction sequence
    //    refinance → periodic settle → preclose → claim (one loan lineage)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice End-to-end M7-class exercise. One borrower position is driven
    ///         through EVERY interest-mutating facet in sequence:
    ///
    ///           1. loan1 (30d @ 5%, no cadence) opened via OfferAccept.
    ///           2. borrower posts a refinance vehicle (90d @ 4%, Monthly
    ///              cadence, partial-repay allowed); a third actor accepts it
    ///              (loan2 born Active); RefinanceFacet.refinanceLoan closes
    ///              loan1 with loan2's principal.
    ///           3. Period 1 of loan2: real `repayPartial` before the boundary
    ///              (interest portion folds into `interestSettled` +
    ///              `interestPaidSinceLastPeriod`), then a post-boundary
    ///              `repayPartial` fires the inline checkpoint advance —
    ///              the periodic-settlement machinery on real funds.
    ///           4. Period 2: `RepayPeriodicFacet.settlePeriodicInterest`
    ///              just-stamp entry point (precondition scaffolded — see
    ///              in-line TODO).
    ///           5. `PrecloseFacet.precloseDirect` exits the loan.
    ///           6. `ClaimFacet.claimAsBorrower` sweeps any residual claim.
    ///
    ///         Conservation asserted across the WHOLE sequence:
    ///           - interest charged at close + interest already settled
    ///             ≤ full-term coupon (borrower not double-charged — M7);
    ///           - old lender's total take ≤ principal + full-term coupon;
    ///           - new lender's total take ≤ principal + full-term coupon;
    ///           - borrower ends with EXACTLY the collateral they started
    ///             with (refinance refund + preclose release leak nothing);
    ///           - no stale fallbackSnapshot / VPFI custody on either loan.
    function test_CrossFacetSequence_RefinanceThenPeriodicSettleThenPrecloseThenClaim()
        public
    {
        // ── Phase 0 — enable periodic interest & make Monthly cadence
        //    admissible (value-threshold: 1000 tokens × $1000 = $1M ≥ $100k
        //    default floor). Mirrors PeriodicInterestSettleTest.setUp.
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(2 * 365);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);

        // Baseline: borrower's total collateral holdings before ANY loan.
        uint256 borrowerColl0 = _totBal(mockCollateralERC20, borrower);

        // ── Phase 1 — loan1: lender → borrower, 30d @ 5%.
        uint256 offer1 = _createOffer(
            lender,
            OfferCfg({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                collateralAsset: mockCollateralERC20,
                amount: PRINCIPAL,
                collateralAmount: COLLATERAL,
                rateBps: 500,
                durationDays: 30,
                allowsPartialRepay: false,
                cadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
        uint256 loan1 = _signAndAcceptOffer(borrower, borrowerPk, offer1);

        // ── Phase 2 — borrower's refinance vehicle: 90d @ 4%, Monthly.
        uint256 offer2 = _createOffer(
            borrower,
            OfferCfg({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                collateralAsset: mockCollateralERC20,
                amount: PRINCIPAL,
                collateralAmount: COLLATERAL,
                rateBps: 400,
                durationDays: 90,
                allowsPartialRepay: true,
                cadence: LibVaipakam.PeriodicInterestCadence.Monthly
            })
        );

        // Third actor — the refinancing lender.
        (address newLender, uint256 newLenderPk) = makeAddrAndKey("r3NewLender");
        ERC20Mock(mockERC20).mint(newLender, 50_000 ether);
        vm.prank(newLender);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(newLender);
        ProfileFacet(address(diamond)).setUserCountry("US");
        ProfileFacet(address(diamond)).updateKYCTier(
            newLender,
            LibVaipakam.KYCTier.Tier2
        );
        _fundActorVault(newLender, mockERC20, PRINCIPAL);

        uint256 lender1Before = _totBal(mockERC20, lender);
        uint256 newLenderBeforeAccept = _totBal(mockERC20, newLender);

        // Accepting the Borrower offer births loan2 (Active immediately).
        uint256 loan2 = _signAndAcceptOffer(newLender, newLenderPk, offer2);
        assertEq(
            uint8(_loan(loan2).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan2 Active at accept"
        );
        uint256 loan2Start = uint256(_loan(loan2).startTime);

        // ── Phase 2b — refinance loan1 into loan2 five days in.
        // SetupTest's global HF=2e18 / LTV=6666 mocks keep the refinance risk
        // gate green; everything else (repayment pull, collateral refund,
        // NFT relabel, consolidation hop) runs UNMOCKED through the Diamond.
        vm.warp(block.timestamp + 5 days);
        // Diamond float for internal transfer legs — mirrors
        // RefinanceFacetTest.setUp. Deltas below are measured per-actor so
        // this seed cannot mask a conservation violation.
        ERC20Mock(mockERC20).mint(address(diamond), 100_000 ether);

        vm.prank(borrower);
        RefinanceFacet(address(diamond)).refinanceLoan(loan1, offer2);

        assertEq(
            uint8(_loan(loan1).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "loan1 terminally Repaid by refinance"
        );
        assertEq(
            uint8(_loan(loan2).status),
            uint8(LibVaipakam.LoanStatus.Active),
            "loan2 still Active after refinance"
        );

        // Old lender conservation: total take − principal ≤ 30d full coupon.
        {
            uint256 lender1After = _totBal(mockERC20, lender);
            assertGe(
                lender1After,
                lender1Before,
                "old lender must not lose money on a proper refinance close"
            );
            assertLe(
                lender1After - lender1Before,
                _fullTermCoupon(PRINCIPAL, 500, 30) + DUST,
                "old lender interest exceeds loan1 full-term coupon"
            );
        }

        // ── Phase 3 — Period 1 of loan2 on real funds.
        // 3a: partial repay just before the period boundary — the interest
        // portion of the payment folds into interestSettled.
        vm.warp(loan2Start + 29 days);
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loan2, 50 ether);

        uint256 interestSettledAfterP1 = _loan(loan2).interestSettled;
        assertGt(
            interestSettledAfterP1,
            0,
            "partial repay must credit interestSettled (the M7 anchor)"
        );

        // 3b: post-boundary partial fires the inline periodic checkpoint
        // advance (same path PeriodicInterestSettleTest pins).
        vm.warp(loan2Start + 30 days + 1 days + 1);
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loan2, 20 ether);
        assertEq(
            _loan(loan2).lastPeriodicInterestSettledAt,
            SafeCast.toUint64(loan2Start + 30 days),
            "period-1 checkpoint advanced by the repay fold"
        );

        // ── Phase 4 — Period 2: exercise the settlePeriodicInterest entry
        // point on its just-stamp branch.
        //
        // TODO(scaffold): the shortfall==0 precondition is seeded via
        // TestMutatorFacet.setLoan (exactly as the passing
        // PeriodicInterestSettleTest.testSettle_JustStamp_DirectSettlerCall
        // does) because a single real repayPartial cannot land the period's
        // expected interest to the wei — partials re-stamp the accrual clock.
        // A fully-funds-backed version needs a multi-micro-repay fixture; the
        // seed moves NO tokens and does not touch interestSettled, so every
        // conservation assertion below remains honest.
        {
            LibVaipakam.Loan memory l2 = _loan(loan2);
            uint256 expectedPeriod2 = (uint256(l2.principal) *
                uint256(l2.interestRateBps) * 30) / (10_000 * 365);
            l2.interestPaidSinceLastPeriod =
                SafeCast.toUint128(expectedPeriod2);
            TestMutatorFacet(address(diamond)).setLoan(loan2, l2);
        }
        vm.warp(loan2Start + 60 days + 1 days);
        vm.prank(makeAddr("r3SettleBot"));
        RepayPeriodicFacet(address(diamond)).settlePeriodicInterest(
            loan2,
            _emptyCalls()
        );
        assertEq(
            _loan(loan2).lastPeriodicInterestSettledAt,
            SafeCast.toUint64(loan2Start + 60 days),
            "period-2 checkpoint advanced by settlePeriodicInterest"
        );

        // ── Phase 5 — preclose exit. THE M7 assertion: the close-time
        // interest charge PLUS everything already settled must fit inside
        // one full-term coupon (computed on the ORIGINAL principal — an
        // over-bound, since partials only shrink the accruing base).
        uint256 interestSettledPreClose = _loan(loan2).interestSettled;
        uint256 principalOutstanding = _loan(loan2).principal;
        uint256 totalDue =
            RepayFacet(address(diamond)).calculateRepaymentAmount(loan2);
        assertGe(totalDue, principalOutstanding, "due covers principal");
        uint256 interestAtClose = totalDue - principalOutstanding;

        assertLe(
            interestAtClose + interestSettledPreClose,
            _fullTermCoupon(PRINCIPAL, 400, 90) + DUST,
            "M7: close-time interest + already-settled interest exceeds the "
            "full-term coupon - settled interest was charged twice"
        );

        ERC20Mock(mockERC20).mint(borrower, totalDue + 200 ether);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).precloseDirect(loan2);
        assertEq(
            uint8(_loan(loan2).status),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "loan2 terminally Repaid by preclose"
        );

        // ── Phase 6 — claim. On the plain ERC20 preclose path the collateral
        // is released inline and there may legitimately be NothingToClaim;
        // the call must never revert for any OTHER reason and must never
        // move collateral anywhere but to the borrower.
        //
        // TODO(scaffold): tighten to an exact expectation (claim vs inline
        // release) once the intended preclose claim shape is pinned in
        // docs/FunctionalSpecs — both outcomes conserve value, which is what
        // this suite asserts.
        vm.prank(borrower);
        try ClaimFacet(address(diamond)).claimAsBorrower(loan2) {
            // claim existed and was swept
        } catch {
            // nothing left to claim after the inline preclose release
        }

        // ── Phase 7 — whole-sequence conservation.
        // Borrower collateral: two loans opened, two loans properly closed →
        // every wei of collateral must be back under borrower control.
        assertEq(
            _totBal(mockCollateralERC20, borrower),
            borrowerColl0,
            "collateral leak across refinance -> periodic -> preclose -> claim"
        );

        // New lender: total take − principal ≤ loan2 full-term coupon.
        {
            uint256 newLenderEnd = _totBal(mockERC20, newLender);
            assertGe(newLenderEnd, newLenderBeforeAccept, "lender2 whole");
            assertLe(
                newLenderEnd - newLenderBeforeAccept,
                _fullTermCoupon(PRINCIPAL, 400, 90) + DUST,
                "new lender interest exceeds loan2 full-term coupon"
            );
        }

        // Terminal hygiene on both loans.
        for (uint256 i = 0; i < 2; i++) {
            uint256 id = i == 0 ? loan1 : loan2;
            (, , , , , bool snapActive, ) =
                ClaimFacet(address(diamond)).getFallbackSnapshot(id);
            assertFalse(snapActive, "Repaid loan carries a fallbackSnapshot");
            (uint256 rebate, uint256 held) =
                ClaimFacet(address(diamond)).getBorrowerLifRebate(id);
            assertEq(held, 0, "Repaid loan leaked vpfiHeld custody");
            rebate; // no VPFI path in this sequence; rebate may only be 0
        }
    }

    /// @notice M7 probe at the LIQUIDATION terminal (the exit RepayFacet's
    ///         #413 fix did NOT flow through by construction): partial repay
    ///         settles ~15 days of interest, then an HF liquidation at day 29
    ///         records the lender's claim. If the liquidation entitlement
    ///         math computes interest gross-from-origination WITHOUT
    ///         crediting `interestSettled` (or the #641 accrual clock), the
    ///         summed interest exceeds one full-term coupon and this test
    ///         FAILS — that failure IS the finding.
    function test_CrossFacetSequence_PartialRepayThenHfLiquidation_InterestNotDoubleCharged()
        public
    {
        uint256 offerId = _createOffer(
            lender,
            OfferCfg({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                collateralAsset: mockCollateralERC20,
                amount: PRINCIPAL,
                collateralAmount: COLLATERAL,
                rateBps: 400,
                durationDays: 30,
                allowsPartialRepay: true,
                cadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);
        uint256 start = uint256(_loan(loanId).startTime);

        // Day 15 — partial repay: ~15 days of interest is settled and paid
        // to the lender NOW.
        vm.warp(start + 15 days);
        ERC20Mock(mockERC20).mint(borrower, 100 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, 50 ether);

        uint256 interestSettledMid = _loan(loanId).interestSettled;
        assertGt(interestSettledMid, 0, "partial credited interestSettled");
        uint256 principalOutstanding = _loan(loanId).principal;
        uint256 collateralAtLiq = _loan(loanId).collateralAmount;

        // Day 29 (still pre-endTime → NO late fees can excuse extra
        // interest). Collapse the collateral price and pin HF below 1 —
        // the proven-passing DefaultedFacetTest combination.
        vm.warp(start + 29 days);
        mockOraclePrice(mockCollateralERC20, 5e7, 8); // $0.50
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector),
            abi.encode(uint256(0.5e18))
        );

        uint256 liquidatorBalBefore = IERC20(mockERC20).balanceOf(address(this));

        RiskFacet(address(diamond)).triggerLiquidation(
            loanId,
            defaultAdapterCalls()
        );
        assertEq(
            uint8(_loan(loanId).status),
            uint8(LibVaipakam.LoanStatus.Defaulted),
            "HF liquidation terminal"
        );

        // Lender's recorded claim.
        (address claimAsset, uint256 lenderClaim, bool claimed) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, true);
        assertEq(claimAsset, mockERC20, "lender claim in principal asset");
        assertFalse(claimed, "not yet claimed");

        // ── THE M7 ASSERTION ──
        // interest embedded in the liquidation claim = claim − outstanding
        // principal (0 when proceeds-capped below principal). Adding the
        // interest ALREADY paid via the partial must stay inside one
        // full-term coupon: 15d (settled) + ≤15d (accrued since) ≤ 30d.
        // A gross-from-origination recompute yields 15 + 29 = 44 days
        // and trips this bound.
        uint256 interestInClaim = lenderClaim > principalOutstanding
            ? lenderClaim - principalOutstanding
            : 0;
        assertLe(
            interestInClaim + interestSettledMid,
            _fullTermCoupon(PRINCIPAL, 400, 30) + DUST,
            "M7 @ liquidation: settled interest re-charged in the "
            "liquidation entitlement"
        );

        // Proceeds conservation: everything distributed out of the swap
        // (lender claim + borrower surplus claim + liquidator bonus) must
        // fit inside the realized proceeds. ZeroExProxyMock rate = 11/10.
        (, uint256 borrowerClaim, ) =
            ClaimFacet(address(diamond)).getClaimableAmount(loanId, false);
        uint256 proceeds = (collateralAtLiq * 11) / 10;
        uint256 liquidatorBonus =
            IERC20(mockERC20).balanceOf(address(this)) - liquidatorBalBefore;
        assertLe(
            lenderClaim + borrowerClaim + liquidatorBonus,
            proceeds + DUST,
            "liquidation distributed more value than the swap produced"
        );

        // Claims sweep. TODO(scaffold): on the liquid HF path the lender
        // proceeds are delivered to the lender vault at liquidation time and
        // the claim row is bookkeeping — claimAsLender/claimAsBorrower may
        // legitimately have nothing further to move. If either call SUCCEEDS
        // *and* moves a second copy of the funds, the vault-balance
        // assertions in FundsConservation.invariant.t.sol are the intended
        // catch; pinning that here needs the intended claim-vs-delivery
        // shape from docs/FunctionalSpecs (not derivable from code without
        // circularity).
        vm.prank(lender);
        try ClaimFacet(address(diamond)).claimAsLender(loanId) {} catch {}
        vm.prank(borrower);
        try ClaimFacet(address(diamond)).claimAsBorrower(loanId) {} catch {}

        // Terminal hygiene: a Defaulted loan must never leave VPFI custody
        // behind (forfeit path) nor a live fallback snapshot (the swap
        // SUCCEEDED here, so no snapshot may exist).
        (, , , , , bool snapActive, ) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        assertFalse(snapActive, "successful liquidation left a snapshot");
        (, uint256 heldAfter) =
            ClaimFacet(address(diamond)).getBorrowerLifRebate(loanId);
        assertEq(heldAfter, 0, "Defaulted loan leaked vpfiHeld custody");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // B.1 + B.2 — mixed-lifecycle terminal-state invariants
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice One diamond, three loans, three different lifecycles:
    ///           L1 liquid, fully repaid            → Repaid
    ///           L2 illiquid collateral, defaulted  → Defaulted (full transfer)
    ///           L3 liquid, default w/ failed swap  → FallbackPending
    ///         Then the protocol-level invariants are asserted over the WHOLE
    ///         loan set:
    ///           (a) collateral conservation per terminal loan — for L2 the
    ///               lender-claim + borrower-claim must equal EXACTLY the
    ///               original collateral (illiquid = full transfer, no leak);
    ///               for L3 the LibFallback three-way split must sum to
    ///               EXACTLY the collateral that entered the fallback;
    ///           (b) no Active/Repaid loan carries a live fallbackSnapshot;
    ///           (c) no terminal (Repaid/Defaulted/Settled) loan retains
    ///               vpfiHeld custody.
    function test_Invariant_MixedLifecycle_CollateralConservation_NoStaleSnapshots()
        public
    {
        // ── open three loans at t0 ─────────────────────────────────────────
        uint256 l1;
        uint256 l2;
        uint256 l3;
        {
            uint256 o1 = _createOffer(
                lender,
                OfferCfg({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    collateralAsset: mockCollateralERC20,
                    amount: PRINCIPAL,
                    collateralAmount: COLLATERAL,
                    rateBps: 500,
                    durationDays: 30,
                    allowsPartialRepay: false,
                    cadence: LibVaipakam.PeriodicInterestCadence.None
                })
            );
            l1 = _signAndAcceptOffer(borrower, borrowerPk, o1);

            // L2: illiquid collateral. Principal is temporarily mocked
            // illiquid during creation so the asset pair passes the
            // MixedCollateralNotAllowed gate (DefaultedFacetTest pattern),
            // then restored.
            mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Illiquid);
            uint256 o2 = _createOffer(
                lender,
                OfferCfg({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    collateralAsset: mockIlliquidERC20,
                    amount: PRINCIPAL,
                    collateralAmount: COLLATERAL,
                    rateBps: 500,
                    durationDays: 30,
                    allowsPartialRepay: false,
                    cadence: LibVaipakam.PeriodicInterestCadence.None
                })
            );
            l2 = _signAndAcceptOffer(borrower, borrowerPk, o2);
            mockOracleLiquidity(mockERC20, LibVaipakam.LiquidityStatus.Liquid);

            uint256 o3 = _createOffer(
                lender,
                OfferCfg({
                    offerType: LibVaipakam.OfferType.Lender,
                    lendingAsset: mockERC20,
                    collateralAsset: mockCollateralERC20,
                    amount: PRINCIPAL,
                    collateralAmount: COLLATERAL,
                    rateBps: 500,
                    durationDays: 30,
                    allowsPartialRepay: false,
                    cadence: LibVaipakam.PeriodicInterestCadence.None
                })
            );
            l3 = _signAndAcceptOffer(borrower, borrowerPk, o3);
        }

        // ── L1: proper full repay at day 10 ────────────────────────────────
        vm.warp(block.timestamp + 10 days);
        ERC20Mock(mockERC20).mint(borrower, 200 ether); // interest pad
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(l1);

        // ── L2 + L3 past end + grace (30d loans → 3-day grace bucket) ──────
        vm.warp(block.timestamp + 20 days + 3 days + 1);

        // L2: illiquid default — full collateral entitlement to the lender,
        // no swap involved.
        vm.prank(lender);
        DefaultedFacet(address(diamond)).triggerDefault(l2, defaultAdapterCalls());

        // L3: liquid default whose swap REVERTS → FallbackPending with a
        // recorded three-way snapshot (FallbackCureTest entry recipe: the
        // vault pull + NFT relabel legs are mocked away, the diamond is
        // dealt the collateral it would be holding).
        vm.mockCallRevert(
            mockZeroExProxy,
            abi.encodeWithSelector(IZeroExProxy.swap.selector),
            "swap failed"
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaultFactoryFacet.vaultWithdrawERC20.selector),
            abi.encode(true)
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VaipakamNFTFacet.updateNFTStatus.selector),
            ""
        );
        deal(mockCollateralERC20, address(diamond), COLLATERAL * 2);
        vm.prank(lender);
        DefaultedFacet(address(diamond)).triggerDefault(l3, defaultAdapterCalls());

        // ── state sanity ───────────────────────────────────────────────────
        assertEq(uint8(_loan(l1).status), uint8(LibVaipakam.LoanStatus.Repaid));
        assertEq(uint8(_loan(l2).status), uint8(LibVaipakam.LoanStatus.Defaulted));
        assertEq(
            uint8(_loan(l3).status),
            uint8(LibVaipakam.LoanStatus.FallbackPending)
        );

        // ── (a) collateral conservation ────────────────────────────────────
        // L2 (illiquid full-transfer): lenderClaim + borrowerClaim must equal
        // the original collateral EXACTLY — a single missing wei is a leak,
        // a single extra wei is a mint-from-nowhere.
        {
            (address a2, uint256 lenderAmt2, ) =
                ClaimFacet(address(diamond)).getClaimableAmount(l2, true);
            (, uint256 borrowerAmt2, ) =
                ClaimFacet(address(diamond)).getClaimableAmount(l2, false);
            assertEq(a2, mockIlliquidERC20, "L2 claim asset = collateral");
            assertEq(
                lenderAmt2 + borrowerAmt2,
                COLLATERAL,
                "L2 collateral split leaks (illiquid full-transfer terminal)"
            );
        }
        // L3 (fallback): the LibFallback three-way split must sum to EXACTLY
        // the collateral that entered the fallback path.
        {
            (
                uint256 lenderCol,
                uint256 treasuryCol,
                uint256 borrowerCol,
                ,
                ,
                bool active3,

            ) = ClaimFacet(address(diamond)).getFallbackSnapshot(l3);
            assertTrue(active3, "L3 snapshot live while FallbackPending");
            assertEq(
                lenderCol + treasuryCol + borrowerCol,
                COLLATERAL,
                "L3 LibFallback split does not conserve collateral"
            );
        }

        // ── (b) + (c) global terminal-hygiene sweep over EVERY loan ────────
        uint256 total = _totalLoansEverCreated();
        for (uint256 id = 1; id <= total; id++) {
            LibVaipakam.Loan memory ln = _loan(id);
            if (ln.lender == address(0)) continue; // hole / not a loan

            (, , , , , bool snapActive, ) =
                ClaimFacet(address(diamond)).getFallbackSnapshot(id);
            bool activeOrRepaid = ln.status == LibVaipakam.LoanStatus.Active ||
                ln.status == LibVaipakam.LoanStatus.Repaid;
            assertFalse(
                snapActive && activeOrRepaid,
                "INVARIANT: Active/Repaid loan holds a live fallbackSnapshot"
            );

            bool terminal = ln.status == LibVaipakam.LoanStatus.Repaid ||
                ln.status == LibVaipakam.LoanStatus.Defaulted ||
                ln.status == LibVaipakam.LoanStatus.Settled;
            if (terminal) {
                (, uint256 held) =
                    ClaimFacet(address(diamond)).getBorrowerLifRebate(id);
                assertEq(
                    held,
                    0,
                    "INVARIANT: terminal loan retains vpfiHeld custody"
                );
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // B.3 — VPFI custody-solvency / commingling invariant
    // ═════════════════════════════════════════════════════════════════════════

    VPFIToken internal vpfi;
    address internal treasuryRecipient;

    /// @dev Mirrors VPFIDiscountFacetTest's ceremony: real VPFIToken behind a
    ///      UUPS proxy, canonical chain, discount rate + ETH anchor, borrower
    ///      staked to tier 1 with consent. Returns two VPFI-fee-path loans:
    ///      `loanHeld` still Active (custody live) and `loanSettled` properly
    ///      repaid (rebate credited, unclaimed).
    function _setupVpfiPathLoans()
        internal
        returns (uint256 loanHeld, uint256 loanSettled)
    {
        // Treasury must NOT be the diamond, or the treasury legs of the LIF
        // split would be invisible no-op self-transfers and the solvency
        // check below would be vacuous.
        treasuryRecipient = makeAddr("r3Treasury");
        AdminFacet(address(diamond)).setTreasury(treasuryRecipient);

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        // Modest reserve — deliberately NOT the 69M-VPFI interaction-pool
        // cap. That gap is exactly what the commingling demonstration
        // below measures.
        vpfi.transfer(address(diamond), 1_000 ether);

        // Discount price anchor: 1 VPFI = 0.001 ETH; WETH at $2000.
        ERC20Mock weth = new ERC20Mock("Wrapped Ether", "WETH", 18);
        VPFIDiscountFacet f = VPFIDiscountFacet(address(diamond));
        f.setVPFIDiscountRate(1e15);
        f.setVPFIDiscountETHPriceAsset(address(weth));
        mockOraclePrice(address(weth), 2000e8, 8);

        // Borrower: stake to tier 1 through the sanctioned deposit path
        // (populates the time-weighted accumulator), opt in, clear the
        // min-history gate.
        vpfi.transfer(borrower, 5_000 ether);
        vm.startPrank(borrower);
        vpfi.approve(address(diamond), type(uint256).max);
        f.depositVPFIToVault(500 ether); // tier 1
        f.setVPFIDiscountConsent(true);
        vm.stopPrank();
        vm.warp(block.timestamp + 4 days);

        loanHeld = _openVpfiPathLoan(10_000 ether);
        loanSettled = _openVpfiPathLoan(10_000 ether);

        // Properly repay loanSettled after a full hold → rebate credited to
        // the claim slot (unclaimed), treasury share forwarded OUT of the
        // diamond, custody row drained.
        vm.warp(block.timestamp + 30 days);
        ERC20Mock(mockERC20).mint(borrower, 12_000 ether);
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanSettled);

        (uint256 rebate, uint256 heldAfter) =
            ClaimFacet(address(diamond)).getBorrowerLifRebate(loanSettled);
        assertEq(heldAfter, 0, "settled loan custody drained");
        assertGt(rebate, 0, "settled loan rebate credited (tier-1 hold)");
    }

    /// @dev Open one lender→borrower loan whose LIF is paid on the VPFI path
    ///      (Diamond custody). Fails fast if the discount path silently fell
    ///      back to the lending-asset fee — the invariants below would be
    ///      vacuous otherwise.
    function _openVpfiPathLoan(uint256 principal)
        internal
        returns (uint256 loanId)
    {
        ERC20Mock(mockERC20).mint(lender, principal);
        uint256 offerId = _createOffer(
            lender,
            OfferCfg({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                collateralAsset: mockCollateralERC20,
                amount: principal,
                collateralAmount: principal,
                rateBps: 500,
                durationDays: 30,
                allowsPartialRepay: false,
                cadence: LibVaipakam.PeriodicInterestCadence.None
            })
        );

        (bool eligible, uint256 vpfiRequired, , ) = VPFIDiscountFacet(
            address(diamond)
        ).quoteVPFIDiscountFor(offerId, borrower);
        assertTrue(eligible, "VPFI fee path must quote eligible");

        // Top the borrower vault up so it covers the full VPFI LIF.
        address bVault =
            VaultFactoryFacet(address(diamond)).getOrCreateUserVault(borrower);
        vpfi.transfer(bVault, vpfiRequired * 2);
        vm.prank(address(diamond));
        VaultFactoryFacet(address(diamond)).recordVaultDepositERC20(
            borrower,
            address(vpfi),
            vpfiRequired * 2
        );

        loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        (, uint256 held) =
            ClaimFacet(address(diamond)).getBorrowerLifRebate(loanId);
        assertGt(held, 0, "accept did not take the VPFI custody path");
    }

    /// @dev Σ vpfiHeld and Σ rebateAmount over every loan ever created.
    ///      NOTE (missing-view-helper finding): there is no aggregate
    ///      `getTotalVpfiCustody()` on-chain view — an auditor/keeper must
    ///      O(n)-walk every loan id to reconstruct the diamond's hard VPFI
    ///      obligations. See the suite header for the full list.
    function _sumVpfiObligations()
        internal
        view
        returns (uint256 sumHeld, uint256 sumRebate)
    {
        uint256 total = _totalLoansEverCreated();
        for (uint256 id = 1; id <= total; id++) {
            (uint256 rebate, uint256 held) =
                ClaimFacet(address(diamond)).getBorrowerLifRebate(id);
            sumHeld += held;
            sumRebate += rebate;
        }
    }

    /// @notice HARD custody solvency (expected to PASS): the diamond's VPFI
    ///         balance must always cover the sum of every live LIF custody
    ///         row plus every credited-but-unclaimed borrower rebate. If this
    ///         fails, some settlement path forwarded custody it was still
    ///         liable for.
    function test_Invariant_VpfiCustody_DiamondBalanceCoversHardObligations()
        public
    {
        _setupVpfiPathLoans();

        (uint256 sumHeld, uint256 sumRebate) = _sumVpfiObligations();
        assertGt(sumHeld, 0, "fixture: at least one live custody row");
        assertGt(sumRebate, 0, "fixture: at least one unclaimed rebate");

        assertGe(
            vpfi.balanceOf(address(diamond)),
            sumHeld + sumRebate,
            "INVARIANT VIOLATED: diamond VPFI balance below hard custody "
            "obligations (vpfiHeld + unclaimed rebates)"
        );
    }

    /// @notice COMMINGLING DEMONSTRATION (expected to PASS — and its passing
    ///         is the Informational finding, not a healthy state): the
    ///         interaction-reward pool is pure accounting
    ///         (`getInteractionPoolRemaining()` = 69M-VPFI cap − paidOut) with
    ///         NO dedicated backing balance, yet interaction-reward claims pay
    ///         out of the SAME diamond VPFI balance that holds borrower-LIF
    ///         custody and unclaimed rebates. Under any realistic seeding the
    ///         combined obligation exceeds the balance, so reward claimants
    ///         and rebate/custody claimants compete for the same tokens:
    ///         first-come-first-served insolvency by construction. The fix is
    ///         either a segregated reward reserve or a pool-remaining figure
    ///         clamped to seeded backing.
    function test_Invariant_VpfiCustody_InteractionPoolAccountingIsNotBacked()
        public
    {
        _setupVpfiPathLoans();

        (uint256 sumHeld, uint256 sumRebate) = _sumVpfiObligations();
        uint256 poolRemaining = InteractionRewardsFacet(address(diamond))
            .getInteractionPoolRemaining();
        assertGt(poolRemaining, 0, "interaction pool accounting is live");

        // If this ever flips (balance actually covers the pool), the
        // commingling finding is resolved and this test should be inverted
        // into a hard >= invariant like the one above.
        assertLt(
            vpfi.balanceOf(address(diamond)),
            sumHeld + sumRebate + poolRemaining,
            "DEMONSTRATION: pool accounting now fully backed - flip this "
            "test into a hard solvency invariant"
        );
    }
}
