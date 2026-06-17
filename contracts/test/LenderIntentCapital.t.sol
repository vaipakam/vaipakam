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
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
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
}
