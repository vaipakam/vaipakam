// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIBuyAdapter} from "../../src/token/VPFIBuyAdapter.sol";

/// @dev Minimal LZ endpoint stub — same shape as the one in the
///      payment-token suite. Sufficient because rate-limit setters /
///      getters never invoke the endpoint.
contract MockLZEndpointForRateLimits {
    function eid() external pure returns (uint32) {
        return 40245;
    }
    function setDelegate(address) external {}
}

/**
 * @title VPFIBuyAdapterRateLimitsTest
 * @notice Covers the {VPFIBuyAdapter.getRateLimits} convenience
 *         tuple-getter and the {setRateLimits} round-trip it pairs
 *         with. Pinned to the May-2026 rehearsal follow-up where the
 *         deploy-script's post-deploy health check (deploy-chain.sh
 *         step `[5d]`) and the mainnet `--phase verify` step both
 *         needed an external getter to assert "the rate limits are
 *         in their finite (non-uint256.max) post-deploy state."
 *
 *         Without that getter, a partial deploy where {setRateLimits}
 *         silently failed (RPC drop, hook revert) would leave the
 *         adapter in its initialize-default unlimited state and
 *         operators wouldn't notice — catastrophic on a canonical
 *         BuyAdapter where unlimited spend equals unlimited mint.
 *
 *         The matching contract surface is at
 *         {VPFIBuyAdapter.getRateLimits}.
 */
contract VPFIBuyAdapterRateLimitsTest is Test {
    VPFIBuyAdapter internal impl;
    MockLZEndpointForRateLimits internal lzEndpoint;

    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xCAFE);
    address internal constant NON_OWNER = address(0xBEEF);
    uint32 internal constant RECEIVER_EID = 40245;
    uint64 internal constant REFUND_TIMEOUT = 900;

    VPFIBuyAdapter internal adapter;

    function setUp() public {
        lzEndpoint = new MockLZEndpointForRateLimits();
        impl = new VPFIBuyAdapter(address(lzEndpoint));

        // Native-gas mode (paymentToken == address(0)) is the cheapest
        // proxy init path for fixture purposes — the rate-limit logic
        // is independent of payment mode.
        bytes memory initData = abi.encodeCall(
            VPFIBuyAdapter.initialize,
            (
                OWNER,
                RECEIVER_EID,
                TREASURY,
                address(0),
                bytes(""),
                REFUND_TIMEOUT
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        adapter = VPFIBuyAdapter(payable(address(proxy)));
    }

    /// @notice Initialize leaves both caps at `uint256.max`. A health
    ///         check that hard-fails on this state is what the deploy
    ///         script needs to gate mainnet readiness.
    function test_getRateLimits_DefaultsToUintMax() public view {
        (uint256 perRequest, uint256 daily) = adapter.getRateLimits();
        assertEq(perRequest, type(uint256).max, "perRequestCap default");
        assertEq(daily, type(uint256).max, "dailyCap default");
    }

    /// @notice After {setRateLimits} lands, {getRateLimits} reflects the
    ///         new bounds. Asymmetric values prove the order of return
    ///         tuples matches the setter parameter order.
    function test_getRateLimits_ReflectsSetRateLimits() public {
        vm.prank(OWNER);
        adapter.setRateLimits(50_000e18, 500_000e18);

        (uint256 perRequest, uint256 daily) = adapter.getRateLimits();
        assertEq(perRequest, 50_000e18, "perRequestCap after set");
        assertEq(daily, 500_000e18, "dailyCap after set");
    }

    /// @notice {getRateLimits} stays in lockstep with the individual
    ///         field-level public getters auto-generated from the
    ///         storage declarations. Guards against an accidental
    ///         storage-rename or visibility regression that would
    ///         desync the two surfaces.
    function test_getRateLimits_AgreesWithFieldGetters() public {
        vm.prank(OWNER);
        adapter.setRateLimits(123e18, 456e18);

        (uint256 perRequestTuple, uint256 dailyTuple) =
            adapter.getRateLimits();
        assertEq(perRequestTuple, adapter.perRequestCap());
        assertEq(dailyTuple, adapter.dailyCap());
    }
}
