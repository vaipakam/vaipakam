// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {MirrorTierReceiverFacet} from "../src/facets/MirrorTierReceiverFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title MirrorTierReceiverFacetTest
/// @notice T-087 Sub 2.C — exercises the mirror-side Diamond ingress for
///         the cross-chain tier push. The facet owns the
///         `userTierCache[user]` writer + the `currentTierTableVersion`
///         raise; this suite tests the trust gating + monotonic-order
///         invariants + the happy-path cache write.
contract MirrorTierReceiverFacetTest is SetupTest {
    address internal user;
    address internal messengerAddr;

    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant WRONG_CHAIN_ID = 1; // mainnet, not Base

    function setUp() public {
        setupHelper();
        user = makeAddr("user");
        messengerAddr = makeAddr("messenger");

        // Wire the rewardMessenger + baseChainId via the production
        // setters on `RewardReporterFacet`. They write to the diamond
        // storage (via delegatecall). Writing through
        // `LibVaipakam.storageSlot()` from the test contract would hit
        // the test contract's OWN storage, not the diamond's.
        RewardReporterFacet(address(diamond)).setRewardMessenger(messengerAddr);
        RewardReporterFacet(address(diamond)).setBaseChainId(
            uint32(BASE_CHAIN_ID)
        );
    }

    function _call() internal view returns (MirrorTierReceiverFacet) {
        return MirrorTierReceiverFacet(address(diamond));
    }

    // ─── Happy-path cache write ──────────────────────────────────────

    function test_OnTierUpdateReceived_WritesCacheAndEmits() public {
        vm.expectEmit(true, true, false, true, address(diamond));
        emit MirrorTierReceiverFacet.MirrorTierCacheWritten(
            user, BASE_CHAIN_ID, 2, 1500, 1, 3
        );

        vm.prank(messengerAddr);
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID,
            user,
            uint8(2),
            uint16(1500),
            uint40(123),
            uint256(1),
            type(uint40).max,
            uint16(3)
        );

        LibVaipakam.CachedTier memory cache = _call().getUserTierCache(user);
        assertEq(cache.effectiveTier, 2, "tier written");
        assertEq(cache.effectiveBps, 1500, "bps written");
        assertEq(cache.lastNonce, 1, "nonce written");
        assertEq(cache.tierExpirySec, type(uint40).max, "expiry sentinel preserved");
        assertEq(cache.tierTableVersion, 3, "version written");
        // `lastUpdateSec` is the LOCAL block.timestamp at the write (so
        // the `cfgMirrorTierMaxAgeSec` backstop is local-clock based,
        // not Base's clock). Verify it's `block.timestamp` of this test.
        assertEq(cache.lastUpdateSec, uint40(block.timestamp), "localSec stamped");
    }

    // ─── Trust gates ──────────────────────────────────────────────────

    function test_OnTierUpdateReceived_RaisesVersionOnNewerStamp() public {
        // Codex Sub 2.C round-1 P2 — if the TierUpdated arrives BEFORE
        // its companion VersionBumped (or the VersionBumped is missed),
        // the per-user push itself must raise the mirror's
        // `currentTierTableVersion` so the Sub 1.C freshness gate
        // accepts the cache entry. Otherwise the cache write is dead
        // letter until a separate bump lands.
        assertEq(_call().getCurrentTierTableVersion(), 0, "seeded clean");

        vm.prank(messengerAddr);
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 2, 1500, 0, 1, type(uint40).max, 5
        );

        assertEq(
            _call().getCurrentTierTableVersion(),
            5,
            "mirror version raised by the push's stamp"
        );

        LibVaipakam.CachedTier memory cache = _call().getUserTierCache(user);
        assertEq(cache.tierTableVersion, 5, "cache version matches");
    }

    function test_OnTierUpdateReceived_DoesNotLowerVersion() public {
        // Seed the mirror at version 7 via a standalone bump.
        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 7);
        assertEq(_call().getCurrentTierTableVersion(), 7, "seeded to 7");

        // An older TierUpdated push (version 3) must not lower the
        // current version (only raise — monotonic semantics).
        vm.prank(messengerAddr);
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, 1, type(uint40).max, 3
        );

        assertEq(_call().getCurrentTierTableVersion(), 7, "stayed at 7");
    }

    function test_OnTierUpdateReceived_RevertWhen_NotMessenger() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.NotMessenger.selector,
                address(this)
            )
        );
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, 1, 0, 1
        );
    }

    function test_OnTierUpdateReceived_RevertWhen_WrongSourceChain() public {
        vm.prank(messengerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.WrongSourceChain.selector,
                WRONG_CHAIN_ID,
                uint32(BASE_CHAIN_ID)
            )
        );
        _call().onTierUpdateReceived(
            WRONG_CHAIN_ID, user, 1, 1000, 0, 1, 0, 1
        );
    }

    // ─── Monotonic ordering ──────────────────────────────────────────

    function test_OnTierUpdateReceived_RevertWhen_StaleNonce() public {
        // First push: nonce 5.
        vm.prank(messengerAddr);
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, 5, type(uint40).max, 1
        );

        // Replay attempt: nonce 5 again.
        vm.prank(messengerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.StaleNonce.selector,
                uint64(5),
                uint64(5)
            )
        );
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, 5, type(uint40).max, 1
        );
    }

    function test_OnTierUpdateReceived_RevertWhen_OutOfOrderNonce() public {
        // First push: nonce 10.
        vm.prank(messengerAddr);
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 2, 1500, 0, 10, type(uint40).max, 1
        );

        // Out-of-order delivery: nonce 9 arrives after 10.
        vm.prank(messengerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.StaleNonce.selector,
                uint64(9),
                uint64(10)
            )
        );
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, 9, type(uint40).max, 1
        );
    }

    function test_OnTierUpdateReceived_RevertWhen_NonceOverflow() public {
        uint256 oversized = uint256(type(uint64).max) + 1;
        vm.prank(messengerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.NonceOverflow.selector, oversized
            )
        );
        _call().onTierUpdateReceived(
            BASE_CHAIN_ID, user, 1, 1000, 0, oversized, type(uint40).max, 1
        );
    }

    // ─── VersionBumped ───────────────────────────────────────────────

    function test_OnVersionBumpedReceived_RaisesVersionAndEmits() public {
        // Seed via a bump.
        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 3);

        vm.expectEmit(true, false, false, true, address(diamond));
        emit MirrorTierReceiverFacet.MirrorTierTableVersionBumped(
            BASE_CHAIN_ID, 3, 7
        );

        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 7);

        assertEq(_call().getCurrentTierTableVersion(), 7, "version raised");
    }

    function test_OnVersionBumpedReceived_BenignNoOp_OnNotHigher() public {
        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 10);
        assertEq(_call().getCurrentTierTableVersion(), 10, "seeded to 10");

        // No event expected — silent no-op.
        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 10);
        assertEq(_call().getCurrentTierTableVersion(), 10, "unchanged on equal");

        vm.prank(messengerAddr);
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 5);
        assertEq(_call().getCurrentTierTableVersion(), 10, "unchanged on lower");
    }

    function test_OnVersionBumpedReceived_RevertWhen_NotMessenger() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.NotMessenger.selector,
                address(this)
            )
        );
        _call().onVersionBumpedReceived(BASE_CHAIN_ID, 1);
    }

    function test_OnVersionBumpedReceived_RevertWhen_WrongSourceChain() public {
        vm.prank(messengerAddr);
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorTierReceiverFacet.WrongSourceChain.selector,
                WRONG_CHAIN_ID,
                uint32(BASE_CHAIN_ID)
            )
        );
        _call().onVersionBumpedReceived(WRONG_CHAIN_ID, 1);
    }

}
