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
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {LibPausable} from "../../src/libraries/LibPausable.sol";

/**
 * @title PositiveFlowsOperatorAdmin
 * @notice Operator and compliance surfaces (#848 Phase 1): a flagged wallet's
 *         Tier-1 refusal with its Tier-2 close-out left open, per-asset pause,
 *         global pause, treasury accrual and withdrawal, and an admin fee knob inside its bounds.
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
        list[3] = Scenario("PF-329", "Treasury receives the initiation fee; a Diamond-held balance is withdrawn",
            "PF-329");
        list[4] = Scenario("PF-324", "Admin fee knob: above the cap refused; inside it, the getter and the next loan follow",
            "PF-324");
    }

    function _runScenario(uint256 index) internal override {
        if (index == 0) _sanctionsTier1Deny();
        else if (index == 1) _pauseAsset();
        else if (index == 2) _globalPause();
        else if (index == 3) _treasuryAccrual();
        else if (index == 4) _feeKnobInsideBounds();
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

        // Step 3: the Diamond reads the flag, and a Tier-1 entry point
        // refuses the flagged wallet by name. The refusal is probed in the
        // simulation only (`RevertProbe`): a reverting call under
        // `vm.startBroadcast` would be replayed on chain and abort the run.
        bool isFlagged = ProfileFacet(diamond).isSanctionedAddress(borrower);
        require(isFlagged, "PF-008: borrower should be flagged on the oracle");
        _requireRefused(
            borrower,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _borrowerOfferStandard()),
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, borrower),
            "PF-008: createOffer by a flagged wallet should revert SanctionedAddress(borrower)"
        );
        console.log("Tier-1 createOffer refused the flagged borrower with SanctionedAddress");

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

        // Step 2: an offer on the paused asset is refused, naming it.
        // Probed in the simulation only (`RevertProbe`, see PF-008).
        _requireRefused(
            newLender,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _lenderOfferStandard()),
            abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, address(usdc)),
            "PF-323: createOffer on a paused asset should revert AssetPaused(usdc)"
        );
        console.log("createOffer on paused USDC refused with AssetPaused");

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
        // A whenNotPaused entry point is refused while paused. Probed in
        // the simulation only (`RevertProbe`, see PF-008).
        _requireRefused(
            lender,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _lenderOfferStandard()),
            abi.encodeWithSelector(LibPausable.EnforcedPause.selector),
            "PF-322: createOffer while the Diamond is paused should revert EnforcedPause"
        );
        console.log("createOffer refused with EnforcedPause while paused");

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

    // ─── PF-329: Treasury accrual and withdrawal ───────────────────────────

    /// @dev Where a fee goes depends on the deployment's treasury topology,
    ///      and the scenario states which one it found rather than assuming:
    ///
    ///        - External treasury (the documented mainnet shape, and what
    ///          `anvil-bootstrap.sh` sets): a fee leaves the Diamond as it is
    ///          collected. The treasury wallet must receive at least the loan
    ///          initiation fee, and nothing is held at the Diamond, so there
    ///          is nothing there to withdraw.
    ///        - Diamond as treasury: the fee is held at the Diamond and
    ///          recorded in `getTreasuryBalance`, and the admin withdraws it
    ///          with `claimTreasuryFees`.
    ///
    ///      On an external-treasury deployment the scenario walks the first
    ///      shape, then points the treasury at the Diamond for one more loan
    ///      so the withdrawal half of the row runs too, and restores the
    ///      original treasury in the same broadcast as the withdrawal.
    ///
    ///      The fee checked is the initiation fee, read from what the
    ///      borrower received (principal less the fee). Interest-side fees
    ///      round to zero here: the loan lives a few seconds, and 5% APR on
    ///      1,000 USDC for that long is below one USDC unit. So the checks
    ///      are "at least the fee", never an exact interest share;
    ///      TreasuryFacetTest covers duration-bearing fees with warped time.
    function _treasuryAccrual() internal {
        address treasury = AdminFacet(diamond).getTreasury();
        bool diamondIsTreasury = treasury == diamond;
        console.log("Treasury:", treasury);
        console.log(diamondIsTreasury
            ? "Topology: the Diamond is the treasury (fees held, then withdrawn)"
            : "Topology: external treasury (fees leave the Diamond as collected)");

        if (!diamondIsTreasury) {
            uint256 walletBefore = usdc.balanceOf(treasury);
            uint256 heldBefore = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
            uint256 fee = _loanRoundTrip();
            require(
                usdc.balanceOf(treasury) - walletBefore >= fee,
                "PF-329: the external treasury should receive at least the initiation fee"
            );
            require(
                TreasuryFacet(diamond).getTreasuryBalance(address(usdc)) == heldBefore,
                "PF-329: an external treasury leaves nothing held at the Diamond"
            );
            console.log("External treasury received the initiation fee; nothing held at the Diamond");

            vm.startBroadcast(adminKey);
            AdminFacet(diamond).setTreasury(diamond);
            vm.stopBroadcast();
            console.log("Treasury pointed at the Diamond for the withdrawal half");
        }

        uint256 heldStart = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        uint256 heldFee = _loanRoundTrip();
        uint256 held = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        require(held - heldStart >= heldFee, "PF-329: a Diamond treasury should hold at least the initiation fee");
        console.log("USDC held at the Diamond for the treasury:", held);

        uint256 adminBefore = usdc.balanceOf(admin);
        vm.startBroadcast(adminKey);
        TreasuryFacet(diamond).claimTreasuryFees(address(usdc), admin);
        if (!diamondIsTreasury) AdminFacet(diamond).setTreasury(treasury);
        vm.stopBroadcast();
        require(
            TreasuryFacet(diamond).getTreasuryBalance(address(usdc)) == 0,
            "PF-329: the withdrawal should clear the held USDC balance"
        );
        require(
            usdc.balanceOf(admin) - adminBefore == held,
            "PF-329: the admin should receive exactly the held balance"
        );
        require(AdminFacet(diamond).getTreasury() == treasury, "PF-329: the original treasury should be restored");
        console.log("Admin withdrew the held treasury USDC:", held);

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

    /// @dev One standard loan, opened by `newBorrower` against `newLender`'s
    ///      offer, repaid in full and claimed by both. Returns the loan
    ///      initiation fee, read from what the borrower received.
    function _loanRoundTrip() internal returns (uint256 initiationFee) {
        vm.startBroadcast(newLenderKey);
        usdc.approve(diamond, LOAN_AMOUNT);
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard());
        vm.stopBroadcast();

        uint256 borrowerBefore = usdc.balanceOf(newBorrower);
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        uint256 received = usdc.balanceOf(newBorrower) - borrowerBefore;
        require(received < LOAN_AMOUNT, "the borrower paid no initiation fee");
        initiationFee = LOAN_AMOUNT - received;
        console.log("Loan / initiation fee:", loanId, initiationFee);

        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, repayAmt);
        RepayFacet(diamond).repayLoan(loanId);
        vm.stopBroadcast();
        _claimBoth(newLenderKey, newBorrowerKey, loanId);
    }

    // ─── PF-324: Admin config knob inside its bounds ───────────────────────

    /// @dev The knob is the loan initiation fee (`setFeesConfig`), chosen
    ///      because its effect on the next loan can be measured exactly.
    ///      The scenario shows the three things PF-324 asks of a knob:
    ///        1. A value above the cap is refused (`InvalidFeeBps`).
    ///        2. A value inside the cap lands and the getter reports it.
    ///        3. The next loan pays the new fee, and the old value comes
    ///           back the same way.
    ///      The range master flags are not used here: `rangeAmountEnabled`
    ///      no longer gates offer creation (OfferCreateFacet calls it
    ///      "now-dead"), so it cannot show a knob affecting a flow (#2812).
    /// @dev `ConfigFacet`'s fee ceiling (its private `MAX_FEE_BPS`, 50%),
    ///      which the setter names in `InvalidFeeBps`.
    uint256 private constant FEE_CAP_BPS = 5_000;

    function _feeKnobInsideBounds() internal {
        (uint256 treasuryBps, uint256 originalLifBps) = ConfigFacet(diamond).getFeesConfig();
        console.log("Loan initiation fee bps pre:", originalLifBps);
        require(
            _loanRoundTrip() == _netInitiationFee(originalLifBps),
            "PF-324: the first loan should pay the configured initiation fee"
        );

        // Step 1: above the cap is refused, with the cap named.
        _requireRefused(
            admin,
            abi.encodeWithSelector(ConfigFacet.setFeesConfig.selector, uint16(treasuryBps), uint16(FEE_CAP_BPS + 1)),
            abi.encodeWithSelector(ConfigFacet.InvalidFeeBps.selector, FEE_CAP_BPS + 1, FEE_CAP_BPS),
            "PF-324: an initiation fee above the 50% cap should be refused with InvalidFeeBps"
        );
        console.log("Initiation fee above the cap refused with InvalidFeeBps");

        // Step 2: a different value inside the cap lands and is visible.
        // Step down instead of up when the current fee is near the cap.
        uint256 newLifBps = originalLifBps + 10 <= FEE_CAP_BPS ? originalLifBps + 10 : originalLifBps - 10;
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setFeesConfig(uint16(treasuryBps), uint16(newLifBps));
        vm.stopBroadcast();
        (, uint256 lifBps) = ConfigFacet(diamond).getFeesConfig();
        require(lifBps == newLifBps, "PF-324: the getter should report the new initiation fee");
        require(
            ConfigFacet(diamond).getLoanInitiationFeeBps() == newLifBps,
            "PF-324: the single-field getter should agree"
        );

        // Step 3: the next loan pays it.
        require(
            _loanRoundTrip() == _netInitiationFee(newLifBps),
            "PF-324: the next loan should pay the new initiation fee"
        );
        console.log("The next loan paid the new initiation fee at bps:", newLifBps);

        // Restores the effective values read at the start. Where either fee
        // was on its library default, it is now stored as an explicit value
        // equal to that default (`setFeesConfig` has no "keep the default"
        // input other than 0, and the getter does not say which was set).
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setFeesConfig(uint16(treasuryBps), uint16(originalLifBps));
        vm.stopBroadcast();
        (, lifBps) = ConfigFacet(diamond).getFeesConfig();
        require(lifBps == originalLifBps, "PF-324: the original initiation fee should be restored");
    }

    /// @dev What `_loanRoundTrip` measures as the fee: the initiation fee on
    ///      LOAN_AMOUNT at `lifBps`, less the matcher's share, which goes
    ///      back to the accepting borrower (the matcher on a direct accept).
    ///      The round-trip borrower holds no VPFI, so no discount applies.
    function _netInitiationFee(uint256 lifBps) internal view returns (uint256) {
        uint256 gross = (LOAN_AMOUNT * lifBps) / 10_000;
        return gross - (gross * ConfigFacet(diamond).getLifMatcherFeeBps()) / 10_000;
    }

    /// @dev Requires `data`, sent to the Diamond as `caller`, to revert with
    ///      exactly `expectedRevert` (selector and arguments). Runs in the
    ///      simulation only, through `RevertProbe`.
    function _requireRefused(
        address caller,
        bytes memory data,
        bytes memory expectedRevert,
        string memory failure
    ) internal {
        (bool ok, bytes memory ret) = RevertProbe.call(caller, diamond, data);
        require(!ok && keccak256(ret) == keccak256(expectedRevert), failure);
    }
}
