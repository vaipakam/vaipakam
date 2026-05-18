// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

import {
    VpfiPoolRateGovernor,
    ITokenPoolRateLimit
} from "../src/crosschain/VpfiPoolRateGovernor.sol";

/**
 * @dev Records the last `setChainRateLimiterConfig` it received — stands
 *      in for a CCIP `TokenPool` so the governor can be unit-tested
 *      without a live CCIP deployment.
 */
contract MockRateLimitPool is ITokenPoolRateLimit {
    uint64 public lastSelector;
    RateLimiter.Config public lastOutbound;
    RateLimiter.Config public lastInbound;
    uint256 public callCount;

    function setChainRateLimiterConfig(
        uint64 remoteChainSelector,
        RateLimiter.Config memory outboundConfig,
        RateLimiter.Config memory inboundConfig
    ) external override {
        lastSelector = remoteChainSelector;
        lastOutbound = outboundConfig;
        lastInbound = inboundConfig;
        ++callCount;
    }

    function getRateLimitAdmin() external pure override returns (address) {
        return address(0);
    }
}

/**
 * @title VpfiPoolRateGovernorTest
 * @notice T-068 Phase 2 — unit tests for the bounds-checked CCIP
 *         rate-limit admin. Verifies the ET-008 capacity/rate bounds, the
 *         "a lane limit can never be disabled" stance, owner-gating, and
 *         that an in-bounds call reaches the pool verbatim.
 */
contract VpfiPoolRateGovernorTest is Test {
    uint64 internal constant SEL = 5009297550715157269;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    VpfiPoolRateGovernor internal governor;
    MockRateLimitPool internal pool;

    function setUp() public {
        pool = new MockRateLimitPool();
        VpfiPoolRateGovernor impl = new VpfiPoolRateGovernor();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VpfiPoolRateGovernor.initialize, (owner, address(pool))
            )
        );
        governor = VpfiPoolRateGovernor(address(proxy));
    }

    /// @dev A valid config — the design's starting values (50k cap, ~6/s).
    function _cfg() internal pure returns (RateLimiter.Config memory) {
        return RateLimiter.Config({
            isEnabled: true,
            capacity: 50_000 ether,
            rate: 6 ether
        });
    }

    // ─── Happy path ─────────────────────────────────────────────────────────

    function test_SetLaneRateLimits_ForwardsToPool() public {
        RateLimiter.Config memory c = _cfg();
        vm.prank(owner);
        governor.setLaneRateLimits(SEL, c, c);

        assertEq(pool.callCount(), 1, "pool received one config call");
        assertEq(pool.lastSelector(), SEL, "selector forwarded");
        (bool en, uint128 cap, uint128 rate) = pool.lastOutbound();
        assertTrue(en, "enabled");
        assertEq(cap, 50_000 ether, "capacity forwarded");
        assertEq(rate, 6 ether, "rate forwarded");
    }

    function test_SetLaneRateLimits_AcceptsBoundEdges() public {
        RateLimiter.Config memory lo = RateLimiter.Config({
            isEnabled: true,
            capacity: governor.MIN_RATE_LIMIT_CAPACITY(),
            rate: governor.MIN_RATE_LIMIT_RATE()
        });
        RateLimiter.Config memory hi = RateLimiter.Config({
            isEnabled: true,
            capacity: governor.MAX_RATE_LIMIT_CAPACITY(),
            rate: governor.MAX_RATE_LIMIT_RATE()
        });
        vm.prank(owner);
        governor.setLaneRateLimits(SEL, lo, hi);
        assertEq(pool.callCount(), 1, "bound edges accepted");
    }

    // ─── Bounds + disable guard ─────────────────────────────────────────────

    function test_RevertWhen_Disabled() public {
        RateLimiter.Config memory off =
            RateLimiter.Config({isEnabled: false, capacity: 0, rate: 0});
        vm.prank(owner);
        vm.expectRevert(
            VpfiPoolRateGovernor.RateLimitDisableForbidden.selector
        );
        governor.setLaneRateLimits(SEL, off, _cfg());
    }

    function test_RevertWhen_CapacityTooLow() public {
        RateLimiter.Config memory c = _cfg();
        c.capacity = governor.MIN_RATE_LIMIT_CAPACITY() - 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiPoolRateGovernor.CapacityOutOfBounds.selector, c.capacity
            )
        );
        governor.setLaneRateLimits(SEL, c, _cfg());
    }

    function test_RevertWhen_CapacityTooHigh() public {
        RateLimiter.Config memory c = _cfg();
        c.capacity = governor.MAX_RATE_LIMIT_CAPACITY() + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiPoolRateGovernor.CapacityOutOfBounds.selector, c.capacity
            )
        );
        governor.setLaneRateLimits(SEL, c, _cfg());
    }

    function test_RevertWhen_RateTooLow() public {
        RateLimiter.Config memory c = _cfg();
        c.rate = governor.MIN_RATE_LIMIT_RATE() - 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiPoolRateGovernor.RateOutOfBounds.selector, c.rate
            )
        );
        governor.setLaneRateLimits(SEL, c, _cfg());
    }

    function test_RevertWhen_RateTooHigh() public {
        RateLimiter.Config memory c = _cfg();
        c.rate = governor.MAX_RATE_LIMIT_RATE() + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiPoolRateGovernor.RateOutOfBounds.selector, c.rate
            )
        );
        governor.setLaneRateLimits(SEL, c, _cfg());
    }

    /// @dev The inbound config is validated too — a bad inbound is caught
    ///      even when outbound is fine.
    function test_RevertWhen_InboundOutOfBounds() public {
        RateLimiter.Config memory bad = _cfg();
        bad.rate = governor.MAX_RATE_LIMIT_RATE() + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VpfiPoolRateGovernor.RateOutOfBounds.selector, bad.rate
            )
        );
        governor.setLaneRateLimits(SEL, _cfg(), bad);
    }

    // ─── Access control ─────────────────────────────────────────────────────

    function test_RevertWhen_NotOwnerSetsLimits() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        governor.setLaneRateLimits(SEL, _cfg(), _cfg());
    }

    function test_SetPool_OnlyOwner() public {
        address newPool = makeAddr("newPool");
        vm.prank(owner);
        governor.setPool(newPool);
        assertEq(governor.pool(), newPool, "pool rotated");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        governor.setPool(address(pool));
    }

    function test_Initialize_RevertWhen_CalledTwice() public {
        vm.expectRevert();
        governor.initialize(owner, address(pool));
    }
}
