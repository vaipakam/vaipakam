// test/audit/Round3LoanLifecyclePoC.t.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/*
 * ============================================================================
 *  AUTHORED IN A NO-FORGE ENVIRONMENT — NOT EXECUTED HERE.
 *
 *  Foundry is not installed in the authoring environment (egress policy
 *  blocks the toolchain), so these PoCs were written by mirroring the
 *  existing passing suites (SetupTest / RepayFacetTest /
 *  PeriodicInterestSettleTest) but have NOT been compiled or run. Run them on
 *  the team toolchain with:
 *
 *    nice -n -10 ionice -c 2 -n 0 \
 *      forge test --match-path test/audit/Round3LoanLifecyclePoC.t.sol -vvv
 *
 *  Each test asserts the CURRENT (buggy) behaviour and documents, in its
 *  natspec, what the CORRECT behaviour would be. A test that stays GREEN is
 *  reproducing the bug as described; a test that turns RED means the finding
 *  has been fixed (the assertion of buggy behaviour no longer holds) — read
 *  each test's `@dev EXPECTED` line for the exact red/green semantics.
 * ============================================================================
 */

import {SetupTest} from "../SetupTest.t.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {RepayPeriodicFacet} from "../../src/facets/RepayPeriodicFacet.sol";
import {VaultFactoryFacet} from "../../src/facets/VaultFactoryFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {NumeraireConfigFacet} from "../../src/facets/NumeraireConfigFacet.sol";
import {TestMutatorFacet} from "../mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// @title  Round3LoanLifecyclePoC
/// @notice PoC regression tests for four Round-3 loan-lifecycle findings:
///           H1 — autoDeductDaily collapses the ERC-4907 renter expiry.
///           H4 — useFullTermInterest is evadable via repayPartial.
///           M1 — repayPartial ignores interestSettled (periodic double-charge).
///           M7 — interestSettled is not netted on refinance / obligation-
///                transfer terminals (scaffold; see the test's TODO).
/// @dev    Inherits {SetupTest} (the full-diamond fixture used by
///         PeriodicInterestSettleTest / PeriodicInterestCadenceTest) so every
///         facet these PoCs touch — RepayFacet, RepayPeriodicFacet,
///         ConfigFacet, NumeraireConfigFacet, TestMutatorFacet — is routed.
contract Round3LoanLifecyclePoC is SetupTest {
    // Cadence shorthand (mirrors PeriodicInterestSettleTest).
    LibVaipakam.PeriodicInterestCadence constant MONTHLY =
        LibVaipakam.PeriodicInterestCadence.Monthly;
    LibVaipakam.PeriodicInterestCadence constant NONE_C =
        LibVaipakam.PeriodicInterestCadence.None;

    // Days-per-year constant used by the settlement interest math
    // (LibEntitlement.proRataInterest / fullTermInterest divide by
    // LibVaipakam.DAYS_PER_YEAR, which is 365).
    uint256 constant DAYS_PER_YEAR = 365;

    function setUp() public {
        setupHelper();
        // Allow multi-year terms so the long-dated H4 / M7 loans (365-day)
        // clear the offer-duration cap. Mirrors PeriodicInterestSettleTest.
        vm.prank(owner);
        ConfigFacet(address(diamond)).setMaxOfferDurationDays(3 * 365);
    }

    // ─── Offer/loan helpers ───────────────────────────────────────────────────

    /// @dev Build a lender-side ERC-20 offer with the full CreateOfferParams
    ///      shape (mirrors RepayFacetTest.helperOfferLoan exactly, field for
    ///      field). Lending asset = mockERC20, collateral = mockCollateralERC20
    ///      (both liquid + $1 in SetupTest).
    function _erc20Offer(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays,
        bool allowPartial,
        LibVaipakam.PeriodicInterestCadence cadence
    ) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: rateBps,
                collateralAsset: mockCollateralERC20,
                collateralAmount: principal * 5,
                durationDays: durationDays,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: allowPartial,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: principal,
                interestRateBpsMax: rateBps,
                collateralAmountMax: principal * 5,
                periodicInterestCadence: cadence,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    /// @dev Build a lender-side NFT-rental offer (mirrors
    ///      RepayFacetTest.helperOfferLoan's `offerId2` field for field):
    ///      lending asset = mockNft721 token #1, daily fee (`amount`) = 10,
    ///      duration 30 days, collateral + prepay in mockERC20.
    function _nftRentalOffer() internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockNft721,
                amount: 10, // daily rental fee → loan.principal
                interestRateBps: 500,
                collateralAsset: mockERC20,
                collateralAmount: 1500,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC721,
                tokenId: 1,
                quantity: 1,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: true,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: 10,
                interestRateBpsMax: 500,
                collateralAmountMax: 1500,
                periodicInterestCadence: NONE_C,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // H1 — RepayPeriodicFacet.autoDeductDaily collapses the ERC-4907 renter
    //      expiry to `startTime + remainingDays`, shrinking the renter's
    //      remaining term at ~2× real time and evicting them at the term
    //      midpoint even though prepaid rental days remain.
    //
    //      Root cause (RepayPeriodicFacet.autoDeductDaily):
    //          loan.durationDays -= 1;                         // decremented
    //          newExpires = startTime + durationDays * ONE_DAY;// <-- BUG
    //      `startTime` is fixed but `durationDays` shrinks by 1 per elapsed
    //      day, so after k days newExpires = T0 + (30-k)d while now = T0 + k d.
    //      The renter's usable window is (30 - 2k) days — it hits zero at
    //      k = 15 (the midpoint) and goes negative afterwards.
    //
    //      CORRECT behaviour: the renter prepaid a fixed 30-day term, so the
    //      ERC-4907 expiry should stay pinned at `startTime + 30 days` (the
    //      original term end) regardless of how many daily fees have been
    //      auto-deducted.
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev EXPECTED: GREEN while the bug is live (renter expiry lands in the
    ///      PAST before the 30-day term ends). Turns RED once autoDeductDaily
    ///      pins the expiry to the original term end.
    function test_H1_autoDeductDaily_collapsesRenterExpiryBeforeTermEnds() public {
        uint256 offerId = _nftRentalOffer();
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        uint256 startTs = uint256(loan.startTime);
        uint256 termEnd = startTs + 30 days; // the renter's prepaid term end

        // Renter expiry recorded at loan initiation (read from the lender's
        // vault ERC-4907 state). If the init path pins it, it should be at/after
        // the term end; we don't assert its exact initial value (init wiring is
        // out of H1's scope) — only the post-deduction collapse below.
        uint64 expiresAtInit = VaultFactoryFacet(address(diamond))
            .vaultGetNFTUserExpires(lender, mockNft721, 1);
        emit log_named_uint("renter expiry at init", expiresAtInit);

        // Drive the permissionless daily deduction one day at a time, past the
        // midpoint of the 30-day term (16 deductions → 16 days elapsed).
        uint256 deductions = 16;
        for (uint256 i = 1; i <= deductions; i++) {
            vm.warp(startTs + i * 1 days);
            RepayPeriodicFacet(address(diamond)).autoDeductDaily(loanId);
        }

        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        // The rental has NOT legitimately ended: 14 prepaid days remain.
        assertEq(loan.durationDays, 30 - deductions, "remaining term should be 14 days");
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Active), "loan still Active");

        uint64 expiresNow = VaultFactoryFacet(address(diamond))
            .vaultGetNFTUserExpires(lender, mockNft721, 1);

        // BUG: newExpires = startTime + (30-16) days = T0 + 14 days, while
        // block.timestamp = T0 + 16 days. The renter is already expired even
        // though 14 prepaid rental days remain.
        assertLt(
            uint256(expiresNow),
            block.timestamp,
            "H1: renter expiry collapsed into the PAST mid-term (premature eviction)"
        );
        assertLt(
            uint256(expiresNow),
            termEnd,
            "H1: renter expiry is earlier than the prepaid 30-day term end"
        );

        // CORRECT behaviour would keep the renter alive to `termEnd`:
        //   assertGe(uint256(expiresNow), termEnd);
        // (left as a comment — it is the RED/fixed-state expectation).
    }

    // ─────────────────────────────────────────────────────────────────────────
    // H4 — `useFullTermInterest` (the lender's guarantee of the FULL-term
    //      coupon on early repayment) is evadable via repayPartial. A borrower
    //      repays the entire principal via repayPartial — which charges only
    //      pro-rata interest to date (LibEntitlement.accruedInterestToTime uses
    //      proRataInterest, ignoring the flag) — driving principal to 0. The
    //      subsequent repayLoan then computes interest on 0 principal (~0), so
    //      the lender collects only the few-days pro-rata interest instead of
    //      the full-term coupon they were promised.
    // ─────────────────────────────────────────────────────────────────────────

    uint256 constant H4_PRINCIPAL = 1000 ether;
    uint256 constant H4_RATE_BPS = 1200; // 12% APR
    uint256 constant H4_DURATION = 365; // days

    /// @dev EXPECTED: GREEN while the bug is live (lender receives << full-term
    ///      coupon). Turns RED once repayPartial honours the full-term floor
    ///      for useFullTermInterest loans.
    function test_H4_useFullTermInterest_evadedByRepayPartial() public {
        uint256 offerId = _erc20Offer(
            H4_PRINCIPAL,
            H4_RATE_BPS,
            H4_DURATION,
            /* partial */ true,
            NONE_C
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Turn on the lender's full-term-interest guarantee. Mirrors
        // RepayFacetTest.testRepayLoanFullTermInterestERC20: flip the loan flag
        // via the mutator (the create path defaults it false).
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.useFullTermInterest = true;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        // The full-term coupon the lender is entitled to (LibEntitlement.
        // fullTermInterest): principal * rate * duration / (365 * 10000).
        uint256 fullTermCoupon =
            (H4_PRINCIPAL * H4_RATE_BPS * H4_DURATION) / (DAYS_PER_YEAR * 10000);
        // ≈ 120 ether. The lender's share is 99% of that (1% treasury cut).

        // Move ~10 days into the 365-day term, then repay the WHOLE principal
        // as a "partial". Interest is paid DIRECTLY to the lender's wallet
        // (lenderRecipient = ownerOf(lenderTokenId) = lender).
        vm.warp(block.timestamp + 10 days);
        uint256 lenderBefore = ERC20Mock(mockERC20).balanceOf(lender);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, H4_PRINCIPAL);

        uint256 lenderAfterPartial = ERC20Mock(mockERC20).balanceOf(lender);
        // The partial returned principal + pro-rata-interest-to-date to the
        // lender's wallet. The interest slice is everything above the principal.
        uint256 interestFromPartial =
            (lenderAfterPartial - lenderBefore) - H4_PRINCIPAL;

        // Close the now-zero-principal loan; interest on 0 principal is ~0.
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.principal, 0, "principal fully repaid via repayPartial");
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(uint8(loan.status), uint8(LibVaipakam.LoanStatus.Repaid), "loan closed");

        emit log_named_uint("full-term coupon owed", fullTermCoupon);
        emit log_named_uint("interest lender actually received", interestFromPartial);

        // BUG: the lender received only the ~10-day pro-rata interest — less
        // than one tenth of the full-term coupon they were guaranteed.
        assertLt(
            interestFromPartial * 10,
            fullTermCoupon,
            "H4: lender received <10% of the full-term coupon (useFullTermInterest evaded)"
        );

        // CORRECT behaviour: interestFromPartial ~= 99% of `fullTermCoupon`.
        //   assertApproxEqRel(interestFromPartial, fullTermCoupon * 99 / 100, 0.02e18);
        // (left as a comment — it is the RED/fixed-state expectation.)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // M1 — repayPartial ignores `loan.interestSettled`. On a periodic-cadence
    //      loan, a periodic auto-liquidation (RepayPeriodicFacet.
    //      _autoLiquidatePeriodShortfall) forwards a period's interest to the
    //      lender and credits `loan.interestSettled += lenderProceeds` WITHOUT
    //      resetting the accrual clock. A later repayPartial then charges the
    //      borrower `accruedInterestToTime` GROSS (it never subtracts
    //      interestSettled — only the full-repay / preclose paths net via
    //      settlementInterestNet), so the already-settled period is charged a
    //      second time and paid to the lender again.
    //
    //      NOTE / SCAFFOLD: faithfully DRIVING the periodic auto-liquidation
    //      requires a working DEX swap try-list (LibSwap.AdapterCall[]) — the
    //      exact 4-DEX failover mock infrastructure that
    //      PeriodicInterestSettleTest defers to a dedicated suite. To keep this
    //      PoC self-contained we SIMULATE the completed auto-liquidation by
    //      seeding `loan.interestSettled` directly via the mutator (this is the
    //      same field `_autoLiquidatePeriodShortfall` writes). The bug being
    //      demonstrated — repayPartial charging gross accrued interest with no
    //      interestSettled credit — is unchanged by how interestSettled got its
    //      value.
    //      TODO(team): replace the mutator seed with an end-to-end trigger —
    //      warp past a period boundary+grace and call
    //      settlePeriodicInterest(loanId, adapterCalls) with a funded swap
    //      try-list so interestSettled is written by production code.
    // ─────────────────────────────────────────────────────────────────────────

    uint256 constant M1_PRINCIPAL = 1000 ether;
    uint256 constant M1_RATE_BPS = 1200; // 12% APR

    /// @dev EXPECTED: GREEN while the bug is live (repayPartial pays the lender
    ///      fresh pro-rata interest even though interestSettled already covered
    ///      it, and leaves interestSettled un-consumed). Turns RED once
    ///      repayPartial credits interestSettled against the accrued charge.
    function test_M1_repayPartial_ignoresInterestSettled_doubleCharge() public {
        // A periodic (Monthly) loan mirrors PeriodicInterestSettleTest's
        // fixture: feature enabled, duration cap bumped, principal priced above
        // the finer-cadence threshold ($1M), allowsPartialRepay = true.
        vm.prank(owner);
        NumeraireConfigFacet(address(diamond)).setPeriodicInterestEnabled(true);
        mockOraclePrice(mockERC20, 1_000 * 1e8, 8);
        mockOraclePrice(mockCollateralERC20, 1_000 * 1e8, 8);

        uint256 offerId = _erc20Offer(
            M1_PRINCIPAL,
            M1_RATE_BPS,
            /* duration */ 90,
            /* partial */ true,
            MONTHLY
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Simulate a COMPLETED periodic auto-liquidation that already forwarded
        // a large amount of interest to the lender. Seed interestSettled far
        // above any pro-rata interest a 10-day partial could accrue, so the
        // CORRECT additional charge at repayPartial is exactly ZERO.
        uint256 seededSettled = 500 ether;
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.interestSettled = seededSettled;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        // 10 days into the first period, well before the 30-day boundary.
        vm.warp(block.timestamp + 10 days);

        // Gross pro-rata interest a 10-day partial accrues on the full
        // principal (LibEntitlement.proRataInterest); the lender keeps 99%.
        uint256 grossProRata10d =
            (M1_PRINCIPAL * M1_RATE_BPS * 10) / (DAYS_PER_YEAR * 10000);

        uint256 partialAmount = 50 ether; // > minPartial (1% of principal)
        uint256 lenderBefore = ERC20Mock(mockERC20).balanceOf(lender);

        vm.prank(borrower);
        RepayFacet(address(diamond)).repayPartial(loanId, partialAmount);

        uint256 lenderAfter = ERC20Mock(mockERC20).balanceOf(lender);
        uint256 interestPaidToLender = (lenderAfter - lenderBefore) - partialAmount;

        emit log_named_uint("seeded interestSettled", seededSettled);
        emit log_named_uint("gross 10d pro-rata interest", grossProRata10d);
        emit log_named_uint("interest paid to lender by repayPartial", interestPaidToLender);

        // BUG (double-charge): repayPartial paid the lender fresh pro-rata
        // interest even though `interestSettled` (500e18) already exceeds it —
        // the correct additional charge is 0.
        assertGt(
            interestPaidToLender,
            0,
            "M1: repayPartial charged fresh interest despite interestSettled covering it"
        );
        // And it charged (nearly) the FULL gross pro-rata — i.e. no
        // interestSettled credit was applied (99% of gross, allow 10% slack).
        assertGe(
            interestPaidToLender,
            (grossProRata10d * 90) / 100,
            "M1: interest charged is the full pro-rata, un-netted by interestSettled"
        );

        // repayPartial did not consume/credit interestSettled either — it is
        // left untouched, confirming the accrued charge overlapped it.
        loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(
            loan.interestSettled,
            seededSettled,
            "M1: interestSettled unchanged — repayPartial ignored it entirely"
        );

        // CORRECT behaviour: interestPaidToLender == 0 here (the period was
        // already settled), i.e.
        //   assertEq(interestPaidToLender, 0);
        // (left as a comment — it is the RED/fixed-state expectation.)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // M7 — `interestSettled` is not netted on the refinance / obligation-
    //      transfer terminals. The borrower-facing repay + preclose paths
    //      (LibSettlement.computeRepayment / computePreclose) DO subtract
    //      `interestSettled` via LibEntitlement.settlementInterestNet, so
    //      interest paid via partial-repay / periodic-settle is credited
    //      exactly once. The finding is that the OTHER terminals that pay off
    //      the outgoing lender — RefinanceFacet.refinanceLoan and
    //      PrecloseFacet.transferObligationViaOffer (preclose "Option 2") —
    //      compute that payoff WITHOUT this netting, so the incoming lender /
    //      borrower re-pays interest the outgoing lender was already paid.
    //
    //      SCAFFOLD: a faithful red PoC needs a full multi-party set-up (a new
    //      lender funding a borrower offer, warping, then calling
    //      refinanceLoan / transferObligationViaOffer) that this authoring
    //      environment can't validate for compile-correctness without a
    //      reference test to mirror. This test instead PINS THE INTENDED
    //      INVARIANT on a surface that IS reproducible here — the repay-side
    //      view `calculateRepaymentAmount`, which correctly nets
    //      interestSettled — and leaves a TODO to wire the refinance terminal
    //      that violates it.
    // ─────────────────────────────────────────────────────────────────────────

    uint256 constant M7_PRINCIPAL = 1000 ether;
    uint256 constant M7_RATE_BPS = 1200;
    uint256 constant M7_DURATION = 365;

    /// @dev EXPECTED: GREEN — documents the netting invariant that the repay /
    ///      preclose paths satisfy (`calculateRepaymentAmount` drops by exactly
    ///      the seeded interestSettled). The RED half — proving the refinance /
    ///      obligation-transfer terminals DON'T net — is the TODO below.
    function test_M7_interestSettledNettingInvariant_repayPathControl() public {
        uint256 offerId = _erc20Offer(
            M7_PRINCIPAL,
            M7_RATE_BPS,
            M7_DURATION,
            /* partial */ true,
            NONE_C
        );
        uint256 loanId = _signAndAcceptOffer(borrower, borrowerPk, offerId);

        // Accrue meaningful gross interest so the seeded settle amount stays
        // below the gross (netting reduces, does not saturate to 0).
        vm.warp(block.timestamp + 200 days);

        // Baseline repay quote with interestSettled == 0.
        uint256 dueBefore = RepayFacet(address(diamond)).calculateRepaymentAmount(loanId);

        // Seed interestSettled to represent interest already paid to the
        // outgoing lender (e.g. via periodic settlement). 50 ether < the
        // ~65.75 ether gross accrued at 200 days, so it nets rather than
        // saturating.
        uint256 seededSettled = 50 ether;
        LibVaipakam.Loan memory loan = LoanFacet(address(diamond)).getLoanDetails(loanId);
        loan.interestSettled = seededSettled;
        TestMutatorFacet(address(diamond)).setLoan(loanId, loan);

        uint256 dueAfter = RepayFacet(address(diamond)).calculateRepaymentAmount(loanId);

        emit log_named_uint("repay quote (settled=0)", dueBefore);
        emit log_named_uint("repay quote (settled=50e18)", dueAfter);

        // INVARIANT (repay/preclose surface): the borrower's obligation drops
        // by exactly the already-settled interest — interest is charged once.
        assertLt(dueAfter, dueBefore, "M7 control: repay path nets interestSettled");
        assertEq(
            dueBefore - dueAfter,
            seededSettled,
            "M7 control: repay quote reduced by exactly interestSettled"
        );

        // TODO(team) — turn this into the RED double-charge PoC on the M7 site:
        //   1. Create a borrower offer funded by a NEW lender (mirror the
        //      RefinanceFacetTest set-up: fund newLender's vault, borrower
        //      posts an offer with refinanceTargetLoanId = loanId).
        //   2. Call RefinanceFacet.refinanceLoan(loanId, borrowerOfferId)  OR
        //      PrecloseFacet.transferObligationViaOffer(loanId, borrowerOfferId).
        //   3. Assert the OUTGOING lender's payoff (or the incoming
        //      obligation) charges gross interest WITHOUT subtracting
        //      `loan.interestSettled` — i.e. the borrower re-pays the
        //      already-settled `seededSettled` a second time. That assertion
        //      is GREEN (bug live) until the refinance/transfer terminals route
        //      through settlementInterestNet like computeRepayment does.
    }
}
