// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {RepatriationFacet} from "../src/facets/RepatriationFacet.sol";
import {LibVpfiRecycle} from "../src/libraries/LibVpfiRecycle.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @title  RepatriationAccountingTest
 * @notice #1568 C2 Mode A — the accounting core's behaviour pins, all reads
 *         and writes THROUGH THE DIAMOND (a test-contract `storageSlot()`
 *         resolves against the test's own storage and asserts 0 == 0).
 *
 *         Availability is seeded through the REAL report ingress
 *         (`MockRewardMessenger.deliverChainReportRecycled`), so every
 *         "avail shrinks / restores" assertion starts from a proven non-zero
 *         baseline — the fixture is live before the property is asserted.
 */
contract RepatriationAccountingTest is SetupTest {
    MockRewardMessenger internal messenger;
    ERC20Mock internal vpfi;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    address internal constant RECEIVER = address(0xC2CE1BE2);

    function setUp() public {
        setupHelper();
        messenger = new MockRewardMessenger(address(diamond));
        vm.chainId(CHAIN_BASE);
        _rep().setBaseChainId(CHAIN_BASE);
        _rep().setIsCanonicalRewardChain(true);
        _rep().setRewardMessenger(address(messenger));
        uint32[] memory chainIds = new uint32[](2);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        _agg().setExpectedSourceChainIds(chainIds);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        _mut().setVpfiTokenRaw(address(vpfi));
        // The endpoint setter rejects code-less addresses (Codex #1608 r1),
        // so give the pranked receiver a byte of code.
        vm.etch(RECEIVER, hex"01");
    }

    function _rep() internal view returns (RewardReporterFacet) {
        return RewardReporterFacet(address(diamond));
    }

    function _agg() internal view returns (RewardAggregatorFacet) {
        return RewardAggregatorFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _repat() internal view returns (RepatriationFacet) {
        return RepatriationFacet(address(diamond));
    }

    /// Real-ingress availability seed (avail == reported while nothing is
    /// consumed/released). Distinct dayId per call; cumulative monotone.
    function _seedAvail(uint256 dayId, uint256 amount) internal {
        messenger.deliverChainReportRecycled(
            CHAIN_ARB, dayId, 20e18, 10e18, amount, amount
        );
    }

    function _avail(uint32 chainId) internal view returns (uint256 avail) {
        (, , avail, ) = _agg().getChainRecycledLedger(chainId);
    }

    function _arm() internal {
        _repat().setRepatriationEndpoints(address(0), RECEIVER);
        // #1618 r3 — an unarmed lane refuses authorization (fail-closed
        // per-destination ceiling). Type-max keeps the ceiling out of this
        // suite's way: it pins the ACCOUNTING core, including hostile
        // near-max draw magnitudes a finite ceiling would fence off.
        _repat().setRepatriationMaxPerAuth(CHAIN_ARB, type(uint256).max);
    }

    // ── Dark by default ─────────────────────────────────────────────────────

    function test_DarkByDefault_AuthorizeReverts() public {
        _seedAvail(1, 100 ether);
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().authorizeRepatriation(CHAIN_ARB, 1 ether);
    }

    // ── Authorize ───────────────────────────────────────────────────────────

    function test_Authorize_ChargesDrawAndShrinksAvailability() public {
        _seedAvail(1, 100 ether);
        assertEq(_avail(CHAIN_ARB), 100 ether, "fixture must be live");
        _arm();
        uint256 authId = _repat().authorizeRepatriation(CHAIN_ARB, 40 ether);
        assertEq(authId, 1);
        (uint256 debited, uint256 released) =
            _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(debited, 40 ether);
        assertEq(released, 0);
        assertEq(_avail(CHAIN_ARB), 60 ether, "avail nets the repat draw");
        (uint8 status, uint32 dst, , uint256 amount, uint256 shortfall) =
            _repat().getRepatriationAuthorization(authId);
        assertEq(status, 1);
        assertEq(dst, CHAIN_ARB);
        assertEq(amount, 40 ether);
        assertEq(shortfall, 0);
    }

    function test_Authorize_BoundsToLiveAvailability() public {
        _seedAvail(1, 100 ether);
        _arm();
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsAvailability.selector,
                100 ether + 1,
                100 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 100 ether + 1);
        // A second authorization is bounded by the ALREADY-NETTED figure.
        _repat().authorizeRepatriation(CHAIN_ARB, 70 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationExceedsAvailability.selector,
                31 ether,
                30 ether
            )
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 31 ether);
    }

    function test_Authorize_RejectsZeroAndSelfChain() public {
        _arm();
        vm.expectRevert(
            RepatriationFacet.RepatriationInvalidRequest.selector
        );
        _repat().authorizeRepatriation(CHAIN_ARB, 0);
        vm.expectRevert(
            RepatriationFacet.RepatriationInvalidRequest.selector
        );
        _repat().authorizeRepatriation(CHAIN_BASE, 1 ether);
    }

    // ── Return settlement ───────────────────────────────────────────────────

    function _authorized(uint256 amount) internal returns (uint256 authId) {
        _seedAvail(1, 100 ether);
        _arm();
        authId = _repat().authorizeRepatriation(CHAIN_ARB, amount);
    }

    function test_Return_SettlesExactMatch_CreditsBucketAsRelocation()
        public
    {
        uint256 authId = _authorized(40 ether);
        // The receiver forwarded the tokens before reporting (balance-delta
        // pattern) — model the delivery by minting to the Diamond.
        vpfi.mint(address(diamond), 40 ether);
        uint256 bucketBefore = _mut().getRecycleBucketRaw();
        vm.prank(RECEIVER);
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
        assertEq(
            _mut().getRecycleBucketRaw(),
            bucketBefore + 40 ether,
            "arrival credits the bucket"
        );
        (uint8 status, , , , uint256 shortfall) =
            _repat().getRepatriationAuthorization(authId);
        assertEq(status, 2);
        assertEq(shortfall, 0);
        // The draw STANDS — settlement never releases (the surplus left the
        // mirror; availability must not re-offer it).
        (uint256 debited, uint256 released) =
            _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(debited, 40 ether);
        assertEq(released, 0);
        assertEq(_avail(CHAIN_ARB), 60 ether);
    }

    function test_Return_ShortArrivalTracksShortfall() public {
        uint256 authId = _authorized(40 ether);
        vpfi.mint(address(diamond), 39 ether);
        vm.prank(RECEIVER);
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 39 ether
        );
        (uint8 status, , , , uint256 shortfall) =
            _repat().getRepatriationAuthorization(authId);
        assertEq(status, 2, "short arrival still settles");
        assertEq(shortfall, 1 ether, "gap recorded, never resized");
    }

    function test_Return_GateChecks() public {
        uint256 authId = _authorized(40 ether);
        vpfi.mint(address(diamond), 40 ether);
        // Not the receiver.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.OnlyRepatriationReceiver.selector,
                address(this)
            )
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
        // Wrong era.
        vm.prank(RECEIVER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationWrongEra.selector,
                address(0xdead)
            )
        );
        _repat().onRepatriationReturnReceived(
            authId, address(0xdead), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
        // Wrong source chain.
        vm.prank(RECEIVER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationWrongSourceChain.selector,
                uint32(10),
                CHAIN_ARB
            )
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), 10, address(vpfi), 40 ether, 40 ether
        );
        // Wrong token.
        vm.prank(RECEIVER);
        vm.expectRevert(
            RepatriationFacet.RepatriationDeliveryInvalid.selector
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(0xbeef),
            40 ether, 40 ether
        );
        // Declared amount must EXACT-MATCH the authorization.
        vm.prank(RECEIVER);
        vm.expectRevert(
            RepatriationFacet.RepatriationDeliveryInvalid.selector
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            39 ether, 39 ether
        );
        // Zero actual.
        vm.prank(RECEIVER);
        vm.expectRevert(
            RepatriationFacet.RepatriationDeliveryInvalid.selector
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi), 40 ether, 0
        );
    }

    function test_Return_DoubleSettleRejected() public {
        uint256 authId = _authorized(40 ether);
        vpfi.mint(address(diamond), 40 ether);
        vm.prank(RECEIVER);
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
        vm.prank(RECEIVER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationAuthNotPending.selector,
                authId,
                uint8(2)
            )
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
    }

    // ── Cancellation ACK — the only release path ────────────────────────────

    function test_CancelAck_ReleasesAndRestoresAvailability() public {
        uint256 authId = _authorized(40 ether);
        assertEq(_avail(CHAIN_ARB), 60 ether, "fixture must be live");
        vm.prank(RECEIVER);
        _repat().onRepatriationCancelAck(authId, address(diamond), CHAIN_ARB);
        (uint256 netDraw, uint256 lifetimeReleased) =
            _repat().getChainRepatriationDraw(CHAIN_ARB);
        assertEq(netDraw, 0, "release decrements the net draw in place");
        assertEq(lifetimeReleased, 40 ether, "lifetime observability grows");
        assertEq(_avail(CHAIN_ARB), 100 ether, "release restores avail");
        (uint8 status, , , , ) = _repat().getRepatriationAuthorization(authId);
        assertEq(status, 3);
        // A released authorization cannot be settled afterwards.
        vpfi.mint(address(diamond), 40 ether);
        vm.prank(RECEIVER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationAuthNotPending.selector,
                authId,
                uint8(3)
            )
        );
        _repat().onRepatriationReturnReceived(
            authId, address(diamond), CHAIN_ARB, address(vpfi),
            40 ether, 40 ether
        );
    }

    function test_CancelAck_NearMaxDrawDoesNotWedgeTheChain() public {
        // Codex #1608 r1 P2 regression: with a hostile near-max reported
        // cumulative, authorize ~everything, cancel it, then authorize
        // again. Under gross-cumulative release semantics the second
        // authorization overflowed the debited counter and wedged the chain
        // forever while availability said the capacity was back.
        uint256 huge = type(uint256).max - 1_000;
        _seedAvail(1, huge);
        _arm();
        uint256 bigId = _repat().authorizeRepatriation(CHAIN_ARB, huge);
        assertEq(_avail(CHAIN_ARB), 0, "fixture live: everything drawn");
        vm.prank(RECEIVER);
        _repat().onRepatriationCancelAck(bigId, address(diamond), CHAIN_ARB);
        assertEq(_avail(CHAIN_ARB), huge, "release restored the capacity");
        // The chain must remain authorizable — this is the wedge assert.
        uint256 nextId = _repat().authorizeRepatriation(CHAIN_ARB, 40 ether);
        (uint8 status, , , uint256 amount, ) =
            _repat().getRepatriationAuthorization(nextId);
        assertEq(status, 1);
        assertEq(amount, 40 ether);
    }

    function test_SetEndpoints_RejectsCodelessNonzero() public {
        address eoa = address(0xE0A0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.RepatriationEndpointNotContract.selector,
                eoa
            )
        );
        _repat().setRepatriationEndpoints(address(0), eoa);
        // Zero stays allowed — it re-darkens.
        _repat().setRepatriationEndpoints(address(0), address(0));
    }

    // ── Mirror instruction ingress ──────────────────────────────────────────

    function test_Instruction_CanonicalChainRejected() public {
        vm.prank(address(messenger));
        vm.expectRevert(
            RepatriationFacet.RepatriationWrongChainRole.selector
        );
        _repat().onRepatriationInstructionReceived(address(0xBA5E), 1, 5 ether);
    }

    function test_Instruction_DarkWithoutSenderConfigured() public {
        _rep().setIsCanonicalRewardChain(false);
        // Codex #1608 r1: an unconfigured mirror must REVERT (leaving the
        // CCIP packet failed-but-re-executable), never persist state
        // recorded while the deployment was supposed to be dark.
        vm.prank(address(messenger));
        vm.expectRevert(RepatriationFacet.RepatriationNotConfigured.selector);
        _repat().onRepatriationInstructionReceived(address(0xBA5E), 1, 5 ether);
    }

    function test_Instruction_MessengerGatedAndIdempotent() public {
        _rep().setIsCanonicalRewardChain(false);
        // Arm the mirror side: the sender satellite must exist and hold code.
        address senderSat = address(0x5E4D);
        vm.etch(senderSat, hex"01");
        _repat().setRepatriationEndpoints(senderSat, address(0));
        // Non-messenger caller rejected.
        vm.expectRevert(
            abi.encodeWithSelector(
                RepatriationFacet.OnlyRewardMessengerRepat.selector,
                address(this)
            )
        );
        _repat().onRepatriationInstructionReceived(address(0xBA5E), 1, 5 ether);
        // Messenger delivery records the pending instruction.
        vm.prank(address(messenger));
        _repat().onRepatriationInstructionReceived(address(0xBA5E), 1, 5 ether);
        // Re-delivery (CCIP re-execution) is a silent no-op — never a revert
        // (a revert would be re-executable into the same revert forever) and
        // never a state resurrection.
        vm.prank(address(messenger));
        _repat().onRepatriationInstructionReceived(address(0xBA5E), 1, 7 ether);
    }

    // ── The surplus-debit primitive (via the test-only Diamond wrapper) ─────

    function test_DebitSurplus_FundableBoundAndCounters() public {
        _mut().setRecycleBucketRaw(100 ether);
        _mut().setOutstandingCommitRaw(0, 30 ether);
        _mut().setRecycleKeeperBudgetRaw(20 ether);
        // Fixture is live: fundable = 100 − 30 − 20 = 50.
        vm.expectRevert(
            abi.encodeWithSelector(
                LibVpfiRecycle.RepatriationExceedsFundable.selector,
                50 ether + 1,
                50 ether
            )
        );
        _mut().debitRepatriationSurplusRaw(50 ether + 1);
        _mut().debitRepatriationSurplusRaw(50 ether);
        assertEq(
            _mut().getRecycleBucketRaw(),
            50 ether,
            "bucket drops by the debit"
        );
        (uint256 repatriatedOut, , , ) = _repat().getRepatriationPosition();
        assertEq(repatriatedOut, 50 ether, "outflow counter advances");
    }

    function test_DebitSurplus_FloorSurvivesRepatriation() public {
        // §3.6a constraint 2a: the derived credited floor must NOT drop when
        // the bucket is debited for repatriation — the outflow term keeps
        // repatriated value in the floor, and the seed-before-debit step
        // stamps the pre-debit cumulative on an unseeded Diamond.
        _mut().setRecycleBucketRaw(100 ether);
        _mut().setRecycleCreditedCumulativeRaw(0); // unseeded upgrade shape
        _mut().debitRepatriationSurplusRaw(60 ether);
        (uint256 creditedRaw, , bool seeded, ) =
            _agg().getRecycleCompositionPosition();
        assertTrue(seeded, "seed-before-debit stamps the seeded flag");
        assertEq(
            creditedRaw,
            100 ether,
            "the pre-debit cumulative was seeded before the bucket dropped"
        );
    }
}
