// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LenderIntentViewFacet} from "../src/facets/LenderIntentViewFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LoanFacet} from "../src/facets/LoanFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {MetricsFacet} from "../src/facets/MetricsFacet.sol";
import {OfferMatchIntentFacet} from "../src/facets/OfferMatchIntentFacet.sol";
import {OfferPriceGuardFacet} from "../src/facets/OfferPriceGuardFacet.sol";
import {LenderIntentFacet} from "../src/facets/LenderIntentFacet.sol";
import {RiskPreviewFacet} from "../src/facets/RiskPreviewFacet.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibOfferMatch} from "../src/libraries/LibOfferMatch.sol";
import {LibOfferPriceGuard} from "../src/libraries/LibOfferPriceGuard.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LibTestTiming} from "./helpers/LibTestTiming.sol";
import {LibTestCalmPair} from "./helpers/LibTestCalmPair.sol";

/**
 * @title  IntentCalmCheckTest
 * @notice A lender intent slot's fill runs the calm rule on its pair (the
 *         one forced sales and the maker's offer guard use): refused while
 *         the pair moved past the calm bound against either of the last two
 *         hourly checkpoints, while a checkpoint is missing, or while a price
 *         cannot be read. On by default; the slot's owner, and only the
 *         owner, may switch it off. The backstop and adapter routes are
 *         covered in their own suites.
 */
contract IntentCalmCheckTest is SetupTest {
    address internal solver;

    uint256 internal constant PRINCIPAL = 1_000 ether;
    uint256 internal constant MIN_RATE_BPS = 500;
    uint16 internal constant MAX_INIT_LTV_BPS = 5_000; // 50%
    uint32 internal constant MAX_DURATION = 30;

    function setUp() public {
        setupHelper();
        vm.warp(((block.timestamp / 1 hours) + 10) * 1 hours);
        solver = makeAddr("calm-solver");
        vm.prank(owner);
        ConfigFacet(address(diamond)).setPartialFillEnabled(true);
        vm.prank(owner);
        LenderIntentFacet(address(diamond)).setLenderIntentEnabled(true);

        vm.prank(lender);
        LenderIntentFacet(address(diamond)).setLenderIntent(
            mockERC20, mockCollateralERC20, 0, 10 * PRINCIPAL, MIN_RATE_BPS, MAX_INIT_LTV_BPS,
            MAX_DURATION, 100 ether, false, 0, false, true, type(uint64).max
        );
        LibTestTiming.waitOutIntentAge(address(diamond), lender, mockERC20, mockCollateralERC20);
        ERC20Mock(mockERC20).mint(lender, PRINCIPAL);
        vm.prank(lender);
        ERC20(mockERC20).approve(address(diamond), PRINCIPAL);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).fundLenderIntent(mockERC20, mockCollateralERC20, 0, PRINCIPAL);
    }

    // ── helpers ─────────────────────────────────────────────────────────

    function _request(uint256 coll) internal returns (uint256 offerId) {
        address b = makeAddr("calm-borrower");
        ERC20Mock(mockCollateralERC20).mint(b, coll);
        vm.prank(b);
        ERC20(mockCollateralERC20).approve(address(diamond), type(uint256).max);
        vm.prank(b);
        ProfileFacet(address(diamond)).setUserCountry("US");
        vm.prank(owner);
        ProfileFacet(address(diamond)).updateKYCTier(b, LibVaipakam.KYCTier.Tier2);
        vm.prank(b);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                integrator: address(0),
                lifecycleFlex: 0,
                offerType: LibVaipakam.OfferType.Borrower,
                lendingAsset: mockERC20,
                amount: PRINCIPAL,
                interestRateBps: MIN_RATE_BPS, // the slot's floor rate
                collateralAsset: mockCollateralERC20,
                collateralAmount: coll,
                durationDays: MAX_DURATION, // the slot's longest term
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
                interestRateBpsMax: MIN_RATE_BPS,
                collateralAmountMax: coll,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: true
            }),
            type(uint64).max
        );
        LibTestTiming.waitOutTermsAge(address(diamond), offerId);
    }

    function _fill(uint256 cp) internal returns (uint256) {
        vm.prank(solver);
        return OfferMatchIntentFacet(address(diamond)).matchIntent(
            lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    function _preview(uint256 cp) internal view returns (LibOfferMatch.IntentPreviewResult memory) {
        return RiskPreviewFacet(address(diamond)).previewIntent(
            solver, solver, lender, mockERC20, mockCollateralERC20, 0, cp, PRINCIPAL
        );
    }

    function _status() internal view returns (LibOfferPriceGuard.Status) {
        return OfferPriceGuardFacet(address(diamond)).intentCalmStatus(lender, mockERC20, mockCollateralERC20, 0);
    }

    function _expectNotCalm() internal {
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairNotCalm.selector, mockERC20, mockCollateralERC20)
        );
    }

    /// @dev Collateral covering the 50% ceiling at `price8` (8 decimals).
    function _collAt(uint256 price8) internal pure returns (uint256) {
        return (PRINCIPAL * 2 * 1e8) / price8 + 1 ether;
    }

    // ── 1. The moving pair, refused ─────────────────────────────────────

    /// The collateral reads 50% above both checkpoints, and a request sized
    /// to the ceiling at that price is refused by name.
    function test_movingPair_upwards_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        mockOraclePrice(mockCollateralERC20, 1.5e8, 8);
        uint256 cp = _request(_collAt(1.5e8));
        _expectNotCalm();
        _fill(cp);
    }

    // ── 8. A move down is refused like a move up ────────────────────────

    function test_movingPair_downwards_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        uint256 cp = _request(_collAt(0.5e8));
        mockOraclePrice(mockCollateralERC20, 0.5e8, 8);
        _expectNotCalm();
        _fill(cp);
    }

    // ── 2. A calm pair fills as before ──────────────────────────────────

    function test_calmPair_fills() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        uint256 cp = _request(_collAt(1e8));
        assertEq(uint8(_status()), uint8(LibOfferPriceGuard.Status.Clear));
        assertTrue(_preview(cp).ok, "the preview clears it");
        uint256 loanId = _fill(cp);
        assertEq(LoanFacet(address(diamond)).getLoanDetails(loanId).principal, PRINCIPAL);
    }

    // ── 3. Missing checkpoint, unreadable price ─────────────────────────

    function test_noCheckpointsAtAll_isRefused() public {
        uint256 cp = _request(_collAt(1e8));
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairNoCheckpoint.selector, mockERC20, mockCollateralERC20)
        );
        _fill(cp);
    }

    function test_lendingAssetCheckpointMissing_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockCollateralERC20);
        uint256 cp = _request(_collAt(1e8));
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairNoCheckpoint.selector, mockERC20, mockCollateralERC20)
        );
        _fill(cp);
    }

    function test_collateralCheckpointMissing_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockERC20, mockERC20);
        uint256 cp = _request(_collAt(1e8));
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairNoCheckpoint.selector, mockERC20, mockCollateralERC20)
        );
        _fill(cp);
    }

    /// Only the older of the last two hours is checkpointed: still refused,
    /// the strict form needs both.
    function test_oneOfTheTwoHoursMissing_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        vm.warp(vm.getBlockTimestamp() + 1 hours); // the newest hour now has none
        uint256 cp = _request(_collAt(1e8));
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairNoCheckpoint.selector, mockERC20, mockCollateralERC20)
        );
        _fill(cp);
    }

    function test_unreadablePrice_isRefused() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        uint256 cp = _request(_collAt(1e8));
        mockOraclePrice(mockCollateralERC20, 0, 8);
        vm.expectRevert(
            abi.encodeWithSelector(OfferPriceGuardFacet.IntentPairUnpriced.selector, mockERC20, mockCollateralERC20)
        );
        _fill(cp);
    }

    // ── 4. The owner's switch ───────────────────────────────────────────

    function test_ownerSwitchesOff_theSameFillSucceeds_andBackOn() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        mockOraclePrice(mockCollateralERC20, 1.5e8, 8);
        uint256 cp = _request(_collAt(1.5e8));

        vm.expectEmit(true, true, true, true, address(diamond));
        emit OfferPriceGuardFacet.IntentCalmCheckSet(lender, mockERC20, mockCollateralERC20, 0, false);
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
        assertEq(uint8(_status()), uint8(LibOfferPriceGuard.Status.Off));
        assertGt(_fill(cp), 0, "switched off, the slot fills");

        vm.expectEmit(true, true, true, true, address(diamond));
        emit OfferPriceGuardFacet.IntentCalmCheckSet(lender, mockERC20, mockCollateralERC20, 0, true);
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, true);
        assertEq(uint8(_status()), uint8(LibOfferPriceGuard.Status.NotCalm));
    }

    /// The switch is keyed by the caller: an approved keeper, or any other
    /// wallet (a manager or a mandate acts as itself the same way), only
    /// ever writes its own slot, never the owner's.
    function test_keeperOrStranger_cannotSwitchTheOwnersSlot() public {
        vm.prank(lender);
        ProfileFacet(address(diamond)).setKeeperAccess(true);
        vm.prank(lender);
        ProfileFacet(address(diamond)).approveKeeper(solver, LibVaipakam.KEEPER_ACTION_SIGNED_FILL);

        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        mockOraclePrice(mockCollateralERC20, 1.5e8, 8);
        uint256 cp = _request(_collAt(1.5e8));

        vm.prank(solver);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
        vm.prank(makeAddr("stranger"));
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);

        assertEq(uint8(_status()), uint8(LibOfferPriceGuard.Status.NotCalm), "the owner's slot is still checked");
        _expectNotCalm();
        _fill(cp);
    }

    /// A protected account's active signer acts as itself too: it can sign
    /// for the account's protected steps, but this setting is the owner's.
    function test_protectedAccountSigner_cannotSwitchTheOwnersSlot() public {
        address signer = makeAddr("calm-signer");
        LibTestProtection.enable(address(diamond), lender, 2 days);
        LibTestProtection.addSigner(address(diamond), lender, lender, signer, 2 days);

        vm.prank(signer);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
        assertTrue(_status() != LibOfferPriceGuard.Status.Off, "the owner's slot is still checked");
        assertEq(
            uint8(OfferPriceGuardFacet(address(diamond)).intentCalmStatus(signer, mockERC20, mockCollateralERC20, 0)),
            uint8(LibOfferPriceGuard.Status.Off),
            "the signer only switched its own key"
        );
    }

    function test_slotOutOfRange_isRefused() public {
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.IntentSlotOutOfRange.selector, uint8(8)));
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 8, false);
    }

    /// Cancelling the intent switches the check back on, so a new intent in
    /// the slot starts protected.
    function test_cancel_switchesTheCheckBackOn() public {
        vm.prank(lender);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
        assertEq(uint8(_status()), uint8(LibOfferPriceGuard.Status.Off));
        vm.expectEmit(true, true, true, true, address(diamond));
        emit OfferPriceGuardFacet.IntentCalmCheckSet(lender, mockERC20, mockCollateralERC20, 0, true);
        vm.prank(lender);
        LenderIntentFacet(address(diamond)).cancelLenderIntent(mockERC20, mockCollateralERC20, 0);
        assertTrue(_status() != LibOfferPriceGuard.Status.Off, "back on after a cancel");
    }

    // ── 5. Platform-run slots cannot switch it off (the real backstop
    //       vault: `BackstopVaultTest`) ──────────────────────────────────

    function test_aggregatorAdapter_cannotSwitchOff() public {
        address adapter = makeAddr("adapter");
        vm.prank(owner);
        TestMutatorFacet(address(diamond)).setAggregatorAdapterRaw(adapter, address(0));
        vm.prank(adapter);
        vm.expectRevert(abi.encodeWithSelector(OfferPriceGuardFacet.IntentCalmCheckRequired.selector, adapter));
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, false);
        // Switching it ON is harmless and allowed.
        vm.prank(adapter);
        OfferPriceGuardFacet(address(diamond)).setIntentCalmCheck(mockERC20, mockCollateralERC20, 0, true);
    }

    // ── 6 / 7. Preview, and a refused fill changes nothing ──────────────

    function test_preview_reportsEachRefusal() public {
        uint256 cp = _request(_collAt(1e8));
        assertEq(uint8(_preview(cp).intentError), uint8(LibOfferMatch.IntentError.PairNoCheckpoint));

        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        mockOraclePrice(mockCollateralERC20, 1.5e8, 8);
        LibOfferMatch.IntentPreviewResult memory r = _preview(cp);
        assertFalse(r.ok);
        assertEq(uint8(r.intentError), uint8(LibOfferMatch.IntentError.PairNotCalm));

        mockOraclePrice(mockCollateralERC20, 0, 8);
        assertEq(uint8(_preview(cp).intentError), uint8(LibOfferMatch.IntentError.PairUnpriced));
    }

    function test_refusedFill_changesNothing_thenFillsOnceCalm() public {
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        uint256 cp = _request(_collAt(1e8));
        mockOraclePrice(mockCollateralERC20, 1.5e8, 8);

        uint256 capital = _capital();
        uint256 loansBefore = _loanCount();
        _expectNotCalm();
        _fill(cp);
        assertEq(_capital(), capital, "funding unchanged");
        assertEq(_loanCount(), loansBefore, "no loan");
        assertEq(OfferCancelFacet(address(diamond)).getOffer(cp).amountFilled, 0, "request untouched");

        // The price returns and settles; two fresh hours read calm.
        mockOraclePrice(mockCollateralERC20, 1e8, 8);
        LibTestCalmPair.checkpoint(address(diamond), mockCollateralERC20, mockERC20);
        assertGt(_fill(cp), 0, "the same request fills once calm");
    }

    function _loanCount() internal view returns (uint256 n) {
        (n,) = MetricsFacet(address(diamond)).getGlobalCounts();
    }

    function _capital() internal view returns (uint256 c) {
        c = LenderIntentViewFacet(address(diamond)).getLenderIntentCapital(
            lender, mockERC20, mockCollateralERC20, 0
        );
    }
}
