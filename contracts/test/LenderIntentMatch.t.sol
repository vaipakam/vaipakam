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
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
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
                useFullTermInterest: false
            })
        );
    }

    function _livePrincipal() internal view returns (uint256) {
        return LenderIntentFacet(address(diamond)).getLenderIntentLivePrincipal(
            lender, mockERC20, mockCollateralERC20
        );
    }

    // ─── 1. Happy path — fill + lender-of-record + exposure increment ───────

    function test_matchIntent_fillsAndAttributesToLender() public {
        _setIntent(MAX_EXPOSURE);
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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
    }

    // ─── 2. Exposure cap across simultaneous fills ──────────────────────────

    function test_matchIntent_exposureCap_enforced() public {
        // Cap at 1.5x PRINCIPAL: one PRINCIPAL fill fits; a second would exceed.
        _setIntent(3 * PRINCIPAL / 2);
        _fundActorVault(lender, mockERC20, 3 * PRINCIPAL);
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
        // No intent set.
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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
                useFullTermInterest: false
            })
        );
        vm.prank(solver);
        vm.expectRevert(OfferMatchFacet.LenderIntentDurationTooLong.selector);
        OfferMatchFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, cp, PRINCIPAL
        );
    }

    // ─── 4. Kill-switch ─────────────────────────────────────────────────────

    function test_matchIntent_killSwitchOff_reverts() public {
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(false);
        _setIntent(MAX_EXPOSURE);
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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
        _fundActorVault(lender, mockERC20, PRINCIPAL);
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

        // Lender (holds the loan lender-position NFT) claims → exposure released,
        // and the principal is back in their vault, re-lendable.
        vm.prank(lender);
        ClaimFacet(address(diamond)).claimAsLender(loanId);
        assertEq(_livePrincipal(), 0, "exposure released on lender claim");
    }
}
