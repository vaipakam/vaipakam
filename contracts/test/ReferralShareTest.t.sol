// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibReferral} from "../src/libraries/LibReferral.sol";
import {LibFeeShares} from "../src/libraries/LibFeeShares.sol";
import {ReferralFacet} from "../src/facets/ReferralFacet.sol";
import {IntegratorFacet} from "../src/facets/IntegratorFacet.sol";
import {FeeLevelsFacet} from "../src/facets/FeeLevelsFacet.sol";
import {FeeEntitlementFacet} from "../src/facets/FeeEntitlementFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {OfferPreviewFacet} from "../src/facets/OfferPreviewFacet.sol";
import {OfferAcceptFacet} from "../src/facets/OfferAcceptFacet.sol";
import {OfferMatchFacet} from "../src/facets/OfferMatchFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {TreasuryFeeFacet} from "../src/facets/TreasuryFeeFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {PrecloseFacet} from "../src/facets/PrecloseFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {AutoLifecycleSettingsFacet} from "../src/facets/AutoLifecycleSettingsFacet.sol";
import {VaultFactoryFacet} from "../src/facets/VaultFactoryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LibAcceptTestSigner} from "./helpers/LibAcceptTestSigner.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestVaultBeacon} from "./helpers/LibTestVaultBeacon.sol";
import {RefinancePayoffPermitHelper} from "./helpers/RefinancePayoffPermitHelper.sol";

/// @title ReferralShareTest — #3722
/// @notice The referral share of the initiation fee
///         (`ReferralFeeShareDesign.md` section 8). On a 10,000 loan for 30
///         days the fee is 20; the treasury floor is 10 and A, the part above
///         it, is 10. A bound wallet inside its period pays 19 (the cut of 10%
///         of A, 1, is not charged) and its inviter's wallet receives 1. The
///         matcher's 1% of A (0.1) goes to the accepting caller. The treasury
///         leg is the rest, 17.9, of which the floor of 10 is the treasury's.
contract ReferralShareTest is SetupTest {
    event InviterBound(address indexed newUser, address indexed inviter, uint64 endsAt);
    event ReferralShareSettled(
        uint256 indexed loanId,
        address indexed newUser,
        address indexed inviter,
        address asset,
        uint256 offerId,
        uint256 cut,
        uint256 share,
        LibReferral.Outcome outcome
    );

    uint256 internal constant PRINCIPAL = 10_000 ether;
    uint256 internal constant FEE = 20 ether;
    uint256 internal constant ABOVE = 10 ether;
    uint256 internal constant MATCHER = 0.1 ether;
    uint256 internal constant CUT = 1 ether;
    uint256 internal constant SHARE = 1 ether;

    address internal treasury;
    address internal inviter;
    ReferralFacet internal ref;

    function setUp() public {
        setupHelper();
        treasury = makeAddr("refTreasury");
        LibTestVaultBeacon.setTreasury(address(diamond), treasury);
        inviter = makeAddr("inviter");
        ref = ReferralFacet(address(diamond));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _params(LibVaipakam.OfferType kind, uint256 durationDays)
        internal
        view
        returns (LibVaipakam.CreateOfferParams memory)
    {
        return LibVaipakam.CreateOfferParams({
            integrator: address(0),
            lifecycleFlex: 0,
            offerType: kind,
            lendingAsset: mockERC20,
            amount: PRINCIPAL,
            interestRateBps: 500,
            collateralAsset: mockCollateralERC20,
            collateralAmount: PRINCIPAL * 2,
            durationDays: durationDays,
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
            interestRateBpsMax: 500,
            collateralAmountMax: PRINCIPAL * 2,
            periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
            expiresAt: 0,
            fillMode: LibVaipakam.FillMode.Partial,
            refinanceTargetLoanId: 0,
            useFullTermInterest: false
        });
    }

    function _lenderOffer(uint256 durationDays) internal returns (uint256 offerId) {
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Lender, durationDays), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _accept(uint256 offerId) internal returns (uint256) {
        return LibAcceptTestSigner.signAndAcceptVia(address(diamond), borrower, borrowerPk, offerId, address(0));
    }

    function _bind() internal {
        vm.prank(borrower);
        ref.bindInviter(inviter);
    }

    function _nextLoanId() internal view returns (uint256) {
        (uint256 created,) = MetricsFacet(address(diamond)).getGlobalCounts();
        return created + 1;
    }

    function _vaultBal(address owner_) internal view returns (uint256) {
        address v = VaultFactoryFacet(address(diamond)).getUserVaultAddress(owner_);
        return v == address(0) ? 0 : IERC20(mockERC20).balanceOf(v);
    }

    function _treasuryBal() internal view returns (uint256) {
        return IERC20(mockERC20).balanceOf(treasury);
    }

    function _inviterBal() internal view returns (uint256) {
        return IERC20(mockERC20).balanceOf(inviter);
    }

    /// @dev Give `who` a hold discount of `bps` on a liquid principal.
    function _holdDiscount(address who, uint16 bps) internal {
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        vm.mockCall(
            address(diamond),
            abi.encodeWithSelector(VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector, who),
            abi.encode(uint8(1), bps)
        );
        vm.prank(who);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
    }

    /// @dev The settlements a recorded log set carries, by loan.
    function _settlements(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(diamond) && logs[i].topics[0] == ReferralShareSettled.selector) ++n;
        }
    }

    // ── Binding ──────────────────────────────────────────────────────────

    function test_bind_recordsEndTimeAndEmits() public {
        uint64 endsAt = uint64(block.timestamp + 180 days);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit InviterBound(borrower, inviter, endsAt);
        _bind();
        ReferralFacet.ReferralView memory v = ref.getReferral(borrower);
        assertEq(v.inviter, inviter);
        assertEq(v.endsAt, endsAt);
        assertTrue(v.active);
        assertFalse(v.hasBorrowed);
    }

    function test_bind_onceOnly() public {
        _bind();
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.ReferralAlreadyBound.selector, inviter));
        ref.bindInviter(makeAddr("other"));
    }

    function test_bind_refusedAfterFirstBorrow() public {
        _accept(_lenderOffer(30));
        assertTrue(ref.getReferral(borrower).hasBorrowed);
        vm.prank(borrower);
        vm.expectRevert(ReferralFacet.ReferralAfterFirstBorrow.selector);
        ref.bindInviter(inviter);
    }

    function test_bind_refusesSelfZeroDiamondVaultAndIntegrator() public {
        address[4] memory bad;
        bad[0] = borrower;
        bad[1] = address(0);
        bad[2] = address(diamond);
        bad[3] = VaultFactoryFacet(address(diamond)).getOrCreateUserVault(lender);
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(borrower);
            vm.expectRevert(abi.encodeWithSelector(ReferralFacet.ReferralInviterInvalid.selector, bad[i]));
            ref.bindInviter(bad[i]);
        }
        address integ = makeAddr("integ");
        address payout = makeAddr("integPayout");
        IntegratorFacet(address(diamond)).setIntegrator(integ, payout, 0, "Acme", new address[](0));
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.ReferralInviterInvalid.selector, payout));
        ref.bindInviter(payout);
    }

    /// No one binds for another wallet: a call binds only its own caller.
    function test_bind_onlyTheCallersOwn() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        ref.bindInviter(inviter);
        assertEq(ref.getReferral(borrower).inviter, address(0));
        assertEq(ref.getReferral(stranger).inviter, inviter);
    }

    // ── Settings ─────────────────────────────────────────────────────────

    function test_settings_boundsAndAdminOnly() public {
        (uint256 cutBps, uint256 shareBps, uint256 period, uint256 ceiling) = ref.getReferralSettings();
        assertEq(cutBps, 1000);
        assertEq(shareBps, 1000);
        assertEq(period, 180);
        assertEq(ceiling, 6000);

        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.InvalidReferralRates.selector, uint256(3001), uint256(0)));
        ref.setReferralRates(3001, 0);
        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.InvalidReferralRates.selector, uint256(0), uint256(3001)));
        ref.setReferralRates(0, 3001);
        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.InvalidReferralPeriod.selector, uint256(29)));
        ref.setReferralPeriodDays(29);
        vm.expectRevert(abi.encodeWithSelector(ReferralFacet.InvalidReferralPeriod.selector, uint256(366)));
        ref.setReferralPeriodDays(366);

        ref.setReferralRates(0, 3000);
        ref.setReferralPeriodDays(30);
        (cutBps, shareBps, period,) = ref.getReferralSettings();
        assertEq(cutBps, 0, "zero is a rate");
        assertEq(shareBps, 3000);
        assertEq(period, 30);
        ref.setReferralPeriodDays(0);
        (,, period,) = ref.getReferralSettings();
        assertEq(period, 180, "0 restores the default");

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert();
        ref.setReferralRates(1, 1);
        vm.expectRevert();
        ref.setReferralPeriodDays(60);
        vm.stopPrank();
    }

    // ── Matcher rate + cut rate <= ceiling (owner decision 2026-11-18) ──

    function _fitErr(uint256 m, uint256 c, uint256 ceil) private pure returns (bytes memory) {
        return abi.encodeWithSelector(LibFeeShares.MatcherAndCutAboveCeiling.selector, m, c, ceil);
    }

    function test_fit_matcherSetterAtTheEdge() public {
        FeeLevelsFacet(address(diamond)).setFeeShareCeiling(4000);
        FeeLevelsFacet levels = FeeLevelsFacet(address(diamond));
        vm.expectRevert(_fitErr(3001, 1000, 4000));
        levels.setLifMatcherFeeBps(3001);
        vm.expectRevert(abi.encodeWithSelector(FeeLevelsFacet.InvalidFeeBps.selector, uint256(5001), uint256(5000)));
        levels.setLifMatcherFeeBps(5001);
        levels.setLifMatcherFeeBps(3000);
        assertEq(ConfigFacet(address(diamond)).getLifMatcherFeeBps(), 3000, "exactly the ceiling is admitted");
    }

    function test_fit_cutSetterAtTheEdge() public {
        FeeLevelsFacet(address(diamond)).setFeeShareCeiling(4000);
        FeeLevelsFacet(address(diamond)).setLifMatcherFeeBps(1500);
        vm.expectRevert(_fitErr(1500, 2501, 4000));
        ref.setReferralRates(2501, 0);
        ref.setReferralRates(2500, 3000);
        (uint256 cutBps,,,) = ref.getReferralSettings();
        assertEq(cutBps, 2500, "exactly the ceiling is admitted");
        // The inviter's share is not part of the rule: the ceiling reduces it.
    }

    function test_fit_ceilingSetterAtTheEdge() public {
        FeeLevelsFacet(address(diamond)).setLifMatcherFeeBps(3000);
        ref.setReferralRates(2000, 1000);
        FeeLevelsFacet levels = FeeLevelsFacet(address(diamond));
        vm.expectRevert(_fitErr(3000, 2000, 4999));
        levels.setFeeShareCeiling(4999);
        levels.setFeeShareCeiling(5000);
        assertEq(levels.getFeeShareCeiling(), 5000, "exactly the sum is admitted");
        levels.setFeeShareCeiling(0);
        assertEq(levels.getFeeShareCeiling(), 6000, "0 restores the default, checked too");
    }

    function test_fit_tightestSettings() public {
        // The tightest allowed ceiling (40%) with the highest cut (30%):
        // the matcher's rate may go to 10% and no further; 0 (the 1% default)
        // is admitted and reads as 100.
        FeeLevelsFacet levels = FeeLevelsFacet(address(diamond));
        levels.setFeeShareCeiling(4000);
        ref.setReferralRates(3000, 3000);
        levels.setLifMatcherFeeBps(1000);
        vm.expectRevert(_fitErr(1001, 3000, 4000));
        levels.setLifMatcherFeeBps(1001);
        levels.setLifMatcherFeeBps(0);
        assertEq(ConfigFacet(address(diamond)).getLifMatcherFeeBps(), 100);
    }

    /// Any order of admitted changes keeps the rule, and then the cut and
    /// the matcher's share, each its rate of A rounded down, never pass the
    /// ceiling's amount of A.
    function testFuzz_fit_holdsAfterAnyAdmittedSettings(
        uint16[6] memory vals,
        uint8[6] memory which,
        uint256 above
    ) public {
        above = bound(above, 0, 1e36);
        ConfigFacet cfg = ConfigFacet(address(diamond));
        FeeLevelsFacet levels = FeeLevelsFacet(address(diamond));
        for (uint256 i; i < 6; ++i) {
            uint8 w = which[i] % 3;
            if (w == 0) {
                try levels.setLifMatcherFeeBps(uint16(bound(vals[i], 0, 5000))) {} catch {}
            } else if (w == 1) {
                uint16 c = uint16(bound(vals[i], 0, 3000));
                try ref.setReferralRates(c, c) {} catch {}
            } else {
                uint256 v = bound(vals[i], 3999, 7000);
                try levels.setFeeShareCeiling(v == 3999 ? 0 : uint16(v)) {} catch {}
            }
            uint256 m = cfg.getLifMatcherFeeBps();
            (uint256 cutBps,,, uint256 ceil) = ref.getReferralSettings();
            assertLe(m + cutBps, ceil, "rates fit");
            assertLe(
                (above * cutBps) / 10_000 + (above * m) / 10_000, (above * ceil) / 10_000, "amounts fit after rounding"
            );
        }
    }

    function test_pay_isDiamondOnly() public {
        vm.expectRevert(IVaipakamErrors.UnauthorizedCrossFacetCall.selector);
        ref.payReferralShare(lender, mockERC20, 1, borrower, 1);
    }

    // ── The cut and the share at acceptance ──────────────────────────────

    function test_accept_defaultRates_cutAndSharePaid() public {
        _bind();
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        uint256 d0 = IERC20(mockERC20).balanceOf(address(diamond));
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.Paid);
        uint256 loanId = _accept(offerId);
        assertEq(loanId, _nextLoanId() - 1, "the settlement named the loan it opened");

        assertEq(_inviterBal(), SHARE, "the share lands in the inviter's wallet");
        assertEq(_vaultBal(borrower), PRINCIPAL - (FEE - CUT), "the cut is not charged");
        assertEq(_treasuryBal() - t0, FEE - CUT - MATCHER - SHARE, "the treasury leg is the rest");
        assertEq(IERC20(mockERC20).balanceOf(address(diamond)), d0, "nothing is held");

        LibVaipakam.ReferralTotals memory t = ref.getReferralTotals(mockERC20);
        assertEq(t.cut, CUT);
        assertEq(t.sharePaid, SHARE);
        assertEq(t.shareRedirected, 0);
        assertEq(t.loans, 1);
        assertTrue(ref.getReferral(borrower).hasBorrowed);
    }

    /// #3360 — the kept fee the loan records is the fee after the referral
    /// cut, less the matcher's and the inviter's shares, paid through the real
    /// fee host: exactly what the treasury received.
    function test3360_keptFee_netOfCutMatcherAndInviter() public {
        _bind();
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        uint256 loanId = _accept(offerId);
        uint256 kept = FeeEntitlementFacet(address(diamond)).getFeeEntitlement(loanId).keptFeeOpen;
        assertEq(kept, FEE - CUT - MATCHER - SHARE, "the inviter's share is not kept");
        assertEq(kept, _treasuryBal() - t0, "kept = what the fee host received");
    }

    /// A one-year loan: fee 100, A 90, cut 9, share 9 (design section 2).
    function test_accept_oneYear() public {
        _bind();
        uint256 offerId = _lenderOffer(365);
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, 9 ether, 9 ether, LibReferral.Outcome.Paid);
        _accept(offerId);
        assertEq(_inviterBal(), 9 ether);
        assertEq(_vaultBal(borrower), PRINCIPAL - 91 ether);
        assertEq(_treasuryBal() - t0, 91 ether - 0.9 ether - 9 ether);
    }

    function test_unbound_paysTheWholeFee_noEvent() public {
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        vm.recordLogs();
        _accept(offerId);
        assertEq(_settlements(vm.getRecordedLogs()), 0);
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE);
        assertEq(_treasuryBal() - t0, FEE - MATCHER);
    }

    /// The period runs up to and including its end time; one second later
    /// the loan pays the whole fee and the inviter nothing. A change to the
    /// period after binding never moves a bound wallet's end time.
    function test_period_endInclusive_andFixedAtBinding() public {
        ref.setReferralPeriodDays(30);
        _bind();
        uint64 endsAt = ref.getReferral(borrower).endsAt;
        assertEq(endsAt, block.timestamp + 30 days);
        ref.setReferralPeriodDays(365);
        assertEq(ref.getReferral(borrower).endsAt, endsAt, "a later setting does not move it");

        uint256 offerId = _lenderOffer(30);
        vm.warp(endsAt);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.Paid);
        _accept(offerId);

        uint256 late = _lenderOffer(30);
        vm.warp(endsAt + 1);
        assertFalse(ref.getReferral(borrower).active);
        uint256 v0 = _vaultBal(borrower);
        vm.recordLogs();
        _accept(late);
        assertEq(_settlements(vm.getRecordedLogs()), 0, "ended: no referral");
        assertEq(_vaultBal(borrower) - v0, PRINCIPAL - FEE, "the whole fee");
        assertEq(_inviterBal(), SHARE, "nothing more to the inviter");
    }

    /// However many loans: each inside the period carries it.
    function test_everyLoanInsideThePeriod() public {
        _bind();
        _accept(_lenderOffer(30));
        _accept(_lenderOffer(30));
        _accept(_lenderOffer(30));
        assertEq(_inviterBal(), 3 * SHARE);
        assertEq(ref.getReferralTotals(mockERC20).loans, 3);
    }

    function test_rateZero_nothingTakenOffNothingPaid() public {
        ref.setReferralRates(0, 0);
        _bind();
        uint256 offerId = _lenderOffer(30);
        vm.recordLogs();
        _accept(offerId);
        assertEq(_settlements(vm.getRecordedLogs()), 0);
        assertEq(_vaultBal(borrower), PRINCIPAL - FEE);
        assertEq(_inviterBal(), 0);
    }

    /// Both rates at 30%: the cut is 3 and the share 3, but the ceiling (60%
    /// of A = 6) holds the sum: 3 + the matcher's 0.1 + the share, so the
    /// inviter's share is reduced first, to 2.9. The cut is never reduced.
    function test_ratesAtMost_inviterReducedFirst() public {
        ref.setReferralRates(3000, 3000);
        _bind();
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, 3 ether, 2.9 ether, LibReferral.Outcome.Paid);
        _accept(offerId);
        assertEq(_vaultBal(borrower), PRINCIPAL - 17 ether);
        assertEq(_inviterBal(), 2.9 ether);
        // The reserve keeps at least 40% of A above the treasury's floor.
        assertEq(_treasuryBal() - t0, 17 ether - MATCHER - 2.9 ether);
        assertGe(_treasuryBal() - t0, 10 ether + 4 ether);
    }

    /// With an integrator at 50% and the ceiling at 40%: the room after the
    /// cut (4 - 3 = 1) goes to the matcher (0.1), then the integrator (0.9);
    /// the inviter's share is reduced to nothing.
    function test_ceiling_withIntegrator_inviterThenIntegrator() public {
        address integ = makeAddr("integ");
        address payout = makeAddr("integPayout");
        IntegratorFacet(address(diamond)).setIntegrator(integ, payout, 5000, "Acme", new address[](0));
        FeeLevelsFacet(address(diamond)).setFeeShareCeiling(4000);
        ref.setReferralRates(3000, 3000);
        _bind();
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, 3 ether, 0, LibReferral.Outcome.NoShare);
        LibAcceptTestSigner.signAndAcceptVia(address(diamond), borrower, borrowerPk, offerId, integ);
        assertEq(_inviterBal(), 0);
        address pv = VaultFactoryFacet(address(diamond)).getUserVaultAddress(payout);
        assertEq(IERC20(mockERC20).balanceOf(pv), 0.9 ether, "the integrator fills what the matcher leaves");
        assertEq(_treasuryBal() - t0, 17 ether - 1 ether, "floor 10 + reserve 6 (60% of A)");
    }

    /// The treasury's floor is the same with and without a referral: the
    /// treasury leg less the reserve's part is 10 either way.
    function test_floorUntouched() public {
        TreasuryFeeFacet tf = TreasuryFeeFacet(address(diamond));
        uint256 t0 = _treasuryBal();
        uint256 r0 = tf.getReservePartHeldByTreasury(mockERC20);
        _accept(_lenderOffer(30));
        uint256 floorWithout = (_treasuryBal() - t0) - (tf.getReservePartHeldByTreasury(mockERC20) - r0);

        ref.setReferralRates(3000, 3000);
        (address fresh, uint256 freshPk) = makeAddrAndKey("freshBorrower");
        ERC20Mock(mockCollateralERC20).mint(fresh, PRINCIPAL * 2);
        vm.prank(fresh);
        IERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(fresh);
        ref.bindInviter(inviter);
        uint256 offerId = _lenderOffer(30);
        t0 = _treasuryBal();
        r0 = tf.getReservePartHeldByTreasury(mockERC20);
        LibAcceptTestSigner.signAndAcceptVia(address(diamond), fresh, freshPk, offerId, address(0));
        uint256 floorWith = (_treasuryBal() - t0) - (tf.getReservePartHeldByTreasury(mockERC20) - r0);
        assertEq(floorWith, floorWithout);
        assertEq(floorWith, 10 ether);
        assertGt(_inviterBal(), 0);
    }

    // ── The hold discount's ceiling ──────────────────────────────────────

    /// One year, a 45% hold discount and both rates at 30%: the fee is 100,
    /// discounted to 55; A is 45; the cut would be 13.5 but the allowance
    /// under the 50% ceiling is 5, so the cut is 5. The share is 13.5,
    /// unaffected.
    function test_holdDiscountNearCeiling_cutIsTheAllowance() public {
        _holdDiscount(borrower, 4500);
        ref.setReferralRates(3000, 3000);
        _bind();
        uint256 offerId = _lenderOffer(365);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, 5 ether, 13.5 ether, LibReferral.Outcome.Paid);
        _accept(offerId);
        assertEq(_vaultBal(borrower), PRINCIPAL - 50 ether, "half the full fee, never less");
        assertEq(_inviterBal(), 13.5 ether);
    }

    /// At the ceiling: no cut; the inviter's share (10% of A = 40) is 4.
    function test_holdDiscountAtCeiling_noCut_shareUnchanged() public {
        _holdDiscount(borrower, 5000);
        _bind();
        uint256 offerId = _lenderOffer(365);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, 0, 4 ether, LibReferral.Outcome.Paid);
        _accept(offerId);
        assertEq(_vaultBal(borrower), PRINCIPAL - 50 ether);
        assertEq(_inviterBal(), 4 ether);
    }

    /// A 30-day fee discounted to the floor has no part above it: no cut,
    /// no share, no event.
    function test_feeAtTheFloor_nothing() public {
        _holdDiscount(borrower, 5000);
        _bind();
        uint256 offerId = _lenderOffer(30);
        vm.recordLogs();
        _accept(offerId);
        assertEq(_settlements(vm.getRecordedLogs()), 0);
        assertEq(_vaultBal(borrower), PRINCIPAL - 10 ether);
        assertEq(_inviterBal(), 0);
    }

    // ── A share that cannot be paid goes to the reserve ──────────────────

    function test_flaggedInviter_shareToTheReserve_cutUnchanged() public {
        address oracle = makeAddr("sanctionsOracle");
        vm.mockCall(oracle, abi.encodeWithSelector(ISanctionsList.isSanctioned.selector), abi.encode(false));
        vm.mockCall(oracle, abi.encodeWithSelector(ISanctionsList.isSanctioned.selector, inviter), abi.encode(true));
        ProfileFacet(address(diamond)).setSanctionsOracle(oracle);
        _bind();
        uint256 offerId = _lenderOffer(30);
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.InviterFlagged);
        uint256 loanId = _accept(offerId);
        assertGt(loanId, 0, "the loan opens");
        assertEq(_inviterBal(), 0);
        assertEq(_vaultBal(borrower), PRINCIPAL - (FEE - CUT), "the cut is unaffected");
        assertEq(_treasuryBal() - t0, FEE - CUT - MATCHER, "the share stays in the treasury leg (the reserve's)");
        assertEq(ref.getReferralTotals(mockERC20).shareRedirected, SHARE);
    }

    function test_paymentFails_shareToTheReserve() public {
        _bind();
        uint256 offerId = _lenderOffer(30);
        vm.mockCallRevert(address(diamond), abi.encodeWithSelector(ReferralFacet.payReferralShare.selector), "no");
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.PaymentFailed);
        _accept(offerId);
        assertEq(_inviterBal(), 0);
        assertEq(_treasuryBal() - t0, FEE - CUT - MATCHER);
    }

    function test_shortDelivery_shareToTheReserve() public {
        _bind();
        uint256 offerId = _lenderOffer(30);
        vm.mockCallRevert(
            address(diamond),
            abi.encodeWithSelector(ReferralFacet.payReferralShare.selector),
            abi.encodeWithSelector(IVaipakamErrors.TokenDeliveryShort.selector, mockERC20, SHARE, SHARE - 1)
        );
        uint256 t0 = _treasuryBal();
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.DeliveredShort);
        _accept(offerId);
        assertEq(_treasuryBal() - t0, FEE - CUT - MATCHER);
    }

    // ── Previews and other routes ────────────────────────────────────────

    function test_preview_agreesWithTheCharge() public {
        _bind();
        uint256 offerId = _lenderOffer(30);
        OfferAcceptFacet.AcceptPreview memory p = OfferPreviewFacet(address(diamond)).previewAccept(offerId, borrower);
        assertEq(p.lifEstimate, FEE - CUT);
        assertEq(p.referralCut, CUT);
        ReferralFacet.FeeQuote memory q = ref.quoteBorrowerFee(borrower, mockERC20, PRINCIPAL, 30, false);
        assertEq(q.fee, FEE - CUT);
        assertEq(q.cut, CUT);
        assertEq(q.share, SHARE);
        assertEq(q.inviter, inviter);
        _accept(offerId);
        assertEq(_vaultBal(borrower), PRINCIPAL - p.lifEstimate);
    }

    /// A rate change after a loan opens does not touch it (nothing is paid
    /// later), and applies to the next loan.
    function test_rateChange_appliesToLoansOpenedAfter() public {
        _bind();
        _accept(_lenderOffer(30));
        ref.setReferralRates(0, 0);
        assertEq(_inviterBal(), SHARE, "already paid");
        uint256 v0 = _vaultBal(borrower);
        _accept(_lenderOffer(30));
        assertEq(_vaultBal(borrower) - v0, PRINCIPAL - FEE);
        assertEq(_inviterBal(), SHARE);
    }

    function test_borrowerOffer_acceptedByLender_carriesIt() public {
        _bind();
        vm.prank(borrower);
        uint256 offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, offerId, CUT, SHARE, LibReferral.Outcome.Paid);
        LibAcceptTestSigner.signAndAcceptVia(address(diamond), lender, lenderPk, offerId, address(0));
        assertEq(_inviterBal(), SHARE);
    }

    function test_match_carriesIt() public {
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        _bind();
        uint256 lo = _lenderOffer(30);
        vm.prank(borrower);
        uint256 bo = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), bo);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), borrower, inviter, mockERC20, bo, CUT, SHARE, LibReferral.Outcome.Paid);
        uint256 loanId = OfferMatchFacet(address(diamond)).matchOffers(lo, bo);
        assertEq(loanId, _nextLoanId() - 1);
        assertEq(_inviterBal(), SHARE);
    }

    /// An extension's added fee carries neither the cut nor the share.
    function test_extension_carriesNeither() public {
        _bind();
        uint256 loanId = _accept(_lenderOffer(30));
        LibVaipakam.Loan memory l = LoanFacet(address(diamond)).getLoanDetails(loanId);
        (uint256 gross, uint256 fee,,) =
            FeeLevelsFacet(address(diamond)).quoteExtensionFee(loanId, l.startTime + 365 days);
        assertGt(gross, 0);
        assertEq(fee, gross, "no cut on an extension");
    }

    // ── An obligation handover (the takeover rulings) ────────────────────

    function _handOver(uint256 loanId, address incoming) internal returns (uint256 offerId) {
        ERC20Mock(mockCollateralERC20).mint(incoming, PRINCIPAL * 2);
        vm.prank(incoming);
        IERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(incoming);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            _params(LibVaipakam.OfferType.Borrower, 30), type(uint64).max
        );
        LibTestTiming.backdateTerms(address(diamond), offerId);
        ERC20Mock(mockERC20).mint(borrower, PRINCIPAL);
        vm.prank(borrower);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.prank(borrower);
        PrecloseFacet(address(diamond)).transferObligationViaOffer(loanId, offerId, type(uint64).max);
    }

    /// 1. A new wallet binds, borrows, then hands the obligation to a main
    ///    wallet: the loan's fee, cut and share were settled once at opening,
    ///    and the handover settles nothing for the incoming wallet.
    function test_handover_fromBoundWallet_changesNothingSettled() public {
        _bind();
        uint256 loanId = _accept(_lenderOffer(30));
        LibVaipakam.ReferralTotals memory before = ref.getReferralTotals(mockERC20);
        address main = makeAddr("mainWallet");
        vm.recordLogs();
        _handOver(loanId, main);
        assertEq(_settlements(vm.getRecordedLogs()), 0, "no settlement on a handover");
        LibVaipakam.ReferralTotals memory afterT = ref.getReferralTotals(mockERC20);
        assertEq(afterT.cut, before.cut);
        assertEq(afterT.sharePaid, before.sharePaid);
        assertEq(afterT.loans, before.loans);
        assertEq(_inviterBal(), SHARE);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).borrower, main);
    }

    /// 2 and 3. A bound wallet taking over an obligation pays no cut and
    ///    earns its inviter nothing; the takeover counts as its first loan as
    ///    borrower, and its binding and end time stay as they were.
    function test_handover_intoBoundWallet_noFee_countsAsFirstBorrow() public {
        uint256 loanId = _accept(_lenderOffer(30));
        address incoming = makeAddr("incoming");
        address incomingInviter = makeAddr("incomingInviter");
        vm.prank(incoming);
        ref.bindInviter(incomingInviter);
        uint64 endsAt = ref.getReferral(incoming).endsAt;

        vm.recordLogs();
        _handOver(loanId, incoming);
        assertEq(_settlements(vm.getRecordedLogs()), 0, "a takeover charges no fee");
        assertEq(IERC20(mockERC20).balanceOf(incomingInviter), 0);

        ReferralFacet.ReferralView memory v = ref.getReferral(incoming);
        assertTrue(v.hasBorrowed, "a takeover is a first loan as borrower");
        assertEq(v.inviter, incomingInviter, "the binding stays");
        assertEq(v.endsAt, endsAt, "and its end time is not restarted");
    }

    /// 3. An unbound wallet that took over an obligation can no longer bind.
    function test_handover_incomingCannotBindAfter() public {
        uint256 loanId = _accept(_lenderOffer(30));
        address incoming = makeAddr("incoming");
        _handOver(loanId, incoming);
        vm.prank(incoming);
        vm.expectRevert(ReferralFacet.ReferralAfterFirstBorrow.selector);
        ref.bindInviter(inviter);
    }

    /// 4. A refinance by the incoming wallet follows that wallet's own
    ///    binding: its own inviter, its own period; nothing is carried over
    ///    from the wallet that opened the loan.
    function test_handover_thenRefinance_followsTheIncomingBinding() public {
        _bind(); // the original borrower's inviter
        uint256 loanId = _accept(_lenderOffer(30));
        address incoming;
        uint256 incomingPk;
        (incoming, incomingPk) = makeAddrAndKey("incomingRefi");
        address incomingInviter = makeAddr("incomingInviter");
        vm.prank(incoming);
        ref.bindInviter(incomingInviter);
        _handOver(loanId, incoming);

        // The incoming wallet asks to refinance the loan it now owes.
        vm.prank(incoming);
        AutoLifecycleSettingsFacet(address(diamond)).setAutoRefinanceCaps(
            loanId, true, 600, uint64(block.timestamp + 365 days)
        );
        ERC20Mock(mockCollateralERC20).mint(incoming, PRINCIPAL * 2);
        LibVaipakam.CreateOfferParams memory p = _params(LibVaipakam.OfferType.Borrower, 30);
        p.refinanceTargetLoanId = loanId;
        p.fillMode = LibVaipakam.FillMode.Aon;
        p.interestRateBps = 400;
        p.interestRateBpsMax = 400;
        vm.prank(incoming);
        uint256 req = OfferCreateFacet(address(diamond)).createOffer(p, type(uint64).max);
        ERC20Mock(mockERC20).mint(incoming, PRINCIPAL);
        RefinancePayoffPermitHelper.attach(address(diamond), incoming, mockERC20, req);
        LibTestTiming.waitOutTermsAge(address(diamond), req);

        (address newLender, uint256 newLenderPk) = makeAddrAndKey("refiLender");
        ERC20Mock(mockERC20).mint(newLender, PRINCIPAL);
        vm.prank(newLender);
        IERC20(mockERC20).approve(address(diamond), type(uint256).max);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ReferralShareSettled(_nextLoanId(), incoming, incomingInviter, mockERC20, req, CUT, SHARE, LibReferral.Outcome.Paid);
        LibAcceptTestSigner.signAndAcceptVia(address(diamond), newLender, newLenderPk, req, address(0));
        assertEq(IERC20(mockERC20).balanceOf(incomingInviter), SHARE);
        assertEq(_inviterBal(), SHARE, "the first wallet's inviter got only its own loan's share");
        incomingPk;
    }
}
