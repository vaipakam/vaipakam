// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PositiveFlowsBase} from "./PositiveFlowsBase.sol";
import {LibVaipakam} from "../../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../../src/libraries/LibMetricsTypes.sol";
import {LibOfferMatch} from "../../src/libraries/LibOfferMatch.sol";
import {OfferCreateFacet} from "../../src/facets/OfferCreateFacet.sol";
import {OfferMatchIntentFacet} from "../../src/facets/OfferMatchIntentFacet.sol";
import {LenderIntentFacet} from "../../src/facets/LenderIntentFacet.sol";
import {RiskPreviewFacet} from "../../src/facets/RiskPreviewFacet.sol";
import {MetricsFacet} from "../../src/facets/MetricsFacet.sol";
import {ConfigFacet} from "../../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../../src/facets/LoanFacet.sol";
import {ClaimFacet} from "../../src/facets/ClaimFacet.sol";

/**
 * @title PositiveFlowsLenderIntent
 * @notice Standing lender intents (#848 Phase 2): a lender registers bounds
 *         for an asset pair and funds working capital; a solver fills a
 *         borrower offer against it; the lender pauses it with capital still
 *         reserved, withdraws, or rolls a repaid loan's proceeds back in.
 *
 *         Each step is checked against both views a lender or keeper reads:
 *         the per-owner list (`getLenderIntentsByOwner`, which keeps a paused
 *         intent while it holds capital) and the global keeper feed
 *         (`getActiveLenderIntents`, which lists an intent only while it is
 *         active and funded for at least one fill).
 *
 *         The fill path needs two admin switches, `partialFillEnabled` and
 *         `lenderIntentEnabled`. A scenario skips, saying so, when partial
 *         fills are off; it turns the intent switch on for its own run and
 *         puts it back as it found it. Fixture, runner and ids:
 *         {PositiveFlowsBase}.
 */
contract PositiveFlowsLenderIntent is PositiveFlowsBase {
    /// @dev The intent's bounds. The 50% LTV ceiling sizes a 1,000 USDC fill
    ///      at about 1 WETH (the fixture prices WETH at $2,000), above the
    ///      protocol's own HF-1.5 floor of about 0.88 WETH: a ceiling looser
    ///      than that floor makes the slice unfillable. The borrower offer
    ///      posts 2 WETH so it covers the sized amount with room to spare.
    uint256 private constant MAX_EXPOSURE = 2 * LOAN_AMOUNT;
    uint256 private constant MIN_FILL = LOAN_AMOUNT / 2;
    uint16 private constant MAX_INIT_LTV_BPS = 5_000;
    uint256 private constant REQUEST_COLLATERAL = 2 * COLLATERAL_AMOUNT;

    function moduleName() public pure override returns (string memory) {
        return "PositiveFlowsLenderIntent";
    }

    function scenarios() public pure override returns (Scenario[] memory list) {
        list = new Scenario[](2);
        list[0] = Scenario("PF-070", "Standing intent: register, fund, solver fill, pause with capital reserved, withdraw",
            "PF-070, PF-073, PF-071, PF-072");
        list[1] = Scenario("PF-074", "A repaid intent loan rolls its proceeds back into the intent's capital",
            "PF-074, PF-073");
    }

    function _runScenario(uint256 index) internal override {
        bool partialFill = ConfigFacet(diamond).getPartialFillEnabled();
        if (!partialFill) {
            return _skip("partial fills are off (partialFillEnabled=false), so no intent can be filled");
        }
        bool intentWasEnabled = LenderIntentFacet(diamond).isLenderIntentEnabled();
        if (!intentWasEnabled) _setIntentSwitch(true);

        if (index == 0) _intentLifecycle();
        else if (index == 1) _intentRoll();
        else revert("PositiveFlowsLenderIntent: no scenario at index");

        if (!intentWasEnabled) _setIntentSwitch(false);
    }

    // ─── PF-070 / PF-073 / PF-071 / PF-072 ────────────────────────────────

    function _intentLifecycle() internal {
        // PF-070: a bare registration is listed for its owner but not offered
        // to keepers, since it commits no capital.
        _setIntent();
        _requireOwnerRow(true, 0, 0, "PF-070: a registered intent should be listed for its owner, active, unfunded");
        require(!_inKeeperFeed(), "PF-070: an unfunded intent should not be in the keeper feed");

        _fundIntent(MAX_EXPOSURE);
        _requireOwnerRow(true, MAX_EXPOSURE, 0, "PF-070: the funded capital should show in the owner view");
        require(_inKeeperFeed(), "PF-070: a funded intent should be in the keeper feed");
        console.log("Intent registered and funded:", MAX_EXPOSURE);

        // PF-073: a solver fills a borrower offer against the intent.
        uint256 loanId = _fillFromIntent(LOAN_AMOUNT);
        _requireOwnerRow(true, MAX_EXPOSURE - LOAN_AMOUNT, LOAN_AMOUNT,
            "PF-073: the fill should move its principal from capital to live principal");

        // PF-071: pausing (cancelling) leaves the reserved capital in place,
        // listed for the owner, out of the keeper feed, and closed to new
        // capital.
        vm.startBroadcast(lenderKey);
        LenderIntentFacet(diamond).cancelLenderIntent(address(usdc), address(weth));
        vm.stopBroadcast();
        _requireOwnerRow(false, MAX_EXPOSURE - LOAN_AMOUNT, LOAN_AMOUNT,
            "PF-071: a paused intent should stay listed with its reserved capital");
        require(!_inKeeperFeed(), "PF-071: a paused intent should leave the keeper feed");
        _requireRefused(
            lender,
            abi.encodeWithSelector(
                LenderIntentFacet.fundLenderIntent.selector, address(usdc), address(weth), LOAN_AMOUNT
            ),
            abi.encodeWithSelector(LenderIntentFacet.LenderIntentNotActive.selector),
            "PF-071: a paused intent should refuse new capital (LenderIntentNotActive)"
        );
        console.log("Intent paused with capital reserved:", MAX_EXPOSURE - LOAN_AMOUNT);

        // PF-072: withdrawing the rest tears the intent down; it leaves the
        // owner view while its one loan runs on.
        uint256 walletBefore = usdc.balanceOf(lender);
        vm.startBroadcast(lenderKey);
        LenderIntentFacet(diamond).withdrawLenderIntentCapital(
            address(usdc), address(weth), MAX_EXPOSURE - LOAN_AMOUNT
        );
        vm.stopBroadcast();
        require(
            usdc.balanceOf(lender) - walletBefore == MAX_EXPOSURE - LOAN_AMOUNT,
            "PF-072: the withdrawn capital should reach the lender's wallet"
        );
        require(_intentCapital() == 0, "PF-072: no capital should remain reserved");
        require(_ownerRowIndex() == type(uint256).max, "PF-072: a torn-down intent should leave the owner view");
        require(
            _livePrincipal() == LOAN_AMOUNT,
            "PF-072: the open loan's principal should still count against the intent"
        );
        console.log("Intent capital withdrawn; the open loan runs on");

        // The loan settles normally; the lender's claim releases its exposure.
        _repayInFull(borrowerKey, loanId);
        _claimBoth(lenderKey, borrowerKey, loanId);
        require(_livePrincipal() == 0, "PF-072: the lender's claim should release the loan's exposure");
    }

    // ─── PF-074 ───────────────────────────────────────────────────────────

    /// @dev The owner rolls a repaid intent loan: its proceeds (principal plus
    ///      the lender's interest, net of the treasury's share) become intent
    ///      capital again instead of a wallet payout, and the lender claim is
    ///      consumed. The owner then winds the intent down.
    function _intentRoll() internal {
        _setIntent();
        _fundIntent(LOAN_AMOUNT);
        uint256 loanId = _fillFromIntent(LOAN_AMOUNT);
        require(_intentCapital() == 0, "PF-074: the fill should draw the whole funded capital");

        _repayInFull(borrowerKey, loanId);
        (address asset, uint256 proceeds, bool claimedBefore,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(asset == address(usdc) && proceeds > LOAN_AMOUNT && !claimedBefore,
            "PF-074: the repaid loan should owe the lender principal plus interest");

        uint256 walletBefore = usdc.balanceOf(lender);
        vm.startBroadcast(lenderKey);
        LenderIntentFacet(diamond).rollIntentLoan(loanId);
        vm.stopBroadcast();
        require(usdc.balanceOf(lender) == walletBefore, "PF-074: a roll should pay nothing to the wallet");
        require(_intentCapital() == proceeds, "PF-074: the whole lender claim should become intent capital");
        require(_livePrincipal() == 0, "PF-074: the rolled loan should release its exposure");
        (,, bool claimed,,,,,) = ClaimFacet(diamond).getClaimable(loanId, true);
        require(claimed, "PF-074: the lender claim should be consumed by the roll");
        _requireOwnerRow(true, proceeds, 0, "PF-074: the owner view should show the rolled capital");
        console.log("Repaid intent loan rolled into capital:", proceeds);

        // Wind down: pause, withdraw everything, and the borrower claims.
        vm.startBroadcast(lenderKey);
        LenderIntentFacet(diamond).cancelLenderIntent(address(usdc), address(weth));
        LenderIntentFacet(diamond).withdrawLenderIntentCapital(address(usdc), address(weth), proceeds);
        vm.stopBroadcast();
        require(usdc.balanceOf(lender) - walletBefore == proceeds, "PF-074: the rolled capital should be withdrawable");
        vm.startBroadcast(borrowerKey);
        ClaimFacet(diamond).claimAsBorrower(loanId);
        vm.stopBroadcast();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _setIntentSwitch(bool enabled) internal {
        vm.startBroadcast(adminKey);
        LenderIntentFacet(diamond).setLenderIntentEnabled(enabled);
        vm.stopBroadcast();
        require(LenderIntentFacet(diamond).isLenderIntentEnabled() == enabled, "the intent switch should land");
    }

    /// @dev `lender` registers (or re-registers) the module's intent on the
    ///      USDC/WETH pair, openly fillable.
    function _setIntent() internal {
        vm.startBroadcast(lenderKey);
        LenderIntentFacet(diamond).setLenderIntent(
            address(usdc), address(weth), MAX_EXPOSURE, INTEREST_BPS, MAX_INIT_LTV_BPS,
            uint32(DURATION_DAYS), MIN_FILL, false, true
        );
        vm.stopBroadcast();
        LibVaipakam.LenderIntent memory intent =
            LenderIntentFacet(diamond).getLenderIntent(lender, address(usdc), address(weth));
        require(
            intent.active && intent.maxExposure == MAX_EXPOSURE && intent.minRateBps == INTEREST_BPS
                && intent.maxInitLtvBps == MAX_INIT_LTV_BPS && intent.minFillAmount == MIN_FILL,
            "PF-070: the intent should read back with the bounds it was set with"
        );
    }

    function _fundIntent(uint256 amount) internal {
        uint256 walletBefore = usdc.balanceOf(lender);
        uint256 capitalBefore = _intentCapital();
        vm.startBroadcast(lenderKey);
        usdc.approve(diamond, amount);
        LenderIntentFacet(diamond).fundLenderIntent(address(usdc), address(weth), amount);
        vm.stopBroadcast();
        require(walletBefore - usdc.balanceOf(lender) == amount, "PF-070: funding should pull exactly the amount");
        require(_intentCapital() == capitalBefore + amount, "PF-070: funding should add to the intent's capital");
    }

    /// @dev `borrower` posts a full-term, full-repay-only borrower offer (the
    ///      two terms an intent fill requires) and `newLender`, as solver,
    ///      fills `amount` of it against the intent. The loan must carry what
    ///      `previewIntent` said it would, inside the intent's bounds.
    function _fillFromIntent(uint256 amount) internal returns (uint256 loanId) {
        LibVaipakam.CreateOfferParams memory request = _borrowerOfferStandard();
        request.interestRateBpsMax = INTEREST_BPS + 100;
        request.useFullTermInterest = true;
        request.collateralAmount = REQUEST_COLLATERAL;
        request.collateralAmountMax = REQUEST_COLLATERAL;
        vm.startBroadcast(borrowerKey);
        weth.approve(diamond, REQUEST_COLLATERAL);
        uint256 requestId = OfferCreateFacet(diamond).createOffer(request);
        vm.stopBroadcast();

        uint256 capitalBefore = _intentCapital();
        uint256 liveBefore = _livePrincipal();
        LibOfferMatch.IntentPreviewResult memory preview = RiskPreviewFacet(diamond).previewIntent(
            newLender, newLender, lender, address(usdc), address(weth), requestId, amount
        );
        require(preview.ok, "PF-073: the fill should preview clear");

        vm.startBroadcast(newLenderKey);
        loanId = OfferMatchIntentFacet(diamond).matchIntent(lender, address(usdc), address(weth), requestId, amount);
        vm.stopBroadcast();

        LibVaipakam.Loan memory loan = LoanFacet(diamond).getLoanDetails(loanId);
        require(loan.status == LibVaipakam.LoanStatus.Active, "PF-073: the fill should open an Active loan");
        require(loan.lender == lender, "PF-073: the intent owner should be the lender of record");
        require(loan.borrower == borrower, "PF-073: the offer's creator should be the borrower");
        require(loan.matcher == newLender, "PF-073: the solver should be recorded as matcher");
        require(loan.principal == amount, "PF-073: the principal should be the fill amount");
        require(loan.collateralAmount == preview.reqCollateral, "PF-073: the collateral should be what the preview sized");
        require(loan.interestRateBps == preview.matchRateBps, "PF-073: the rate should be what the preview said");
        require(
            loan.interestRateBps >= INTEREST_BPS && loan.durationDays <= DURATION_DAYS,
            "PF-073: the loan should sit inside the intent's rate floor and term"
        );
        require(loan.useFullTermInterest && !loan.allowsPartialRepay,
            "PF-073: an intent loan should be full-term and full-repay-only");
        require(_intentCapital() == capitalBefore - amount, "PF-073: the fill should draw its principal from the capital");
        require(_livePrincipal() == liveBefore + amount, "PF-073: the fill should add to the live principal");
        console.log("Solver filled the intent; loanId / rate bps:", loanId, loan.interestRateBps);
    }

    function _intentCapital() internal view returns (uint256) {
        return LenderIntentFacet(diamond).getLenderIntentCapital(lender, address(usdc), address(weth));
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentFacet(diamond).getLenderIntentLivePrincipal(lender, address(usdc), address(weth));
    }

    /// @dev Requires the owner view to list the module's intent with exactly
    ///      this state.
    function _requireOwnerRow(bool active, uint256 capital, uint256 live, string memory failure) internal view {
        uint256 i = _ownerRowIndex();
        require(i != type(uint256).max, failure);
        (LibMetricsTypes.OwnerLenderIntentSummary[] memory rows,) =
            LenderIntentFacet(diamond).getLenderIntentsByOwner(lender, i, 1);
        require(
            rows[0].active == active && rows[0].intent.availableCapital == capital
                && rows[0].intent.livePrincipal == live,
            failure
        );
    }

    /// @dev Index of the module's intent in `lender`'s owner view, or
    ///      `type(uint256).max` when it is not listed.
    function _ownerRowIndex() internal view returns (uint256) {
        (LibMetricsTypes.OwnerLenderIntentSummary[] memory rows, uint256 total) =
            LenderIntentFacet(diamond).getLenderIntentsByOwner(lender, 0, type(uint256).max);
        require(rows.length == total, "the owner view should return every row in one page");
        for (uint256 i; i < rows.length; ++i) {
            if (rows[i].intent.lendingAsset == address(usdc) && rows[i].intent.collateralAsset == address(weth)) {
                return i;
            }
        }
        return type(uint256).max;
    }

    function _inKeeperFeed() internal view returns (bool) {
        (LibMetricsTypes.LenderIntentSummary[] memory rows, uint256 total) =
            MetricsFacet(diamond).getActiveLenderIntents(0, type(uint256).max);
        require(rows.length == total, "the keeper feed should return every row in one page");
        for (uint256 i; i < rows.length; ++i) {
            if (
                rows[i].owner == lender && rows[i].lendingAsset == address(usdc)
                    && rows[i].collateralAsset == address(weth)
            ) return true;
        }
        return false;
    }
}
