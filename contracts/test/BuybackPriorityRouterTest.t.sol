// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibTreasuryBuyback} from "../src/libraries/LibTreasuryBuyback.sol";
import {LibBuybackOrderValidation} from "../src/libraries/LibBuybackOrderValidation.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockEip712Lop} from "./mocks/MockEip712Lop.sol";
import {LibOneTxBuybackFill} from "./helpers/LibOneTxBuybackFill.sol";

contract _Stub {}
contract _MockLOP is MockEip712Lop {
    // #2449 -- a declared domain (ERC-5267), as the Diamond reads it.
    function _lopName() internal pure override returns (string memory) { return "vaipakam.test.lop.priority-router"; }
    function _lopVersion() internal pure override returns (string memory) { return "1"; }
}

/// @title BuybackPriorityRouterTest
/// @notice T-087 Sub 3 add-on #472 — priority cascade tests.
///         rewardEmissionsBudget → keeperRewardBudget. #687-C removed the
///         third staking-pool overflow tier; any remainder past both top-up
///         targets now reverts (BuybackOverflowNotAllowed) instead of
///         stranding VPFI in an unspendable budget.
contract BuybackPriorityRouterTest is SetupTest {
    ERC20Mock internal usdc;
    ERC20Mock internal vpfi;
    address internal receiver;
    _MockLOP internal lopContract;
    address internal lop;
    bytes32 internal lopDomain;

    uint96 internal constant AMOUNT_IN = 1_000e6;

    function setUp() public {
        setupHelper();
        vm.warp(1_000_000);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        receiver = address(new _Stub());
        lopContract = new _MockLOP();
        lop = address(lopContract);
        lopDomain = lopContract.DOMAIN_SEPARATOR();

        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(lop);
        TreasuryFacet(address(diamond)).setBuybackRemittanceReceiver(receiver);
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _d() internal view returns (IntentDispatchFacet) {
        return IntentDispatchFacet(address(diamond));
    }

    function _seed() internal {
        usdc.mint(address(diamond), AMOUNT_IN);
        vm.prank(receiver);
        _t().absorbRemittance(address(usdc), AMOUNT_IN, 11_155_111);
    }

    function _build(uint64 expiresAt, uint128 minVpfiOut, uint96 saltUpper)
        internal
        view
        returns (
            LibBuybackOrderValidation.BuybackOrderTemplate memory tpl,
            bytes32 orderHash
        )
    {
        bytes memory ext = LibBuybackOrderValidation.canonicalBuybackExtension(address(diamond));
        // Salt low-160 bits MUST equal the extension hash (LOP v4
        // extension-binding rule); the upper 96 bits are free to vary
        // for uniqueness across multiple commits in one test.
        uint256 salt = (uint256(saltUpper) << 160)
            | uint256(uint160(uint256(keccak256(ext))));
        uint256 mt = LibBuybackOrderValidation.HAS_EXTENSION_FLAG
            | LibBuybackOrderValidation.PRE_INTERACTION_CALL_FLAG
            | LibBuybackOrderValidation.POST_INTERACTION_CALL_FLAG
            | LibBuybackOrderValidation.ALLOW_MULTIPLE_FILLS_FLAG
            | (uint256(expiresAt) << LibBuybackOrderValidation.EXPIRATION_OFFSET);
        tpl = LibBuybackOrderValidation.BuybackOrderTemplate({
            salt: salt,
            maker: address(diamond),
            receiver: address(diamond),
            makerAsset: address(usdc),
            takerAsset: address(vpfi),
            makingAmount: AMOUNT_IN,
            takingAmount: minVpfiOut,
            makerTraits: mt,
            extension: ext
        });
        bytes32 structHash = keccak256(abi.encode(
            LibBuybackOrderValidation.LIMIT_ORDER_TYPEHASH,
            tpl.salt,
            uint256(uint160(tpl.maker)),
            uint256(uint160(tpl.receiver)),
            uint256(uint160(tpl.makerAsset)),
            uint256(uint160(tpl.takerAsset)),
            tpl.makingAmount,
            tpl.takingAmount,
            tpl.makerTraits
        ));
        orderHash = keccak256(
            abi.encodePacked(bytes2(0x1901), lopDomain, structHash)
        );
    }

    uint96 internal _saltNonce;

    function _commitAndFill(uint256 delivered) internal returns (bytes32) {
        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 1, _saltNonce);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, 1, expiresAt
        );

        vpfi.mint(lop, delivered);
        LibOneTxBuybackFill.fill(
            lop, address(diamond), orderHash, AMOUNT_IN, address(usdc), AMOUNT_IN, address(vpfi), delivered
        );
        return orderHash;
    }

    /// @dev #687-C — like `_commitAndFill` but asserts the final
    ///      `postInteraction` reverts `BuybackOverflowNotAllowed` because the
    ///      delivered VPFI exceeds the rewards + keeper top-up gaps (the former
    ///      staking-pool overflow sink is gone).
    function _commitAndFillExpectOverflow(uint256 delivered) internal {
        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 1, _saltNonce);

        _t().commitBuybackIntentValidated(
            orderHash, tpl, AMOUNT_IN, 1, expiresAt
        );

        vpfi.mint(lop, delivered);
        // Selector-only match — the error carries (delivered, toRewards,
        // toKeepers, overflow) args that vary per test config.
        vm.expectPartialRevert(LibTreasuryBuyback.BuybackOverflowNotAllowed.selector);
        LibOneTxBuybackFill.fill(
            lop, address(diamond), orderHash, AMOUNT_IN, address(usdc), AMOUNT_IN, address(vpfi), delivered
        );
    }

    // ─── #908: zero targets → a commit with a floor is refused ────

    function test_Headroom_ZeroTargets_CommitRefused() public {
        // Both top-up targets default to 0 (dormant Phase-1 config). Nothing
        // could absorb the order's guaranteed VPFI, so every fill would
        // revert BuybackOverflowNotAllowed and the source tokens would sit
        // reserved until expiry. #908 refuses the commit up front instead.
        _seed();
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 1, 1);
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 1, 0)
        );
        _t().commitBuybackIntentValidated(orderHash, tpl, AMOUNT_IN, 1, expiresAt);

        assertEq(_t().getRewardEmissionsBudget(), 0, "no rewards");
        assertEq(_t().getKeeperRewardBudget(), 0, "no keepers");
    }

    // ─── Both targets filled exactly → no overflow ────────────────

    function test_Routing_BothTargetsFillExactly() public {
        uint256 rewardsTarget = 30e18;
        uint256 keepersTarget = 20e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        // Deliver exactly the sum of the two gaps — no remainder.
        _commitAndFill(rewardsTarget + keepersTarget);

        assertEq(_t().getRewardEmissionsBudget(), rewardsTarget, "rewards full");
        assertEq(_t().getKeeperRewardBudget(), keepersTarget, "keepers full");
    }

    // ─── Overflow past both targets → revert ──────────────────────

    function test_Routing_OverflowPastBothTargets_Reverts() public {
        _t().setRewardEmissionsTopUpTarget(30e18);
        _t().setKeeperRewardTopUpTarget(20e18);

        // 50 fills both gaps; the extra 1 has nowhere to go → revert.
        _commitAndFillExpectOverflow(51e18);
    }

    // ─── Rewards step partially exhausts the delivery ─────────────

    function test_Routing_PartialCascade_RewardsConsumesAll() public {
        uint256 rewardsTarget = 500e18;
        uint256 keepersTarget = 100e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        uint256 delivered = 200e18; // less than rewards target → no overflow

        _commitAndFill(delivered);

        assertEq(_t().getRewardEmissionsBudget(), delivered, "all to rewards");
        assertEq(_t().getKeeperRewardBudget(), 0, "no keepers");
    }

    // ─── Rewards at target → cascades to keepers (no overflow) ────

    function test_Routing_RewardsAtTarget_SkipsToKeepers() public {
        uint256 rewardsTarget = 30e18;
        uint256 keepersTarget = 20e18;
        _t().setRewardEmissionsTopUpTarget(rewardsTarget);
        _t().setKeeperRewardTopUpTarget(keepersTarget);

        // First fill tops up rewards exactly; keepers still empty.
        _commitAndFill(rewardsTarget);
        assertEq(_t().getRewardEmissionsBudget(), rewardsTarget, "rewards full");
        assertEq(_t().getKeeperRewardBudget(), 0, "keepers still empty");

        // Second fill — rewards at target → all to keepers (exact gap).
        _commitAndFill(keepersTarget);
        assertEq(
            _t().getRewardEmissionsBudget(), rewardsTarget, "rewards unchanged"
        );
        assertEq(_t().getKeeperRewardBudget(), keepersTarget, "keepers full");
    }

    // ─── Sum invariant (rewards + keepers == delivered) ───────────

    function test_Routing_SumInvariant() public {
        _t().setRewardEmissionsTopUpTarget(10e18);
        _t().setKeeperRewardTopUpTarget(5e18);
        uint256 delivered = 15e18; // exactly fills both gaps

        _commitAndFill(delivered);

        uint256 toRewards = _t().getRewardEmissionsBudget();
        uint256 toKeepers = _t().getKeeperRewardBudget();
        assertEq(toRewards + toKeepers, delivered, "sum invariant");
    }

    // ─── Setter access control ────────────────────────────────────

    function test_SetRewardEmissionsTopUpTarget_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setRewardEmissionsTopUpTarget(100e18);
    }

    function test_SetKeeperRewardTopUpTarget_RevertWhen_NotAdmin() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        _t().setKeeperRewardTopUpTarget(100e18);
    }

    function test_SetRewardEmissionsTopUpTarget_ZeroDisables() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        _t().setRewardEmissionsTopUpTarget(0);
        assertEq(_t().getRewardEmissionsTopUpTarget(), 0);
    }

    // ─── #908 — headroom held for pending orders' VPFI floors ─────

    function _commitFloor(uint128 minVpfiOut) internal returns (bytes32 orderHash) {
        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        LibBuybackOrderValidation.BuybackOrderTemplate memory tpl;
        (tpl, orderHash) = _build(expiresAt, minVpfiOut, _saltNonce);
        _t().commitBuybackIntentValidated(orderHash, tpl, AMOUNT_IN, minVpfiOut, expiresAt);
    }

    function _fillPart(bytes32 orderHash, uint256 consumed, uint256 delivered) internal {
        vpfi.mint(lop, delivered);
        LibOneTxBuybackFill.fill(
            lop, address(diamond), orderHash, consumed, address(usdc), consumed, address(vpfi), delivered
        );
    }

    function _assertHeadroom(uint256 room, uint256 held, string memory tag) internal view {
        (uint256 r, uint256 h) = _t().getBuybackTopUpHeadroom();
        assertEq(r, room, string.concat(tag, ": headroom"));
        assertEq(h, held, string.concat(tag, ": held"));
    }

    function test_Headroom_SecondCommitMustFitBesideFirstFloor() public {
        _t().setRewardEmissionsTopUpTarget(50e18);
        _commitFloor(30e18);
        _assertHeadroom(50e18, 30e18, "after A");

        _seed();
        _saltNonce++;
        uint64 expiresAt = uint64(block.timestamp + 30 minutes);
        (LibBuybackOrderValidation.BuybackOrderTemplate memory tpl, bytes32 orderHash) =
            _build(expiresAt, 30e18, _saltNonce);
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 30e18, 20e18)
        );
        _t().commitBuybackIntentValidated(orderHash, tpl, AMOUNT_IN, 30e18, expiresAt);

        // A floor that fits in the free 20 is accepted.
        _commitFloor(20e18);
        _assertHeadroom(50e18, 50e18, "after B");
    }

    function test_Headroom_FillCannotTakeAnotherOrdersFloor() public {
        _t().setRewardEmissionsTopUpTarget(50e18);
        bytes32 a = _commitFloor(30e18);
        bytes32 b = _commitFloor(20e18);

        // A delivers 1 VPFI over its own floor: that extra would come out of
        // the 20 held for B, so the fill is refused (room 19 < held 20).
        vpfi.mint(lop, 31e18);
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 20e18, 19e18)
        );
        LibOneTxBuybackFill.fill(
            lop, address(diamond), a, AMOUNT_IN, address(usdc), AMOUNT_IN, address(vpfi), 31e18
        );

        // A at exactly its floor settles, and B still fits.
        _fillPart(a, AMOUNT_IN, 30e18);
        _assertHeadroom(20e18, 20e18, "after A");
        _fillPart(b, AMOUNT_IN, 20e18);
        _assertHeadroom(0, 0, "after B");
        assertEq(_t().getRewardEmissionsBudget(), 50e18, "both delivered");
    }

    function test_Headroom_FillAboveFloorUsesFreeRoom() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        bytes32 a = _commitFloor(30e18);
        // 60 delivered against a 30 floor: the extra 30 fits in the free 70.
        _fillPart(a, AMOUNT_IN, 60e18);
        _assertHeadroom(40e18, 0, "after A");
    }

    function test_Headroom_PartialFillsReleaseOnlyTheirShare() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        bytes32 a = _commitFloor(100e18);
        uint96 part = (AMOUNT_IN * 30) / 100;
        _fillPart(a, part, 30e18);
        _assertHeadroom(70e18, 70e18, "after 30%");
        _fillPart(a, AMOUNT_IN - part, 70e18);
        _assertHeadroom(0, 0, "after the rest");
    }

    function test_Headroom_ExpiryReleasesRemainingFloor() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        bytes32 a = _commitFloor(100e18);
        uint96 part = (AMOUNT_IN * 30) / 100;
        _fillPart(a, part, 30e18);
        _assertHeadroom(70e18, 70e18, "after 30%");

        vm.warp(block.timestamp + 30 minutes + 1);
        _t().expireBuybackIntent(a);
        _assertHeadroom(70e18, 0, "after expiry");
    }

    function test_Headroom_TargetSettersCannotStrandAFloor() public {
        _t().setRewardEmissionsTopUpTarget(30e18);
        _t().setKeeperRewardTopUpTarget(20e18);
        _commitFloor(40e18);

        // Lowering the rewards target to 10 leaves 30 of room for 40 held.
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 40e18, 30e18)
        );
        _t().setRewardEmissionsTopUpTarget(10e18);
        // Same for the keeper target.
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 40e18, 30e18)
        );
        _t().setKeeperRewardTopUpTarget(0);

        // A change that keeps the floor covered goes through, either way.
        _t().setRewardEmissionsTopUpTarget(40e18);
        _t().setKeeperRewardTopUpTarget(0);
        _assertHeadroom(40e18, 40e18, "rebalanced");
    }

    // ─── #908 — an order pending across an in-place refresh ───────
    //
    // A Diamond refreshed in place with buyback orders pending carries those
    // orders with no floor recorded: the aggregate and the per-order record
    // are new storage and start at zero. Each order releases only what it
    // recorded, so such an order releases nothing and cannot underflow the
    // aggregate. The tests build that state by erasing a fresh order's two
    // records, which is exactly what the pre-#908 code left behind.

    /// @dev `LibVaipakam.Storage` slot of `buybackVpfiFloorReserved`, from the
    ///      storage-layout golden file; `buybackVpfiFloorHeld` follows it.
    uint256 private constant FLOOR_RESERVED_SLOT = 700;

    function _eraseFloorRecords(bytes32 orderHash) internal {
        bytes32 base = LibVaipakam.VANGKI_STORAGE_POSITION;
        bytes32 reservedSlot = bytes32(uint256(base) + FLOOR_RESERVED_SLOT);
        bytes32 heldSlot = keccak256(abi.encode(orderHash, uint256(base) + FLOOR_RESERVED_SLOT + 1));
        // The slots are the right ones only if they hold what the order
        // recorded: guard the layout assumption before erasing.
        (, uint256 heldBefore) = _t().getBuybackTopUpHeadroom();
        assertEq(uint256(vm.load(address(diamond), reservedSlot)), heldBefore, "aggregate slot");
        assertGt(uint256(vm.load(address(diamond), heldSlot)), 0, "per-order slot");
        vm.store(address(diamond), reservedSlot, bytes32(0));
        vm.store(address(diamond), heldSlot, bytes32(0));
    }

    function test_Headroom_LegacyOrderExpiresWithoutUnderflow() public {
        _t().setRewardEmissionsTopUpTarget(100e18);
        bytes32 legacy = _commitFloor(40e18);
        _eraseFloorRecords(legacy);
        _assertHeadroom(100e18, 0, "legacy holds nothing");

        // An order committed after the refresh reserves as usual.
        bytes32 fresh = _commitFloor(30e18);
        _assertHeadroom(100e18, 30e18, "fresh holds its floor");

        // The legacy order expires: it releases nothing, the fresh order's
        // reservation stays whole, and the source tokens come back.
        vm.warp(block.timestamp + 30 minutes + 1);
        _t().expireBuybackIntent(legacy);
        _assertHeadroom(100e18, 30e18, "after legacy expiry");
        _t().expireBuybackIntent(fresh);
        _assertHeadroom(100e18, 0, "after fresh expiry");
    }

    function test_Headroom_LegacyOrderFillsFromFreeRoomOnly() public {
        _t().setRewardEmissionsTopUpTarget(50e18);
        bytes32 legacy = _commitFloor(30e18);
        _eraseFloorRecords(legacy);
        bytes32 fresh = _commitFloor(30e18);
        _assertHeadroom(50e18, 30e18, "fresh holds its floor");

        // The legacy order held no room, so all it delivers must come from
        // the free 20: its 30 would take the fresh order's floor.
        vpfi.mint(lop, 30e18);
        vm.expectRevert(
            abi.encodeWithSelector(LibTreasuryBuyback.BuybackHeadroomShort.selector, 30e18, 20e18)
        );
        LibOneTxBuybackFill.fill(
            lop, address(diamond), legacy, AMOUNT_IN, address(usdc), AMOUNT_IN, address(vpfi), 30e18
        );

        // Once the fresh order settles, the legacy one settles too.
        _fillPart(fresh, AMOUNT_IN, 30e18);
        _t().setRewardEmissionsTopUpTarget(80e18);
        _fillPart(legacy, AMOUNT_IN, 30e18);
        _assertHeadroom(20e18, 0, "both settled");
    }

    // #687-C: test_Routing_StakingPoolCap_WidensWithBuybackBudget removed with
    // the staking pool + its buyback-overflow accumulator (5% yield gone).
}
