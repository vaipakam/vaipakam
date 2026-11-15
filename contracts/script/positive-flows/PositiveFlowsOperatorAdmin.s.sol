// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {ProfileFacet} from "../../src/facets/ProfileFacet.sol";
import {PositiveFlowsStaged} from "./PositiveFlowsStaged.sol";
import {MockSanctionsList} from "../../test/mocks/MockSanctionsList.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {RepayFacet} from "../../src/facets/RepayFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";
import {AdminFacet} from "../../src/facets/AdminFacet.sol";
import {TreasuryFacet} from "../../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../../src/facets/VPFITokenFacet.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";
import {LibPausable} from "../../src/libraries/LibPausable.sol";

/**
 * @title PositiveFlowsOperatorAdmin
 * @notice Operator and compliance surfaces (#848 Phase 1): a flagged wallet's
 *         Tier-1 refusal with its Tier-2 close-out left open, per-asset pause,
 *         global pause, treasury accrual and withdrawal, and an admin fee
 *         knob inside its bounds.
 *
 *         Staged (#3574): a scenario that fills an offer it posted takes a
 *         step to post and fills it in a later one, once the terms have
 *         stood the minimum age (PF-008, PF-329 and PF-324; PF-324 takes a
 *         third step for its second loan, at the new fee). The pauses take
 *         one step each. Every setting a scenario changes is recorded to put
 *         back (the borrower's sanctions flag, the asset pause, the global
 *         pause, the initiation fee), so `unwind()` restores whatever an
 *         abandoned run left changed, and `finish()` refuses while any is.
 *         `run()` is the simulation and `stage()` the broadcastable run
 *         ({PositiveFlowsStaged}, `script/positive-flows/run-staged.sh`).
 *
 *         Moved from the retired `AnvilNewPositiveFlows` suite, whose `N`
 *         labels the comments below still use in places; {PositiveFlowsBase}
 *         maps them to the flow ids. Fixture, runner and ids: {PositiveFlowsBase}.
 */
contract PositiveFlowsOperatorAdmin is PositiveFlowsStaged {
    /// @dev The offer a scenario's first step posts and a later step fills.
    string private constant OFFER = "offer";
    /// @dev PF-324's second offer, filled at the new fee.
    string private constant OFFER_AT_NEW_FEE = "offerAtNewFee";

    /// @dev Settings to put back. Each is recorded before the step changes
    ///      it, with the value that identifies it.
    /// @dev The flagged wallet: put back means the oracle no longer flags it.
    string private constant SANCTIONS_FLAG = "sanctionsFlag";
    /// @dev The paused asset: put back means it is no longer paused.
    string private constant ASSET_PAUSE = "assetPause";
    /// @dev The global pause (value unused): put back means not paused.
    string private constant GLOBAL_PAUSE = "globalPause";
    /// @dev The initiation fee in bps before PF-324 changed it.
    string private constant INITIATION_FEE = "initiationFeeBps";

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
        list[3] = Scenario("PF-329", "Treasury receives the initiation fee; a Diamond-held balance is withdrawn where the Diamond is the treasury",
            "PF-329");
        list[4] = Scenario("PF-324", "Admin fee knob: above the cap refused; inside it, the getter and the next loan follow",
            "PF-324");
    }

    /// @dev PF-008 and PF-329 post, then fill; PF-324 posts, fills and
    ///      changes the fee, then fills again; the pauses take one step.
    function _stepCount(uint256 index) internal pure override returns (uint256) {
        if (index == 0 || index == 3) return 2;
        if (index == 4) return 3;
        return 1;
    }

    function _runStep(uint256 index, uint256 step) internal override {
        if (index == 0) {
            if (step == 0) return _keep(OFFER, _createLenderOffer(lenderKey));
            return _sanctionsTier1Deny(_kept(OFFER));
        }
        if (index == 1) return _pauseAsset();
        if (index == 2) return _globalPause();
        if (index == 3) {
            if (step == 0) return _keep(OFFER, _postRoundTripOffer());
            return _treasuryAccrual(_kept(OFFER));
        }
        if (index == 4) {
            if (step == 0) return _keep(OFFER, _postRoundTripOffer());
            if (step == 1) return _changeFeeKnob(_kept(OFFER));
            return _nextLoanPaysNewFee(_kept(OFFER_AT_NEW_FEE));
        }
        revert("PositiveFlowsOperatorAdmin: no scenario at index");
    }

    // ─── Settings to put back ─────────────────────────────────────────────

    function _stillToRestore(string memory name, uint256 value) internal view override returns (bool) {
        if (_eq(name, SANCTIONS_FLAG)) return ProfileFacet(diamond).isSanctionedAddress(address(uint160(value)));
        if (_eq(name, ASSET_PAUSE)) return AdminFacet(diamond).isAssetPaused(address(uint160(value)));
        if (_eq(name, GLOBAL_PAUSE)) return AdminFacet(diamond).paused();
        if (_eq(name, INITIATION_FEE)) {
            (, uint256 lifBps) = ConfigFacet(diamond).getFeesConfig();
            return lifBps != value;
        }
        return super._stillToRestore(name, value);
    }

    function _restore(string memory name, uint256 value) internal override {
        if (_eq(name, SANCTIONS_FLAG)) {
            // The oracle the Diamond reads is the fixture's mock, which
            // anyone may set; it is read from the Diamond so unwind needs
            // nothing but the chain.
            vm.startBroadcast(deployerKey);
            MockSanctionsList(ProfileFacet(diamond).getSanctionsOracle()).setFlagged(address(uint160(value)), false);
            vm.stopBroadcast();
            return;
        }
        if (_eq(name, ASSET_PAUSE)) {
            vm.startBroadcast(adminKey);
            AdminFacet(diamond).unpauseAsset(address(uint160(value)));
            vm.stopBroadcast();
            return;
        }
        if (_eq(name, GLOBAL_PAUSE)) {
            vm.startBroadcast(adminKey);
            AdminFacet(diamond).unpause();
            vm.stopBroadcast();
            return;
        }
        if (_eq(name, INITIATION_FEE)) {
            (uint256 treasuryBps,) = ConfigFacet(diamond).getFeesConfig();
            vm.startBroadcast(adminKey);
            ConfigFacet(diamond).setFeesConfig(uint16(treasuryBps), uint16(value));
            vm.stopBroadcast();
            return;
        }
        super._restore(name, value);
    }

    // ─── PF-008: Sanctions Tier-1 Deny / Tier-2 Close-out ────────────────────

    /// @dev Retail policy (per project memory + ProfileFacet
    ///      `_assertNotSanctioned` placement): Tier-1 entry points
    ///      (createOffer, acceptOffer, getOrCreateUserVault,
    ///      adoptUntracked, etc.) revert SanctionedAddress for
    ///      flagged callers. Tier-2 close-out paths (repayLoan,
    ///      claimAsBorrower, markDefaulted) STAY OPEN so the
    ///      unflagged counterparty can be made whole.
    ///
    ///      Scenario (the lender's offer is posted a step earlier):
    ///        1. the borrower fills it (Tier-1 entry paths must succeed
    ///           BEFORE we flag).
    ///        2. Flag `borrower` on the oracle.
    ///        3. Try `borrower.createOffer(...)` — should revert
    ///           SanctionedAddress (Tier-1 deny).
    ///        4. Try `borrower.repayLoan(activeLoanId)` — should
    ///           SUCCEED (Tier-2 close-out stays open).
    ///        5. Unflag and verify createOffer succeeds again.
    function _sanctionsTier1Deny(uint256 offerId) internal {
        // Step 1: the borrower fills the lender's offer (normal path,
        // pre-flag).
        uint256 loanId = _acceptAs(borrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        console.log("Pre-flag loan initiated:", loanId);

        // Step 2: flag borrower on the sanctions oracle, recorded first so
        // an abandoned run can clear it.
        _toRestore(SANCTIONS_FLAG, uint256(uint160(borrower)));
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
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _borrowerOfferStandard(), type(uint64).max),
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
        // Step 1: admin pauses USDC, recorded first so an abandoned run can
        // unpause it.
        _toRestore(ASSET_PAUSE, uint256(uint160(address(usdc))));
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
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _lenderOfferStandard(), type(uint64).max),
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
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard(), type(uint64).max);
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
        _toRestore(GLOBAL_PAUSE, 1);
        vm.startBroadcast(adminKey);
        AdminFacet(diamond).pause();
        vm.stopBroadcast();
        require(AdminFacet(diamond).paused(), "PF-322: paused() should be true");
        console.log("Diamond globally paused; paused() == true");
        // A whenNotPaused entry point is refused while paused. Probed in
        // the simulation only (`RevertProbe`, see PF-008).
        _requireRefused(
            lender,
            abi.encodeWithSelector(OfferCreateFacet.createOffer.selector, _lenderOfferStandard(), type(uint64).max),
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
        uint256 offerId = OfferCreateFacet(diamond).createOffer(_lenderOfferStandard(), type(uint64).max);
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
    ///      The scenario walks the shape the deployment has. It no longer
    ///      switches an external-treasury deployment to the Diamond for the
    ///      withdrawal half: since #3431 a vault pays treasury fees only to
    ///      the treasury fixed in its code, and since #3569 that code is the
    ///      only place the treasury is written: moving it is new vault code
    ///      through the beacon's wait, not a call this scenario can make. The
    ///      withdrawal half therefore runs only on a Diamond-as-treasury
    ///      deployment.
    ///
    ///      The fee checked is the initiation fee, read from what the
    ///      borrower received (principal less the fee). Interest-side fees
    ///      round to zero here: the loan lives a few seconds, and 5% APR on
    ///      1,000 USDC for that long is below one USDC unit. So the checks
    ///      are "at least the fee", never an exact interest share;
    ///      TreasuryFacetTest covers duration-bearing fees with warped time.
    function _treasuryAccrual(uint256 offerId) internal {
        address treasury = AdminFacet(diamond).getTreasury();
        bool diamondIsTreasury = treasury == diamond;
        console.log("Treasury:", treasury);
        console.log(diamondIsTreasury
            ? "Topology: the Diamond is the treasury (fees held, then withdrawn)"
            : "Topology: external treasury (fees leave the Diamond as collected)");

        if (!diamondIsTreasury) {
            uint256 walletBefore = usdc.balanceOf(treasury);
            uint256 heldBefore = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
            uint256 fee = _fillRoundTrip(offerId);
            require(
                usdc.balanceOf(treasury) - walletBefore >= fee,
                "PF-329: the external treasury should receive at least the initiation fee"
            );
            require(
                TreasuryFacet(diamond).getTreasuryBalance(address(usdc)) == heldBefore,
                "PF-329: an external treasury leaves nothing held at the Diamond"
            );
            console.log("External treasury received the initiation fee; nothing held at the Diamond");
            console.log("Withdrawal half not run: it needs a Diamond-as-treasury deployment (#3569)");
            _logVpfiTreasurySurface();
            return;
        }

        uint256 heldStart = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        uint256 heldFee = _fillRoundTrip(offerId);
        uint256 held = TreasuryFacet(diamond).getTreasuryBalance(address(usdc));
        require(held - heldStart >= heldFee, "PF-329: a Diamond treasury should hold at least the initiation fee");
        console.log("USDC held at the Diamond for the treasury:", held);

        uint256 adminBefore = usdc.balanceOf(admin);
        vm.startBroadcast(adminKey);
        TreasuryFacet(diamond).claimTreasuryFees(address(usdc), admin);
        vm.stopBroadcast();
        require(
            TreasuryFacet(diamond).getTreasuryBalance(address(usdc)) == 0,
            "PF-329: the withdrawal should clear the held USDC balance"
        );
        require(
            usdc.balanceOf(admin) - adminBefore == held,
            "PF-329: the admin should receive exactly the held balance"
        );
        console.log("Admin withdrew the held treasury USDC:", held);

        _logVpfiTreasurySurface();
    }

    /// @dev VPFI treasury surface: CALL-SURFACE ONLY, and labelled as such
    ///      (#1555 r3). No current positive flow in this drive produces VPFI
    ///      treasury revenue: the HoldOnly LIF (#1352) takes no VPFI custody,
    ///      and the Full tariff credits the recycle bucket, not treasury. So
    ///      this reads the balance of whatever VPFI token the Diamond names and
    ///      asserts nothing about its size; inventing a source to make the
    ///      assertion look strong would claim a flow that did not run. Real
    ///      VPFI treasury accrual is covered by TreasuryFacetTest. The token is
    ///      read from the Diamond because this module deploys no VPFI of its
    ///      own (#848 Phase 1; the old suite read the mock its VPFI scenario
    ///      had left wired).
    function _logVpfiTreasurySurface() internal view {
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

    /// @dev `newLender`'s standard offer, for a later step to fill with
    ///      {_fillRoundTrip}.
    function _postRoundTripOffer() internal returns (uint256) {
        return _createLenderOffer(newLenderKey);
    }

    /// @dev One standard loan, opened by `newBorrower` against `newLender`'s
    ///      offer `offerId`, repaid in full and claimed by both. Returns the
    ///      loan initiation fee net of the matcher's share, read from what the
    ///      borrower received in its vault and wallet together.
    function _fillRoundTrip(uint256 offerId) internal returns (uint256 initiationFee) {
        // The net principal lands in the borrower's vault (#3205 part 2); the
        // matcher's share of the fee, which on a direct accept is the
        // borrower's, still goes to its wallet. Both count as received.
        uint256 vaultBefore = _vaultBalance(usdc, newBorrower);
        uint256 walletBefore = usdc.balanceOf(newBorrower);
        uint256 loanId = _acceptAs(newBorrowerKey, offerId, address(weth), COLLATERAL_AMOUNT);
        uint256 received =
            (_vaultBalance(usdc, newBorrower) - vaultBefore) + (usdc.balanceOf(newBorrower) - walletBefore);
        require(received < LOAN_AMOUNT, "the borrower paid no initiation fee");
        initiationFee = LOAN_AMOUNT - received;
        console.log("Loan / initiation fee:", loanId, initiationFee);

        vm.startBroadcast(newBorrowerKey);
        uint256 repayAmt = RepayFacet(diamond).calculateRepaymentAmount(loanId);
        usdc.approve(diamond, _repayAllowance(loanId, repayAmt));
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
    ///      The range master flags are not used here: they gated nothing
    ///      and were retired in #2812 (ranged offers are always on), so
    ///      they could not show a knob affecting a flow.
    /// @dev `ConfigFacet`'s fee ceiling (its private `MAX_FEE_BPS`, 50%),
    ///      which the setter names in `InvalidFeeBps`.
    uint256 private constant FEE_CAP_BPS = 5_000;

    /// @dev Steps 1 and 2: the loan at the configured fee, the refusal above
    ///      the cap, and the new fee landing. Posts the offer the third step
    ///      fills at the new fee.
    function _changeFeeKnob(uint256 offerId) internal {
        (uint256 treasuryBps, uint256 originalLifBps) = ConfigFacet(diamond).getFeesConfig();
        console.log("Loan initiation fee bps pre:", originalLifBps);
        require(
            _fillRoundTrip(offerId) == _netInitiationFee(originalLifBps),
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
        // Step down instead of up when the current fee is near the cap. The
        // original is recorded first, so an abandoned run puts it back.
        uint256 newLifBps = originalLifBps + 10 <= FEE_CAP_BPS ? originalLifBps + 10 : originalLifBps - 10;
        _toRestore(INITIATION_FEE, originalLifBps);
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setFeesConfig(uint16(treasuryBps), uint16(newLifBps));
        vm.stopBroadcast();
        (, uint256 lifBps) = ConfigFacet(diamond).getFeesConfig();
        require(lifBps == newLifBps, "PF-324: the getter should report the new initiation fee");
        require(
            ConfigFacet(diamond).getLoanInitiationFeeBps() == newLifBps,
            "PF-324: the single-field getter should agree"
        );
        _keep(OFFER_AT_NEW_FEE, _postRoundTripOffer());
    }

    /// @dev Step 3: the next loan pays the new fee, and the original comes
    ///      back. The original is the value recorded to put back.
    function _nextLoanPaysNewFee(uint256 offerId) internal {
        (uint256 treasuryBps, uint256 lifBps) = ConfigFacet(diamond).getFeesConfig();
        require(
            _fillRoundTrip(offerId) == _netInitiationFee(lifBps),
            "PF-324: the next loan should pay the new initiation fee"
        );
        console.log("The next loan paid the new initiation fee at bps:", lifBps);

        // Restores the effective value read before the change. Where the
        // fee was on its library default, it is now stored as an explicit
        // value equal to that default (`setFeesConfig` has no "keep the
        // default" input other than 0, and the getter does not say which was
        // set).
        uint256 originalLifBps = _restoreValueOf(INITIATION_FEE);
        vm.startBroadcast(adminKey);
        ConfigFacet(diamond).setFeesConfig(uint16(treasuryBps), uint16(originalLifBps));
        vm.stopBroadcast();
        (, lifBps) = ConfigFacet(diamond).getFeesConfig();
        require(lifBps == originalLifBps, "PF-324: the original initiation fee should be restored");
    }

    /// @dev What `_fillRoundTrip` measures as the fee: the initiation fee on
    ///      LOAN_AMOUNT at `lifBps`, less the matcher's share, which goes
    ///      back to the accepting borrower (the matcher on a direct accept).
    ///      The round-trip borrower holds no VPFI, so no discount applies.
    function _netInitiationFee(uint256 lifBps) internal view returns (uint256) {
        uint256 gross = (LOAN_AMOUNT * lifBps) / 10_000;
        return gross - (gross * ConfigFacet(diamond).getLifMatcherFeeBps()) / 10_000;
    }
}
