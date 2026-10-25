// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibAcceptTerms} from "../../src/libraries/LibAcceptTerms.sol";
import {LibAcceptTestSigner} from "../../test/helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferAcceptFacet} from "../../src/facets/OfferAcceptFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {RevertProbe} from "../lib/RevertProbe.sol";

/**
 * @title PositiveFlowsOperatorAdmin
 * @notice Operator and compliance surfaces (#848 Phase 1): a flagged wallet's
 *         Tier-1 refusal with its Tier-2 close-out left open, per-asset pause,
 *         global pause, the treasury accrual surface, and master-flag dormancy.
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsOperatorAdmin is PositiveFlowsBase {
    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsOperatorAdmin";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](5);
        list[0] = Scenario("PF-008", "Flagged wallet: the Diamond reads the flag, and its Tier-2 repay stays open",
            "PF-008, PF-004");
        list[1] = Scenario("PF-323", "Per-asset pause and unpause",
            "PF-323");
        list[2] = Scenario("PF-322", "Global pause and unpause",
            "PF-322");
        list[3] = Scenario("PF-329", "Treasury accrual surface across a repaid loan",
            "PF-329");
        list[4] = Scenario("PF-324", "Master-flag dormancy: range amounts off, then on",
            "PF-324");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _sanctionsTier1Deny();
        else if (index == 1) _pauseAsset();
        else if (index == 2) _globalPause();
        else if (index == 3) _treasuryAccrual();
        else if (index == 4) _masterFlagDormancy();
        else revert("PositiveFlowsOperatorAdmin: no scenario at index");
    }

    // ─── PF-008: Sanctions Tier-1 Deny / Tier-2 Close-out ────────────────────

    /// @dev Retail policy (per project memory + ProfileFacet
    ///      `_assertNotSanctioned` placement): Tier-1 entry points
    ///      (createOffer, acceptOffer, getOrCreateUserVault,
    ///      recoverStuckERC20, etc.) revert SanctionedAddress for
    ///      flagged callers. Tier-2 close-out paths (repayLoan,
    ///      claimAsBorrower, markDefaulted) STAY OPEN so the
    ///      unflagged counterparty can be made whole.
    ///
    ///      Scenario:
    ///        1. lender + borrower take a normal loan (Tier-1 entry
    ///           paths must succeed BEFORE we flag).
    ///        2. Flag `borrower` on the oracle.
    ///        3. Try `borrower.createOffer(...)` — should revert
    ///           SanctionedAddress (Tier-1 deny).
    ///        4. Try `borrower.repayLoan(activeLoanId)` — should
    ///           SUCCEED (Tier-2 close-out stays open).
    ///        5. Unflag and verify createOffer succeeds again.
    function _sanctionsTier1Deny() internal {
        // Step 1: lender + borrower create + accept loan (normal path,
        // pre-flag). Use the standard helpers.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        LibAcceptTerms.AcceptTerms memory _t4 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(borrowerKey), offerId, true, 0);
        bytes memory _sig4 = LibAcceptTestSigner.sign(diamond, _t4, borrowerKey);
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t4, _sig4);
        vm.stopBroadcast();
        console.log("Pre-flag loan initiated:", loanId);

        // Step 2: flag borrower on the sanctions oracle.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(borrower, true);
        vm.stopBroadcast();
        console.log("Flagged borrower:", borrower);

        // Step 3: verify the borrower is now flagged (Tier-1 deny is
        // exercised end-to-end by NEG-S1 in AnvilNegativeFlows; here we
        // just assert the sanctions state via a view call). Wrapping
        // the try-revert in `vm.startBroadcast` would fail in
        // `--broadcast` mode because forge re-attempts every tx the
        // simulation issued — even ones inside try/catch — and reports
        // them as broadcast failures.
        bool isFlagged = ProfileFacet(diamond).isSanctionedAddress(borrower);
        require(isFlagged, "PF-008: borrower should be flagged on the oracle");
        console.log("Tier-1 deny gate is armed (oracle flag verified via view-call)");

        // Step 4: borrower repays the EXISTING loan — should succeed
        // (Tier-2 close-out stays open).
        vm.startBroadcast(borrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        LibVaipakam.Loan memory loanAfter = LoanFacet(diamond).getLoanDetails(loanId);
        require(
            loanAfter.status != LibVaipakam.LoanStatus.Active,
            "PF-008: Tier-2 repayLoan should have settled the loan"
        );
        console.log("Tier-2 repayLoan succeeded for sanctioned borrower");

        // Step 5: unflag so the scenarios after this one (and a re-run on
        // the same chain) can use `borrower` for Tier-1 entries again.
        // We don't try a fresh createOffer here — that adds noise and
        // an extra cooldown-gated offer to manage. The unflag tx itself
        // is the assertion; verify via view-call.
        vm.startBroadcast(deployerKey);
        sanctions.setFlagged(borrower, false);
        vm.stopBroadcast();
        require(
            !ProfileFacet(diamond).isSanctionedAddress(borrower),
            "PF-008: unflag should clear the sanctions state"
        );
        console.log("Borrower unflagged for the scenarios after this one");
    }

    // ─── PF-323: Per-asset pause ───────────────────────────────────────────

    /// @dev Verifies the per-asset pause gate. Admin pauses USDC, the
    ///      lender's offer-create on USDC reverts, admin unpauses,
    ///      offer-create succeeds. Each new participant uses fresh
    ///      USDC allowance to keep the test isolated from prior runs.
    function _pauseAsset() internal {
        // Step 1: admin pauses USDC.
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pauseAsset(address(usdc));
        vm.stopBroadcast();
        require(
            AdminFacet(diamond).isAssetPaused(address(usdc)),
            "PF-323: USDC should be paused after pauseAsset"
        );
        console.log("USDC paused; isAssetPaused == true");

        // Step 2: assertion of the gate state. We deliberately do NOT
        // attempt a `address(diamond).call(...)` to a paused-asset
        // createOffer here — forge `--broadcast` re-simulates every
        // tx the script issued during the broadcast pre-flight, and
        // a low-level call wrapped in `vm.startBroadcast` IS recorded
        // as a broadcast tx that will revert (causing
        // "Simulated execution failed"). The actual revert path is
        // exercised end-to-end by AdminFacetTest.t.sol's pause tests.
        require(
            AdminFacet(diamond).isAssetPaused(address(usdc)) == true,
            "PF-323: USDC must report paused via view"
        );
        console.log("Pause-gate state verified via isAssetPaused() == true");

        // Step 3: admin unpauses; create succeeds.
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).unpauseAsset(address(usdc));
        vm.stopBroadcast();
        require(
            !AdminFacet(diamond).isAssetPaused(address(usdc)),
            "PF-323: USDC should be unpaused"
        );
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("Post-unpause createOffer succeeded; offerId:", offerId);
        // Note: do NOT cancel here. Range Orders Phase 1 enforces a
        // 5-min cancel cooldown when partialFillEnabled is on, and the
        // bootstrap turns it on. The leftover offer is harmless —
        // newLender has 100k USDC and only 1k went into vault.

    }

    // ─── PF-322: Global pause ──────────────────────────────────────────────

    /// @dev Verifies `AdminFacet.pause()` (PAUSER_ROLE) blocks every
    ///      `whenNotPaused` entry point. We probe with createOffer
    ///      from `lender`, then unpause and verify the action succeeds.
    function _globalPause() internal {
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pause();
        vm.stopBroadcast();
        require(AdminFacet(diamond).paused(), "PF-322: paused() should be true");
        console.log("Diamond globally paused; paused() == true");
        // We don't probe the revert via address(diamond).call here —
        // see PF-323's comment: forge --broadcast re-attempts low-level
        // call txs in the pre-flight and the revert kills the script.
        // AdminFacetTest.t.sol exercises the actual revert path.

        vm.startBroadcast(adminKey);
        AdminFacet(diamond).unpause();
        vm.stopBroadcast();
        require(!AdminFacet(diamond).paused(), "PF-322: paused() should be false");

        // Sanity: post-unpause, an offer can be created. We don't
        // cancel — the cancel-cooldown is gated on `partialFillEnabled`
        // (5 min wall-clock), and the offer itself going through is
        // sufficient evidence the global pause was lifted.
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();
        console.log("Post-unpause sanity create ok; offerId:", offerId);

    }

    // ─── PF-329: Treasury accrual ──────────────────────────────────────────

    /// @dev Verifies the treasury accrual surface is wired end-to-end.
    ///      In broadcast mode against Anvil the actual interest delta
    ///      rounds to 0 because each tx is ~1 second apart and 5% APR
    ///      on 1,000 USDC for 1 second is well below 1 wei (USDC has
    ///      6 decimals). The test therefore (a) reads USDC treasury
    ///      balance pre and post a fresh loan-and-repay and asserts
    ///      it's non-decreasing (the counter is monotonic on positive
    ///      paths), and (b) reads VPFI treasury balance as a CALL-SURFACE
    ///      check only. #1555 r3 — this used to claim the VPFI counter
    ///      "DOES grow when PF-250's settleBorrowerLifProper runs"; that has
    ///      been false since #1352 retired the peg-custody path, so PF-250
    ///      holds nothing to forward and no current positive flow in this
    ///      drive accrues VPFI treasury revenue. Real treasury
    ///      growth on duration-bearing fees is exercised by
    ///      TreasuryFacetTest.t.sol unit tests where vm.warp can move
    ///      simulation time.
    function _treasuryAccrual() internal {
        uint256 usdcTreasuryBefore = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        console.log("USDC treasury pre:", usdcTreasuryBefore);

        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        LibAcceptTerms.AcceptTerms memory _t10 = LibAcceptTestSigner.buildTerms(diamond, vm.addr(newBorrowerKey), offerId, true, 0);
        bytes memory _sig10 = LibAcceptTestSigner.sign(diamond, _t10, newBorrowerKey);
        vm.startBroadcast(newBorrowerKey);
        weth.approve(diamond, COLLATERAL_AMOUNT);
        uint256 loanId = OfferAcceptFacet(diamond).acceptOffer(offerId, _t10, _sig10);
        vm.stopBroadcast();

        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt + 100e6);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(newLenderKey, newBorrowerKey, loanId);

        uint256 usdcTreasuryAfter = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        console.log("USDC treasury post:", usdcTreasuryAfter);
        require(
            usdcTreasuryAfter >= usdcTreasuryBefore,
            "PF-329: USDC treasury must be non-decreasing"
        );

        // VPFI treasury surface: CALL-SURFACE ONLY, and labelled as such
        // (#1555 r3). No current positive flow in this drive produces VPFI
        // treasury revenue: the HoldOnly LIF (#1352) takes no VPFI custody,
        // and the Full tariff credits the recycle bucket, not treasury. So
        // this reads the balance of whatever VPFI token the Diamond names and
        // asserts nothing about its size; inventing a source to make the
        // assertion look strong would claim a flow that did not run. Real
        // VPFI treasury accrual is covered by TreasuryFacetTest. The token is
        // read from the Diamond because this module deploys no VPFI of its
        // own (#848 Phase 1; the old suite read the mock its VPFI scenario
        // had left wired).
        address vpfiToken = VPFITokenFacet(diamond).getVPFIToken();
        if (vpfiToken == address(0)) {
            console.log("No VPFI token configured on the Diamond: no VPFI treasury surface to read");
        } else {
            console.log(
                "VPFI treasury balance (no current flow accrues it):",
                TreasuryFacet(diamond).getTreasuryBalance(vpfiToken)
            );
        }
    }

    // ─── PF-324: Master-flag dormancy ──────────────────────────────────────

    /// @dev Range Orders Phase 1 is governance-gated: every range
    ///      offer is rejected unless the corresponding master flag is
    ///      ON. This scenario verifies the dormancy gate by:
    ///        1. Snapshot the current flags (bootstrap-flipped to ON).
    ///        2. Admin flips `setRangeAmountEnabled(false)`.
    ///        3. Lender attempts to create an `amountMax > amount`
    ///           range offer → must revert.
    ///        4. Admin re-enables → action succeeds.
    function _masterFlagDormancy() internal {
        (bool rangeAmount, , ) = ConfigFacet(diamond).getMasterFlags();
        console.log("rangeAmountEnabled pre:", rangeAmount);
        require(rangeAmount, "PF-324: precondition - bootstrap should leave rangeAmountEnabled=true");

        // Step 1: turn the flag off; verify gate via view call. We
        // intentionally do NOT attempt a range-offer creation while
        // the flag is off — forge --broadcast would re-simulate the
        // failing low-level call in its pre-flight and abort the
        // script. The actual gate revert (FunctionDisabled) is
        // exercised by ConfigFacetTest.t.sol unit tests.
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setRangeAmountEnabled(false);
        vm.stopBroadcast();
        (bool rangeAmountOff, , ) = ConfigFacet(diamond).getMasterFlags();
        require(!rangeAmountOff, "PF-324: setRangeAmountEnabled(false) should land");
        console.log("Dormancy gate state verified: rangeAmountEnabled flipped to false");

        // Step 2: re-enable; range offer now succeeds. The collateral
        // floor scales with `amountMax`, so we bump collateralAmount
        // to 2 WETH (above the ~1.764 WETH floor for amountMax =
        // 2,000 USDC at WETH @ $2000 with 8500 bps liqThreshold).
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setRangeAmountEnabled(true);
        vm.stopBroadcast();
        (bool rangeAmountOn, , ) = ConfigFacet(diamond).getMasterFlags();
        require(rangeAmountOn, "PF-324: setRangeAmountEnabled(true) should land");

        LibVaipakam.CreateOfferParams memory params = _lenderOfferStandard();
        params.amountMax = LOAN_AMOUNT * 2;
        params.collateralAmount = 2 * COLLATERAL_AMOUNT;
        // Lender offers require collateralAmountMax == collateralAmount
        // (LenderCollateralRangeNotAllowed) — keep it in lock-step.
        params.collateralAmountMax = 2 * COLLATERAL_AMOUNT;
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, LOAN_AMOUNT * 2);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(params);
        vm.stopBroadcast();
        console.log("Post-re-enable range offer accepted; offerId:", offerId);

    }
}
