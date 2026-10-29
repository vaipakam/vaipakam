// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../../test/helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {OfferCancelFacet} from "../../src/facets/OfferCancelFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {PrecloseFacet} from "../../src/facets/PrecloseFacet.sol";
import {OfferMatchFacet} from "../../src/facets/OfferMatchFacet.sol";
import {LibOfferMatch} from "../../src/libraries/LibOfferMatch.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {OracleFacet} from "../../src/facets/OracleFacet.sol";
import {RiskFacet} from "../../src/facets/RiskFacet.sol";
import {EarlyWithdrawalFacet} from "../../src/facets/EarlyWithdrawalFacet.sol";
import {EarlyWithdrawalDirectFacet} from "../../src/facets/EarlyWithdrawalDirectFacet.sol";
import {LibSaleSolvency} from "../../src/libraries/LibSaleSolvency.sol";
import {Vm} from "forge-std/Vm.sol";
import {AutoLifecycleFacet} from "../../src/facets/AutoLifecycleFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {LibAutoRefinanceCheck} from "../../src/libraries/LibAutoRefinanceCheck.sol";
import {LibOfferMatchExecute} from "../../src/libraries/LibOfferMatchExecute.sol";

/**
 * @title PositiveFlowsAdvancedCredit
 * @notice Advanced credit flows (#848 Phase 1): lender opt-in partial repay,
 *         range orders with a third-party match and partial fills,
 *         borrower preclose by obligation handover and by offset, the lender
 *         exits (direct sale into a buy offer, the sale solvency floor on that
 *         route, and the same floor on the listing-accept route), and the
 *         atomic accept-and-refinance of a tagged borrower offer, and the
 *         matcher completing a refinance inside the borrower's caps (#848
 *         Phase 2).
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsAdvancedCredit is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsAdvancedCredit";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](9);
        list[0] = Scenario("PF-114", "Partial repay on a lender-opted-in loan, then full close",
            "PF-114");
        list[1] = Scenario("PF-053", "Ranged lender offer matched by a third party, partial fill, then dust close",
            "PF-053, PF-055, PF-056, PF-057");
        list[2] = Scenario("PF-211", "Preclose option 2: obligation handed to a replacement borrower",
            "PF-211");
        list[3] = Scenario("PF-212", "Preclose option 3: offset with a new offer, completed by a third party",
            "PF-212");
        list[4] = Scenario("PF-230", "Lender sells the loan into a standing buy offer; buyer is paid at repay",
            "PF-230");
        list[5] = Scenario("PF-230-floor", "Direct sale refused under the solvency floor, then settles once the price recovers",
            "PF-230");
        list[6] = Scenario("PF-231", "Listing accept refused under the solvency floor, then settles once the price recovers",
            "PF-231");
        list[7] = Scenario("PF-098", "A new lender accepts a refinance-tagged borrower offer; the old loan closes in the same transaction",
            "PF-098, PF-213, PF-112");
        list[8] = Scenario("PF-215", "A matcher completes a refinance inside the borrower's caps, once the admin switch is on",
            "PF-215, PF-098, PF-057");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _partialRepay();
        else if (index == 1) _rangeMatchAndPartialFill();
        else if (index == 2) _precloseOption2TransferObligation();
        else if (index == 3) _precloseOption3Offset();
        else if (index == 4) _sellLoanViaBuyOffer();
        else if (index == 5) _saleSolvencyFloor();
        else if (index == 6) _saleAdmissionOnAcceptBranch();
        else if (index == 7) _acceptAndRefinance();
        else if (index == 8) _matchedRefinanceWithinCaps();
        else revert("PositiveFlowsAdvancedCredit: no scenario at index");
    }

    // ─── PF-114: Partial Repay ────────────────────────────────────────────────

    /// @dev Lender opts into partial repay via `allowsPartialRepay = true`;
    ///      borrower accepts → loan active; borrower partial-repays
    ///      30% mid-loan → loan.principal halves; borrower full-closes
    ///      via repayLoan. Verifies the lender-controlled gate works
    ///      end-to-end on chain.
    function _partialRepay() internal {
        // Lender posts an offer with partial-repay opt-in ON.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferAllowsPartial());
        vm.stopBroadcast();
        console.log("Lender offer with allowsPartialRepay=true:", offerId);

        // Borrower accepts.
        LibAcceptTerms.AcceptTerms memory _t1 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig1 = LibAcceptTestSigner.sign(diamond, _t1, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t1, _sig1);
        vm.stopBroadcast();
        console.log("Loan initiated:", loanId);

        // Snapshot principal pre-partial.
        LibVaipakam.Loan memory loanBefore = LoanFacet(diamond).getLoanDetails(loanId);
        require(loanBefore.principal == LOAN_AMOUNT, "PF-114: pre-principal mismatch");
        require(loanBefore.allowsPartialRepay, "PF-114: opt-in not flagged on loan");

        // Borrower partial-repays 30% of principal. Allowance covers
        // partial principal + accrued interest (negligible at t≈0).
        uint256 partialAmt = (LOAN_AMOUNT * 30) / 100;
        vm.startBroadcast(borrowerKey);
        usdc.approve(diamond, partialAmt + 100e6); // headroom for accrued
        RepayFacet(diamond).repayPartial(loanId, partialAmt);
        vm.stopBroadcast();
        console.log("Partial repaid:", partialAmt);

        // Verify principal reduced.
        LibVaipakam.Loan memory loanMid = LoanFacet(diamond).getLoanDetails(loanId);
        require(loanMid.principal == LOAN_AMOUNT - partialAmt, "PF-114: principal not reduced");
        require(
            loanMid.status == LibVaipakam.LoanStatus.Active,
            "PF-114: should still be Active after partial"
        );
        console.log("Mid-loan principal:", loanMid.principal);

        // Borrower closes the rest.
        uint256 closeAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        vm.startBroadcast(borrowerKey);
        usdc.approve(diamond, closeAmt);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();

        _claimBoth(lenderKey, borrowerKey, loanId);
    }

    // ─── PF-098: Atomic accept-and-refinance ────────────────────────────────

    /// @dev The borrower sets refinance caps on the open loan and posts a
    ///      borrower offer tagged with that loan, at a rate inside the caps.
    ///      When a new lender accepts it, the accept itself repays the old
    ///      loan: one transaction leaves the old loan Repaid and the new one
    ///      Active. The tagged offer reuses the old loan's collateral (the
    ///      carry-over), so the borrower's WETH stays locked once, not twice.
    ///      The new lender's net principal pays the old lender inside the
    ///      Diamond (#3042), so the borrower approves only the difference:
    ///      here the old loan's interest, its treasury fee and the new loan's
    ///      initiation fee, a few USDC. The approval below is a twentieth of
    ///      the principal, so a payoff still routed through the wallet could
    ///      not complete.
    function _acceptAndRefinance() internal {
        uint256 offerId = _createLenderOffer(lenderKey);
        uint256 oldLoanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Old loan initiated:", oldLoanId);

        uint256 newRate = 400;
        LibVaipakam.CreateOfferParams memory request = _borrowerOfferStandard();
        request.interestRateBps = newRate;
        request.interestRateBpsMax = newRate;
        request.fillMode = LibVaipakam.FillMode.Aon; // a refinance request is all-or-nothing
        request.refinanceTargetLoanId = oldLoanId;

        vm.startBroadcast(borrowerKey);
        AutoLifecycleFacet(diamond).setAutoRefinanceCaps(
            oldLoanId, true, 600, uint64(block.timestamp + 365 days)
        );
        uint256 requestId = OfferCreateFacet(diamond).createOffer(request);
        usdc.approve(diamond, LOAN_AMOUNT / 20); // the difference only (#3042)
        vm.stopBroadcast();
        require(
            OfferCancelFacet(diamond).getOfferDetails(requestId).refinanceCarryOver,
            "PF-098: the tagged request should carry the old collateral over"
        );
        console.log("Refinance request posted:", requestId);

        uint256 lockedBefore = MetricsFacet(diamond).getEncumbered(borrower, address(weth), 0);
        uint256 newLoanId = _acceptAs(newLenderKey, requestId, address(usdc), LOAN_AMOUNT);
        console.log("New loan from the accept:", newLoanId);

        require(
            LoanFacet(diamond).getLoanDetails(oldLoanId).status == LibVaipakam.LoanStatus.Repaid,
            "PF-098: the old loan should be Repaid by the same accept"
        );
        LibVaipakam.Loan memory newLoan = LoanFacet(diamond).getLoanDetails(newLoanId);
        require(newLoan.status == LibVaipakam.LoanStatus.Active, "PF-098: the new loan should be Active");
        require(newLoan.lender == newLender, "PF-098: the accepting lender funds the new loan");
        require(newLoan.borrower == borrower, "PF-098: the borrower keeps the position");
        require(newLoan.principal == LOAN_AMOUNT, "PF-098: the new loan carries the requested principal");
        require(newLoan.interestRateBps == newRate, "PF-098: the new loan runs at the requested rate");
        require(newLoan.collateralAmount == COLLATERAL_AMOUNT, "PF-098: the new loan holds the old collateral");
        require(
            MetricsFacet(diamond).getEncumbered(borrower, address(weth), 0) == lockedBefore,
            "PF-098: the collateral should stay locked once (carried over, not pledged again)"
        );

        // The old lender is paid out of the accept; the new loan closes
        // normally.
        vm.startBroadcast(lenderKey);
        ClaimFacet(diamond).claimAsLender(oldLoanId);
        vm.stopBroadcast();
        _repayInFull(borrowerKey, newLoanId);
        _claimBoth(newLenderKey, borrowerKey, newLoanId);
    }

    // ─── PF-215: Matched refinance within caps ─────────────────────────────

    /// @dev The automated refinance route: the borrower pre-approves caps and
    ///      posts a refinance-tagged request, and a third-party matcher (a
    ///      keeper bot) pairs it with a standing lender offer. The matcher's
    ///      fill repays the old loan in the same transaction. Shows the three
    ///      gates on that route:
    ///        1. A request priced above the caps is refused at creation.
    ///        2. With the admin auto-refinance switch off, the matcher is
    ///           refused (a lender's direct accept, PF-098, is not gated).
    ///        3. With it on, the fill opens the replacement loan inside the
    ///           caps, carries the collateral over, and pays the matcher its
    ///           share of the initiation fee.
    ///      The switch is put back as the scenario found it.
    function _matchedRefinanceWithinCaps() internal {
        bool partialFill = ConfigFacet(diamond).getPartialFillEnabled();
        if (!partialFill) return _skip("partial fills are off (partialFillEnabled=false), so offers cannot be matched");

        uint256 oldLoanId = _acceptAs(borrowerKey, _createLenderOffer(lenderKey), address(weth), COLLATERAL_AMOUNT);
        console.log("Old loan initiated:", oldLoanId);

        uint16 capRateBps = 600;
        vm.startBroadcast(borrowerKey);
        AutoLifecycleFacet(diamond).setAutoRefinanceCaps(oldLoanId, true, capRateBps, uint64(block.timestamp + 365 days));
        vm.stopBroadcast();

        // Gate 1: a request whose rate ceiling is above the cap.
        LibVaipakam.CreateOfferParams memory request = _borrowerOfferStandard();
        request.interestRateBps = 400;
        request.interestRateBpsMax = capRateBps + 100;
        request.fillMode = LibVaipakam.FillMode.Aon;
        request.refinanceTargetLoanId = oldLoanId;
        _requireRefused(
            borrower,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, request),
            abi.encodeWithSelector(LibAutoRefinanceCheck.RefinanceRateExceedsCap.selector),
            "PF-215: a request priced above the caps should be refused (RefinanceRateExceedsCap)"
        );

        request.interestRateBpsMax = capRateBps;
        vm.startBroadcast(borrowerKey);
        uint256 requestId = OfferCreateFacet(diamond).createOffer(request);
        usdc.approve(diamond, LOAN_AMOUNT / 20); // the difference only: the new principal nets the payoff (#3042)
        vm.stopBroadcast();
        uint256 lenderOfferId = _createLenderOffer(newLenderKey);
        console.log("Refinance request / standing lender offer:", requestId, lenderOfferId);

        // Gate 2: the matcher is refused while the switch is off.
        bool switchWasOn = AdminFacet(diamond).getAutoRefinanceEnabled();
        if (switchWasOn) _setAutoRefinance(false);
        _requireRefused(
            newBorrower,
            abi.encodeWithSelector(OfferMatchFacet.matchOffers.selector, lenderOfferId, requestId),
            abi.encodeWithSelector(LibOfferMatchExecute.RefinanceTaggedOfferNotMatchable.selector),
            "PF-215: with the switch off the matcher should be refused (RefinanceTaggedOfferNotMatchable)"
        );
        console.log("Matcher refused while auto-refinance is off");

        // Gate 3: switch on, the matcher's fill completes the refinance.
        _setAutoRefinance(true);
        address matcher = newBorrower;
        uint256 lockedBefore = MetricsFacet(diamond).getEncumbered(borrower, address(weth), 0);
        uint256 matcherBefore = usdc.balanceOf(matcher);
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 payoff = RepayFacet(diamond).calculateRepaymentAmount(oldLoanId);
        vm.startBroadcast(newBorrowerKey);
        uint256 newLoanId = OfferMatchFacet(diamond).matchOffers(lenderOfferId, requestId);
        vm.stopBroadcast();
        if (!switchWasOn) _setAutoRefinance(false);
        console.log("New loan from the matcher's fill:", newLoanId);

        require(
            LoanFacet(diamond).getLoanDetails(oldLoanId).status == LibVaipakam.LoanStatus.Repaid,
            "PF-215: the old loan should be Repaid by the matcher's fill"
        );
        LibVaipakam.Loan memory newLoan = LoanFacet(diamond).getLoanDetails(newLoanId);
        require(newLoan.status == LibVaipakam.LoanStatus.Active, "PF-215: the new loan should be Active");
        require(newLoan.lender == newLender && newLoan.borrower == borrower,
            "PF-215: the standing lender funds the new loan and the borrower keeps the position");
        require(newLoan.matcher == matcher, "PF-215: the matcher should be recorded on the new loan");
        require(newLoan.principal == LOAN_AMOUNT, "PF-215: the new loan carries the old principal");
        require(
            newLoan.interestRateBps >= request.interestRateBps && newLoan.interestRateBps <= capRateBps,
            "PF-215: the new rate should sit inside the borrower's caps"
        );
        require(newLoan.collateralAmount == COLLATERAL_AMOUNT, "PF-215: the new loan holds the old collateral");
        require(
            MetricsFacet(diamond).getEncumbered(borrower, address(weth), 0) == lockedBefore,
            "PF-215: the collateral should stay locked once (carried over, not pledged again)"
        );
        // The borrower's wallet nets the new principal (less the initiation
        // fee) against the old loan's payoff; the fee, less the matcher's
        // share, is what PF-057 measures.
        uint256 borrowerAfter = usdc.balanceOf(borrower);
        uint256 netIn = borrowerAfter + payoff - borrowerBefore;
        _requireMatcherShare(LOAN_AMOUNT, netIn, usdc.balanceOf(matcher) - matcherBefore);

        vm.startBroadcast(lenderKey);
        ClaimFacet(diamond).claimAsLender(oldLoanId);
        vm.stopBroadcast();
        _repayInFull(borrowerKey, newLoanId);
        _claimBoth(newLenderKey, borrowerKey, newLoanId);
    }

    function _setAutoRefinance(bool enabled) internal {
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).setAutoRefinanceEnabled(enabled);
        vm.stopBroadcast();
        require(AdminFacet(diamond).getAutoRefinanceEnabled() == enabled, "the auto-refinance switch should land");
    }

    // ─── PF-053: Range Orders Match + Partial Fill ───────────────────────────

    /// @dev Range Orders Phase 1 — bot-driven matching against a
    ///      RANGED lender offer. Two phases:
    ///        Phase A: Lender posts a ranged offer
    ///                 amount=[2k, 5k], rate=[400, 600] bps, with
    ///                 enough collateral floor to support the worst-
    ///                 case (5k) — `previewMatch` does the synthetic
    ///                 HF check using `LibRiskMath`.
    ///        Phase B: Borrower #1 posts a single-point matchable offer
    ///                 (2.5k @ 500 bps); a third-party "matcher"
    ///                 (newBorrower in this script) calls
    ///                 `matchOffers(L, b1)`. Loan opens, lender's
    ///                 `amountFilled` = 2.5k (50% filled), 1% LIF
    ///                 kickback to matcher.
    ///        Phase C: Borrower #2 posts another offer (2k @ 500
    ///                 bps). Matcher calls `matchOffers(L, b2)`.
    ///                 Lender's remaining capacity drops below
    ///                 `amountMin` (2k) → dust auto-close, residual
    ///                 refund.
    ///
    ///      Verifies: ranged offers match with `partialFillEnabled` on;
    ///      midpoint computation; each child loan's terms; the matcher's
    ///      exact kickback; dust close.
    function _rangeMatchAndPartialFill() internal {
        // Pre-flight: matching needs `partialFillEnabled` (LibOfferMatch
        // refuses a match with FunctionDisabled while it is off). Skip,
        // saying so, where it is off. Ranged offers need no flag (always
        // on; the range master flags were retired in #2812).
        bool partialFill = ConfigFacet(diamond).getPartialFillEnabled();
        if (!partialFill) return _skip("partial fills are off (partialFillEnabled=false), so offers cannot be matched");

        // ── Phase A: Lender posts a ranged offer ─────────────────────
        // Collateral chosen to clear the worst-case HF gate at the
        // upper bound (5k principal). With WETH @ $2k each and USDC
        // @ $1, 5 WETH = $10k > minimum collateral for HF≥1.5 at $5k
        // principal × 1/0.85 liqThreshold ≈ $5882 collateral floor.
        uint256 amountMin = 2_000e6;
        uint256 amountMax = 5_000e6;
        uint256 rateMin = 400;
        uint256 rateMax = 600;
        uint256 lenderCollateral = 5e18;

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, amountMax);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(
            _rangedLenderOffer(amountMin, amountMax, rateMin, rateMax, lenderCollateral)
        );
        vm.stopBroadcast();
        console.log("Ranged lender offer:", lenderOfferId);

        // ── Phase B: Borrower 1 posts matchable single-point offer ───
        // Single-point offers (amountMax==0 → auto-collapsed) are
        // permitted on the borrower side regardless of partialFill
        // (matchable amount/rate range is "[v, v]" — point overlap).
        // amount = 2.5k, rate = 500 bps — sits inside lender's range.
        // 3 WETH @ $2k = $6k, ceiling at HF≥1.5 ≈ $6k * 0.85 / 1.5 =
        // $3400 — comfortably above the 2.5k principal target.
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT * 3);
        uint256 borrowerOffer1 = OfferCreateFacet(diamond).createOffer(
            _matchableBorrowerOffer(2_500e6, 500, COLLATERAL_AMOUNT * 3)
        );
        vm.stopBroadcast();
        console.log("Borrower offer 1 (matchable):", borrowerOffer1);

        // Preview the match before submitting — real bot's flow.
        LibOfferMatch.MatchResult memory preview =
            OfferMatchFacet(diamond).previewMatch(lenderOfferId, borrowerOffer1, vm.addr(newBorrowerKey), vm.addr(newBorrowerKey));
        console.log("previewMatch errorCode:", uint8(preview.errorCode));
        require(
            uint8(preview.errorCode) == 0, // MatchError.Ok
            "PF-053: previewMatch did not return Ok"
        );

        // newBorrower acts as the matcher (the bot/searcher). Its wallet and
        // the borrower's are read either side of the match so PF-057 can
        // check the kickback against the fee the borrower actually paid.
        address matcher = vm.addr(newBorrowerKey);
        uint256 borrowerUsdcBefore = usdc.balanceOf(borrower);
        uint256 matcherUsdcBefore = usdc.balanceOf(matcher);
        vm.startBroadcast(newBorrowerKey);
        uint256 loanFromMatch1 =
            OfferMatchFacet(diamond).matchOffers(lenderOfferId, borrowerOffer1);
        vm.stopBroadcast();
        console.log("Match 1 -> loanId:", loanFromMatch1);

        // The fill locks the collateral the match sized for it (the preview's
        // `reqCollateral`), not everything the borrower offer posted.
        _requireChildLoan(loanFromMatch1, borrower, 2_500e6, preview.reqCollateral, rateMin, rateMax);
        _requireMatcherShare(
            2_500e6,
            usdc.balanceOf(borrower) - borrowerUsdcBefore,
            usdc.balanceOf(matcher) - matcherUsdcBefore
        );

        // Inspect lender offer post-match. amountFilled should be 2500e6.
        LibVaipakam.Offer memory lenderState1 = OfferCancelFacet(diamond).getOffer(lenderOfferId);
        require(lenderState1.amountFilled == 2_500e6, "PF-053: amountFilled wrong post-match-1");
        require(!lenderState1.accepted, "PF-053: lender offer should still be open after partial fill");
        console.log("Lender amountFilled:", lenderState1.amountFilled);

        // ── Phase C: Borrower 2 posts a smaller matchable offer ──────
        // remaining = 5000 - 2500 = 2500. Borrower 2 wants 2000 → match
        // succeeds, leaving 500 (< amountMin 2000) which triggers
        // dust auto-close + refund of the residual to the lender.
        // 2.5 WETH @ $2k = $5k, ceiling at HF≥1.5 ≈ $5k * 0.85 / 1.5 =
        // $2833 — comfortably above the 2k principal target.
        vm.startBroadcast(newBorrowerKey);
        uint256 b2Collateral = (COLLATERAL_AMOUNT * 25) / 10; // 2.5 WETH
        weth.approve(diamond, b2Collateral);
        uint256 borrowerOffer2 = OfferCreateFacet(diamond).createOffer(
            _matchableBorrowerOfferAs(newBorrower, 2_000e6, 500, b2Collateral)
        );
        LibOfferMatch.MatchResult memory preview2 =
            OfferMatchFacet(diamond).previewMatch(lenderOfferId, borrowerOffer2, newBorrower, newBorrower);
        // newBorrower also doubles as the matcher here — fine, the
        // matcher just gets paid the LIF kickback regardless of
        // identity overlap with the borrower (no self-deal guard
        // needed: kickback comes from treasury share of LIF).
        uint256 loanFromMatch2 =
            OfferMatchFacet(diamond).matchOffers(lenderOfferId, borrowerOffer2);
        vm.stopBroadcast();
        console.log("Match 2 -> loanId:", loanFromMatch2);
        // The matcher is also this loan's borrower, so its wallet nets the
        // principal and the kickback together; PF-057 is checked on match 1.
        _requireChildLoan(loanFromMatch2, newBorrower, 2_000e6, preview2.reqCollateral, rateMin, rateMax);

        LibVaipakam.Offer memory lenderState2 = OfferCancelFacet(diamond).getOffer(lenderOfferId);
        // Either dust-closed (accepted == true, slot still here) OR
        // fully filled. We expect dust-close because 5000 - 2500 -
        // 2000 = 500 < amountMin (2000).
        require(lenderState2.accepted, "PF-053: lender offer should be closed (dust) after match 2");
        require(
            lenderState2.amountFilled == 4_500e6,
            "PF-053: amountFilled should be 4500 (2500 + 2000) at dust close"
        );
        console.log("Lender amountFilled (dust-closed):", lenderState2.amountFilled);
    }

    /// @dev PF-055: a fill of a partial-fill offer opens its own loan, with
    ///      the fill's principal, the collateral the match sized for that
    ///      fill, the offer creator as lender and the filling borrower as
    ///      borrower, at a rate inside the lender's range.
    function _requireChildLoan(
        uint256 loanId,
        address expectedBorrower,
        uint256 expectedPrincipal,
        uint256 expectedCollateral,
        uint256 rateMin,
        uint256 rateMax
    ) internal view {
        LibVaipakam.Loan memory child = LoanFacet(diamond).getLoanDetails(loanId);
        require(child.status == LibVaipakam.LoanStatus.Active, "PF-055: child loan should be Active");
        require(child.lender == lender, "PF-055: child loan lender should be the offer creator");
        require(child.borrower == expectedBorrower, "PF-055: child loan borrower should be the filling borrower");
        require(child.principal == expectedPrincipal, "PF-055: child loan principal should equal the fill");
        require(child.principalAsset == address(usdc), "PF-055: child loan lends the offer's asset");
        require(child.collateralAmount == expectedCollateral, "PF-055: child loan holds the collateral the match sized");
        require(
            child.interestRateBps >= rateMin && child.interestRateBps <= rateMax,
            "PF-055: child loan rate should sit inside the lender's range"
        );
        console.log("Child loan principal / rate bps:", child.principal, child.interestRateBps);
    }

    /// @dev PF-057: the matcher receives the configured share of the loan
    ///      initiation fee. The fee is read from what the borrower received
    ///      (the principal less the fee), not recomputed from the fee rate,
    ///      so a holder discount on the borrower's side cannot make the
    ///      check pass or fail for the wrong reason.
    function _requireMatcherShare(uint256 principal, uint256 borrowerReceived, uint256 matcherReceived)
        internal
        view
    {
        require(borrowerReceived < principal, "PF-057: borrower paid no initiation fee, so no share to check");
        uint256 initiationFee = principal - borrowerReceived;
        uint256 expected = (initiationFee * ConfigFacet(diamond).getLifMatcherFeeBps()) / 10_000;
        require(expected > 0, "PF-057: configured matcher share rounds to zero on this fee");
        require(matcherReceived == expected, "PF-057: matcher should receive its configured share of the fee");
        console.log("Initiation fee / matcher share:", initiationFee, matcherReceived);
    }

    function _rangedLenderOffer(
        uint256 amtMin,
        uint256 amtMax,
        uint256 rMin,
        uint256 rMax,
        uint256 collateralFloor
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: address(usdc),
            amount: amtMin,
            interestRateBps: rMin,
            collateralAsset: address(weth),
            collateralAmount: collateralFloor,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amtMax,
            interestRateBpsMax: rMax,
            collateralAmountMax: collateralFloor,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    function _matchableBorrowerOffer(
        uint256 amount,
        uint256 rateBps,
        uint256 collateralAmount
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return _matchableBorrowerOfferAs(borrower, amount, rateBps, collateralAmount);
    }

    function _matchableBorrowerOfferAs(
        address /* who */,
        uint256 amount,
        uint256 rateBps,
        uint256 collateralAmount
    ) internal view returns (LibVaipakam.CreateOfferParams memory) {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: amount,
            interestRateBps: rateBps,
            collateralAsset: address(weth),
            collateralAmount: collateralAmount,
            durationDays: DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: amount, // single-point amount
            interestRateBpsMax: rateBps, // single-point rate
            collateralAmountMax: collateralAmount, // #164 — single-point collateral
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    // ─── PF-211: Preclose Option 2 — transferObligationViaOffer ──────────────

    /// @dev alice (existing borrower of l1, lender = liam) wants to
    ///      exit her loan early. ben (a new borrower) creates a
    ///      Borrower offer with terms favoring liam (same asset,
    ///      collateral >= original, duration <= remaining, principal
    ///      matches l1.principal). alice calls
    ///      `transferObligationViaOffer(l1, benOfferId)` — she pays
    ///      accrued interest + any shortfall directly to liam, ben's
    ///      collateral becomes the new collateral, ben becomes the
    ///      new borrower of the SAME loan slot (l1). liam stays on as
    ///      lender; the loan terms (rate, duration end) are preserved.
    ///
    ///      Roles in this scenario:
    ///        liam      = `newLender` (the lender who stays)
    ///        alice     = `lender`  (current borrower; we re-purpose
    ///                              `lender` because the existing
    ///                              `borrower` slot is consumed by
    ///                              earlier scenarios, and alice's
    ///                              role is "borrower being replaced".
    ///                              Naming inversion is local to PF-211.)
    ///        ben       = `borrower` (the new borrower)
    function _precloseOption2TransferObligation() internal {
        // liam (newLender) creates a lender offer. alice (lender slot)
        // is the borrower of l1 — she'll be replaced by ben.
        address liam = newLender;
        address alice = lender;
        address ben = borrower;
        uint256 liamKey = newLenderKey;
        uint256 aliceKey = lenderKey;
        uint256 benKey = borrowerKey;

        vm.startBroadcast(liamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t6 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), lenderOfferId, true, 0);
        bytes memory _sig6 = LibAcceptTestSigner.sign(diamond, _t6, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferAcceptFacet(diamond).acceptOffer(lenderOfferId, _t6, _sig6);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // ben creates a Borrower offer with terms favoring liam:
        // same lending asset, same collateral asset, principal == l1
        // principal, a replacement that ends by l1's maturity
        // (HANDOVER_DURATION_DAYS), collateralAmount >= l1.collateralAmount.
        vm.startBroadcast(benKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 benOfferId = OfferCreateFacet(diamond).createOffer(_borrowerOfferTakeoverFor(ben));
        vm.stopBroadcast();
        console.log("Ben's takeover offer:", benOfferId);

        // alice calls transferObligation, paying accrued + shortfall.
        // Approve generous principal — at t≈0 accrued is tiny but
        // shortfall could be a few cents to a few dollars depending on
        // duration mismatch. We approve full LOAN_AMOUNT for headroom.
        vm.startBroadcast(aliceKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        PrecloseFacet(diamond).transferObligationViaOffer(loanL1, benOfferId);
        vm.stopBroadcast();

        // Verify: l1 is still Active but borrower changed from alice
        // to ben; lender unchanged.
        LibVaipakam.Loan memory l1After = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1After.status == LibVaipakam.LoanStatus.Active,
            "PF-211: L1 should still be Active (only obligation transferred)"
        );
        require(l1After.borrower == ben, "PF-211: borrower should be Ben");
        require(l1After.lender == liam, "PF-211: lender should still be Liam");
        console.log("L1 borrower (Alice -> Ben):", l1After.borrower);
    }

    function _borrowerOfferTakeoverFor(address /* who */)
        internal view returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Borrower,
            lendingAsset: address(usdc),
            amount: LOAN_AMOUNT,
            interestRateBps: INTEREST_BPS,
            collateralAsset: address(weth),
            collateralAmount: COLLATERAL_AMOUNT,
            durationDays: HANDOVER_DURATION_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(usdc),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: false,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: LOAN_AMOUNT,
            interestRateBpsMax: INTEREST_BPS,
            collateralAmountMax: COLLATERAL_AMOUNT,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
        });
    }

    // ─── PF-212: Preclose Option 3 — offsetWithNewOffer + completeOffset ─────

    /// @dev alice (borrower of l1, lender = liam) wants to exit AND
    ///      become a lender herself (Option 3). She:
    ///        1. Pays accrued interest + shortfall to liam.
    ///        2. Creates a new Lender offer linked to l1 via the
    ///           `offsetOfferToLoanId` mapping. The borrower NFT for
    ///           l1 is natively-locked while the offset is in flight.
    ///        3. charlie (new borrower) accepts the offset offer.
    ///           Inside `_acceptOffer` the auto-link triggers
    ///           `completeOffset(l1)` which:
    ///             - Settles l1 (status -> Repaid)
    ///             - Releases alice's collateral to her vault
    ///             - charlie's loan against alice as lender goes Active
    ///
    ///      Roles:
    ///        liam   = `newLender`  (original lender)
    ///        alice  = `lender`     (borrower of l1 -> lender of L_new)
    ///        charlie = `borrower`  (new borrower)
    function _precloseOption3Offset() internal {
        address liam = newLender;
        address alice = lender;
        address charlie = newBorrower;
        uint256 liamKey = newLenderKey;
        uint256 aliceKey = lenderKey;
        uint256 charlieKey = newBorrowerKey;

        // Setup loan l1: liam -> alice.
        vm.startBroadcast(liamKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 lenderOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t7 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(aliceKey), lenderOfferId, true, 0);
        bytes memory _sig7 = LibAcceptTestSigner.sign(diamond, _t7, aliceKey);
        vm.startBroadcast(aliceKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanL1 = OfferAcceptFacet(diamond).acceptOffer(lenderOfferId, _t7, _sig7);
        vm.stopBroadcast();
        console.log("L1 (Liam -> Alice) initiated:", loanL1);

        // alice calls offsetWithNewOffer. She pays accrued + shortfall
        // to liam (~0 at t≈0 with same rate/duration); deposits new
        // principal into her vault; the diamond mints a Lender offer
        // on her behalf and links it to l1.
        vm.startBroadcast(aliceKey);
        // Approve generously: offsetWithNewOffer pulls from alice's
        // wallet THREE times — (1) treasuryFee on accrued, (2)
        // principal+interest to old lender via vaultDepositERC20From,
        // (3) new principal for the offer createOfferInternal pulls.
        // Total ≈ 2 × LOAN_AMOUNT + small accrued; we approve 3× for
        // headroom.
        usdc.approve(diamond, LOAN_AMOUNT * 3);
        uint256 offsetOfferId = PrecloseFacet(diamond).offsetWithNewOffer(
            loanL1,
            INTEREST_BPS,           // same rate as l1 — minimal shortfall
            HANDOVER_DURATION_DAYS, // fits inside l1's remaining term
            address(weth),
            COLLATERAL_AMOUNT,
            true,                   // creatorRiskAndTermsConsent
            address(usdc)           // prepayAsset (unused on ERC20 path)
        );
        vm.stopBroadcast();
        console.log("Alice's offset offer:", offsetOfferId);

        // charlie accepts. The auto-link inside `_acceptOffer` fires
        // `PrecloseFacet.completeOffset(l1)` which closes l1 and
        // releases alice's collateral.
        LibAcceptTerms.AcceptTerms memory _t8 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(charlieKey), offsetOfferId, true, loanL1);
        bytes memory _sig8 = LibAcceptTestSigner.sign(diamond, _t8, charlieKey);
        vm.startBroadcast(charlieKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 newLoanId = OfferAcceptFacet(diamond).acceptOffer(offsetOfferId, _t8, _sig8);
        vm.stopBroadcast();
        console.log("Charlie accepted -> new loanId:", newLoanId);

        // Verify l1 is no longer Active.
        LibVaipakam.Loan memory l1Settled = LoanFacet(diamond).getLoanDetails(loanL1);
        require(
            l1Settled.status != LibVaipakam.LoanStatus.Active,
            "PF-212: L1 should be settled by completeOffset auto-fire"
        );
        console.log("L1 status post-offset:", uint8(l1Settled.status));

        // Verify the new loan has alice as lender, charlie as borrower.
        LibVaipakam.Loan memory newLoan = LoanFacet(diamond).getLoanDetails(newLoanId);
        require(newLoan.lender == alice, "PF-212: new loan lender should be Alice");
        require(newLoan.borrower == charlie, "PF-212: new loan borrower should be Charlie");
        console.log("New loan (Alice -> Charlie) status:", uint8(newLoan.status));

    }

    // ─── PF-230: Lender Early Withdrawal via Buy Offer ─────────────────────

    /// @dev Maps to Advanced Guide § Early Withdrawal (Lender) and the
    ///      EarlyWithdrawalFacet `sellLoanViaBuyOffer` path. Roles:
    ///        - Original lender (liam = `newLender`) holds an active loan.
    ///        - Buyer (bob = `lender`) creates a Lender-type buy offer
    ///          with the same shape as the loan (or no-worse terms).
    ///        - liam calls `sellLoanViaBuyOffer(loanId, buyOfferId)` to
    ///          flip lender on the existing loan to bob.
    ///        - Borrower (`newBorrower`) then repays bob.
    ///
    ///      The auto-link counterpart (createLoanSaleOffer + buyer
    ///      `acceptOffer` → `completeLoanSale` re-entry) needs the
    ///      same `*Internal` cross-facet entry pattern as PF-212's
    ///      `completeOffsetInternal`. That fix is deferred until a
    ///      concrete user flow drives it; the simpler
    ///      `sellLoanViaBuyOffer` path is already reentrancy-safe
    ///      because it doesn't re-enter through the diamond fallback.
    function _sellLoanViaBuyOffer() internal {
        // Step 1: liam (newLender) lends to newBorrower → loan active.
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t11 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig11 = LibAcceptTestSigner.sign(diamond, _t11, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t11, _sig11);
        vm.stopBroadcast();
        console.log("l1 (newLender -> newBorrower) initiated:", loanId);

        // Step 2: bob (`lender`) creates a Lender buy offer with the
        // same shape — sellLoanViaBuyOffer requires asset/duration/
        // collateral parity (or no-worse terms for borrower).
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 buyOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("bob's buy offer:", buyOfferId);

        // Step 3: liam sells the position to bob.
        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOffer(loanId, buyOfferId);
        vm.stopBroadcast();
        LibVaipakam.Loan memory loanAfterSale = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfterSale.lender == lender,
            "PF-230: loan.lender should flip to bob after sale"
        );
        console.log("Loan lender flipped to bob; loan.lender:", loanAfterSale.lender);

        // Step 4: borrower (newBorrower) repays the loan; bob now owns
        // the lender position.
        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(lenderKey, newBorrowerKey, loanId);

        LibVaipakam.Loan memory loanAfterRepay = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfterRepay.status != LibVaipakam.LoanStatus.Active,
            "PF-230: loan should be settled after repay"
        );
        console.log("Loan settled post-sale + repay");

    }

    /// @dev PF-230-floor (#1503 PR-E, design item 11) — the sale solvency admission
    ///      floor, exercised against the REAL deployed Diamond rather than a
    ///      bespoke test fixture: real facet routing, the real cross-facet
    ///      RiskFacet hop, real oracle wiring, no `vm.mockCall` anywhere.
    ///
    ///      Drops the collateral feed so a live position falls below the
    ///      floor its own admission required, proves the sale is refused with
    ///      the exact error, then restores the feed and proves the very same
    ///      sale goes through — so the refusal is attributable to solvency
    ///      and not to some unrelated precondition.
    function _saleSolvencyFloor() internal {
        // A fresh loan: newLender lends to newBorrower, 1000 USDC against
        // 1 WETH at $2000 → ~1.7 HF, comfortably admissible.
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t25 =
            LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig25 = LibAcceptTestSigner.sign(diamond, _t25, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t25, _sig25);
        vm.stopBroadcast();

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 buyOfferId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        uint256 hfHealthy = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $2000 collateral:", hfHealthy);
        require(
            hfHealthy >= LibVaipakam.MIN_HEALTH_FACTOR,
            "PF-230-floor: fixture must start above the floor"
        );

        // Collateral falls. $1500 puts the position under the 1.5e18
        // admission floor while leaving it ABOVE the 1e18 liquidation
        // trigger — the case that proves the floor is the ADMISSION
        // standard, not merely "not liquidatable yet".
        // deployerKey, not adminKey: the mock feed is owner-gated to the
        // account that deployed it in `_deployMocksAndConfigure`.
        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(1500e8);
        vm.stopBroadcast();

        // The depth guard can reclassify an asset when the feed moves away
        // from the mock pool's spot. An Illiquid leg is now refused
        // UNCONDITIONALLY (`SaleLegUnpriceable`, classifier code 6 — #1655), so
        // if that happened the sale would still revert, but for a completely
        // different reason and this scenario would prove nothing about the
        // health floor. Assert the leg is still priced so the revert below can
        // only be the floor — isolating the two refusals rather than, as this
        // comment previously claimed, guarding against an admission.
        require(
            OracleFacet(diamond).checkLiquidity(address(weth)) ==
                LibVaipakam.LiquidityStatus.Liquid,
            "PF-230-floor: WETH must stay Liquid or the floor is not what is being tested"
        );
        uint256 hfSunk = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $1500 collateral:", hfSunk);
        require(hfSunk < LibVaipakam.MIN_HEALTH_FACTOR, "PF-230-floor: must sit below the floor");
        require(
            hfSunk > LibVaipakam.HF_LIQUIDATION_THRESHOLD,
            "PF-230-floor: and above the liquidation trigger"
        );

        // Probed in the simulation only (`RevertProbe`), so a deliberate
        // revert neither aborts the broadcast nor spends a nonce the chain
        // never sees — it still executes the real deployed bytecode against
        // real chain state, which is the thing being verified.
        _requireRefusedWithSelector(
            newLender,
            abi.encodeWithSelector(
                EarlyWithdrawalDirectFacet.sellLoanViaBuyOffer.selector, loanId, buyOfferId
            ),
            LibSaleSolvency.SalePositionBelowSolvencyFloor.selector,
            "PF-230-floor: a sub-floor position must be refused for the solvency reason (SalePositionBelowSolvencyFloor)"
        );
        console.log("Sub-floor sale refused with SalePositionBelowSolvencyFloor");

        // Restore the price and run the SAME sale for real: it must now
        // settle, proving the refusal above was the floor and nothing else.
        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(2000e8);
        vm.stopBroadcast();

        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalDirectFacet(diamond).sellLoanViaBuyOffer(loanId, buyOfferId);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == lender,
            "PF-230-floor: recovered position must sell"
        );
        console.log("Same sale settles once the position is back over its floor");

    }

    // ─── PF-231: Sale Admission Floor on the LISTING ACCEPT branch ─────────

    /// @dev Codex #1635 r5. PF-230-floor drives the floor through
    ///      `EarlyWithdrawalFacet.sellLoanViaBuyOffer` — the DIRECT sale. That
    ///      leaves the other guarded path unexercised on chain: the sale-vehicle
    ///      branch of `OfferAcceptFacet.acceptOffer`, which is where a resting
    ///      listing's binding check lives.
    ///
    ///      This matters specifically for the upgrade rehearsal.
    ///      `ReplaceStaleFacets` is the script that reinstalls
    ///      `OfferAcceptFacet`, so rehearsing it against PF-230-floor proved the wrong
    ///      thing: PF-230-floor's only `acceptOffer` call originates an ordinary loan and
    ///      never reaches the sale branch, so breaking or dropping the refreshed
    ///      sale guard would have left that rehearsal green. The rehearsal picks
    ///      the scenario per script for this reason.
    ///
    ///      Same fixture logic as PF-230-floor — under the admission floor but above the
    ///      liquidation trigger, so what is proved is the ADMISSION standard and
    ///      not "not liquidatable yet" — driven through listing + accept:
    ///        - newLender lends to newBorrower, then LISTS the position.
    ///        - Collateral falls; bob's accept of the listing must be refused.
    ///        - Price recovers; the same accept must settle, moving the lender.
    function _saleAdmissionOnAcceptBranch() internal {
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t26 =
            LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig26 = LibAcceptTestSigner.sign(diamond, _t26, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t26, _sig26);
        vm.stopBroadcast();
        console.log("loan initiated:", loanId);

        // The lender lists the position while it is healthy — the listing-rests
        // -while-collateral-falls case the accept-time check exists for.
        vm.recordLogs();
        vm.startBroadcast(newLenderKey);
        EarlyWithdrawalFacet(diamond).createLoanSaleOffer(loanId, 500, true, 7 days);
        vm.stopBroadcast();
        uint256 saleOfferId;
        {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bytes32 linkedSig = keccak256("LoanSaleOfferLinked(uint256,uint256)");
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].topics[0] == linkedSig) {
                    saleOfferId = uint256(logs[i].topics[2]);
                }
            }
        }
        require(saleOfferId != 0, "PF-231: sale listing was not created");
        console.log("sale listing:", saleOfferId);

        uint256 hfHealthy = RiskFacet(diamond).calculateHealthFactor(loanId);
        require(
            hfHealthy >= LibVaipakam.MIN_HEALTH_FACTOR,
            "PF-231: fixture must start above the floor"
        );

        // Buyer signs terms BEFORE the drift, which is the real sequence: the
        // signature commits to the loan's shape, not to its health.
        LibAcceptTerms.AcceptTerms memory _ts26 =
            LibAcceptTestSigner.buildSaleTerms(diamond, vm.addr(lenderKey), saleOfferId, true, loanId);
        bytes memory _ssig26 = LibAcceptTestSigner.sign(diamond, _ts26, lenderKey);

        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(1500e8);
        vm.stopBroadcast();

        // Same reasoning as PF-230-floor: an Illiquid leg is refused unconditionally for
        // its OWN reason (`SaleLegUnpriceable`, code 6 — #1655), so if the depth
        // guard had reclassified WETH when the feed moved off the mock pool's
        // spot, the refusal below would still happen but would say nothing about
        // the health floor this scenario exists to drive.
        require(
            OracleFacet(diamond).checkLiquidity(address(weth)) ==
                LibVaipakam.LiquidityStatus.Liquid,
            "PF-231: WETH must stay Liquid or the floor is not what is being tested"
        );
        uint256 hfSunk = RiskFacet(diamond).calculateHealthFactor(loanId);
        console.log("HF at $1500 collateral:", hfSunk);
        require(hfSunk < LibVaipakam.MIN_HEALTH_FACTOR, "PF-231: must sit below the floor");
        require(
            hfSunk > LibVaipakam.HF_LIQUIDATION_THRESHOLD,
            "PF-231: and above the liquidation trigger"
        );

        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        vm.stopBroadcast();

        // Probed in the simulation only (`RevertProbe`), as in PF-230-floor; still the
        // real deployed bytecode against real chain state.
        _requireRefusedWithSelector(
            vm.addr(lenderKey),
            abi.encodeWithSelector(
                OfferAcceptFacet.acceptOffer.selector, saleOfferId, _ts26, _ssig26
            ),
            LibSaleSolvency.SalePositionBelowSolvencyFloor.selector,
            "PF-231: a sub-floor listing must be refused for the solvency reason (SalePositionBelowSolvencyFloor)"
        );
        console.log("Sub-floor listing accept refused with SalePositionBelowSolvencyFloor");

        vm.startBroadcast(deployerKey);
        _setWethPriceConsistently(2000e8);
        vm.stopBroadcast();

        vm.startBroadcast(lenderKey);
        OfferAcceptFacet(diamond).acceptOffer(saleOfferId, _ts26, _ssig26);
        vm.stopBroadcast();
        require(
            LoanFacet(diamond).getLoanDetails(loanId).lender == vm.addr(lenderKey),
            "PF-231: recovered position must sell through the accept branch"
        );
        console.log("Same listing accept settles once the position is back over its floor");

    }

    function _lenderOfferAllowsPartial() internal view returns (LibVaipakam.CreateOfferParams memory) {
        LibVaipakam.CreateOfferParams memory p = _lenderOfferStandard();
        p.allowsPartialRepay = true;
        return p;
    }

}
