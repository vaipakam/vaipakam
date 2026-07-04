// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {RepayFacet} from "../src/facets/RepayFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {MockSanctionsList} from "./mocks/MockSanctionsList.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {BackstopFacet} from "../src/facets/BackstopFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibBackstopOracleGate} from "../src/libraries/LibBackstopOracleGate.sol";
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

    /// @dev Provisioning stamps the vault as a top-tier compliant entity so a
    ///      backstop fill (which routes `acceptOfferInternal`'s acceptor-KYC check)
    ///      doesn't revert on a KYC-enforced deployment. (No-op on retail.)
    function test_provision_stampsVaultKYCTier() public view {
        assertEq(
            uint8(ProfileFacet(address(diamond)).getKYCTier(vault)),
            uint8(LibVaipakam.KYCTier.Tier2),
            "vault provisioned at Tier2"
        );
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

    // ─── #954 (§1.5) — re-screen the offer creator at FILL ──────────────────

    /// @dev A borrower flagged AFTER `setOfferBackstopEligible` opt-in but before
    ///      `backstopFill` must not have a treasury-funded loan originated to
    ///      them. The fill re-screens `o.creator` (Tier-1), not only the opt-in.
    function test_backstopFill_RevertWhen_CreatorSanctionedAfterOptIn() public {
        (uint256 offerId, address borrower) = _eligibleOffer();

        MockSanctionsList sanctions = new MockSanctionsList();
        ProfileFacet(address(diamond)).setSanctionsOracle(address(sanctions));
        sanctions.setFlagged(borrower, true);

        address poker = makeAddr("poker");
        vm.prank(poker);
        vm.expectRevert(
            abi.encodeWithSelector(LibVaipakam.SanctionedAddress.selector, borrower)
        );
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    // ─── #638 — backstop-only oracle-coverage gate (Role A) ─────────────────

    /// @dev Knob default 0 ⇒ no coverage requirement ⇒ fill proceeds even with
    ///      zero live secondaries (the general permissionless behaviour).
    function test_backstopFill_coverageKnobOff_fillsRegardless() public {
        assertEq(
            BackstopFacet(address(diamond))
                .getBackstopMinSecondaryOracleCoverage(),
            0,
            "knob defaults to 0"
        );
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.countLiveSecondaryOracleFeeds.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(0))
        );
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(makeAddr("poker"));
        uint256 loanId = BackstopFacet(address(diamond)).backstopFill(offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).lender,
            vault,
            "fill proceeds with knob off"
        );
    }

    /// @dev Knob = 2 but only 1 live secondary ⇒ Role A refuses the collateral.
    function test_backstopFill_coverageInsufficient_reverts() public {
        vm.prank(owner);
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(2);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.countLiveSecondaryOracleFeeds.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(1))
        );
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(makeAddr("poker"));
        vm.expectRevert(
            abi.encodeWithSelector(
                LibBackstopOracleGate.BackstopOracleCoverageInsufficient.selector,
                mockCollateralERC20,
                uint8(1),
                uint8(2)
            )
        );
        BackstopFacet(address(diamond)).backstopFill(offerId);
    }

    /// @dev Knob = 2 and 2 live secondaries ⇒ coverage met ⇒ fill proceeds.
    function test_backstopFill_coverageMet_fills() public {
        vm.prank(owner);
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(2);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(
                OracleFacet.countLiveSecondaryOracleFeeds.selector,
                mockCollateralERC20
            ),
            abi.encode(uint8(2))
        );
        (uint256 offerId, ) = _eligibleOffer();
        vm.prank(makeAddr("poker"));
        uint256 loanId = BackstopFacet(address(diamond)).backstopFill(offerId);
        assertEq(
            LoanFacet(address(diamond)).getLoanDetails(loanId).lender,
            vault,
            "fill proceeds when coverage met"
        );
    }

    // ─── #638 — setter / getter / range bound ───────────────────────────────

    function test_setBackstopMinSecondaryOracleCoverage_setsAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit BackstopFacet.BackstopMinSecondaryOracleCoverageSet(2);
        vm.prank(owner);
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(2);
        assertEq(
            BackstopFacet(address(diamond))
                .getBackstopMinSecondaryOracleCoverage(),
            2,
            "getter reflects set value"
        );
    }

    function test_setBackstopMinSecondaryOracleCoverage_outOfRange_reverts()
        public
    {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BackstopFacet.BackstopOracleCoverageOutOfRange.selector,
                uint8(4)
            )
        );
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(4);
    }

    function test_setBackstopMinSecondaryOracleCoverage_notAdmin_reverts()
        public
    {
        vm.prank(makeAddr("randoCaller"));
        vm.expectRevert();
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(1);
    }

    /// @dev Backstop-scoping guard: the coverage knob must NOT leak into the
    ///      general pricing path. With the knob maxed, `getAssetPrice` /
    ///      `checkLiquidity` on a 0-secondary asset still succeed (the
    ///      Soft-2-of-N single-feed soft fallback governs the general path).
    function test_coverageKnob_doesNotAffectGeneralPricingPath() public {
        vm.prank(owner);
        BackstopFacet(address(diamond))
            .setBackstopMinSecondaryOracleCoverage(3);
        // No revert from the general pricing / liquidity-classification reads.
        OracleFacet(address(diamond)).getAssetPrice(mockCollateralERC20);
        OracleFacet(address(diamond)).checkLiquidity(mockCollateralERC20);
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

    /// @dev A genuinely RANGED borrower offer (amountMax > amount) can't be
    ///      backstop-filled (the backstop fills the whole offer in one shot), so
    ///      opt-in must reject it up-front rather than let it wait out the deadline.
    function test_setOfferBackstopEligible_rangedAmount_reverts() public {
        address borrower = _newBorrower("rangedBorrower");
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
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
                amountMax: 2 * PRINCIPAL, // genuine range ⇒ rejected
                interestRateBpsMax: MIN_RATE + 100,
                collateralAmountMax: 4 * PRINCIPAL,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: base + 7 days,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
        vm.prank(borrower);
        vm.expectRevert(BackstopFacet.OfferNotBackstopEligible.selector);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 2 days
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

    /// @dev Opt-in must reject when the backstop has no live intent for the
    ///      offer's exact (lend, coll) pair — otherwise the borrower waits out a
    ///      last-resort deadline for an offer the backstop can never fill. Here the
    ///      role-swapped pair (mockCollateralERC20 lent vs mockERC20 collateral) has
    ///      no registered backstop intent.
    function test_setOfferBackstopEligible_noIntent_reverts() public {
        address borrower = _newBorrower("noIntentBorrower");
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockCollateralERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE,
                collateralAsset: mockERC20,
                collateralAmount: 2 * PRINCIPAL,
                durationDays: MAX_DUR,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockCollateralERC20,
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
                expiresAt: base + 7 days,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            })
        );
        vm.prank(borrower);
        vm.expectRevert(BackstopFacet.BackstopIntentInactive.selector);
        BackstopFacet(address(diamond)).setOfferBackstopEligible(
            offerId,
            base + 2 days
        );
    }

    /// @dev If `vpfiToken` is rotated onto the seed's `lend` asset AFTER the intent
    ///      row was created, the direct treasury seed must reject it (VPFI can't
    ///      back generic intent capital — mirrors fundLenderIntent/matchIntent).
    function test_seedBackstopOrigination_vpfiLending_reverts() public {
        vm.startPrank(owner);
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20); // rotate onto lend
        ERC20Mock(mockERC20).mint(address(diamond), SEED);
        TestMutatorFacet(address(diamond)).setTreasuryBalanceRaw(mockERC20, SEED);
        vm.expectRevert(BackstopFacet.VpfiLendingUnsupported.selector);
        BackstopFacet(address(diamond)).seedBackstopOrigination(
            mockERC20,
            mockCollateralERC20,
            SEED
        );
        vm.stopPrank();
    }

    // ─── 7. Residue sweep ──────────────────────────────────────────────────────

    /// @dev Raw ERC20 residue that lands on the vault (e.g. a VPFI matcher cut or
    ///      airdrop) is recoverable to treasury via the facet wrapper — the vault's
    ///      `sweepToken` is owner-only with the Diamond as owner, so it's only
    ///      reachable through this selector.
    function test_sweepBackstopToken_recoversResidueToTreasury() public {
        uint256 residue = 42 ether;
        ERC20Mock(mockERC20).mint(vault, residue);

        uint256 before =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);
        vm.prank(owner);
        uint256 swept = BackstopFacet(address(diamond)).sweepBackstopToken(mockERC20);
        uint256 afterBal =
            TreasuryFacet(address(diamond)).getTreasuryBalance(mockERC20);

        assertEq(swept, residue, "swept == residue");
        assertEq(afterBal, before + residue, "treasury credited the residue");
        assertEq(ERC20(mockERC20).balanceOf(vault), 0, "vault drained");
    }
}
