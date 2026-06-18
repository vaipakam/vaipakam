// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";

/**
 * @title  BackstopVaultTest
 * @notice #399 / #401 v2.5 — treasury-seeded backstop, Role A (auto-counterparty).
 *         Provision the vault, seed it from treasury, a borrower opts an offer
 *         into backstop eligibility, and after the on-chain deadline the
 *         permissionless `backstopFill` originates a loan with `lender == vault`.
 *         Plus the kill-switch / trigger / guard reverts.
 *
 * @dev    Same $1/18-dec oracle + partial-fill + lenderIntentEnabled posture as
 *         `AggregatorAdapterTest`. `owner` holds ADMIN + VAULT_ADMIN roles.
 *         Treasury == Diamond (SetupTest), so seeding debits `treasuryBalances`
 *         (funded here via `TestMutatorFacet.setTreasuryBalanceRaw` + a real
 *         token mint to the Diamond so the physical transfer succeeds).
 */
contract BackstopVaultTest is SetupTest {
    address internal vault;

    uint256 internal constant SEED = 10_000 ether;
    uint256 internal constant PRINCIPAL = 500 ether;
    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_EXPOSURE = 100_000 ether;
    uint256 internal constant MIN_RATE = 500;
    uint16 internal constant MAX_LTV = 5000; // 50% ⇒ reqColl = 2x
    uint32 internal constant MAX_DUR = 30;
    uint256 internal constant MIN_FILL = 1 ether;

    uint64 internal base; // a sane base timestamp for the deadline math

    function setUp() public {
        setupHelper();
        base = uint64(1_000_000);
        vm.warp(base);

        vm.startPrank(owner);
        ConfigFacet(address(diamond)).setRangeAmountEnabled(true);
        ConfigFacet(address(diamond)).setRangeRateEnabled(true);
        ConfigFacet(address(diamond)).setRangeCollateralEnabled(true);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);

        // Provision the single backstop vault + register the (lend, coll) intent.
        BackstopFacet(address(diamond)).initializeBackstopVaultImplementation();
        vault = BackstopFacet(address(diamond)).provisionBackstopVault();
        BackstopFacet(address(diamond)).setBackstopIntent(
            mockERC20,
            mockCollateralERC20,
            MAX_EXPOSURE,
            MIN_RATE,
            MAX_LTV,
            MAX_DUR,
            MIN_FILL
        );
        BackstopFacet(address(diamond)).setBackstopEnabled(true);
        BackstopFacet(address(diamond)).setBackstopFillEnabled(true);
        vm.stopPrank();

        _seed(SEED);
    }

    // ─── helpers ────────────────────────────────────────────────────────────

    /// @dev Fund the Diamond's treasury (accounting + physical tokens) then seed.
    function _seed(uint256 amount) internal {
        ERC20Mock(mockERC20).mint(address(diamond), amount);
        vm.startPrank(owner);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, amount);
        BackstopFacet(address(diamond)).seedBackstopOrigination(
            mockERC20,
            mockCollateralERC20,
            amount
        );
        vm.stopPrank();
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

    /// @dev A borrower posts a fillable offer with `expiresAt` set (required for
    ///      backstop eligibility). Returns (offerId, borrower).
    function _postBorrowerOffer(uint64 expiresAt)
        internal
        returns (uint256 offerId, address borrower)
    {
        borrower = _newBorrower("backstopBorrower");
        vm.prank(borrower);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: MAX_DUR,
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
                interestRateBpsMax: MIN_RATE + 100,
                collateralAmountMax: 2 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: expiresAt,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
    }

    /// @dev Full Role-A setup: post an eligible offer, opt in, warp past deadline.
    function _eligibleOffer()
        internal
        returns (uint256 offerId, address borrower)
    {
        (offerId, borrower) = _postBorrowerOffer(base + 7 days);
        vm.prank(borrower);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 2 days
        );
        vm.warp(base + 3 days); // past eligibleAfter, before expiresAt
    }

    // ─── 1. Provisioning ──────────────────────────────────────────────────────

    function test_provision_setsVault() public view {
        assertEq(BackstopFacet(address(diamond)).getBackstopVault(), vault, "vault set");
        assertTrue(vault != address(0), "non-zero");
    }

    function test_provision_alreadyProvisioned_reverts() public {
        vm.prank(owner);
        vm.expectRevert(BackstopFacet.BackstopAlreadyProvisioned.selector);
        BackstopFacet(address(diamond)).provisionBackstopVault();
    }

    // ─── 2. Role A — auto-fill happy path ──────────────────────────────────────

    function test_backstopFill_originatesLoanFromBackstop() public {
        (uint256 offerId, ) = _eligibleOffer();
        // permissionless caller
        address poker = makeAddr("poker");
        vm.prank(poker);
        uint256 loanId = BackstopFacet(address(diamond)).backstopFill(offerId);

        LibVaipakam.Loan memory loan =
            LoanFacet(address(diamond)).getLoanDetails(loanId);
        assertEq(loan.lender, vault, "loan.lender == backstop vault");
        assertEq(loan.principal, PRINCIPAL, "principal");
        assertEq(loan.principalAsset, mockERC20, "principal asset");
    }

    function test_backstopClaim_recoversToTreasury() public {
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(makeAddr("poker"));
        uint256 loanId = BackstopFacet(address(diamond)).backstopFill(offerId);

        // Borrower repays in full.
        address borrower =
            LoanFacet(address(diamond)).getLoanDetails(loanId).borrower;
        vm.prank(borrower);
        RepayFacet(address(diamond)).repayLoan(loanId);

        uint256 before =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        vm.prank(owner);
        BackstopFacet(address(diamond)).backstopClaim(
            loanId,
            new LibSwap.AdapterCall[](0)
        );
        uint256 afterBal =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        assertGe(afterBal, before + PRINCIPAL, "treasury recovered >= principal");
    }

    // ─── 3. Kill-switch gates ──────────────────────────────────────────────────

    function test_backstopFill_masterDisabled_reverts() public {
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopEnabled(false);
        vm.expectRevert(BackstopFacet.BackstopDisabled.selector);
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    function test_backstopFill_roleADisabled_reverts() public {
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(owner);
        BackstopFacet(address(diamond)).setBackstopFillEnabled(false);
        vm.expectRevert(BackstopFacet.BackstopDisabled.selector);
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    // ─── 4. On-chain trigger reverts ───────────────────────────────────────────

    function test_backstopFill_notOptedIn_reverts() public {
        (uint256 offerId, ) = _postBorrowerOffer(base + 7 days); // no opt-in
        vm.warp(base + 3 days);
        vm.expectRevert(BackstopFacet.OfferNotBackstopFillable.selector);
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    function test_backstopFill_beforeDeadline_reverts() public {
        (uint256 offerId, address borrower) = _postBorrowerOffer(base + 7 days);
        vm.prank(borrower);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 2 days
        );
        // still at `base` — before the deadline
        vm.expectRevert(BackstopFacet.OfferNotBackstopFillable.selector);
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    function test_backstopFill_expiredOffer_reverts() public {
        (uint256 offerId, ) = _eligibleOffer();
        vm.warp(base + 8 days); // past expiresAt (base + 7 days)
        vm.expectRevert(BackstopFacet.OfferNotBackstopFillable.selector);
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    // ─── 5. Opt-in validation ──────────────────────────────────────────────────

    function test_setOfferBackstopEligible_notCreator_reverts() public {
        (uint256 offerId, ) = _postBorrowerOffer(base + 7 days);
        vm.prank(makeAddr("notCreator"));
        vm.expectRevert(BackstopFacet.NotOfferCreator.selector);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 2 days
        );
    }

    function test_setOfferBackstopEligible_deadlineBelowFloor_reverts() public {
        (uint256 offerId, address borrower) = _postBorrowerOffer(base + 7 days);
        // < block.timestamp + minBackstopDelay (1 day) → reverts
        vm.prank(borrower);
        vm.expectRevert(BackstopFacet.InvalidBackstopDeadline.selector);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 1 hours
        );
    }

    function test_setOfferBackstopEligible_atOrAfterExpiry_reverts() public {
        (uint256 offerId, address borrower) = _postBorrowerOffer(base + 7 days);
        vm.prank(borrower);
        vm.expectRevert(BackstopFacet.InvalidBackstopDeadline.selector);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 7 days // == expiresAt (not strictly before)
        );
    }

    // ─── 6. backstopClaim own-loan guard ───────────────────────────────────────

    function test_backstopClaim_foreignLoan_reverts() public {
        // A loanId the backstop did NOT originate (here, a non-existent one →
        // loan.lender == address(0) != vault) must trip the own-loan guard so a
        // foreign lender position can't be claimed + swept to treasury.
        vm.prank(owner);
        vm.expectRevert(BackstopFacet.NotBackstopLoan.selector);
        BackstopFacet(address(diamond)).backstopClaim(
            999_999,
            new LibSwap.AdapterCall[](0)
        );
    }
}
