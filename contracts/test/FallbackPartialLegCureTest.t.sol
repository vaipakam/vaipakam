// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CustodyInvariantBase} from "./invariants/CustodyInvariantBase.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";
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
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  FallbackPartialLegCureTest
 * @notice #2448 -- a FallbackPending loan that took a PARTIAL internal-match
 *         leg must stay exactly collateralised in its borrower's vault, so
 *         every later consumer of it works: the cure by top-up, the curing
 *         repayment, the borrower's claim, and a fresh liquidation or default
 *         of the cured loan.
 *
 *         The S0 custody harness (#2141) found the failure on the pre-S2b
 *         code. A partial leg rescaled the fallback snapshot by flooring each
 *         of its three slices independently, so the snapshot fell up to 2
 *         units short of the custody it described. The cure and the curing
 *         repayment then rebuilt the lien from that short sum while
 *         `collateralAmount` still counted the lost units, after which
 *         `triggerLiquidation` (both venues), `triggerDefault` and
 *         `claimAsBorrower` reverted `WithdrawWouldUnderflowLien`: each of
 *         them withdraws `collateralAmount` from a vault that tracked less.
 *
 *         S2b removes both halves. The partial rescale gives the floor
 *         remainder to the borrower slice, so the snapshot totals the custody
 *         row exactly (K5). The cure and the curing repayment move nothing:
 *         they return the row to the pledge (`ReturnedToPledge`) under a lien
 *         that already equals `collateralAmount`, because every partial leg
 *         debits the row, the lien and `collateralAmount` by the same amount
 *         and every top-up credits the lien and `collateralAmount` together.
 *         These cells pin the observable result end to end.
 *
 * @dev    Every cell drives the REAL producers on the {CustodyInvariantBase}
 *         harness (SetupTest's full production cut, an external treasury, one
 *         always-reverting and one paying swap venue, internal matching on).
 *         The loan enters FallbackPending through `triggerLiquidation` with
 *         the reverting venue, so `FallbackCustodyFacet.enterFallback` itself
 *         writes the custody; the partial leg is the real
 *         `triggerInternalMatchLiquidation` against a reverse-pair counter-loan
 *         (WETH principal `m`, USDC collateral `2m`) sized so the leg is
 *         partial for the fallback loan and full for the counter-loan. `m` is
 *         chosen from the live snapshot as the first consumption at which
 *         flooring the three slices independently would strand units, and the
 *         fixture asserts that stranded remainder is non-zero before the leg
 *         runs: at a ratio where independent flooring happens to be exact, no
 *         cell could tell K5 from its mutant. Nothing here writes raw state.
 *
 *         Mutation every cell kills -- K5 reverted to independent flooring of
 *         all three slices (`RiskMatchLiquidationFacet`, the FallbackPending
 *         partial branch of `_settleFallbackOrTransitionPostMatch`): the
 *         rescaled snapshot totals less than the row, so the custody
 *         discriminator (`LibFallbackCustody.isLegacy`, snapshot total != row)
 *         misreads the loan as a Diamond-held legacy row. The cure and the
 *         curing repayment then refuse it by name
 *         (`FallbackCustodyNotVaultHeld`), and the attribution cell reads a
 *         non-zero legacy amount and a snapshot that no longer totals the row.
 */
contract FallbackPartialLegCureTest is CustodyInvariantBase {
    uint256 internal constant PL_HF_HEALTHY = 2e18;
    uint256 internal constant PL_HF_LIQUIDATABLE = 0.9e18;
    /// @dev Inside every admission cap the harness's loans are born under, so a
    ///      top-up at this reading cures a FallbackPending loan.
    uint256 internal constant PL_LTV_HEALTHY = 5_000;
    /// @dev Above the 8500 tier floor plus the widest external-liquidation
    ///      priority window (the external swap path is open), below the 11000
    ///      value-collapse threshold.
    uint256 internal constant PL_LTV_LIQUIDATABLE = 9_600;
    uint256 internal constant PL_LOAN_DAYS = 30;
    /// @dev Past every default-schedule grace bucket for a 30-day term.
    uint256 internal constant PL_PAST_EVERY_GRACE = 8 days;
    uint256 internal constant PL_RATE_BPS = 1_000;
    uint256 internal constant PL_PRINCIPAL = 1_000e18;
    uint256 internal constant PL_COLLATERAL = 2_000e18;
    /// @dev Where the search for the first lossy consumption starts. The
    ///      counter-loan's whole collateral (`2m`, about 600) pays down the
    ///      fallback loan's 1000 of principal, so that loan keeps about 400
    ///      (a PARTIAL leg) while the counter-loan's `m` of principal clears
    ///      (a full leg).
    uint256 internal constant PL_FIRST_LEG_FROM = 300e18;
    /// @dev Cell (c)'s second leg: `2m` of about 200 stays below the roughly
    ///      400 of principal the first leg left, so it is partial too.
    uint256 internal constant PL_SECOND_LEG_FROM = 100e18;
    uint256 internal constant PL_TOP_UP = 50e18;

    /// @notice One fallback loan after its first partial leg.
    struct PlLeg {
        uint256 a; // the FallbackPending loan, partially rescued
        uint256 b; // the counter-loan the leg matched in full
        uint256 m; // collateral the leg consumed from a's custody row
        uint256 n; // a's custody row after the leg
        uint256 stranded; // units independent flooring would have left in no slice
        uint256 diamondWeth0; // the Diamond's WETH before the leg
    }

    address internal plLender;
    address internal plLender2;
    address internal plBorrower;
    uint256 internal plBorrowerPk;
    address internal plBorrower2;
    uint256 internal plBorrower2Pk;
    address internal plBorrower3;
    uint256 internal plBorrower3Pk;
    address internal plMatcher;
    address internal plLiquidator;

    function setUp() public {
        _deployCustodyHarness();
        plLender = custodyLenders[0];
        plLender2 = custodyLenders[1];
        plBorrower = custodyBorrowers[0];
        plBorrowerPk = custodyBorrowerPks[0];
        plBorrower2 = custodyBorrowers[1];
        plBorrower2Pk = custodyBorrowerPks[1];
        plBorrower3 = custodyBorrowers[2];
        plBorrower3Pk = custodyBorrowerPks[2];
        plMatcher = makeAddr("partialLegMatcher");
        plLiquidator = makeAddr("partialLegLiquidator");
        // Fixture-live: the harness leaves no WETH in the Diamond, so every
        // Diamond balance below starts from a known zero.
        assertEq(IERC20(weth).balanceOf(address(diamond)), 0, "genesis: no WETH in the Diamond");
    }

    // =====================================================================
    //  (a) partial leg, then a cure by top-up, then a fresh forced close
    // =====================================================================

    /// @notice (a) Partial leg, then a cure by top-up: the loan is Active with
    ///         lien == collateralAmount == the vault's encumbrance aggregate
    ///         and tracked balance; a later HF drop then liquidates it through
    ///         the paying venue, which receives exactly collateralAmount.
    /// @dev    WHY: this is the #2448 sequence. Before S2b the cure re-liened
    ///         the short snapshot sum, and the liquidation's withdraw of
    ///         `collateralAmount` reverted `WithdrawWouldUnderflowLien`.
    ///         Kills: K5 reverted to independent flooring (the cure refuses the
    ///         loan as legacy, `FallbackCustodyNotVaultHeld`); a cure that
    ///         re-adds the custody to the lien or re-deposits it (the exact
    ///         pledge checks in {_plCureByTopUp}).
    function test_K5a_partialLegThenTopUpCure_swapLiquidationSucceeds() public {
        PlLeg memory f = _plPartialLegOnFallback();
        uint256 c = _plCureByTopUp(f);

        _plSetRisk(f.a, PL_HF_LIQUIDATABLE, PL_LTV_LIQUIDATABLE);
        vm.prank(plLiquidator);
        RiskFacet(address(diamond)).triggerLiquidation(f.a, _plRoute(false));

        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.Defaulted),
            "the swap liquidation closed the cured loan"
        );
        _plAssertSoldExactly(f.a, c, f.diamondWeth0);
    }

    /// @notice (a2) The same cured loan liquidated through the REVERTING
    ///         venue re-enters FallbackPending, and the new episode's custody
    ///         is exactly the cured collateralAmount, liened in the vault.
    /// @dev    WHY: #2448 named both venues. The failed-swap leg withdraws
    ///         `collateralAmount` first, exactly like the paying one, and the
    ///         producer then credits back what it withdrew; a vault short of
    ///         `collateralAmount` reverted it before any swap ran.
    ///         Kills: K5 reverted to independent flooring (the cure refuses the
    ///         loan); a second entry that does not re-lien what it returns.
    function test_K5a2_partialLegThenTopUpCure_failedVenueReentersExactly() public {
        PlLeg memory f = _plPartialLegOnFallback();
        uint256 c = _plCureByTopUp(f);

        _plSetRisk(f.a, PL_HF_LIQUIDATABLE, PL_LTV_LIQUIDATABLE);
        vm.prank(plLiquidator);
        RiskFacet(address(diamond)).triggerLiquidation(f.a, _plRoute(true));

        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "the reverting venue re-entered FallbackPending"
        );
        _plAssertReentered(f.a, c, f.diamondWeth0);
    }

    /// @notice (a3) The cured loan defaults at grace end through the paying
    ///         venue, which receives exactly collateralAmount.
    /// @dev    WHY: #2448's `triggerDefault` revert. The time-based default
    ///         releases the lien and withdraws `collateralAmount` like the HF
    ///         liquidation, through its own facet, so it is pinned on its own.
    ///         Kills: K5 reverted to independent flooring (the cure refuses the
    ///         loan as legacy).
    function test_K5a3_partialLegThenTopUpCure_defaultAtGraceEndSucceeds() public {
        PlLeg memory f = _plPartialLegOnFallback();
        uint256 c = _plCureByTopUp(f);

        LibVaipakam.Loan memory l = _plLoan(f.a);
        vm.warp(uint256(l.startTime) + l.durationDays * 1 days + PL_PAST_EVERY_GRACE);
        vm.prank(plLiquidator);
        DefaultedFacet(address(diamond)).triggerDefault(f.a, _plRoute(false));

        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.Defaulted),
            "the time-based default closed the cured loan"
        );
        _plAssertSoldExactly(f.a, c, f.diamondWeth0);
    }

    /// @notice (a4) The cured loan's default through the REVERTING venue
    ///         re-enters FallbackPending with custody of exactly
    ///         collateralAmount.
    /// @dev    WHY: the DefaultedFacet producer path of (a2); the two forced
    ///         closes share one fallback host but withdraw through their own
    ///         code. Kills: K5 reverted to independent flooring (the cure
    ///         refuses the loan as legacy).
    function test_K5a4_partialLegThenTopUpCure_defaultThroughFailedVenueReentersExactly() public {
        PlLeg memory f = _plPartialLegOnFallback();
        uint256 c = _plCureByTopUp(f);

        LibVaipakam.Loan memory l = _plLoan(f.a);
        vm.warp(uint256(l.startTime) + l.durationDays * 1 days + PL_PAST_EVERY_GRACE);
        vm.prank(plLiquidator);
        DefaultedFacet(address(diamond)).triggerDefault(f.a, _plRoute(true));

        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "the reverting venue re-entered FallbackPending"
        );
        _plAssertReentered(f.a, c, f.diamondWeth0);
    }

    // =====================================================================
    //  (b) partial leg, then a curing full repayment, then the claim
    // =====================================================================

    /// @notice (b) Partial leg, then a full repayment that cures: the loan is
    ///         Repaid with its lien equal to collateralAmount, and
    ///         `claimAsBorrower` pays exactly collateralAmount and releases it.
    /// @dev    WHY: #2448's `claimAsBorrower` revert. The curing repayment
    ///         records `collateralAmount` as the borrower's claim, so the vault
    ///         must hold and lien exactly that; before S2b it held the short
    ///         snapshot sum and the claim's withdraw underflowed.
    ///         Kills: K5 reverted to independent flooring (the curing
    ///         repayment refuses the loan as legacy,
    ///         `FallbackCustodyNotVaultHeld`); a curing repayment that
    ///         re-deposits or re-liens the custody (the pledge checks).
    function test_K5b_partialLegThenRepayCure_claimAsBorrowerPaysExactlyTheCollateral() public {
        PlLeg memory f = _plPartialLegOnFallback();
        uint256 c = _plLoan(f.a).collateralAmount;
        assertEq(c, f.n, "fixture-live: the collateral is the surviving custody row");
        _plFund(plBorrower, usdc, 2 * PL_PRINCIPAL);

        vm.prank(plBorrower);
        RepayFacet(address(diamond)).repayLoan(f.a);
        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "fixture-live: the full repayment cured and closed the partially rescued loan"
        );

        assertEq(_plRow(f.a), 0, "the custody returned to the pledge");
        _plAssertPledge(f.a, c);
        (, uint256 owed, bool claimed) = ClaimFacet(address(diamond)).getClaimableAmount(f.a, false);
        assertEq(owed, c, "the borrower is owed exactly collateralAmount");
        assertFalse(claimed, "and has not claimed it yet");
        assertEq(_plBal(weth, address(diamond)), f.diamondWeth0, "the curing repayment moved nothing through the Diamond");

        uint256 wallet0 = _plBal(weth, plBorrower);
        vm.prank(plBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(f.a);

        assertEq(_plBal(weth, plBorrower) - wallet0, c, "the claim pays exactly collateralAmount");
        assertEq(_plLien(f.a), 0, "and releases the lien");
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(plBorrower, weth, 0),
            0,
            "nothing stays encumbered"
        );
        assertEq(_plBal(weth, _plVault(plBorrower)), 0, "the vault keeps none of the loan's collateral");
        assertEq(_plBal(weth, address(diamond)), f.diamondWeth0, "the Diamond was never a waypoint");
    }

    // =====================================================================
    //  (c) the Diamond never holds the loan's collateral after a leg
    // =====================================================================

    /// @notice (c) Across two lossy partial legs, a non-curing top-up, the
    ///         curing repayment and the claim, the Diamond's WETH never moves
    ///         and the borrower's vault holds, liens and tracks exactly
    ///         collateralAmount, which is the custody row plus the top-up with
    ///         every unit of the row in a snapshot slice. The claim then pays
    ///         out all of it.
    /// @dev    WHY: no user asset rests in protocol custody across
    ///         transactions (#2141, Option F), and no unit of a fallback
    ///         loan's collateral is owned by nobody. Two legs, because K5 is an
    ///         induction (each leg's rescale assumes the previous one left the
    ///         snapshot equal to the row); a single leg would not reach the
    ///         second step.
    ///         Kills: K5 reverted to independent flooring (after the first leg
    ///         the legacy reading is the short snapshot total, not 0, and the
    ///         snapshot no longer totals the row); any leg or top-up that
    ///         routes collateral through the Diamond (the balance delta).
    function test_K5c_partialLegs_diamondNeverHoldsTheCollateral() public {
        PlLeg memory f = _plPartialLegOnFallback();
        _plAssertAttributed(f.a, 0, f.diamondWeth0);

        (,, uint256 n2,) =
            _plLossyPartialLeg(f.a, plLender2, plBorrower3, plBorrower3Pk, PL_SECOND_LEG_FROM);
        assertLt(n2, f.n, "fixture-live: the second leg consumed more of the row");
        _plAssertAttributed(f.a, 0, f.diamondWeth0);

        // The risk readings are still liquidatable (set by the producer
        // fixture), so this top-up lands under the lien without curing.
        _plTopUp(f.a, PL_TOP_UP);
        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the top-up did not cure"
        );
        _plAssertAttributed(f.a, PL_TOP_UP, f.diamondWeth0);

        uint256 c = _plLoan(f.a).collateralAmount;
        _plFund(plBorrower, usdc, 2 * PL_PRINCIPAL);
        vm.prank(plBorrower);
        RepayFacet(address(diamond)).repayLoan(f.a);
        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.Repaid),
            "fixture-live: the full repayment cured and closed the loan"
        );
        assertEq(_plBal(weth, address(diamond)), f.diamondWeth0, "the curing repayment moved nothing through the Diamond");
        _plAssertPledge(f.a, c);

        uint256 wallet0 = _plBal(weth, plBorrower);
        vm.prank(plBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(f.a);
        assertEq(
            _plBal(weth, plBorrower) - wallet0,
            c,
            "the claim pays out every unit: the two lossy legs stranded none"
        );
        assertEq(_plBal(weth, address(diamond)), f.diamondWeth0, "and none of it ever rested in the Diamond");
    }

    // =====================================================================
    //  Fixtures
    // =====================================================================

    /// @dev A forward loan (USDC principal, WETH collateral at twice that)
    ///      entered into FallbackPending by the real HF producer, then one
    ///      lossy partial leg through the real explicit match.
    function _plPartialLegOnFallback() internal returns (PlLeg memory f) {
        f.a = _plOpen(plLender, plBorrower, plBorrowerPk, usdc, PL_PRINCIPAL, weth, PL_COLLATERAL);
        _plLiquidateToFallback(f.a);
        (uint256 row, uint256 legacy) = _plCustody(f.a);
        assertEq(row, PL_COLLATERAL, "fixture-live: the custody row is the whole collateral");
        assertEq(legacy, 0, "fixture-live: nothing reads as Diamond-held");
        f.diamondWeth0 = _plBal(weth, address(diamond));
        (f.b, f.m, f.n, f.stranded) =
            _plLossyPartialLeg(f.a, plLender2, plBorrower2, plBorrower2Pk, PL_FIRST_LEG_FROM);
    }

    /// @dev One partial leg on the FallbackPending loan `a`, at the first
    ///      consumption `m >= from` at which flooring the CURRENT snapshot's
    ///      three slices independently would strand units
    ///      ({_plPickLossyConsumption}). The counter-loan lends `m` WETH against
    ///      `2m` USDC, so leg Y takes exactly `m` of a's row and leg X pays down
    ///      `2m` of a's principal. Fixture-live: the leg is partial for `a` and
    ///      full for the counter-loan, and the row dropped by exactly `m`.
    function _plLossyPartialLeg(
        uint256 a,
        address lender_,
        address borrower_,
        uint256 borrowerPk_,
        uint256 from
    ) internal returns (uint256 b, uint256 m, uint256 n, uint256 stranded) {
        (m, n, stranded) = _plPickLossyConsumption(a, from);
        b = _plOpen(lender_, borrower_, borrowerPk_, weth, m, usdc, 2 * m);
        _plSetRisk(b, PL_HF_LIQUIDATABLE, PL_LTV_LIQUIDATABLE);
        uint256 principal0 = _plLoan(a).principal;
        vm.prank(plMatcher);
        RiskMatchLiquidationFacet(address(diamond)).triggerInternalMatchLiquidation(a, b, 0);

        assertEq(
            uint8(_plStatus(a)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the leg was PARTIAL for the fallback loan"
        );
        assertEq(
            uint8(_plStatus(b)),
            uint8(LibVaipakam.LoanStatus.InternalMatched),
            "fixture-live: and full for the counter-loan"
        );
        assertEq(_plRow(a), n, "fixture-live: the leg consumed exactly m of the custody row");
        assertEq(
            _plLoan(a).principal,
            principal0 - 2 * m,
            "fixture-live: the counter-loan's whole collateral paid down the principal"
        );
    }

    /// @dev Reads the live snapshot of `a` and picks the first consumption
    ///      `m >= from` at which the three independently floored slices would
    ///      total less than the surviving row `n`. Fixture-live: the snapshot
    ///      totals the row before the leg (the entry made it so, or K5 kept it
    ///      so), and the stranded remainder is 1 or 2 units -- non-zero, so the
    ///      cell can tell K5 from independent flooring, and at most one unit
    ///      per floored slice.
    function _plPickLossyConsumption(uint256 a, uint256 from)
        internal
        view
        returns (uint256 m, uint256 n, uint256 stranded)
    {
        (uint256 lc, uint256 tc, uint256 bc) = _plSlices(a);
        uint256 o = lc + tc + bc;
        assertEq(o, _plRow(a), "fixture-live: the snapshot totals the custody row before the leg");
        m = _plLossyConsumption(lc, tc, bc, from);
        n = o - m;
        stranded = n - ((lc * n) / o + (tc * n) / o + (bc * n) / o);
        assertGt(stranded, 0, "fixture-live: independent flooring would strand units at this ratio");
        assertLe(stranded, 2, "fixture-live: at most one unit per floored slice");
    }

    /// @dev The cure by top-up through the real `addCollateral`, at healthy
    ///      risk readings, and the exact pledge it must leave: the custody row
    ///      returned, nothing reads as Diamond-held, and the lien, the
    ///      encumbrance aggregate, the tracked balance and the vault balance
    ///      all equal `collateralAmount`, which is the surviving row plus the
    ///      top-up. Returns that `collateralAmount`.
    function _plCureByTopUp(PlLeg memory f) internal returns (uint256 c) {
        _plSetRisk(f.a, PL_HF_HEALTHY, PL_LTV_HEALTHY);
        _plTopUp(f.a, PL_TOP_UP);
        assertEq(
            uint8(_plStatus(f.a)),
            uint8(LibVaipakam.LoanStatus.Active),
            "fixture-live: the top-up cured the partially rescued loan"
        );
        c = _plLoan(f.a).collateralAmount;
        assertEq(c, f.n + PL_TOP_UP, "the cured collateral is the surviving row plus the top-up");
        (uint256 row, uint256 legacy) = _plCustody(f.a);
        assertEq(row, 0, "the custody returned to the pledge");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        _plAssertPledge(f.a, c);
        assertEq(_plBal(weth, address(diamond)), f.diamondWeth0, "the cure moved nothing through the Diamond");
    }

    /// @dev The real producer: an HF liquidation through the always-reverting
    ///      venue. Leaves the loan's risk readings liquidatable, so a later
    ///      top-up does not cure it unless the cell restores them.
    function _plLiquidateToFallback(uint256 loanId) internal {
        _plSetRisk(loanId, PL_HF_LIQUIDATABLE, PL_LTV_LIQUIDATABLE);
        RiskFacet(address(diamond)).triggerLiquidation(loanId, _plRoute(true));
        assertEq(
            uint8(_plStatus(loanId)),
            uint8(LibVaipakam.LoanStatus.FallbackPending),
            "fixture-live: the failed liquidation entered FallbackPending"
        );
    }

    /// @dev Opens a loan through the real lender offer and the borrower's
    ///      signed accept, then gives it healthy per-loan risk readings
    ///      (SetupTest mocks HF and LTV globally; a per-loan mock is how a
    ///      loan becomes liquidatable later).
    function _plOpen(
        address lender_,
        address borrower_,
        uint256 borrowerPk_,
        address lending,
        uint256 principal,
        address collateral,
        uint256 collateralAmount
    ) internal returns (uint256 loanId) {
        _plFund(lender_, lending, principal);
        _plFund(borrower_, collateral, collateralAmount);
        LibVaipakam.CreateOfferParams memory p = LibVaipakam.CreateOfferParams({
            offerType: LibVaipakam.OfferType.Lender,
            lendingAsset: lending,
            amount: principal,
            interestRateBps: PL_RATE_BPS,
            collateralAsset: collateral,
            collateralAmount: collateralAmount,
            durationDays: PL_LOAN_DAYS,
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
            interestRateBpsMax: PL_RATE_BPS,
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
        _plSetRisk(loanId, PL_HF_HEALTHY, PL_LTV_HEALTHY);
        assertEq(uint8(_plStatus(loanId)), uint8(LibVaipakam.LoanStatus.Active), "fixture-live: the loan opened Active");
    }

    /// @dev A top-up through the real entry point, paid by the stored borrower.
    function _plTopUp(uint256 loanId, uint256 amount) internal {
        LibVaipakam.Loan memory l = _plLoan(loanId);
        _plFund(l.borrower, l.collateralAsset, amount);
        vm.prank(l.borrower);
        AddCollateralFacet(address(diamond)).addCollateral(loanId, amount);
    }

    /// @dev The first consumption >= `start` at which flooring the three slices
    ///      independently loses at least one unit of the surviving row.
    function _plLossyConsumption(uint256 l, uint256 t, uint256 b, uint256 start) internal pure returns (uint256) {
        uint256 o = l + t + b;
        for (uint256 k; k < 512; ++k) {
            uint256 m = start + k;
            uint256 n = o - m;
            if ((l * n) / o + (t * n) / o + (b * n) / o < n) return m;
        }
        revert("FallbackPartialLegCureTest: no lossy ratio in range");
    }

    // =====================================================================
    //  Shared property checks
    // =====================================================================

    /// @dev The loan's pledge is exactly `c` everywhere it is recorded: the
    ///      per-loan lien, the owner's encumbrance aggregate (this owner has
    ///      no other WETH lien), the vault's tracked balance and the vault's
    ///      token balance.
    function _plAssertPledge(uint256 loanId, uint256 c) internal view {
        address owner_ = _plLoan(loanId).borrower;
        assertEq(_plLien(loanId), c, "the lien is exactly collateralAmount");
        assertEq(
            MetricsFacet(address(diamond)).getEncumbered(owner_, weth, 0),
            c,
            "the vault's encumbrance aggregate is exactly collateralAmount"
        );
        assertEq(_plTracked(owner_, weth), c, "the vault tracks exactly collateralAmount");
        assertEq(_plBal(weth, _plVault(owner_)), c, "the vault holds exactly collateralAmount");
    }

    /// @dev A FallbackPending loan's collateral is fully attributed: the
    ///      Diamond holds none of it, nothing reads as Diamond-held, every
    ///      unit of the custody row is in a snapshot slice (K5), and
    ///      `collateralAmount` is the row plus the top-up, pledged exactly.
    function _plAssertAttributed(uint256 loanId, uint256 topUp, uint256 diamond0) internal view {
        LibVaipakam.Loan memory l = _plLoan(loanId);
        (uint256 row, uint256 legacy) = _plCustody(loanId);
        assertEq(_plBal(weth, address(diamond)), diamond0, "the Diamond holds none of the loan's collateral");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        assertEq(_plSnapshotTotal(loanId), row, "every unit of the custody row is in a snapshot slice");
        assertEq(l.collateralAmount, row + topUp, "collateralAmount is the custody row plus the top-up");
        assertEq(_plLien(loanId), row + topUp, "the lien is the custody row plus the top-up");
        _plAssertPledge(loanId, l.collateralAmount);
    }

    /// @dev After a forced close through the paying venue: the venue received
    ///      exactly `c` of WETH, the borrower's vault released all of it, no
    ///      lien or encumbrance survives, and the Diamond kept none.
    function _plAssertSoldExactly(uint256 loanId, uint256 c, uint256 diamond0) internal view {
        address owner_ = _plLoan(loanId).borrower;
        assertEq(
            _plBal(weth, address(workingAdapter)),
            VENUE_FLOAT + c,
            "the paying venue received exactly collateralAmount"
        );
        assertEq(_plBal(weth, _plVault(owner_)), 0, "the vault released all of it");
        assertEq(_plTracked(owner_, weth), 0, "and tracks none of it");
        assertEq(_plLien(loanId), 0, "no lien survives");
        assertEq(MetricsFacet(address(diamond)).getEncumbered(owner_, weth, 0), 0, "nothing stays encumbered");
        assertEq(_plBal(weth, address(diamond)), diamond0, "the Diamond kept none of it");
    }

    /// @dev After a cured loan re-entered FallbackPending: the new episode's
    ///      custody row and snapshot are exactly `c`, pledged exactly, and the
    ///      Diamond holds none of it.
    function _plAssertReentered(uint256 loanId, uint256 c, uint256 diamond0) internal view {
        (uint256 row, uint256 legacy) = _plCustody(loanId);
        assertEq(row, c, "the new episode's custody row is the whole cured collateral");
        assertEq(legacy, 0, "nothing reads as Diamond-held");
        assertEq(_plSnapshotTotal(loanId), c, "and its snapshot splits exactly that");
        _plAssertPledge(loanId, c);
        assertEq(_plBal(weth, address(diamond)), diamond0, "the Diamond holds none of it");
    }

    // =====================================================================
    //  Reads
    // =====================================================================

    function _plCustody(uint256 loanId) internal view returns (uint256 row, uint256 legacy) {
        return FallbackCustodyFacet(address(diamond)).getFallbackCustody(loanId);
    }

    function _plRow(uint256 loanId) internal view returns (uint256 row) {
        (row,) = _plCustody(loanId);
    }

    function _plLien(uint256 loanId) internal view returns (uint256 amount) {
        (amount,) = TestMutatorFacet(address(diamond)).getLoanCollateralLienAmount(loanId);
    }

    function _plSlices(uint256 loanId) internal view returns (uint256 l, uint256 t, uint256 b) {
        (l, t, b,,,,) = ClaimFacet(address(diamond)).getFallbackSnapshot(loanId);
    }

    function _plSnapshotTotal(uint256 loanId) internal view returns (uint256) {
        (uint256 l, uint256 t, uint256 b) = _plSlices(loanId);
        return l + t + b;
    }

    function _plTracked(address who, address token) internal view returns (uint256) {
        return VaultFactoryFacet(address(diamond)).getProtocolTrackedVaultBalance(who, token);
    }

    function _plVault(address who) internal view returns (address) {
        return VaultFactoryFacet(address(diamond)).getUserVaultAddress(who);
    }

    function _plBal(address token, address who) internal view returns (uint256) {
        return IERC20(token).balanceOf(who);
    }

    function _plLoan(uint256 loanId) internal view returns (LibVaipakam.Loan memory) {
        return LoanFacet(address(diamond)).getLoanDetails(loanId);
    }

    function _plStatus(uint256 loanId) internal view returns (LibVaipakam.LoanStatus) {
        return _plLoan(loanId).status;
    }

    function _plSetRisk(uint256 loanId, uint256 hf, uint256 ltv) internal {
        vm.mockCall(
            address(diamond), abi.encodeWithSelector(RiskFacet.calculateHealthFactor.selector, loanId), abi.encode(hf)
        );
        vm.mockCall(address(diamond), abi.encodeWithSelector(RiskFacet.calculateLTV.selector, loanId), abi.encode(ltv));
    }

    function _plRoute(bool fails) internal view returns (LibSwap.AdapterCall[] memory route) {
        route = new LibSwap.AdapterCall[](1);
        route[0] = LibSwap.AdapterCall({adapterIdx: fails ? failingAdapterIdx : workingAdapterIdx, data: bytes("")});
    }

    /// @dev Both harness tokens here (USDC, WETH) are ERC20Mock and minted.
    function _plFund(address who, address token, uint256 amount) internal {
        if (amount == 0) return;
        ERC20Mock(token).mint(who, amount);
    }
}
