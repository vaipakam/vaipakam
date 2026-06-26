// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  LenderIntentCapitalTest
 * @notice #393 v1-d (Layer 1) — the standing-intent WORKING-CAPITAL lifecycle:
 *         `fundLenderIntent` (wallet → vault + intent-capital lien) and
 *         `withdrawLenderIntentCapital` (the `cancelOffer`-style exit). The
 *         funded capital is held as a lien (mirroring an offer's principal),
 *         so `matchIntent` draws fill slices from it and the exit returns the
 *         un-lent remainder — and repaid proceeds (separate free balance + a
 *         Position-NFT claim) can NEVER be double-spent through the exit door.
 *
 * @dev    Same setup posture as `LenderIntentMatchTest`: $1/token 18-dec
 *         oracle, partial-fill + lenderIntentEnabled ON, intent maxInitLtv=50%
 *         (collateral = 2x principal) so the materialized lender slice clears
 *         the HF gate. `lender` is the inherited SetupTest actor (User1).
 */
contract LenderIntentCapitalTest is SetupTest {
    address internal solver;

    uint256 internal constant PRINCIPAL = 1000 ether;
    uint256 internal constant MAX_EXPOSURE = 10_000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5000; // 50% ⇒ reqColl = 2x
    uint32 internal constant MAX_DURATION = 30;
    uint256 internal constant MIN_FILL = 100 ether;

    function setUp() public {
        setupHelper();
        solver = makeAddr("intentSolver");

        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.stopPrank();
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    function _setIntent() internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL, false, true
        );
    }

    /// @dev Mint wallet balance + approve the Diamond for exactly `amount`,
    ///      then fund the (already-active) intent.
    function _fund(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, amount
        );
    }

    function _capital() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20
        );
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentLivePrincipal(
            lender, mockERC20, mockCollateralERC20
        );
    }

    /// @dev The borrower from the most recent `_fillAndRepay` (for tests that
    ///      need to drive the borrower-side claim).
    address internal lastBorrower;

    /// @dev Fund → fill an intent against a fresh borrower → borrower repays in
    ///      full. Returns the repaid loan id (status Repaid, lender claim set).
    function _fillAndRepay() internal returns (uint256 loanId) {
        _setIntent();
        _fund(PRINCIPAL);
        address b = _newBorrower("rollB");
        lastBorrower = b;
        uint256 cp = _postBorrower(b);
        vm.prank(solver);
        loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
    }

    function _newBorrower(string memory name) internal returns (address b) {
        b = makeAddr(name);
        ERC20Mock(mockERC20).mint(b, 1_000_000 ether);
        ERC20Mock(mockCollateralERC20).mint(b, 1_000_000 ether);
        vm.prank(b);
        ERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
    }

    function _postBorrower(address creator) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: MAX_DURATION,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: PRINCIPAL,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    // ─── 1. Fund — increments capital + moves wallet → vault ─────────────────

    function test_fund_incrementsCapital_andPullsFromWallet() public {
        _setIntent();
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        assertEq(_capital(), PRINCIPAL, "capital == funded");
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            walletBefore - PRINCIPAL,
            "pulled exactly from wallet"
        );
    }

    function test_fund_topUp_accumulates() public {
        _setIntent();
        _fund(PRINCIPAL);
        _fund(PRINCIPAL);
        assertEq(_capital(), 2 * PRINCIPAL, "top-up accumulates");
    }

    // ─── 2. Fund — guards ───────────────────────────────────────────────────

    function test_fund_requiresActiveIntent_reverts() public {
        // No intent set → fund refused (capital never parked without a
        // governing intent).
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentNotActive.selector);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
    }

    function test_fund_zeroAmount_reverts() public {
        _setIntent();
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, 0
        );
    }

    // ─── 3. Withdraw — returns to wallet + decrements ───────────────────────

    function test_withdraw_returnsToWallet_andDecrements() public {
        _setIntent();
        _fund(PRINCIPAL);
        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        assertEq(_capital(), 0, "capital drained");
        assertEq(
            ERC20(mockERC20).balanceOf(lender),
            walletBefore + PRINCIPAL,
            "returned to wallet"
        );
    }

    function test_withdraw_partial_thenRemainder() public {
        _setIntent();
        _fund(PRINCIPAL);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL / 4
        );
        assertEq(_capital(), 3 * PRINCIPAL / 4, "partial withdraw");
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, 3 * PRINCIPAL / 4
        );
        assertEq(_capital(), 0, "remainder withdrawn");
    }

    function test_withdraw_exceedsCapital_reverts() public {
        _setIntent();
        _fund(PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibEncumbrance.IntentCapitalInsufficient.selector,
                lender, mockERC20, mockCollateralERC20,
                PRINCIPAL + 1, PRINCIPAL
            )
        );
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL + 1
        );
    }

    function test_withdraw_zeroAmount_reverts() public {
        _setIntent();
        _fund(PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentInvalidBounds.selector);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, 0
        );
    }

    /// @dev A cancelled intent's residual capital must remain withdrawable so a
    ///      lender can fully wind down (the exit is NOT gated on active).
    function test_withdraw_afterCancel_succeeds() public {
        _setIntent();
        _fund(PRINCIPAL);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        assertEq(_capital(), 0, "residual withdrawable after cancel");
    }

    // ─── 3b. Per-asset pause — blocks the on-ramp, NOT the exit (#393 v1-d.1) ─

    function test_fund_lendingAssetPaused_reverts() public {
        _setIntent();
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockERC20);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(IVaipakamErrors.AssetPaused.selector, mockERC20)
        );
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
    }

    function test_fund_collateralAssetPaused_reverts() public {
        _setIntent();
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockCollateralERC20);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.AssetPaused.selector, mockCollateralERC20
            )
        );
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
    }

    /// @dev Exit stays OPEN during a pause: a lender must always be able to
    ///      wind down standing capital (block-new / allow-exit posture).
    function test_withdraw_notBlockedByAssetPause() public {
        _setIntent();
        _fund(PRINCIPAL); // fund BEFORE the pause
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockERC20);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        assertEq(_capital(), 0, "exit succeeds despite asset pause");
    }

    /// @dev #393 v1-d.1 Codex round-2 — the root `setLenderIntent` VPFI gate
    ///      isn't airtight: `vpfiToken` can be rotated to an asset AFTER an
    ///      intent on it was already stored + funded. The fund on-ramp
    ///      re-asserts the block before custody moves; the exit stays open so
    ///      pre-existing capital can be wound down.
    function test_fund_blockedAfterAssetBecomesVPFI() public {
        _setIntent();
        _fund(PRINCIPAL); // funds fine — mockERC20 isn't VPFI yet
        // Operator rotates vpfiToken to the lending asset post-hoc.
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        // A top-up now reverts at the on-ramp (defense-in-depth).
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentVpfiLendingUnsupported.selector);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        // Exit stays open — the already-funded capital is still withdrawable.
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        assertEq(_capital(), 0, "pre-existing capital still withdrawable");
    }

    // ─── 4. matchIntent draws from the lien (under-funding reverts) ─────────

    function test_matchIntent_underfunded_reverts() public {
        _setIntent();
        _fund(PRINCIPAL / 2); // funded less than the fill needs
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibEncumbrance.IntentCapitalInsufficient.selector,
                lender, mockERC20, mockCollateralERC20,
                PRINCIPAL, PRINCIPAL / 2
            )
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    /// @dev #393 v1-d.1 Codex round-3 — a fill is blocked too if `vpfiToken`
    ///      rotates onto the lending asset of an already-funded intent (the
    ///      fund/root gates can't catch a row funded before the rotation).
    ///      Leaves only the wind-down exit (which checkpoints the VPFI rollup).
    function test_matchIntent_blockedAfterAssetBecomesVPFI() public {
        _setIntent();
        _fund(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b);
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        vm.prank(solver);
        vm.expectRevert(
            OfferMatchFacet.LenderIntentVpfiLendingUnsupported.selector
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ─── 5. The crux — repaid proceeds can't be double-spent via the exit ───

    function test_doubleSpend_repaidProceedsNotWithdrawableAsCapital() public {
        _setIntent();
        _fund(PRINCIPAL);
        assertEq(_capital(), PRINCIPAL, "funded");

        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b);
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        // The fill consumed the whole capital lien.
        assertEq(_capital(), 0, "capital drawn to zero by the fill");

        // Borrower repays → principal + interest now sits in the lender's vault
        // as a Position-NFT claim (a SEPARATE bucket from the intent lien).
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);

        // The exit door can NOT reach those proceeds: intent capital is 0, so a
        // withdraw of even 1 wei reverts. The repaid proceeds are claimable
        // ONLY through the Position-NFT claim path — no double-spend.
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibEncumbrance.IntentCapitalInsufficient.selector,
                lender, mockERC20, mockCollateralERC20, uint256(1), uint256(0)
            )
        );
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, 1
        );

        // The legitimate exit for the proceeds is the NFT claim → to wallet.
        uint256 walletBefore = ERC20(mockERC20).balanceOf(lender);
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertGt(
            ERC20(mockERC20).balanceOf(lender),
            walletBefore,
            "proceeds claimed via NFT to wallet (the only path)"
        );
    }

    // ─── 6. v1-d.2 — zero-gap auto-roll (rollIntentLoan) ────────────────────

    function test_rollIntentLoan_compoundsAndReLiens() public {
        uint256 loanId = _fillAndRepay();
        assertEq(_capital(), 0, "capital drawn down by the fill");
        assertEq(_livePrincipal(), PRINCIPAL, "live until roll");

        // Owner rolls their own repaid loan (no keeper needed for self).
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);

        // Proceeds (principal + interest) re-liened as capital; exposure freed.
        assertGt(_capital(), PRINCIPAL, "compounded: principal + interest re-liened");
        assertEq(_livePrincipal(), 0, "exposure released on roll");
    }

    /// @dev The headline: rolled capital is immediately re-lendable with NO
    ///      wallet round-trip (true zero-gap).
    function test_rollIntentLoan_thenReMatch() public {
        uint256 loanId = _fillAndRepay();
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        uint256 capAfterRoll = _capital();
        assertGt(capAfterRoll, PRINCIPAL, "rolled capital available");

        // A fresh fill consumes the rolled capital directly — no re-funding.
        address b2 = _newBorrower("reB");
        uint256 cp2 = _postBorrower(b2);
        vm.prank(solver);
        uint256 loan2 = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp2, PRINCIPAL
        );
        assertGt(loan2, 0, "re-matched from rolled capital");
        assertEq(_capital(), capAfterRoll - PRINCIPAL, "rolled capital drawn by re-fill");
        assertEq(_livePrincipal(), PRINCIPAL, "re-fill live");
    }

    function test_rollIntentLoan_keeperAuthorized() public {
        uint256 loanId = _fillAndRepay();
        // Lender authorizes the solver as an AUTO_ROLL keeper.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            solver, LibVaipakam.KEEPER_ACTION_AUTO_ROLL
        );
        vm.prank(solver);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        assertGt(_capital(), PRINCIPAL, "keeper rolled on the lender's behalf");
    }

    function test_rollIntentLoan_unauthorizedKeeper_reverts() public {
        uint256 loanId = _fillAndRepay();
        // `solver` was authorized for the FILL but not for AUTO_ROLL.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            solver, LibVaipakam.KEEPER_ACTION_SIGNED_FILL
        );
        vm.prank(solver);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    /// @dev If the lender SOLD their position, the buyer is owed the proceeds —
    ///      auto-roll must NOT redirect them into the original owner's intent.
    ///      The position NFT is lock-restricted (transfers route through the
    ///      controlled sale flow, not raw `transferFrom` — which SetupTest's
    ///      diamond doesn't even cut), so we mock the post-sale `ownerOf` to
    ///      exercise the guard directly: current holder != originating owner.
    function test_rollIntentLoan_positionSold_reverts() public {
        uint256 loanId = _fillAndRepay();
        uint256 lenderTok =
            LoanFacet(address(diamond)).getLoanDetails(loanId).lenderTokenId;
        address buyer = makeAddr("positionBuyer");
        vm.mockCall(
            address(diamond),
            abi.encodeWithSignature("ownerOf(uint256)", lenderTok),
            abi.encode(buyer)
        );
        // Even the original owner can't roll a sold position.
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentPositionTransferred.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        vm.clearMockedCalls();
    }

    function test_rollIntentLoan_notRepaid_reverts() public {
        // Fill but DON'T repay → loan is Active, not rollable.
        _setIntent();
        _fund(PRINCIPAL);
        address b = _newBorrower("activeB");
        uint256 cp = _postBorrower(b);
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentLoanNotRollable.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    function test_rollIntentLoan_nonIntentLoan_reverts() public {
        // A loanId with no intent origin (never matched) is not rollable.
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentLoanNotRollable.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(999_999);
    }

    function test_rollIntentLoan_doubleRoll_reverts() public {
        uint256 loanId = _fillAndRepay();
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        // The origin marker is cleared on the first roll → second is not rollable.
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentLoanNotRollable.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    // ─── 6b. Codex #623 round-1 — reject edge cases to the normal claim ─────

    /// @dev #623 P2 — VPFI rotated onto the lending asset post-match: RepayFacet
    ///      reserved the proceeds, which this roll can't release, so the roll is
    ///      rejected (VPFI winds down via the normal claim).
    function test_rollIntentLoan_vpfiRotated_reverts() public {
        uint256 loanId = _fillAndRepay();
        vm.prank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        vm.prank(lender);
        vm.expectRevert(
            LenderIntentFacet.LenderIntentVpfiLendingUnsupported.selector
        );
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    /// @dev #623 round-3 P2 — a CANCELLED intent routes its outstanding loans to
    ///      the normal claim, not auto-roll (honours cancelLenderIntent).
    function test_rollIntentLoan_intentCancelled_reverts() public {
        uint256 loanId = _fillAndRepay();
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        vm.prank(lender);
        vm.expectRevert(LenderIntentFacet.LenderIntentLoanNotRollable.selector);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    /// @dev #623 round-3 P2 — a paused asset blocks the roll (new capital
    ///      commitment); the lender exits via the normal claim instead.
    function test_rollIntentLoan_assetPaused_reverts() public {
        uint256 loanId = _fillAndRepay();
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockCollateralERC20);
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.AssetPaused.selector, mockCollateralERC20
            )
        );
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
    }

    /// @dev #623 P3 — when the borrower has already claimed, the roll settles the
    ///      loan AND emits LoanSettled (parity with the claim path's indexing).
    function test_rollIntentLoan_settlesAndEmitsWhenBorrowerClaimed() public {
        uint256 loanId = _fillAndRepay();
        // Borrower claims their collateral back first.
        vm.prank(lastBorrower);
        ClaimFacet(address(diamond)).claimAsBorrower(loanId);

        // Now the lender roll should settle the loan and emit LoanSettled.
        vm.expectEmit(true, false, false, false, address(diamond));
        emit LenderIntentFacet.LoanSettled(loanId);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);

        assertEq(
            uint8(LoanFacet(address(diamond)).getLoanDetails(loanId).status),
            uint8(LibVaipakam.LoanStatus.Settled),
            "loan settled by roll"
        );
    }

    // ─── #755 per-owner intent view (`getLenderIntentsByOwner`) ──────────────

    function _byOwner(address who)
        internal
        view
        returns (
            LibMetricsTypes.LenderIntentSummary[] memory rows,
            uint256 total
        )
    {
        return
            LenderIntentFacet(address(diamond)).getLenderIntentsByOwner(
                who, 0, 50
            );
    }

    /// Active+funded stays listed; a PAUSED intent (cancelled but capital
    /// reserved) stays listed with `active=false`; a fully torn-down intent
    /// (inactive AND zero capital) is de-listed.
    function test_byOwner_listsActiveFunded_keepsPaused_dropsTornDown() public {
        _setIntent();
        (LibMetricsTypes.LenderIntentSummary[] memory rows, uint256 total) =
            _byOwner(lender);
        assertEq(total, 1, "registered intent listed");
        assertEq(rows[0].owner, lender);
        assertEq(rows[0].lendingAsset, mockERC20);
        assertEq(rows[0].collateralAsset, mockCollateralERC20);
        assertTrue(rows[0].active, "active");
        assertEq(rows[0].availableCapital, 0, "unfunded");
        assertEq(rows[0].maxExposure, MAX_EXPOSURE, "bounds surfaced");

        _fund(PRINCIPAL);
        (rows, total) = _byOwner(lender);
        assertEq(total, 1);
        assertEq(rows[0].availableCapital, PRINCIPAL, "funded capital");

        // Cancel ⇒ paused, capital still reserved ⇒ stays listed, active=false.
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(
            mockERC20, mockCollateralERC20
        );
        (rows, total) = _byOwner(lender);
        assertEq(total, 1, "paused intent with reserved capital stays listed");
        assertFalse(rows[0].active, "paused");
        assertEq(rows[0].availableCapital, PRINCIPAL, "capital still reserved");

        // Withdraw all ⇒ inactive AND zero capital ⇒ fully torn down ⇒ de-listed.
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).withdrawLenderIntentCapital(
            mockERC20, mockCollateralERC20, PRINCIPAL
        );
        (, total) = _byOwner(lender);
        assertEq(total, 0, "fully torn-down intent de-listed");
    }

    /// An active intent fully drawn down by a fill (capital 0, live principal
    /// out) stays in the OWNER feed — unlike the funded-active global feed.
    function test_byOwner_reflectsLivePrincipalAfterFill() public {
        _setIntent();
        _fund(PRINCIPAL);
        address b = _newBorrower("byOwnerLP");
        uint256 cp = _postBorrower(b);
        vm.prank(solver);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        (LibMetricsTypes.LenderIntentSummary[] memory rows, uint256 total) =
            _byOwner(lender);
        assertEq(total, 1, "active intent stays listed even fully drawn down");
        assertTrue(rows[0].active);
        assertEq(rows[0].availableCapital, 0, "capital drawn by the fill");
        assertEq(rows[0].livePrincipal, PRINCIPAL, "live principal reflected");
    }

    function test_byOwner_multiplePairs_andOwnerIsolation() public {
        _setIntent(); // pair A: (mockERC20, mockCollateralERC20)
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockCollateralERC20, mockERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL, false, true
        ); // pair B: (mockCollateralERC20, mockERC20)
        (, uint256 total) = _byOwner(lender);
        assertEq(total, 2, "both pairs listed for the owner");

        (, uint256 otherTotal) = _byOwner(makeAddr("strangerLender"));
        assertEq(otherTotal, 0, "owner-scoped: a different lender sees none");
    }

    function test_byOwner_pagination() public {
        _setIntent();
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockCollateralERC20, mockERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL, false, true
        );
        (
            LibMetricsTypes.LenderIntentSummary[] memory p0,
            uint256 total
        ) = LenderIntentFacet(address(diamond)).getLenderIntentsByOwner(
            lender, 0, 1
        );
        assertEq(total, 2, "total is the full count");
        assertEq(p0.length, 1, "page window respected");
        (LibMetricsTypes.LenderIntentSummary[] memory p1, ) =
            LenderIntentFacet(address(diamond)).getLenderIntentsByOwner(
                lender, 1, 1
            );
        assertEq(p1.length, 1);
        (LibMetricsTypes.LenderIntentSummary[] memory pEnd, ) =
            LenderIntentFacet(address(diamond)).getLenderIntentsByOwner(
                lender, 2, 10
            );
        assertEq(pEnd.length, 0, "offset >= total returns empty");
    }
}
