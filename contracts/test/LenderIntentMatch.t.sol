// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RiskAccessFacet} from "../src/facets/RiskAccessFacet.sol";
import {AdminFacet} from "../src/facets/AdminFacet.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibOfferBounds} from "../src/libraries/LibOfferBounds.sol";
import {LibEncumbrance} from "../src/libraries/LibEncumbrance.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {ClaimFacet} from "../src/facets/ClaimFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibRiskAccess} from "../src/libraries/LibRiskAccess.sol";
import {LibMetricsTypes} from "../src/libraries/LibMetricsTypes.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title  LenderIntentMatchTest
 * @notice #393 v1-b — the `OfferMatchFacet.matchIntent` fill path. A solver
 *         fills a lender's STANDING INTENT against an on-chain borrower
 *         counterparty: the materialized lender slice (creator = lender, terms
 *         from the intent's bounds) routes through the same `_executeMatch` as
 *         `matchOffers`, so the lender stays lender-of-record
 *         (`loan.lender == lender`). Exposure is tracked in the full-intent-
 *         keyed `lenderIntentLivePrincipal` and released at terminal close.
 *
 * @dev    Mirrors `SignedOfferMatcherTest`'s setup posture: $1/token 18-dec
 *         oracle, partialFillEnabled ON, plus the new `lenderIntentEnabled`
 *         flag. The LTV-safe shape lets the intent's maxInitLtvBps=50%
 *         (collateral = 2x principal) clear the HF gate.
 */
contract LenderIntentMatchTest is SetupTest {
    // `lender` is the inherited SetupTest actor (User1); reused as the
    // standing-intent owner / lender-of-record.
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
        // The #393 v1-b kill-switch — enabled here so matchIntent is reachable
        // (the kill-switch case re-disables it in its own scope).
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);
    }

    // ─── Setup helpers ──────────────────────────────────────────────────────

    function _setIntent(uint256 maxExposure) internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20,
            mockCollateralERC20,
            maxExposure,
            MIN_RATE_BPS,
            MAX_INIT_LTV_BPS,
            MAX_DURATION,
            MIN_FILL,
            false, // requiresKeeperAuth
            true // riskAndTermsConsent
        );
    }

    /// @dev Provision a borrower actor (KYC + country + approvals + balances).
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

    /// @dev Post an on-chain BORROWER offer: `principal` size, `coll` collateral
    ///      (2x to clear the 50% LTV cap), rate band [500,600], 30-day term.
    function _postBorrower(address creator, uint256 principal, uint256 coll)
        internal
        returns (uint256 offerId)
    {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: coll,
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
                amountMax: principal,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: coll,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentLivePrincipal(
            lender, mockERC20, mockCollateralERC20
        );
    }

    /// @dev #393 v1-d — fund the lender's (already-active) intent with working
    ///      capital via the on-ramp: mint wallet balance, approve the Diamond
    ///      for exactly `amount` (exact-amount approval convention), then
    ///      `fundLenderIntent` (wallet → vault + intent-capital lien). The
    ///      intent MUST be set first (fund follows set). This replaces the old
    ///      `_fundActorVault` free-balance seeding — `matchIntent` now draws
    ///      strictly from the intent-capital lien, not raw free balance.
    function _fundIntent(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(lender, amount);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), amount);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(
            mockERC20, mockCollateralERC20, amount
        );
    }

    function _intentCapital() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20
        );
    }

    // ─── 1. Happy path — fill + lender-of-record + exposure increment ───────

    function test_matchIntent_fillsAndAttributesToLender() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);

        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );

        assertGt(loanId, 0, "loan initiated");
        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        // The depositing lender is lender-of-record — NOT a vault contract.
        assertEq(loan.lender, lender, "loan.lender == intent owner");
        assertEq(loan.borrower, b, "borrower == counterparty creator");
        assertEq(loan.matcher, solver, "matcher == solver");
        assertEq(loan.principal, PRINCIPAL, "principal == fill");
        // Exposure counter tracks the live principal.
        assertEq(_livePrincipal(), PRINCIPAL, "live principal == fill");
        // #393 v1-d — the fill drew its slice from the intent-capital lien:
        // funded PRINCIPAL, lent PRINCIPAL ⇒ 0 un-lent capital remains.
        assertEq(_intentCapital(), 0, "intent capital drawn down by the fill");
        // #625 WI-3 — pin the passive-lender protection: an intent-filled loan is
        // ALWAYS full-term + no-partial. The matchIntent guards reject a pro-rata
        // (`LenderIntentFullTermRequired`) or partial-enabled
        // (`LenderIntentPartialRepayNotAllowed`) borrower offer, and the loan
        // inherits the borrower offer's flags. Asserting on the resulting LOAN (not
        // just the guard reverts) locks the guarantee against a future regression in
        // either the guard or the inheritance copy.
        assertTrue(loan.useFullTermInterest, "intent loan is full-term");
        assertFalse(loan.allowsPartialRepay, "intent loan disallows partial repay");
    }

    /// @dev #625 WI-2a — a fill that depletes the intent's funded capital re-syncs the
    ///      discovery registry, so `getActiveLenderIntents` stops advertising it (the
    ///      keeper can't fill a zero-capital intent). Pins the matchIntent sync site.
    function test_matchIntent_depletionDelistsFromDiscoveryFeed() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        (, uint256 listedBefore) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(listedBefore, 1, "funded intent is listed in the feed");

        address b = _newBorrower("bdep");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );

        assertEq(_intentCapital(), 0, "fill depleted the funded capital");
        (, uint256 listedAfter) =
            MetricsFacet(address(diamond)).getActiveLenderIntents(0, 10);
        assertEq(listedAfter, 0, "depleted intent de-listed (matchIntent re-sync)");
    }

    // ─── 2. Exposure cap across simultaneous fills ──────────────────────────

    function test_matchIntent_exposureCap_enforced() public {
        // Cap at 1.5x PRINCIPAL: one PRINCIPAL fill fits; a second would exceed.
        _setIntent(3 * PRINCIPAL / 2);
        _fundIntent(3 * PRINCIPAL);
        address b1 = _newBorrower("b1");
        address b2 = _newBorrower("b2");
        uint256 cp1 = _postBorrower(b1, PRINCIPAL, 2 * PRINCIPAL);
        uint256 cp2 = _postBorrower(b2, PRINCIPAL, 2 * PRINCIPAL);

        vm.prank(solver);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp1, PRINCIPAL
        );
        assertEq(_livePrincipal(), PRINCIPAL, "first fill counted");

        // Second fill: live (1000) + 1000 > cap (1500) → revert.
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentExposureExceeded.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp2, PRINCIPAL
        );
    }

    // ─── 3. Bounds reverts ──────────────────────────────────────────────────

    function test_matchIntent_inactiveIntent_reverts() public {
        // No intent set — and with no active intent the lender cannot even
        // fund capital (`fundLenderIntent` reverts), so there's nothing to
        // seed; `matchIntent` rejects on the inactive-intent gate first.
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentInactive.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    function test_matchIntent_belowMinFill_reverts() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentFillBelowMin.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, MIN_FILL / 2
        );
    }

    function test_matchIntent_durationTooLong_reverts() public {
        // Intent caps duration at 30; post a 60-day borrower offer.
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        vm.prank(b);
        uint256 cp = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: 60, // > intent.maxDurationDays
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
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentDurationTooLong.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    function test_matchIntent_fullTermNotHonoured_reverts() public {
        // A counterparty offer that disables the full-term floor can't fill an
        // intent (the lender's committed-interest election would be bypassed).
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        vm.prank(b);
        uint256 cp = OfferCreateFacet(address(diamond)).createOffer(
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
                useFullTermInterest: false // ← disables the floor
            })
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentFullTermRequired.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    function test_matchIntent_partialRepayNotAllowed_reverts() public {
        // A partial-repay counterparty can't fill an intent (it would let the
        // borrower escape the committed-interest economics via pro-rata repays).
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        vm.prank(b);
        uint256 cp = OfferCreateFacet(address(diamond)).createOffer(
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
                allowsPartialRepay: true, // ← disallowed for intent fills
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
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentPartialRepayNotAllowed.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ─── 4. Kill-switch ─────────────────────────────────────────────────────

    function test_matchIntent_killSwitchOff_reverts() public {
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSignature("FunctionDisabled(uint8)", uint8(4))
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ─── 5. Lender-claim releases exposure ──────────────────────────────────

    function test_matchIntent_lenderClaim_releasesExposure() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);

        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertEq(_livePrincipal(), PRINCIPAL, "live after fill");

        // Borrower repays in full → loan terminal, but exposure is HELD until the
        // principal actually returns to the lender's vault at claim time.
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        assertEq(_livePrincipal(), PRINCIPAL, "exposure held until claim");

        // Lender (holds the loan lender-position NFT) claims → exposure
        // released. In v1-d.1 the repaid proceeds are withdrawn to the lender's
        // WALLET via the Position-NFT claim (NOT re-liened into the intent —
        // that zero-gap re-credit is v1-d.2). The intent-capital lien stays at
        // 0 (drawn down by the fill, not refilled by the claim).
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(_livePrincipal(), 0, "exposure released on lender claim");
        assertEq(_intentCapital(), 0, "intent capital not auto-refilled (v1-d.1)");
    }

    // ─── 6. Permissioned-solver gate (#393 v1-c) ────────────────────────────

    function _setIntentKeeperGated() internal {
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, MAX_EXPOSURE, MIN_RATE_BPS,
            MAX_INIT_LTV_BPS, MAX_DURATION, MIN_FILL,
            true, // requiresKeeperAuth
            true // riskAndTermsConsent
        );
    }

    function test_matchIntent_keeperGated_unauthorizedSolver_reverts() public {
        _setIntentKeeperGated();
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        // The solver isn't authorized for KEEPER_ACTION_SIGNED_FILL → rejected.
        vm.prank(solver);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    function test_matchIntent_keeperGated_authorizedSolver_succeeds() public {
        _setIntentKeeperGated();
        _fundIntent(PRINCIPAL);
        // The lender opts the solver in for SIGNED_FILL.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            solver, LibVaipakam.KEEPER_ACTION_SIGNED_FILL
        );
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertGt(loanId, 0, "authorized solver fills keeper-gated intent");
    }

    function test_matchIntent_keeperGated_lenderSelf_succeeds() public {
        // The lender can always fill their own keeper-gated intent.
        _setIntentKeeperGated();
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(lender);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertGt(loanId, 0, "lender fills own keeper-gated intent");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // #625 WI-2b — previewIntent ⟺ matchIntent agreement
    //
    // Binding guarantee of `RiskAccessFacet.previewIntent`: for identical
    // inputs, `preview.ok == true` IFF `matchIntent` would succeed, and each
    // `IntentError` maps to the precise revert the live path raises. Because
    // `previewIntent` is a pure view it is read FIRST without disturbing the
    // state the subsequent `matchIntent` runs against, so each test pairs the
    // two on one fresh state (foundry resets state per test fn — no snapshot).
    // ═══════════════════════════════════════════════════════════════════════

    function _preview(address solver_, uint256 fill, uint256 boId)
        internal
        view
        returns (LibOfferMatch.IntentPreviewResult memory)
    {
        return RiskPreviewFacet(address(diamond)).previewIntent(
            solver_, lender, mockERC20, mockCollateralERC20, boId, fill
        );
    }

    /// @dev Flexible borrower-offer builder for the guard cases (duration,
    ///      full-term, partial-repay, under-collateral all vary). Mirrors
    ///      `_postBorrower` otherwise.
    function _postBorrowerCustom(
        address creator,
        uint256 principal,
        uint256 coll,
        uint32 duration,
        bool fullTerm,
        bool partialRepay
    ) internal returns (uint256 offerId) {
        vm.prank(creator);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: principal,
                interestRateBps: MIN_RATE_BPS,
                collateralAsset: mockCollateralERC20,
                collateralAmount: coll,
                durationDays: duration,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: partialRepay,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: principal,
                interestRateBpsMax: MIN_RATE_BPS + 100,
                collateralAmountMax: coll,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: fullTerm
            })
        );
    }

    // ── Happy path: preview Ok, figures mirror the loan, fill succeeds ──
    function test_previewIntent_happyPath_agreesAndReportsFigures() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertTrue(r.ok, "preview Ok on a fillable intent");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.Ok),
            "intentError Ok"
        );
        assertEq(
            uint8(r.matchError),
            uint8(LibOfferMatch.MatchError.Ok),
            "matchError Ok"
        );
        assertEq(r.riskBlock, 0, "no risk block (gate off)");
        assertEq(r.matchAmount, PRINCIPAL, "matchAmount == fill");
        assertEq(r.reqCollateral, 2 * PRINCIPAL, "reqCollateral == 2x (50% LTV cap)");
        assertEq(r.availableCapital, PRINCIPAL, "availableCapital == funded");
        assertEq(r.matchRateBps, 550, "midpoint of [500,600]");

        // matchIntent succeeds for the same inputs ⇒ agrees with preview Ok.
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        assertGt(loanId, 0, "fill succeeds - agrees with preview Ok");
    }

    // ── sale-vehicle counterparty (#951 v2, D3) — non-matchable via intent too ──
    /// @dev A borrower offer linked as a lender-sale vehicle (`saleOfferToLoanId`)
    ///      is fillable ONLY through direct `acceptOffer`; `matchIntent` reverts
    ///      `SaleVehicleNotMatchable` (via the shared `_executeMatch` guard).
    ///      `previewIntent` must mirror that with `SaleVehicleTagged` rather than
    ///      report Ok (Codex #959 round-8 P2/P3 preview parity).
    function test_previewIntent_saleVehicleTagged_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("bSale");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        // Tag the otherwise-matchable borrower offer as a sale vehicle.
        TestMutatorFacet(address(diamond)).setSaleOfferToLoanIdRaw(cp, 4242);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok, "preview !ok for a sale-vehicle counterparty");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.SaleVehicleTagged),
            "intentError SaleVehicleTagged"
        );
        // matchIntent reverts SaleVehicleNotMatchable ⇒ agrees with the preview.
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.SaleVehicleNotMatchable.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── #1104 — no-borrow (effective-tier-0) collateral floor ──
    //
    // A collateral that admits NO borrow at loan-init (per-asset
    // `loanInitMaxLtvBps == 0`, or effective-tier-0 under depth-tiering) can
    // never back a loan, yet `minCollateralForLending` returns a FINITE
    // HF-derived floor for it — so a floor-ONLY slice check would pass the
    // preview and only fail later in the match core with a different reason.
    // The #1104 guard mirrors `LibOfferBounds.noBorrowCollateral` in the slice
    // check so the preview reports `SliceCollateralBelowFloor` up front, exactly
    // as `matchIntent` reverts `MinCollateralBelowFloor` at slice materialization
    // (`createSignedOfferVault` → `LibOfferBounds`). Affordable now that the
    // RiskAccessFacet→RiskPreviewFacet split freed the EIP-170 headroom the
    // guard's inlining needs. The borrower offer is posted while the collateral
    // is still borrowable (S15 rejects a no-borrow collateral offer at CREATE),
    // then demoted — the realistic dynamic-depth-drop path.
    function test_previewIntent_noBorrowCollateralFloor_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("bNoBorrow");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        // Demote the collateral to no-borrow AFTER the borrower offer is posted.
        TestMutatorFacet(address(diamond)).setLoanInitMaxLtvBpsRaw(
            mockCollateralERC20, 0
        );

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok, "preview !ok for no-borrow collateral");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.SliceCollateralBelowFloor),
            "intentError SliceCollateralBelowFloor (mirrors materialize revert)"
        );
        // matchIntent reverts `MinCollateralBelowFloor` at slice materialization
        // ⇒ agrees with the preview's SliceCollateralBelowFloor. Selector-only
        // match (the exact (provided, floor) payload is an internal derivation).
        vm.prank(solver);
        vm.expectPartialRevert(LibOfferBounds.MinCollateralBelowFloor.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── #1115 P2 — risk gate precedes the collateral floor ──
    //
    // When the #671 risk-access gate is ON and a slice fails BOTH the risk gate
    // (under-tiered lender) AND the no-borrow collateral floor, the live
    // `matchIntent` reverts with the RISK reason: `_createOfferSetup` runs
    // `assertActorMayTransact` BEFORE `assertOfferBounds`. The preview must
    // therefore report the risk block first, not the floor — otherwise #1104's
    // floor guard would diverge from the live revert for this combined case.
    function test_previewIntent_noBorrowCollateral_riskGateTakesPrecedence()
        public
    {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("bCombined");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);

        // Classify both legs at tier 1 (BroadLiquid) so the default-tier
        // (BlueChipOnly) lender is under-tiered => risk block code 1, and turn
        // the gate ON. Done AFTER the borrower offer is posted so its own create
        // isn't gated.
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector, mockERC20
            ),
            abi.encode(uint8(1))
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector, mockCollateralERC20
            ),
            abi.encode(uint8(1))
        );
        vm.prank(owner);
        ConfigFacet(address(diamond)).setRiskAccessGateEnabled(true);
        // Also fail the no-borrow floor, so BOTH failures coincide.
        TestMutatorFacet(address(diamond)).setLoanInitMaxLtvBpsRaw(
            mockCollateralERC20, 0
        );

        // Preview reports the RISK block first (not the floor).
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok, "combined risk+floor failure is not ok");
        assertEq(r.riskBlock, 1, "risk block reported first, before the floor");

        // Live matchIntent reverts with the risk error, not MinCollateralBelowFloor
        // => the preview's risk-first report agrees with the live revert reason.
        vm.prank(solver);
        vm.expectPartialRevert(LibRiskAccess.RiskTierTooLow.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── below-min fill ──
    function test_previewIntent_belowMinFill_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        uint256 tiny = MIN_FILL - 1;

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, tiny, cp);
        assertFalse(r.ok, "preview !ok below min fill");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.BelowMinFill)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentFillBelowMin.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, tiny
        );
    }

    // ── exposure cap (checked BEFORE funded-capital) ──
    function test_previewIntent_exposureExceeded_agrees() public {
        _setIntent(500 ether); // maxExposure below the fill
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, 600 ether, 1200 ether);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, 600 ether, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.ExposureExceeded)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentExposureExceeded.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, 600 ether
        );
    }

    // ── funded-capital shortfall (within exposure, above min) ──
    function test_previewIntent_capitalInsufficient_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(MIN_FILL); // fund only the dust floor
        address b = _newBorrower("b1");
        uint256 fill = 2 * MIN_FILL; // > capital, < exposure, >= min
        uint256 cp = _postBorrower(b, fill, 2 * fill);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, fill, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.CapitalInsufficient)
        );
        assertEq(r.availableCapital, MIN_FILL, "reports the un-lent capital");
        vm.prank(solver);
        // `IntentCapitalInsufficient` carries args, so match the full encoded
        // error (selector-only `expectRevert(bytes4)` wants exactly 4 bytes).
        vm.expectRevert(
            abi.encodeWithSelector(
                LibEncumbrance.IntentCapitalInsufficient.selector,
                lender,
                mockERC20,
                mockCollateralERC20,
                fill,
                MIN_FILL
            )
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, fill
        );
    }

    // ── borrower term exceeds the lender's max (WI-3 guard family) ──
    function test_previewIntent_durationTooLong_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrowerCustom(
            b, PRINCIPAL, 2 * PRINCIPAL, MAX_DURATION + 1, true, false
        );
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.DurationTooLong)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentDurationTooLong.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── borrower disables full-term interest (WI-3 protective guard) ──
    function test_previewIntent_fullTermRequired_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrowerCustom(
            b, PRINCIPAL, 2 * PRINCIPAL, MAX_DURATION, false, false
        );
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.FullTermRequired)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentFullTermRequired.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── borrower opts into partial-repay (WI-3 protective guard) ──
    function test_previewIntent_partialRepayNotAllowed_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrowerCustom(
            b, PRINCIPAL, 2 * PRINCIPAL, MAX_DURATION, true, true
        );
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.PartialRepayNotAllowed)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentPartialRepayNotAllowed.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── inactive intent ──
    function test_previewIntent_inactiveIntent_agrees() public {
        // No `_setIntent` ⇒ intent.active == false.
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.Inactive)
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentInactive.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── matcher kill-switch OFF (checked before the intent switch) ──
    function test_previewIntent_matcherDisabled_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(false);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.MatcherDisabled)
        );
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(OfferMatchFacet.FunctionDisabled.selector, 3)
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── intent kill-switch OFF (matcher stays on) ──
    function test_previewIntent_intentDisabled_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.IntentDisabled)
        );
        vm.prank(solver);
        vm.expectRevert(
            abi.encodeWithSelector(OfferMatchFacet.FunctionDisabled.selector, 4)
        );
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── keeper-gated intent, unauthorized solver (the isKeeperForPrincipal path) ──
    function test_previewIntent_keeperUnauthorized_agrees() public {
        _setIntentKeeperGated();
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);

        // Unauthorized solver ⇒ preview reports KeeperUnauthorized.
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok);
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.KeeperUnauthorized)
        );
        vm.prank(solver);
        vm.expectRevert(IVaipakamErrors.KeeperAccessRequired.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );

        // Once the lender opts the solver in, preview flips to Ok.
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(
            solver, LibVaipakam.KEEPER_ACTION_SIGNED_FILL
        );
        LibOfferMatch.IntentPreviewResult memory r2 = _preview(solver, PRINCIPAL, cp);
        assertTrue(r2.ok, "authorized solver -> preview Ok");
        // The lender themselves is always authorized.
        LibOfferMatch.IntentPreviewResult memory rSelf = _preview(lender, PRINCIPAL, cp);
        assertTrue(rSelf.ok, "lender self-fill -> preview Ok");
    }

    // ── match-core failure: borrower under-collateralizes the fill ──
    function test_previewIntent_matchCoreCollateralShortfall_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        // 1.8x collateral: ABOVE the ~1.765x the system create-time admission
        // floor requires (#998 S15 — else the borrower offer would be rejected
        // at posting with MaxLendingAboveCeiling, before the match), but BELOW
        // the 2x the lender intent's stricter 50% init-LTV cap requires ⇒ the
        // offer posts, and the match core rejects on CollateralBelowRequired
        // (an intent-guard-clean pair). This exercises the match-core shortfall
        // path for an offer that clears system admission but fails a specific
        // lender's tighter LTV preference.
        uint256 cp = _postBorrowerCustom(
            b, PRINCIPAL, 1800 ether, MAX_DURATION, true, false
        );
        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok, "preview !ok on a match-core shortfall");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.Ok),
            "intent guards all cleared"
        );
        assertEq(
            uint8(r.matchError),
            uint8(LibOfferMatch.MatchError.CollateralBelowRequired),
            "match core flags the collateral shortfall"
        );
        vm.prank(solver);
        vm.expectRevert(); // the fill reverts (match-core classifier)
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ── #747 Codex r1/r2: a paused leg fails at the slice-MATERIALIZATION stage
    //    (createSignedOfferVault calls requireAssetNotPaused before the match),
    //    so preview reports SlicePausedAsset — mirroring the live first reason.
    function test_previewIntent_slicePausedAsset_agrees() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        // Pause the lending asset AFTER the intent/offer exist.
        vm.prank(owner);
        AdminFacet(address(diamond)).pauseAsset(mockERC20);

        LibOfferMatch.IntentPreviewResult memory r = _preview(solver, PRINCIPAL, cp);
        assertFalse(r.ok, "preview !ok when a leg is paused");
        assertEq(
            uint8(r.intentError),
            uint8(LibOfferMatch.IntentError.SlicePausedAsset)
        );
        vm.prank(solver);
        vm.expectRevert(); // live fill reverts at createSignedOfferVault's pause guard
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // NOTE: `SliceCollateralBelowFloor` is exercised in production but NOT
    // pinned by an agreement test here — this suite's $1 mock oracle does not
    // classify the pair as `Liquid`, so `minCollateralForLending` returns 0 and
    // both the slice's create-time floor check AND `previewIntent`'s mirror of
    // it (which reuses the SAME helper + `rangeAmountEnabled` condition, so it
    // cannot drift from `OfferCreateFacet`) skip. The agreement holds: with the
    // floor inactive, matchIntent succeeds and preview reports Ok.

    // ═══════════════════════════════════════════════════════════════════════
    // #625 WI-2c — getRollableIntentLoans registry (roll-discovery surface)
    // ═══════════════════════════════════════════════════════════════════════

    function _rollable()
        internal
        view
        returns (LibMetricsTypes.RollableIntentLoan[] memory loans, uint256 total)
    {
        return MetricsFacet(address(diamond)).getRollableIntentLoans(0, 100);
    }

    // Active → (repay) Repaid surfaces as rollable → (normal claim) de-registers.
    function test_getRollableIntentLoans_repaidThenClaimedLifecycle() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );

        // Registered but Active → not yet a roll candidate.
        (LibMetricsTypes.RollableIntentLoan[] memory r0, uint256 t0) = _rollable();
        assertEq(t0, 1, "intent loan registered");
        assertEq(r0.length, 0, "an Active loan is not rollable");

        // Repay → Repaid → surfaces as rollable, keyed off intentOrigin.
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);
        (LibMetricsTypes.RollableIntentLoan[] memory r1, uint256 t1) = _rollable();
        assertEq(t1, 1, "still registered after repay");
        assertEq(r1.length, 1, "a Repaid intent loan is rollable");
        assertEq(r1[0].loanId, loanId, "loanId");
        assertEq(r1[0].owner, lender, "owner from intentOrigin");
        assertEq(r1[0].amount, PRINCIPAL, "original fill amount");

        // Normal claim (not roll) → de-registered via releaseIntentExposure.
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        (, uint256 t2) = _rollable();
        assertEq(t2, 0, "a normal claim de-registers the loan");
    }

    // A roll de-registers the loan AND re-liens its proceeds as intent capital.
    function test_getRollableIntentLoans_rollDeregisters() public {
        _setIntent(MAX_EXPOSURE);
        _fundIntent(PRINCIPAL);
        address b = _newBorrower("b1");
        uint256 cp = _postBorrower(b, PRINCIPAL, 2 * PRINCIPAL);
        vm.prank(solver);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
        vm.prank(b);
        RepayFacet(address(diamond)).repayLoan(loanId);

        (, uint256 tBefore) = _rollable();
        assertEq(tBefore, 1, "rollable before roll");

        // Owner auto-rolls → de-registered + proceeds re-liened.
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).rollIntentLoan(loanId);
        (LibMetricsTypes.RollableIntentLoan[] memory rAfter, uint256 tAfter) =
            _rollable();
        assertEq(tAfter, 0, "roll de-registers the loan");
        assertEq(rAfter.length, 0, "no rollable loans after roll");
        assertGt(_intentCapital(), 0, "proceeds re-liened as intent capital");
    }
}
