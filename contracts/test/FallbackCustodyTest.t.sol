// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CustodyInvariantBase} from "./invariants/CustodyInvariantBase.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
import {LibFallbackCustody} from "../src/libraries/LibFallbackCustody.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RiskFacet} from "../src/facets/RiskFacet.sol";
import {DefaultedFacet} from "../src/facets/DefaultedFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {AddCollateralFacet} from "../src/facets/AddCollateralFacet.sol";
import {RiskMatchLiquidationFacet} from "../src/facets/RiskMatchLiquidationFacet.sol";
import {FallbackCustodyFacet} from "../src/facets/FallbackCustodyFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../src/VaipakamVaultImplementation.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {EncumbranceMutateFacet} from "../src/facets/EncumbranceMutateFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {VaipakamNFTFacet} from "../src/facets/VaipakamNFTFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  FallbackCustodyTest
 * @notice #1566 slice 2 (S2b): liquidation-fallback custody rests in the
 *         borrower's vault under the loan's collateral lien, never in the
 *         Diamond, and every unit of it moves by a named row move.
 *
 *         The rule under test (owner-ratified Option F, #2141): no user asset
 *         rests in protocol custody across transactions. A failed liquidation
 *         or default swap returns the collateral to `loan.borrower`'s vault in
 *         the failing transaction, re-liens it, records it as the loan's
 *         fallback custody row, and every later consumer (the in-kind lender
 *         claim, the claim-time retry, the backstop absorb, the cure by
 *         top-up, the curing repayment, the internal match) moves the row and
 *         the lien together, with one `FallbackCustodyMoved` event per move.
 *         A pre-slice row that still rests in the Diamond (O1 = A: no
 *         migration) fails closed by name, `FallbackCustodyNotVaultHeld`.
 *
 * @dev    Cells F1-F17 and F19-F21 of the S2b brief (F18/F18b, the
 *         DefaultedFacet VPFI restamp, live in their own file with S2c).
 *         Every cell first asserts that its fixture is LIVE, then checks the
 *         property, at a straddle wherever the property has a threshold.
 *         Fixtures drive the REAL producer: a real loan, liquidated or
 *         defaulted through the real entry point with the harness's
 *         permanently reverting swap venue, so the fallback is entered by
 *         `FallbackCustodyFacet.enterFallback` itself. Nothing here mocks
 *         `vaultWithdrawERC20`. Raw state is written only where a shape cannot
 *         be reached through real flows at the harness's 1:1 prices, and each
 *         such cell says why (F9, F16, F16b).
 *
 *         Harness: {CustodyInvariantBase}, the full production cut of
 *         SetupTest with an EXTERNAL treasury (the documented mainnet
 *         topology, so a treasury slice is an observable transfer; F20 flips
 *         it to the Diamond on purpose), VPFI as a liquid collateral priced at
 *         1 USD, one always-reverting and one paying swap venue, a seeded
 *         backstop, internal matching on, and a scriptable sanctions oracle.
 */
contract FallbackCustodyTest is CustodyInvariantBase {
    uint256 internal constant FC_HF_HEALTHY = 2e18;
    uint256 internal constant FC_HF_LIQUIDATABLE = 0.9e18;
    /// @dev Inside every admission cap the harness's loans are born under.
    uint256 internal constant FC_LTV_HEALTHY = 5_000;
    /// @dev Above the 8500 tier floor plus the widest external-liquidation
    ///      priority window, below the 11000 value-collapse threshold.
    uint256 internal constant FC_LTV_LIQUIDATABLE = 9_600;
    uint256 internal constant FC_LOAN_DAYS = 30;
    /// @dev Past every default-schedule grace bucket for a 30-day term.
    uint256 internal constant FC_PAST_EVERY_GRACE = 8 days;
    uint256 internal constant FC_RATE_BPS = 1_000;
    uint256 internal constant FC_PRINCIPAL = 1_000e18;
    uint256 internal constant FC_COLLATERAL = 2_000e18;
    /// @dev The reverse-pair counterparty used by the internal-match cells:
    ///      WETH principal, USDC collateral at twice that (above the offer
    ///      create floor at 1:1).
    uint256 internal constant FC_REVERSE_PRINCIPAL = 600e18;
    uint256 internal constant FC_REVERSE_COLLATERAL = 1_200e18;

    /// @notice One decoded `FallbackCustodyMoved`.
    struct FcMove {
        uint8 move;
        address counterparty;
        address asset;
        uint256 amount;
        uint256 custodyAfter;
    }

    /// @notice The two legs of one decoded `InternalMatchExecuted` (2-way).
    struct FcMatch {
        uint256 movedX;
        uint256 movedY;
        uint256 incentiveX;
        uint256 incentiveY;
    }

    address internal fcLender;
    address internal fcLender2;
    address internal fcBorrower;
    uint256 internal fcBorrowerPk;
    address internal fcBorrower2;
    uint256 internal fcBorrower2Pk;
    address internal fcMatcher;

    function setUp() public {
        _deployCustodyHarness();
        fcLender = custodyLenders[0];
        fcLender2 = custodyLenders[1];
        fcBorrower = custodyBorrowers[0];
        fcBorrowerPk = custodyBorrowerPks[0];
        fcBorrower2 = custodyBorrowers[1];
        fcBorrower2Pk = custodyBorrowerPks[1];
        fcMatcher = makeAddr("fallbackCustodyMatcher");
        // Fixture-live: the harness leaves none of either collateral in the
        // Diamond, so every Diamond balance below starts from a known zero.
        assertEq(IERC20(weth).balanceOf(address(diamond)), 0, "genesis: no WETH in the Diamond");
        assertEq(IERC20(vpfi).balanceOf(address(diamond)), 0, "genesis: no VPFI in the Diamond");
    }

    // =====================================================================
    //  F1-F5: the producer
    // =====================================================================

    /// @notice F1. An HF liquidation whose every venue reverts enters
    ///         FallbackPending with the collateral back in the borrower's
    ///         vault, recorded there, under a lien over all of it, as one
    ///         `Entered` row move. The Diamond keeps nothing.
    /// @dev    Kills: custody left in the Diamond (the S2a body); the lien or
    ///         the tracked record missing; an entry with no event.
    function test_F1_liquidationFallback_custodyReturnsToTheVaultUnderLien() public {
        uint256 id = _fcForward(weth);
        address bVault = _fcVault(fcBorrower);
        uint256 diamond0 = _fcBal(weth, address(diamond));
        uint256 vault0 = _fcBal(weth, bVault);
        uint256 tracked0 = _fcTracked(fcBorrower, weth);
        assertEq(vault0, FC_COLLATERAL, "fixture-live: the collateral is in the borrower's vault");
        assertEq(_fcLien(id), FC_COLLATERAL, "fixture-live: liened at origination");

        vm.recordLogs();
        _fcLiquidateToFallback(id);
        FcMove[] memory moves = _fcMoves(vm.getRecordedLogs(), id);

        assertEq(_fcSnapshotTotal(id), FC_COLLATERAL, "fixture-live: the split covers the whole collateral");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond keeps nothing");
        assertEq(_fcBal(weth, bVault), vault0, "the collateral is back in the borrower's vault");
        assertEq(_fcTracked(fcBorrower, weth), tracked0, "and recorded there");
        assertEq(_fcLien(id), FC_COLLATERAL, "under a lien over all of it");
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(fcBorrower, weth, 0),
            FC_COLLATERAL,
            "the encumbrance aggregate agrees"
        );
        (uint256 row, uint256 legacy) = _fcCustody(id);
        assertEq(row, FC_COLLATERAL, "the custody row is the whole collateral");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        assertEq(moves.length, 1, "exactly one custody move");
        _fcAssertMove(moves[0], LibFallbackCustody.Move.Entered, fcBorrower, weth, FC_COLLATERAL, FC_COLLATERAL);
    }

    /// @notice F2. The same entry through the time-based default.
    /// @dev    Kills: DefaultedFacet keeping its own (Diamond-held) copy of the
    ///         producer.
    function test_F2_defaultFallback_custodyReturnsToTheVaultUnderLien() public {
        uint256 id = _fcForward(weth);
        address bVault = _fcVault(fcBorrower);
        uint256 diamond0 = _fcBal(weth, address(diamond));
        uint256 vault0 = _fcBal(weth, bVault);
        uint256 tracked0 = _fcTracked(fcBorrower, weth);

        LibVaipakam.Loan memory l = _fcLoan(id);
        vm.warp(uint256(l.startTime) + l.durationDays * 1 days + FC_PAST_EVERY_GRACE);
        vm.recordLogs();
        DefaultedFacet(address(diamond)).triggerDefault(id, _fcRoute(true));
        FcMove[] memory moves = _fcMoves(vm.getRecordedLogs(), id);

        assertEq(
            uint8(_fcStatus(id)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the default entered FallbackPending"
        );
        assertEq(_fcSnapshotTotal(id), FC_COLLATERAL, "fixture-live: the split covers the whole collateral");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond keeps nothing");
        assertEq(_fcBal(weth, bVault), vault0, "the collateral is back in the borrower's vault");
        assertEq(_fcTracked(fcBorrower, weth), tracked0, "and recorded there");
        assertEq(_fcLien(id), FC_COLLATERAL, "under a lien over all of it");
        (uint256 row, uint256 legacy) = _fcCustody(id);
        assertEq(row, FC_COLLATERAL, "the custody row is the whole collateral");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        assertEq(moves.length, 1, "exactly one custody move");
        _fcAssertMove(moves[0], LibFallbackCustody.Move.Entered, fcBorrower, weth, FC_COLLATERAL, FC_COLLATERAL);
    }

    /// @notice F3. VPFI custody is liened in the vault: the borrower can take
    ///         out exactly their unrelated free deposit, not one unit more.
    /// @dev    Straddle: `d` succeeds, `d + 1` reverts with the free figure
    ///         `d`. Kills: the lien missing from the entry (the whole vault
    ///         would read free).
    function test_F3_vpfiFallback_onlyTheFreeDepositIsWithdrawable() public {
        uint256 id = _fcForward(vpfi);
        uint256 d = 300e18;
        _fcDepositVpfi(fcBorrower, d);
        _fcLiquidateToFallback(id);
        assertEq(_fcRow(id), FC_COLLATERAL, "fixture-live: the custody is vault-held");
        assertEq(_fcTracked(fcBorrower, vpfi), FC_COLLATERAL + d, "fixture-live: custody plus the free deposit");

        vm.prank(fcBorrower);
        vm.expectRevert(abi.encodeWithSelector(VPFIDiscountFacet.VPFIEncumberedByActiveLoan.selector, d + 1, d));
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(d + 1);

        uint256 wallet0 = _fcBal(vpfi, fcBorrower);
        vm.prank(fcBorrower);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(d);
        assertEq(_fcBal(vpfi, fcBorrower) - wallet0, d, "the free deposit is withdrawable");
        assertEq(_fcRow(id), FC_COLLATERAL, "the custody row is untouched");
        assertEq(_fcLien(id), FC_COLLATERAL, "and so is its lien");
    }

    /// @notice F4. VPFI custody is kept out of the borrower's fee tier, and the
    ///         entry never stamps the tier below the borrower's own VPFI.
    /// @dev    The liquidation runs on a fresh day so the day slot holds only
    ///         its own stamps. Kills: no FallbackPending tier clause (the stamp
    ///         would count the custody); the exclusion installed BEFORE the
    ///         deposit (a stamp at `own - custody` would pull the day minimum
    ///         below `own`).
    function test_F4_vpfiFallback_tierExcludesTheCustody_noDip() public {
        uint256 id = _fcForward(vpfi);
        uint256 own = 500e18;
        _fcDepositVpfi(fcBorrower, own);
        vm.warp(block.timestamp + 1 days);
        _fcLiquidateToFallback(id);
        uint256 tracked = _fcTracked(fcBorrower, vpfi);
        assertEq(tracked, FC_COLLATERAL + own, "fixture-live: custody plus the borrower's own VPFI");

        (address bv, uint256 bVpfi) = _fcBorrowerExclusion(id);
        assertEq(bv, fcBorrower, "the borrower's vault carries the exclusion");
        assertEq(bVpfi, FC_COLLATERAL, "of exactly the custody row");
        assertEq(
            EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(fcBorrower),
            FC_COLLATERAL,
            "the aggregate agrees"
        );
        (uint256 dayMin, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked - FC_COLLATERAL, "the stamp counts only the borrower's own VPFI");
        assertGe(dayMin, tracked - FC_COLLATERAL, "and never dipped below it during the entry");
    }

    /// @notice F5. The FallbackPending tier clause is VPFI-only: a WETH entry
    ///         excludes nothing, while the same entry on VPFI excludes its row.
    /// @dev    Kills: the clause applied to every collateral asset.
    function test_F5_wethFallback_excludesNothing_vpfiDoes() public {
        uint256 w = _fcForward(weth);
        uint256 owed0 = EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(fcBorrower);
        _fcLiquidateToFallback(w);
        assertEq(_fcRow(w), FC_COLLATERAL, "fixture-live: WETH custody is vault-held");
        (address bv, uint256 bVpfi) = _fcBorrowerExclusion(w);
        assertEq(bv, address(0), "a WETH row charges no vault");
        assertEq(bVpfi, 0, "and excludes nothing");
        assertEq(
            EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(fcBorrower),
            owed0,
            "the borrower's VPFI aggregate is unchanged"
        );

        uint256 v = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, usdc, FC_PRINCIPAL, vpfi, FC_COLLATERAL);
        _fcLiquidateToFallback(v);
        (bv, bVpfi) = _fcBorrowerExclusion(v);
        assertEq(bv, fcBorrower2, "straddle: the VPFI entry charges its borrower");
        assertEq(bVpfi, FC_COLLATERAL, "straddle: with its whole row");
    }

    // =====================================================================
    //  F6-F8b: the in-kind split and the claim-time retry
    // =====================================================================

    /// @notice F6. The in-kind lender claim moves the treasury and lender
    ///         slices out of the vault, each under its own lien decrement, and
    ///         leaves the borrower slice in place under the lien it already
    ///         had: lien = slice + top-up, and so is the borrower's claim.
    /// @dev    VPFI, so an unrelated free deposit is easy to make. The free
    ///         deposit is as large as the collateral: with it, a missing lien
    ///         decrement on the departing slices would NOT trip the vault
    ///         withdraw guard, so only the lien assertion can catch it.
    ///         Kills: the missing lender-slice lien decrement (S1-3); the S2a
    ///         re-lien of the borrower slice (a double lien).
    function test_F6_inKind_slicesLeaveUnderTheirOwnLienDecrement() public {
        uint256 id = _fcForward(vpfi);
        uint256 u = FC_COLLATERAL;
        _fcDepositVpfi(fcBorrower, u);
        _fcLiquidateToFallback(id);
        _fcTopUp(id, 1);
        (uint256 l, uint256 t, uint256 b) = _fcSlices(id);
        assertGt(l, 0, "fixture-live: a lender slice");
        assertGt(t, 0, "fixture-live: a treasury slice");
        assertGt(b, 0, "fixture-live: a borrower slice");
        assertEq(_fcLien(id), FC_COLLATERAL + 1, "fixture-live: the 1-wei top-up is liened");
        assertEq(_fcRow(id), FC_COLLATERAL, "fixture-live: the top-up is not custody");

        uint256 diamond0 = _fcBal(vpfi, address(diamond));
        uint256 lender0 = _fcBal(vpfi, fcLender);
        uint256 treasury0 = _fcBal(vpfi, treasuryEOA);
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);

        assertEq(_fcBal(vpfi, address(diamond)), diamond0, "the Diamond is never a waypoint");
        assertEq(_fcBal(vpfi, fcLender) - lender0, l, "the lender is paid the lender slice");
        assertEq(_fcBal(vpfi, treasuryEOA) - treasury0, t, "the treasury slice reaches the treasury");
        assertEq(_fcRow(id), 0, "the row is spent");
        assertEq(_fcLien(id), b + 1, "the lien is exactly the retained slice plus the top-up");
        (address asset, uint256 owed,) = ClaimFacet(address(diamond)).getClaimableAmount(id, false);
        assertEq(asset, vpfi, "the borrower is owed collateral");
        assertEq(owed, b + 1, "exactly the retained slice plus the top-up");
        assertEq(_fcTracked(fcBorrower, vpfi), u + b + 1, "the vault keeps the free deposit, the slice and the top-up");
    }

    /// @notice F6b. With the oracle dead at entry the lender takes the whole
    ///         collateral (b = 0); after the in-kind claim moves it out of the
    ///         borrower's vault, the borrower's tier stamp equals the vault's
    ///         tracked VPFI.
    /// @dev    Kills: the host's final restamp missing. The lien and row
    ///         notifies restamp BEFORE the vault outflow and the terminal sync
    ///         changes no charged amount here, so without the final restamp
    ///         the stamp would keep the departed custody.
    function test_F6b_inKind_oracleDead_borrowerStampMatchesTrackedAfterward() public {
        uint256 id = _fcForward(vpfi);
        uint256 u = 400e18;
        _fcDepositVpfi(fcBorrower, u);
        mockOraclePrice(vpfi, 0, 8);
        _fcLiquidateToFallback(id);
        mockOraclePrice(vpfi, 1e8, 8);
        (uint256 l, uint256 t, uint256 b) = _fcSlices(id);
        assertEq(l, FC_COLLATERAL, "fixture-live: without a price the lender takes everything");
        assertEq(t, 0, "fixture-live: no treasury slice");
        assertEq(b, 0, "fixture-live: no borrower slice");

        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);

        uint256 tracked = _fcTracked(fcBorrower, vpfi);
        assertEq(tracked, u, "fixture-live: only the free deposit remains in the vault");
        (, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked, "the stamp was refreshed after the last outflow");
        assertEq(
            EncumbranceMutateFacet(address(diamond)).getVpfiOwedToOthers(fcBorrower),
            0,
            "nothing is excluded once the custody has left"
        );
    }

    /// @notice F6c. A borrower position transferred during FallbackPending:
    ///         after the in-kind claim the retained slice is owed to the
    ///         holder, so it is excluded from the stored borrower's tier and
    ///         the stamp is the tracked balance minus that exclusion.
    /// @dev    Pins the end state with a NON-zero exclusion: a restamp that
    ///         ignored it (stamping the raw tracked balance) fails here.
    function test_F6c_inKind_transferredBorrowerPosition_stampExcludesTheOwedSlice() public {
        uint256 id = _fcForward(vpfi);
        _fcLiquidateToFallback(id);
        (,, uint256 b) = _fcSlices(id);
        assertGt(b, 0, "fixture-live: a borrower slice is retained");
        address holder = makeAddr("fcBorrowerPositionHolder");
        uint256 tokenId = _fcLoan(id).borrowerTokenId;
        vm.prank(fcBorrower);
        VaipakamNFTFacet(address(diamond)).transferFrom(fcBorrower, holder, tokenId);

        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);

        uint256 tracked = _fcTracked(fcBorrower, vpfi);
        assertEq(tracked, b, "fixture-live: the stored vault holds only the retained slice");
        (address bv, uint256 bVpfi) = _fcBorrowerExclusion(id);
        assertEq(bv, fcBorrower, "the stored borrower is charged");
        assertEq(bVpfi, b, "with the slice owed to the holder");
        (, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked - bVpfi, "the stamp excludes what the stored borrower owes the holder");
    }

    /// @notice F7. A successful claim-time retry sells exactly the custody
    ///         row, never the FallbackPending top-up beside it, and leaves the
    ///         lien at exactly the top-up.
    /// @dev    Kills: a retry sized to `collateralAmount` (row + top-up).
    function test_F7_retrySuccess_sellsExactlyTheRow_topUpStaysLiened() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        uint256 topUp = 37e18;
        _fcTopUp(id, topUp);
        assertEq(_fcRow(id), FC_COLLATERAL, "fixture-live: the row");
        assertEq(_fcLien(id), FC_COLLATERAL + topUp, "fixture-live: the lien covers row and top-up");

        uint256 venue0 = _fcBal(weth, address(workingAdapter));
        uint256 diamond0 = _fcBal(weth, address(diamond));
        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(id, _fcRoute(false));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool ran, bool ok) = _fcRetryOutcome(logs, id);
        assertTrue(ran && ok, "fixture-live: the retry ran and succeeded");

        assertEq(_fcBal(weth, address(workingAdapter)) - venue0, FC_COLLATERAL, "the venue sold exactly the row");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "nothing of it rests in the Diamond");
        assertEq(_fcLien(id), topUp, "the lien is exactly the top-up");
        assertEq(_fcRow(id), 0, "the row is spent");
        (uint256 pulled, uint256 nPulled) = _fcSum(_fcMoves(logs, id), LibFallbackCustody.Move.RetryPulled);
        assertEq(nPulled, 1, "one pull");
        assertEq(pulled, FC_COLLATERAL, "of the row");
    }

    /// @notice F7b. After a successful VPFI retry the borrower's stamp equals
    ///         the vault's tracked VPFI.
    /// @dev    Kills: the retry's success-path restamp missing (the pull is a
    ///         vault withdraw, which never restamps).
    function test_F7b_vpfiRetrySuccess_stampMatchesTracked() public {
        uint256 id = _fcForward(vpfi);
        uint256 u = 250e18;
        _fcDepositVpfi(fcBorrower, u);
        _fcLiquidateToFallback(id);
        assertEq(_fcRow(id), FC_COLLATERAL, "fixture-live: VPFI custody is vault-held");

        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(id, _fcRoute(false));
        (bool ran, bool ok) = _fcRetryOutcome(vm.getRecordedLogs(), id);
        assertTrue(ran && ok, "fixture-live: the retry ran and succeeded");

        uint256 tracked = _fcTracked(fcBorrower, vpfi);
        assertEq(tracked, u, "fixture-live: the custody left, the free deposit stays");
        (, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked, "restamped after the retry pulled the custody out");
    }

    /// @notice F8. A failed retry restores exactly what it pulled, and the
    ///         in-kind split that follows drains the row; the Diamond ends the
    ///         claim holding nothing.
    /// @dev    Kills: a missing restore (the custody would stay in the
    ///         Diamond, or the split would find an empty row).
    function test_F8_retryFails_restoresThePull_thenSplitsInKind() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        (uint256 l, uint256 t, uint256 b) = _fcSlices(id);
        uint256 diamond0 = _fcBal(weth, address(diamond));

        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(id, _fcRoute(true));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool ran, bool ok) = _fcRetryOutcome(logs, id);
        assertTrue(ran, "fixture-live: the retry ran");
        assertFalse(ok, "fixture-live: and failed");

        FcMove[] memory moves = _fcMoves(logs, id);
        (uint256 pulled, uint256 nPulled) = _fcSum(moves, LibFallbackCustody.Move.RetryPulled);
        (uint256 restored, uint256 nRestored) = _fcSum(moves, LibFallbackCustody.Move.RetryRestored);
        assertEq(nPulled, 1, "one pull");
        assertEq(nRestored, 1, "one restore");
        assertEq(pulled, FC_COLLATERAL, "the pull took the row");
        assertEq(restored, pulled, "the restore returned exactly the pull");
        (uint256 toTreasury,) = _fcSum(moves, LibFallbackCustody.Move.ToTreasury);
        (uint256 toLender,) = _fcSum(moves, LibFallbackCustody.Move.ToLender);
        (uint256 retained,) = _fcSum(moves, LibFallbackCustody.Move.RetainedForBorrower);
        assertEq(toTreasury, t, "treasury slice");
        assertEq(toLender, l, "lender slice");
        assertEq(retained, b, "borrower slice");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond holds nothing after the claim");
        assertEq(_fcRow(id), 0, "the row is drained");
    }

    /// @notice F8b. A borrower flagged after entry cannot strand the lender:
    ///         the failed retry's restore goes back into the flagged vault
    ///         through the pinned deposit, and the lender is paid.
    /// @dev    Straddle: an unpinned vault resolution for the same borrower
    ///         reverts `SanctionedAddress`. Kills: a plain deposit in place of
    ///         the pinned primitive.
    function test_F8b_flaggedBorrower_failedRetryRestores_lenderIsPaid() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        (uint256 l,,) = _fcSlices(id);
        sanctionsList.setFlagged(fcBorrower, true);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, fcBorrower));
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(fcBorrower);

        uint256 lender0 = _fcBal(weth, fcLender);
        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(id, _fcRoute(true));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool ran, bool ok) = _fcRetryOutcome(logs, id);
        assertTrue(ran && !ok, "fixture-live: the retry ran and failed");
        (uint256 restored, uint256 nRestored) = _fcSum(_fcMoves(logs, id), LibFallbackCustody.Move.RetryRestored);
        assertEq(nRestored, 1, "the custody was restored into the flagged vault");
        assertEq(restored, FC_COLLATERAL, "all of it");
        assertEq(_fcBal(weth, fcLender) - lender0, l, "and the lender is paid the lender slice");
    }

    // =====================================================================
    //  F9-F10: the backstop
    // =====================================================================

    /// @notice F9. The keeper's backstop call with a failing retry, on a
    ///         snapshot whose lender slice was scaled to zero, returns without
    ///         an absorb and leaves the custody exactly where it was: row,
    ///         lien, tracked balance and VPFI exclusion all restored.
    /// @dev    RAW snapshot edit, and why: a partial internal match can floor
    ///         the lender slice to zero only by consuming all but a few units
    ///         of the row while the loan keeps outstanding principal, which at
    ///         the harness's 1:1 prices and the offer create floor
    ///         (collateral >= ~1.76 x principal on both legs) no
    ///         counterparty can do. So the real producer enters the fallback
    ///         and the lender units are then moved into the borrower slice:
    ///         the total, and so the row, are unchanged (still consistent,
    ///         not legacy). Kills: a missing retry restore on this
    ///         non-terminal return.
    function test_F9_backstopReturnsAtAZeroLenderSlice_custodyRestoredExactly() public {
        uint256 id = _fcForward(vpfi);
        _fcDepositVpfi(fcBorrower, 300e18);
        _fcLiquidateToFallback(id);
        _fcZeroLenderSliceRaw(id);
        assertEq(_fcRow(id), _fcSnapshotTotal(id), "fixture-live: still a consistent vault-held row");
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(id, true);

        uint256 tracked0 = _fcTracked(fcBorrower, vpfi);
        uint256 lien0 = _fcLien(id);
        uint256 diamond0 = _fcBal(vpfi, address(diamond));
        (address bv0, uint256 bVpfi0) = _fcBorrowerExclusion(id);
        assertEq(bVpfi0, FC_COLLATERAL, "fixture-live: the custody is excluded");

        vm.recordLogs();
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(id, _fcRoute(true));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool ran, bool ok) = _fcRetryOutcome(logs, id);
        assertTrue(ran && !ok, "fixture-live: the keeper's retry ran and failed");
        assertEq(
            uint8(_fcStatus(id)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the call returned at the zero lender slice, no absorb"
        );

        assertEq(_fcRow(id), FC_COLLATERAL, "the row is restored");
        assertEq(_fcLien(id), lien0, "the lien is restored");
        assertEq(_fcTracked(fcBorrower, vpfi), tracked0, "the tracked balance is restored");
        assertEq(_fcBal(vpfi, address(diamond)), diamond0, "nothing rests in the Diamond");
        (address bv, uint256 bVpfi) = _fcBorrowerExclusion(id);
        assertEq(bv, bv0, "the exclusion is charged to the same vault");
        assertEq(bVpfi, bVpfi0, "for the same amount");
        (, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked0 - FC_COLLATERAL, "and the stamp is back to the borrower's own VPFI");
        (,,,,,, bool retried) = ClaimFacet(address(diamond)).getFallbackSnapshot(id);
        assertTrue(retried, "the one-shot retry is spent");
    }

    /// @notice F10. The backstop absorb moves the lender slice vault to vault
    ///         into the backstop's vault and warehouses exactly that amount;
    ///         the borrower slice stays under the lien it already had.
    /// @dev    Warehoused is read by straddle: sweeping `L + 1` reverts, `L`
    ///         succeeds. Kills: the S2a re-lien of the borrower slice kept (a
    ///         double lien); `absorbed` read from the snapshot after a mutation.
    function test_F10_backstopAbsorb_lenderSliceVaultToVault_warehousedExactly() public {
        uint256 id = _fcForward(vpfi);
        uint256 u = 600e18;
        _fcDepositVpfi(fcBorrower, u);
        _fcLiquidateToFallback(id);
        (uint256 l, uint256 t, uint256 b) = _fcSlices(id);
        assertGt(l, 0, "fixture-live: a lender slice to absorb");
        assertGt(b, 0, "fixture-live: a borrower slice to keep");
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(id, true);

        address bsVault = _fcVault(backstopVault);
        address bVault = _fcVault(fcBorrower);
        uint256 bs0 = _fcBal(vpfi, bsVault);
        uint256 vault0 = _fcBal(vpfi, bVault);
        uint256 treasury0 = _fcBal(vpfi, treasuryEOA);
        uint256 diamond0 = _fcBal(vpfi, address(diamond));
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(id, _fcRoute(true));
        LibVaipakam.LoanStatus st = _fcStatus(id);
        assertTrue(
            st == LibVaipakam.LoanStatus.Defaulted || st == LibVaipakam.LoanStatus.Settled,
            "fixture-live: the absorb terminated the loan"
        );

        assertEq(_fcBal(vpfi, bsVault) - bs0, l, "the lender slice reached the backstop's vault");
        assertEq(_fcBal(vpfi, treasuryEOA) - treasury0, t, "the treasury slice reached the treasury");
        assertEq(vault0 - _fcBal(vpfi, bVault), l + t, "only those two left the borrower's vault");
        assertEq(_fcBal(vpfi, address(diamond)), diamond0, "the Diamond is never a waypoint");
        assertEq(_fcLien(id), b, "the lien is exactly the retained slice");
        assertEq(_fcRow(id), 0, "the row is spent");
        assertEq(_fcTracked(fcBorrower, vpfi), u + b, "the vault keeps the free deposit and the slice");

        address sink = makeAddr("fcBackstopSweepSink");
        vm.expectRevert(BackstopFacet.BackstopAbsorbCollateralInsufficient.selector);
        BackstopFacet(address(diamond)).sweepBackstopAbsorbCollateral(vpfi, sink, l + 1);
        BackstopFacet(address(diamond)).sweepBackstopAbsorbCollateral(vpfi, sink, l);
        assertEq(_fcBal(vpfi, sink), l, "warehoused exactly the lender slice");
    }

    // =====================================================================
    //  F11-F12: the cures
    // =====================================================================

    /// @notice F11. A cure by top-up moves nothing: the lien becomes the whole
    ///         pledge (custody + top-up, the custody not re-added), the row
    ///         returns to the pledge, the VPFI exclusion is gone and the stamp
    ///         counts the whole vault again.
    /// @dev    Kills: the S2a cure re-adding the custody to the lien; the
    ///         exclusion left standing after the cure.
    function test_F11_cureByTopUp_lienIsThePledge_exclusionCleared() public {
        uint256 id = _fcForward(vpfi);
        _fcLiquidateToFallback(id);
        (, uint256 bVpfi0) = _fcBorrowerExclusion(id);
        assertEq(bVpfi0, FC_COLLATERAL, "fixture-live: the custody is excluded");
        uint256 diamond0 = _fcBal(vpfi, address(diamond));
        uint256 topUp = 50e18;

        _fcSetRisk(id, FC_HF_HEALTHY, FC_LTV_HEALTHY);
        _fcTopUp(id, topUp);
        assertEq(uint8(_fcStatus(id)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the top-up cured the loan");

        assertEq(_fcLien(id), FC_COLLATERAL + topUp, "the lien is the whole pledge");
        assertEq(_fcLoan(id).collateralAmount, FC_COLLATERAL + topUp, "which is the loan's collateral");
        (uint256 row, uint256 legacy) = _fcCustody(id);
        assertEq(row, 0, "the custody returned to the pledge");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        (address bv, uint256 bVpfi) = _fcBorrowerExclusion(id);
        assertEq(bv, address(0), "no exclusion survives the cure");
        assertEq(bVpfi, 0, "of any amount");
        uint256 tracked = _fcTracked(fcBorrower, vpfi);
        assertEq(tracked, FC_COLLATERAL + topUp, "the vault holds the pledge");
        (, uint256 dayClose) = _fcDayMinClose(fcBorrower);
        assertEq(dayClose, tracked, "the stamp counts it all again");
        assertEq(_fcBal(vpfi, address(diamond)), diamond0, "nothing moved through the Diamond");
    }

    /// @notice F12. A curing full repayment moves nothing either: the lien is
    ///         the loan's collateral, held until the borrower claims it.
    /// @dev    Straddle: the borrower's claim then pays exactly that and
    ///         releases it. Kills: the S2a repay deposit + lien increment kept
    ///         (a doubled lien and a double payout source).
    function test_F12_repayCure_lienIsTheCollateral_releasedByTheClaim() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        address bVault = _fcVault(fcBorrower);
        uint256 vault0 = _fcBal(weth, bVault);
        uint256 diamond0 = _fcBal(weth, address(diamond));
        _fcFund(fcBorrower, usdc, FC_PRINCIPAL * 2);

        vm.prank(fcBorrower);
        RepayFacet(address(diamond)).repayLoan(id);
        assertEq(uint8(_fcStatus(id)), uint8(LibVaipakam.LoanStatus.Repaid), "fixture-live: the repayment cured and closed");

        assertEq(_fcLien(id), FC_COLLATERAL, "the lien is exactly the collateral");
        assertEq(_fcRow(id), 0, "the custody returned to the pledge");
        assertEq(_fcBal(weth, bVault), vault0, "nothing moved into or out of the vault");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "nothing moved through the Diamond");

        uint256 wallet0 = _fcBal(weth, fcBorrower);
        vm.prank(fcBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(id);
        assertEq(_fcBal(weth, fcBorrower) - wallet0, FC_COLLATERAL, "the claim pays exactly the liened collateral");
        assertEq(_fcLien(id), 0, "and releases the lien");
    }

    // =====================================================================
    //  F13-F14: the internal match
    // =====================================================================

    /// @notice F13 + F13c. A partial match at a ratio where flooring the three
    ///         slices independently would lose units: the row and the lien
    ///         each drop by exactly the consumed amount, the rescaled
    ///         snapshot totals the row with the lender slice rounded up and
    ///         the borrower absorbing the remainder, and the leg is two named
    ///         moves whose matcher part is
    ///         exactly the incentive.
    /// @dev    The consumed amount is chosen in-test from the live snapshot so
    ///         the independent floors provably lose at least one unit. Kills:
    ///         the K5 dust (independent floors); a missing lien decrement; a
    ///         leg with no `MatchToMatcher` move (F13c).
    function test_F13_partialMatch_rowAndLienDropByMoved_borrowerAbsorbsTheFloor() public {
        uint256 a = _fcForward(weth);
        _fcLiquidateToFallback(a);
        (uint256 lc, uint256 tc, uint256 bc) = _fcSlices(a);
        uint256 o = lc + tc + bc;
        assertEq(o, _fcRow(a), "fixture-live: the row is the snapshot total");
        uint256 m = _fcLossyConsumption(lc, tc, bc, 300e18);
        uint256 n = o - m;
        assertLt(
            (lc * n) / o + (tc * n) / o + (bc * n) / o,
            n,
            "fixture-live: independent floors would lose units at this ratio"
        );

        uint256 b = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, weth, m, usdc, 2 * m);
        _fcSetRisk(b, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);
        address aVault = _fcVault(fcBorrower);
        uint256 lien0 = _fcLien(a);
        uint256 vault0 = _fcBal(weth, aVault);
        uint256 diamond0 = _fcBal(weth, address(diamond));

        vm.recordLogs();
        vm.prank(fcMatcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        FcMatch memory r = _fcMatch(logs, a, b);
        assertEq(uint8(_fcStatus(a)), uint8(LibVaipakam.LoanStatus.FallbackPending), "fixture-live: A is a partial leg");
        assertEq(r.movedY, m, "fixture-live: leg Y consumed m of A's row");
        assertGt(r.incentiveY, 0, "fixture-live: an incentive was paid on A's collateral");

        assertEq(_fcRow(a), n, "the row dropped by exactly the consumed amount");
        assertEq(_fcLien(a), lien0 - m, "so did the lien");
        assertEq(vault0 - _fcBal(weth, aVault), m, "the vault paid exactly that");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond is never a waypoint");
        (uint256 l2, uint256 t2, uint256 b2) = _fcSlices(a);
        assertEq(l2 + t2 + b2, n, "the snapshot total equals the row: no unit owned by nobody");
        assertEq(l2, Math.ceilDiv(lc * n, o), "the lender slice rounds up (lender first, #1281)");
        assertEq(t2, (tc * n) / o, "the treasury slice is floored");
        assertEq(b2, n - l2 - t2, "the borrower slice absorbs the remainder");

        FcMove[] memory moves = _fcMoves(logs, a);
        (uint256 toLender, uint256 nL) = _fcSum(moves, LibFallbackCustody.Move.MatchToLender);
        (uint256 toMatcher, uint256 nM) = _fcSum(moves, LibFallbackCustody.Move.MatchToMatcher);
        assertEq(nL, 1, "one lender move");
        assertEq(toLender, m - r.incentiveY, "the receiving lender's share");
        assertEq(nM, 1, "F13c: one matcher move");
        assertEq(toMatcher, r.incentiveY, "F13c: exactly the incentive");
        for (uint256 i; i < moves.length; ++i) {
            if (moves[i].move == uint8(LibFallbackCustody.Move.MatchToLender)) {
                assertEq(moves[i].counterparty, fcLender2, "the lender move names B's lender");
            }
            if (moves[i].move == uint8(LibFallbackCustody.Move.MatchToMatcher)) {
                assertEq(moves[i].counterparty, fcMatcher, "the matcher move names the matcher");
            }
        }
    }

    /// @notice F13b. Both legs FallbackPending: each PAYING row debits its own
    ///         consumption, never the other leg's.
    /// @dev    The two legs move different amounts (1000 vs 600), so keying
    ///         the debit on the receiving loan (S1-4) swaps them. B enters
    ///         first while A is healthy (no candidate); A enters with internal
    ///         matching off so its own auto-dispatch cannot pair it with B.
    function test_F13b_bothLegsFallback_eachRowDebitsItsOwnConsumption() public {
        uint256 a = _fcForward(weth);
        uint256 b = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, weth, FC_REVERSE_PRINCIPAL, usdc, FC_REVERSE_COLLATERAL);
        _fcLiquidateToFallback(b);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(false);
        _fcLiquidateToFallback(a);
        ConfigFacet(address(diamond)).setInternalMatchEnabled(true);
        assertEq(_fcRow(a), FC_COLLATERAL, "fixture-live: A's row");
        assertEq(_fcRow(b), FC_REVERSE_COLLATERAL, "fixture-live: B's row");
        uint256 lienA0 = _fcLien(a);
        uint256 lienB0 = _fcLien(b);

        vm.recordLogs();
        vm.prank(fcMatcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        FcMatch memory r = _fcMatch(logs, a, b);
        assertEq(r.movedX, FC_PRINCIPAL, "fixture-live: leg X consumed 1000 of B's row");
        assertEq(r.movedY, FC_REVERSE_PRINCIPAL, "fixture-live: leg Y consumed 600 of A's row");

        assertEq(_fcLegDebit(_fcMoves(logs, a)), r.movedY, "A's row debits leg Y, which A paid");
        assertEq(_fcLegDebit(_fcMoves(logs, b)), r.movedX, "B's row debits leg X, which B paid");
        assertEq(_fcLien(a), lienA0 - r.movedY, "A's lien drops by its own consumption");
        assertEq(_fcLien(b), lienB0 - r.movedX, "B's lien drops by its own consumption");
    }

    /// @notice F14. A full rescue moves no residual: the matched collateral
    ///         leaves the borrower's vault and the rest never moves, the row
    ///         returns to the pledge, and the lien is exactly the residual.
    /// @dev    Kills: the S2a rescue deposit of the residual (a double count in
    ///         the vault and the lien).
    function test_F14_fullRescue_residualNeverMoves_lienIsTheResidual() public {
        uint256 a = _fcForward(weth);
        _fcLiquidateToFallback(a);
        uint256 b = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, weth, FC_REVERSE_PRINCIPAL, usdc, FC_REVERSE_COLLATERAL);
        _fcSetRisk(b, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);
        address aVault = _fcVault(fcBorrower);
        uint256 vault0 = _fcBal(weth, aVault);
        uint256 diamond0 = _fcBal(weth, address(diamond));

        vm.recordLogs();
        vm.prank(fcMatcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        FcMatch memory r = _fcMatch(logs, a, b);
        assertEq(uint8(_fcStatus(a)), uint8(LibVaipakam.LoanStatus.InternalMatched), "fixture-live: A fully rescued");
        assertEq(r.movedY, FC_REVERSE_PRINCIPAL, "fixture-live: leg Y consumed 600 of A's row");

        uint256 residual = FC_COLLATERAL - r.movedY;
        assertEq(vault0 - _fcBal(weth, aVault), r.movedY, "only the matched collateral left the vault");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond is never a waypoint");
        assertEq(_fcLien(a), residual, "the lien is exactly the residual");
        assertEq(_fcRow(a), 0, "the row returned to the pledge");
        (, uint256 owed,) = ClaimFacet(address(diamond)).getClaimableAmount(a, false);
        assertEq(owed, residual, "the borrower is owed exactly the residual");
        (uint256 returned, uint256 nReturned) = _fcSum(_fcMoves(logs, a), LibFallbackCustody.Move.ReturnedToPledge);
        assertEq(nReturned, 1, "one ReturnedToPledge move");
        assertEq(returned, residual, "of the residual row");
    }

    // =====================================================================
    //  F15-F17: sanctions, the legacy refusal, the helpers
    // =====================================================================

    /// @notice F15. A borrower flagged after entry: the in-kind lender claim
    ///         still pays the lender, and the borrower slice stays frozen in
    ///         the borrower's own vault under the lien.
    /// @dev    Straddle: the flagged borrower's own claim reverts, and the same
    ///         claim pays exactly the slice once the flag clears. Kills: a
    ///         plain (unexempted) withdraw from the flagged vault.
    function test_F15_flaggedBorrower_lenderPaid_borrowerSliceFrozenInPlace() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        (uint256 l,, uint256 b) = _fcSlices(id);
        assertGt(b, 0, "fixture-live: a borrower slice");
        sanctionsList.setFlagged(fcBorrower, true);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, fcBorrower));
        VaultFactoryFacet(address(diamond)).getOrCreateUserVault(fcBorrower);

        uint256 lender0 = _fcBal(weth, fcLender);
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        assertEq(_fcBal(weth, fcLender) - lender0, l, "the lender is paid despite the flag");
        assertEq(_fcBal(weth, _fcVault(fcBorrower)), b, "the borrower slice stays in the borrower's vault");
        assertEq(_fcLien(id), b, "under the lien");

        vm.prank(fcBorrower);
        vm.expectRevert(abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, fcBorrower));
        ClaimFacet(address(diamond)).claimAsBorrower(id);

        sanctionsList.setFlagged(fcBorrower, false);
        uint256 wallet0 = _fcBal(weth, fcBorrower);
        vm.prank(fcBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(id);
        assertEq(_fcBal(weth, fcBorrower) - wallet0, b, "straddle: unflagged, the same claim pays the slice");
    }

    /// @notice F16. A pre-slice row that still rests in the Diamond (O1 = A:
    ///         a Diamond refreshed in place, never a fresh deploy) fails closed
    ///         BY NAME at every consumer, and nothing is paid out of the
    ///         Diamond.
    /// @dev    RAW legacy fixture, the only cell that writes one: the real
    ///         producer enters the fallback, then the entry's slice-2 work is
    ///         undone exactly as pre-slice code left it -- the units moved from
    ///         the vault into the Diamond, the tracked record and the lien
    ///         dropped, the row zero under the still-active snapshot.
    ///         Straddle: from the consistent state saved before the edit, the
    ///         same lender claim succeeds. Kills: a consumer that pays a
    ///         legacy row out of the Diamond's own balance.
    function test_F16_legacyDiamondHeldRow_everyConsumerFailsClosedByName() public {
        uint256 a = _fcForward(weth);
        _fcLiquidateToFallback(a);
        (uint256 l,,) = _fcSlices(a);
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(a, true);
        // Saved BEFORE the counterparty exists: on the straddle claim its
        // auto-dispatch would otherwise match A instead of splitting in kind.
        uint256 consistent = vm.snapshotState();
        uint256 b = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, weth, FC_REVERSE_PRINCIPAL, usdc, FC_REVERSE_COLLATERAL);
        _fcSetRisk(b, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);
        _fcFund(fcBorrower, weth, 1e18);
        _fcFund(fcBorrower, usdc, FC_PRINCIPAL * 2);

        uint256 diamond0 = _fcBal(weth, address(diamond));
        _fcMakeLegacyRaw(a);
        (uint256 row, uint256 legacy) = _fcCustody(a);
        assertEq(row, 0, "fixture-live: no vault row");
        assertEq(legacy, FC_COLLATERAL, "fixture-live: the read names the snapshot total as Diamond-held");
        assertEq(_fcBal(weth, address(diamond)), diamond0 + FC_COLLATERAL, "fixture-live: the units rest in the Diamond");

        bytes memory refusal = abi.encodeWithSelector(LibFallbackCustody.FallbackCustodyNotVaultHeld.selector, a);
        vm.prank(fcLender);
        vm.expectRevert(refusal);
        ClaimFacet(address(diamond)).claimAsLender(a);

        LibSwap.AdapterCall[] memory failing = _fcRoute(true);
        vm.prank(fcLender);
        vm.expectRevert(refusal);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(a, failing);

        vm.expectRevert(refusal);
        ClaimFacet(address(diamond)).claimAsLenderViaBackstop(a, failing);

        _fcSetRisk(a, FC_HF_HEALTHY, FC_LTV_HEALTHY);
        vm.prank(fcBorrower);
        vm.expectRevert(refusal);
        AddCollateralFacet(address(diamond)).addCollateral(a, 1e18);
        _fcSetRisk(a, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);

        vm.prank(fcBorrower);
        vm.expectRevert(refusal);
        RepayFacet(address(diamond)).repayLoan(a);

        vm.prank(fcMatcher);
        vm.expectRevert(refusal);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);

        assertEq(_fcBal(weth, address(diamond)), diamond0 + FC_COLLATERAL, "nothing was paid out of the Diamond");
        assertEq(uint8(_fcStatus(a)), uint8(LibVaipakam.LoanStatus.FallbackPending), "the loan is untouched");

        vm.revertToState(consistent);
        uint256 lender0 = _fcBal(weth, fcLender);
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(a);
        assertEq(_fcBal(weth, fcLender) - lender0, l, "straddle: the consistent row pays the lender");
    }

    /// @notice F16b. A snapshot scaled to zero (active, total 0, row 0) is
    ///         vault-held and empty, NOT legacy: the lender claim pays the
    ///         matched proceeds held for the lender, and the retry and the
    ///         in-kind split short-circuit without moving anything.
    /// @dev    RAW fixture, and why: the real shape needs a partial match that
    ///         consumes the whole row while principal remains, unreachable at
    ///         1:1 prices under the offer create floor (see F9). The fixture
    ///         reproduces that match's end state: the row's units gone to a
    ///         counterparty, the lien and row zero, the snapshot scaled to
    ///         zero, the matched proceeds in the lender's vault as
    ///         `heldForLender`. Kills: a legacy predicate of "row == 0"
    ///         (S1-7), which would refuse this loan.
    function test_F16b_snapshotScaledToZero_isNotLegacy_claimPaysHeldForLender() public {
        uint256 a = _fcForward(weth);
        _fcLiquidateToFallback(a);
        uint256 held = 777e18;
        _fcScaleToZeroRaw(a, held);
        (uint256 row, uint256 legacy) = _fcCustody(a);
        assertEq(row, 0, "fixture-live: an empty row");
        assertEq(legacy, 0, "fixture-live: which is not legacy");
        (,,,,, bool active,) = ClaimFacet(address(diamond)).getFallbackSnapshot(a);
        assertTrue(active, "fixture-live: under a still-active snapshot");
        assertEq(_fcSnapshotTotal(a), 0, "fixture-live: scaled to zero");

        uint256 lender0 = _fcBal(usdc, fcLender);
        uint256 diamond0 = _fcBal(weth, address(diamond));
        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(a, _fcRoute(true));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bool ran, bool ok) = _fcRetryOutcome(logs, a);
        assertTrue(ran && !ok, "the retry short-circuited to a failure");
        assertEq(_fcMoves(logs, a).length, 0, "and nothing moved: no row move at all");
        assertEq(_fcBal(usdc, fcLender) - lender0, held, "the lender is paid the held proceeds");
        assertEq(_fcBal(weth, address(diamond)), diamond0, "the Diamond is untouched");
    }

    /// @notice F17. `hasActiveFallbackTopUp` reads the lien IN EXCESS of the
    ///         row (N9), and the internal match sizes a FallbackPending leg by
    ///         its row.
    /// @dev    Straddle: before a 1-wei top-up the backstop opt-in succeeds
    ///         (the old `lien > 0` reading would refuse every fallback loan,
    ///         since the custody is now liened); after it, the opt-in is
    ///         refused. A counterparty owing more than the row then consumes
    ///         exactly the row (the old `collateralAmount - lien` reading would
    ///         be 0 and refuse the match). Kills: the old formulas.
    function test_F17_oneWeiTopUp_flipsTheTopUpGate_matchableIsTheRow() public {
        uint256 a = _fcForward(weth);
        _fcLiquidateToFallback(a);
        assertEq(_fcLien(a), _fcRow(a), "fixture-live: lien == row, no top-up");
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(a, true);

        _fcTopUp(a, 1);
        assertEq(_fcLien(a), _fcRow(a) + 1, "fixture-live: a 1-wei top-up");
        vm.prank(fcLender);
        vm.expectRevert(ClaimFacet.NotBackstopAbsorbable.selector);
        ClaimFacet(address(diamond)).setLenderBackstopOptIn(a, true);

        uint256 owe = FC_COLLATERAL + 100e18;
        uint256 b = _fcOpen(fcLender2, fcBorrower2, fcBorrower2Pk, weth, owe, usdc, 2 * owe);
        _fcSetRisk(b, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);
        vm.recordLogs();
        vm.prank(fcMatcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);
        FcMatch memory r = _fcMatch(vm.getRecordedLogs(), a, b);
        assertEq(r.movedY, FC_COLLATERAL, "leg Y consumed exactly the row, never the top-up");
        assertEq(_fcLien(a), 1, "the top-up stays liened as the borrower's");
    }

    // =====================================================================
    //  F19-F21: provenance, Diamond-as-treasury, the vault upgrade
    // =====================================================================

    /// @notice F19. The row moves of a whole episode reconcile: replaying the
    ///         events reproduces every `custodyAfter`, the credits equal the
    ///         debits, and the named exits are the snapshot slices.
    /// @dev    Kills: any custody change made without its event.
    function test_F19_custodyMoveEventsReconcileToTheEntry() public {
        uint256 id = _fcForward(weth);
        vm.recordLogs();
        _fcLiquidateToFallback(id);
        FcMove[] memory entry = _fcMoves(vm.getRecordedLogs(), id);
        (uint256 l, uint256 t, uint256 b) = _fcSlices(id);
        assertEq(entry.length, 1, "fixture-live: one entry move");

        vm.recordLogs();
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLenderWithRetry(id, _fcRoute(true));
        FcMove[] memory exit = _fcMoves(vm.getRecordedLogs(), id);
        assertGt(exit.length, 0, "fixture-live: the claim moved custody");

        uint256 running = _fcReplay(entry, 0);
        assertEq(running, FC_COLLATERAL, "the entry credited the whole collateral");
        running = _fcReplay(exit, running);
        assertEq(running, 0, "every unit that entered left by a named move");
        assertEq(_fcRow(id), 0, "and the row agrees");
        (uint256 toTreasury,) = _fcSum(exit, LibFallbackCustody.Move.ToTreasury);
        (uint256 toLender,) = _fcSum(exit, LibFallbackCustody.Move.ToLender);
        (uint256 retained,) = _fcSum(exit, LibFallbackCustody.Move.RetainedForBorrower);
        assertEq(toTreasury, t, "treasury slice");
        assertEq(toLender, l, "lender slice");
        assertEq(retained, b, "borrower slice");
        assertEq(toTreasury + toLender + retained, entry[0].amount, "the exits reconcile to the entry");
    }

    /// @notice F20. With the Diamond as the treasury, the treasury slice lands
    ///         in the Diamond AND is recorded as treasury balance: the
    ///         Diamond's balance delta equals the treasury-balance delta.
    /// @dev    Kills: a treasury slice moved but not recorded (unattributed
    ///         Diamond balance).
    function test_F20_diamondAsTreasury_treasurySliceIsRecorded() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        (, uint256 t,) = _fcSlices(id);
        assertGt(t, 0, "fixture-live: a treasury slice");
        AdminFacet(address(diamond)).setTreasury(address(diamond));
        uint256 diamond0 = _fcBal(weth, address(diamond));
        uint256 recorded0 = TreasuryFacet(address(diamond)).getTreasuryBalance(weth);

        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);

        assertEq(_fcBal(weth, address(diamond)) - diamond0, t, "the slice landed in the Diamond");
        assertEq(TreasuryFacet(address(diamond)).getTreasuryBalance(weth) - recorded0, t, "and is recorded as treasury");
    }

    /// @notice F21. A borrower vault behind a mandatory upgrade blocks the
    ///         lender's in-kind claim (`VaultUpgradeRequired`), and anyone can
    ///         lift the block with the permissionless `upgradeUserVault`.
    /// @dev    Straddle: the same claim reverts before the upgrade and pays the
    ///         lender slice after it (D12: not a veto).
    function test_F21_borrowerVaultBehindMandatoryUpgrade_anyoneCanUnblock() public {
        uint256 id = _fcForward(weth);
        _fcLiquidateToFallback(id);
        (uint256 l,,) = _fcSlices(id);
        // A REAL implementation upgrade bumps the factory's current version (it starts at 0 on a
        // fresh Diamond); existing proxies keep their old version until each is upgraded. The
        // lender is brought current through the same permissionless upgrade, so only the
        // borrower's vault sits behind the mandatory version.
        vm.prank(owner);
        VaultFactoryFacet(address(diamond)).upgradeVaultImplementation(address(new VaipakamVaultImplementation()));
        VaultFactoryFacet(address(diamond)).upgradeUserVault(fcLender);
        (, uint256 current,,) = VaultFactoryFacet(address(diamond)).getVaultVersionInfo(fcBorrower);
        assertGt(current, 0, "fixture-live: a current vault version");
        TestMutatorFacet(address(diamond)).setVaultVersionRaw(fcBorrower, current - 1);
        TestMutatorFacet(address(diamond)).setMandatoryVaultVersionRaw(current);
        (,,, bool borrowerBehind) = VaultFactoryFacet(address(diamond)).getVaultVersionInfo(fcBorrower);
        (,,, bool lenderBehind) = VaultFactoryFacet(address(diamond)).getVaultVersionInfo(fcLender);
        assertTrue(borrowerBehind, "fixture-live: the borrower's vault is behind");
        assertFalse(lenderBehind, "fixture-live: the lender's is not");

        vm.prank(fcLender);
        vm.expectRevert(VaultFactoryFacet.VaultUpgradeRequired.selector);
        ClaimFacet(address(diamond)).claimAsLender(id);

        vm.prank(makeAddr("fcAnyone"));
        VaultFactoryFacet(address(diamond)).upgradeUserVault(fcBorrower);
        (,,, borrowerBehind) = VaultFactoryFacet(address(diamond)).getVaultVersionInfo(fcBorrower);
        assertFalse(borrowerBehind, "the upgrade lifted the block");

        uint256 lender0 = _fcBal(weth, fcLender);
        vm.prank(fcLender);
        ClaimFacet(address(diamond)).claimAsLender(id);
        assertEq(_fcBal(weth, fcLender) - lender0, l, "straddle: the same claim now pays the lender slice");
    }

    // =====================================================================
    //  Fixtures
    // =====================================================================

    /// @dev A forward loan from the primary pair: USDC principal, `collateral`
    ///      (WETH or VPFI) at twice that.
    function _fcForward(address collateral) internal returns (uint256) {
        return _fcOpen(fcLender, fcBorrower, fcBorrowerPk, usdc, FC_PRINCIPAL, collateral, FC_COLLATERAL);
    }

    /// @dev Opens a loan through the real lender offer and the borrower's
    ///      signed accept, then gives it healthy per-loan risk readings
    ///      (SetupTest mocks HF and LTV globally; a per-loan mock is how a
    ///      loan becomes liquidatable later).
    function _fcOpen(
        address lender_,
        address borrower_,
        uint256 borrowerPk_,
        address lending,
        uint256 principal,
        address collateral,
        uint256 collateralAmount
    ) internal returns (uint256 loanId) {
        _fcFund(lender_, lending, principal);
        _fcFund(borrower_, collateral, collateralAmount);
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: lending,
            amount: principal,
            interestRateBps: FC_RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: collateralAmount,
            durationDays: FC_LOAN_DAYS,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            creatorRiskAndTermsConsent: true,
            prepayAsset: address(0),
            collateralAssetType: LibVaipakam.AssetType.ERC20,
            collateralTokenId: 0,
            collateralQuantity: 0,
            allowsPartialRepay: true,
            allowsPrepayListing: false,
            allowsParallelSale: false,
            amountMax: principal,
            interestRateBpsMax: FC_RATE_BPS,
            collateralAmountMax: collateralAmount,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
        vm.prank(lender_);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(p);
        loanId = LibAcceptTestSigner.signAndAccept(address(diamond), borrower_, borrowerPk_, offerId);
        _fcSetRisk(loanId, FC_HF_HEALTHY, FC_LTV_HEALTHY);
        assertEq(uint8(_fcStatus(loanId)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan opened Active");
    }

    /// @dev The real producer: an HF liquidation through the always-reverting
    ///      venue. Leaves the loan's risk readings liquidatable, so a later
    ///      top-up does not cure it unless the cell restores them.
    function _fcLiquidateToFallback(uint256 loanId) internal {
        _fcSetRisk(loanId, FC_HF_LIQUIDATABLE, FC_LTV_LIQUIDATABLE);
        RiskFacet(address(diamond)).triggerLiquidation(loanId, _fcRoute(true));
        assertEq(
            uint8(_fcStatus(loanId)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the failed liquidation entered FallbackPending"
        );
    }

    /// @dev A FallbackPending (non-curing while the risk stays liquidatable) or
    ///      Active top-up through the real entry point.
    function _fcTopUp(uint256 loanId, uint256 amount) internal {
        LibVaipakam.Loan memory l = _fcLoan(loanId);
        _fcFund(l.borrower, l.collateralAsset, amount);
        vm.prank(l.borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, amount);
    }

    function _fcDepositVpfi(address who, uint256 amount) internal {
        _fcFund(who, vpfi, amount);
        vm.prank(who);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amount);
    }

    /// @dev F9's raw shape: the lender slice folded into the borrower slice,
    ///      total (and so the row) unchanged, the lender claim emptied with it.
    function _fcZeroLenderSliceRaw(uint256 loanId) internal {
        (uint256 l, uint256 t, uint256 b, , uint256 tpd, bool active, bool retried) =
            ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(
            loanId,
            LibVaipakam.FallbackSnapshot({
                lenderCollateral: 0,
                treasuryCollateral: t,
                borrowerCollateral: b + l,
                lenderPrincipalDue: 0,
                treasuryPrincipalDue: tpd,
                active: active,
                retryAttempted: retried
            })
        );
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setBorrowerClaimAmountRaw(loanId, b + l);
    }

    /// @dev F16's raw legacy shape: what pre-slice code left after a fallback
    ///      entry. The units sit in the Diamond, outside the borrower's vault
    ///      and its tracked record; the lien was released at entry and never
    ///      re-created; no row exists under the active snapshot.
    function _fcMakeLegacyRaw(uint256 loanId) internal {
        LibVaipakam.Loan memory l = _fcLoan(loanId);
        uint256 held = _fcRow(loanId);
        address bVault = _fcVault(l.borrower);
        vm.prank(bVault);
        assertTrue(IERC20(l.collateralAsset).transfer(address(diamond), held), "legacy units into the Diamond");
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            l.borrower, l.collateralAsset, _fcTracked(l.borrower, l.collateralAsset) - held
        );
        _fcSetLienRaw(loanId, l.borrower, l.collateralAsset, 0);
        TestMutatorFacet(address(diamond)).setFallbackVaultCustodyRaw(loanId, 0);
    }

    /// @dev F16b's raw shape: the end state of a partial match that consumed
    ///      the whole row while principal remained. The units left for a
    ///      counterparty's lender, the lien, row and loan collateral are zero,
    ///      the snapshot is scaled to zero and still active, and the matched
    ///      proceeds wait in the lender's vault as `heldForLender`.
    function _fcScaleToZeroRaw(uint256 loanId, uint256 heldForLender) internal {
        LibVaipakam.Loan memory l = _fcLoan(loanId);
        uint256 rowAmt = _fcRow(loanId);
        address consumer = makeAddr("fcConsumedByTheMatch");
        address bVault = _fcVault(l.borrower);
        vm.prank(bVault);
        assertTrue(IERC20(l.collateralAsset).transfer(consumer, rowAmt), "the row's units left for the counterparty");
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            l.borrower, l.collateralAsset, _fcTracked(l.borrower, l.collateralAsset) - rowAmt
        );
        _fcSetLienRaw(loanId, l.borrower, l.collateralAsset, 0);
        TestMutatorFacet(address(diamond)).setFallbackVaultCustodyRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setFallbackSnapshotRaw(
            loanId,
            LibVaipakam.FallbackSnapshot({
                lenderCollateral: 0,
                treasuryCollateral: 0,
                borrowerCollateral: 0,
                lenderPrincipalDue: 0,
                treasuryPrincipalDue: 0,
                active: true,
                retryAttempted: false
            })
        );
        TestMutatorFacet(address(diamond)).setLenderClaimAmountRaw(loanId, 0);
        TestMutatorFacet(address(diamond)).setBorrowerClaimAmountRaw(loanId, 0);
        l.collateralAmount = 0;
        TestMutatorFacet(address(diamond)).setLoan(loanId, l);
        address lVault = _fcVault(l.lender);
        ERC20Mock(l.principalAsset).mint(lVault, heldForLender);
        TestMutatorFacet(address(diamond)).setProtocolTrackedVaultBalanceRaw(
            l.lender, l.principalAsset, _fcTracked(l.lender, l.principalAsset) + heldForLender
        );
        TestMutatorFacet(address(diamond)).setHeldForLenderRaw(loanId, heldForLender);
    }

    /// @dev Rewrites a loan's collateral lien to `amount` and keeps the owner's
    ///      encumbrance aggregate exact (the raw lien setter adds to it).
    function _fcSetLienRaw(uint256 loanId, address user, address asset, uint256 amount) internal {
        (uint256 old, bool released) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(loanId);
        uint256 agg = TestMutatorFacet(address(diamond)).getEncumberedRaw(user, asset, 0);
        TestMutatorFacet(address(diamond)).setLoanCollateralLienRaw(
            loanId, user, asset, 0, amount, LibVaipakam.AssetType.ERC20
        );
        TestMutatorFacet(address(diamond)).setEncumberedRaw(user, asset, 0, agg - (released ? 0 : old) + amount);
    }

    /// @dev The first consumption >= `start` at which flooring the three
    ///      slices independently loses at least one unit of the surviving row.
    function _fcLossyConsumption(uint256 l, uint256 t, uint256 b, uint256 start) internal pure returns (uint256) {
        uint256 o = l + t + b;
        for (uint256 k; k < 512; ++k) {
            uint256 m = start + k;
            uint256 n = o - m;
            if ((l * n) / o + (t * n) / o + (b * n) / o < n) return m;
        }
        revert("FallbackCustodyTest: no lossy ratio in range");
    }

    // =====================================================================
    //  Reads
    // =====================================================================

    function _fcCustody(uint256 loanId) internal view returns (uint256 row, uint256 legacy) {
        return FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
    }

    function _fcRow(uint256 loanId) internal view returns (uint256 row) {
        (row,) = _fcCustody(loanId);
    }

    function _fcLien(uint256 loanId) internal view returns (uint256 amount) {
        (amount,) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(loanId);
    }

    function _fcSlices(uint256 loanId) internal view returns (uint256 l, uint256 t, uint256 b) {
        (l, t, b,,,,) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
    }

    function _fcSnapshotTotal(uint256 loanId) internal view returns (uint256) {
        (uint256 l, uint256 t, uint256 b) = _fcSlices(loanId);
        return l + t + b;
    }

    function _fcBorrowerExclusion(uint256 loanId) internal view returns (address vaultOwner, uint256 vpfiAmount) {
        (,, vaultOwner, vpfiAmount) = EncumbranceMutateFacet(address(diamond)).getTierExclusion(loanId);
    }

    function _fcDayMinClose(address who) internal view returns (uint256 dayMin, uint256 dayClose) {
        (,, uint120 close, uint120 min_) = TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(who);
        return (min_, close);
    }

    function _fcTracked(address who, address token) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(who, token);
    }

    function _fcVault(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _fcBal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _fcLoan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _fcStatus(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return _fcLoan(loanId).status;
    }

    function _fcSetRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf));
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function _fcRoute(bool fails) internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: fails ? failingAdapterIdx : workingAdapterIdx, data: bytes("")});
    }

    /// @dev ERC20Mock tokens are minted; VPFI comes from this contract's
    ///      initial supply (the harness deployed the token to itself).
    function _fcFund(address who, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == vpfi) {
            assertTrue(IERC20(vpfi).transfer(who, amount), "VPFI funding");
        } else {
            ERC20Mock(token).mint(who, amount);
        }
    }

    // =====================================================================
    //  Event decoding
    // =====================================================================

    /// @dev Every `FallbackCustodyMoved` the Diamond emitted for `loanId`, in
    ///      emission order.
    function _fcMoves(Vm.Log[] memory logs, uint256 loanId) internal view returns (FcMove[] memory out) {
        bytes32 sig = LibFallbackCustody.FallbackCustodyMoved.selector;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (_fcIsMove(logs[i], sig, loanId)) ++n;
        }
        out = new FcMove[](n);
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (!_fcIsMove(logs[i], sig, loanId)) continue;
            (address asset, uint256 amount, uint256 custodyAfter) =
                abi.decode(logs[i].data, (address, uint256, uint256));
            out[k++] = FcMove({
                move: uint8(uint256(logs[i].topics[2])),
                counterparty: address(uint160(uint256(logs[i].topics[3]))),
                asset: asset,
                amount: amount,
                custodyAfter: custodyAfter
            });
        }
    }

    function _fcIsMove(Vm.Log memory log, bytes32 sig, uint256 loanId) internal view returns (bool) {
        return log.emitter == address(diamond) && log.topics.length == 4 && log.topics[0] == sig
            && log.topics[1] == bytes32(loanId);
    }

    /// @dev Total amount and count of the moves of one kind.
    function _fcSum(FcMove[] memory moves, LibFallbackCustody.Move kind)
        internal
        pure
        returns (uint256 sum, uint256 count)
    {
        for (uint256 i; i < moves.length; ++i) {
            if (moves[i].move == uint8(kind)) {
                sum += moves[i].amount;
                ++count;
            }
        }
    }

    /// @dev One internal-match leg's debit of a paying row: lender share plus
    ///      matcher incentive.
    function _fcLegDebit(FcMove[] memory moves) internal pure returns (uint256) {
        (uint256 toLender,) = _fcSum(moves, LibFallbackCustody.Move.MatchToLender);
        (uint256 toMatcher,) = _fcSum(moves, LibFallbackCustody.Move.MatchToMatcher);
        return toLender + toMatcher;
    }

    /// @dev Replays `moves` from `start`, asserting each `custodyAfter` is the
    ///      running row; returns the final row. Credits are `Entered` and
    ///      `RetryRestored`; every other kind is a debit.
    function _fcReplay(FcMove[] memory moves, uint256 start) internal pure returns (uint256 running) {
        running = start;
        for (uint256 i; i < moves.length; ++i) {
            bool credit = moves[i].move == uint8(LibFallbackCustody.Move.Entered)
                || moves[i].move == uint8(LibFallbackCustody.Move.RetryRestored);
            running = credit ? running + moves[i].amount : running - moves[i].amount;
            assertEq(moves[i].custodyAfter, running, "each move states the row it leaves");
        }
    }

    function _fcAssertMove(
        FcMove memory m,
        LibFallbackCustody.Move kind,
        address counterparty,
        address asset,
        uint256 amount,
        uint256 custodyAfter
    ) internal pure {
        assertEq(m.move, uint8(kind), "move kind");
        assertEq(m.counterparty, counterparty, "move counterparty");
        assertEq(m.asset, asset, "move asset");
        assertEq(m.amount, amount, "move amount");
        assertEq(m.custodyAfter, custodyAfter, "move custodyAfter");
    }

    /// @dev The claim-time retry's `ClaimRetryExecuted` for `loanId`: whether
    ///      it ran in the recorded call, and whether it succeeded.
    function _fcRetryOutcome(Vm.Log[] memory logs, uint256 loanId) internal view returns (bool ran, bool ok) {
        bytes32 sig = ClaimFacet.ClaimRetryExecuted.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(diamond) && logs[i].topics.length > 1 && logs[i].topics[0] == sig
                    && logs[i].topics[1] == bytes32(loanId)
            ) {
                ran = true;
                (ok,) = abi.decode(logs[i].data, (bool, uint256));
            }
        }
    }

    /// @dev The 2-way `InternalMatchExecuted` for the pair `(a, b)`.
    function _fcMatch(Vm.Log[] memory logs, uint256 a, uint256 b) internal view returns (FcMatch memory r) {
        bytes32 sig = RiskMatchLiquidationFacet.InternalMatchExecuted.selector;
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(diamond) && logs[i].topics.length == 3 && logs[i].topics[0] == sig
                    && logs[i].topics[1] == bytes32(a) && logs[i].topics[2] == bytes32(b)
            ) {
                (,, uint256 nA, uint256 nB,, uint256 iA, uint256 iB,) = abi.decode(
                    logs[i].data, (uint256, address, uint256, uint256, uint256, uint256, uint256, uint256)
                );
                r = FcMatch({movedX: nA, movedY: nB, incentiveX: iA, incentiveY: iB});
                seen = true;
            }
        }
        assertTrue(seen, "fixture-live: the match was executed");
    }
}
