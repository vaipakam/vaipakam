// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title OracleAdminFacetTest
/// @notice Owner-only coverage for the four oracle-config setters exposed by
///         OracleAdminFacet. Each setter delegates to a LibVaipakam helper
///         that gates on `LibDiamond.enforceIsContractOwner()` before writing
///         one storage slot; no external getter is provided so round-trip is
///         verified through the public {OracleFacet} surface:
///
///           - registry / denominator writes → {getAssetPrice} NoPriceFeed
///             branch when either is zero
///           - uniswap factory write         → {checkLiquidity} Illiquid
///             fail-closed branch when factory is zero
///           - weth contract write           → asset/WETH pool discovery
///             for every non-WETH asset in {checkLiquidity}
///           - eth/usd feed write             → WETH pricing + depth→USD
///             conversion in {checkLiquidity}
///
///         SetupTest cuts {OracleFacet} but not {OracleAdminFacet}. This test
///         extends the shared setup by diamond-cutting the admin facet on top
///         so the setters are reachable through the diamond proxy.
contract OracleAdminFacetTest is SetupTest {
    function setUp() public {
        // #229 — OracleAdminFacet now cut by `SetupTest.setupHelper()`
        // (all 34 selectors, mirroring DeployDiamond). The prior local
        // 11-selector subset cut would double-cut and revert. Dropped.
        setupHelper();
    }

    // ─── Non-owner guard coverage ─────────────────────────────────────────────

    function testSetChainlinkRegistryRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(address(0xBEEF));
    }

    function testSetUsdChainlinkDenominatorRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(address(0xBEEF));
    }

    function testSetWethContractRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setWethContract(address(0xBEEF));
    }

    function testSetEthUsdFeedRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(0xBEEF));
    }

    function testSetStableTokenFeedRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setStableTokenFeed("EUR", address(0xBEEF));
    }

    function testSetUniswapV3FactoryRevertsForNonOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(address(0xBEEF));
    }

    // ─── Owner-path side effects ──────────────────────────────────────────────

    /// @dev Zero registry collapses {getAssetPrice} to NoPriceFeed. SetupTest
    ///      never calls {setChainlinkRegistry}, so the slot already starts at
    ///      zero — but invoking the setter still has to succeed for the owner,
    ///      and the subsequent revert confirms the slot value after the write.
    function testOwnerCanZeroChainlinkRegistry() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setChainlinkRegistry(address(0));
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);
    }

    /// @dev Zero denominator collapses {getAssetPrice} to NoPriceFeed on the
    ///      second half of the guard (`usdDenominator == address(0)`).
    function testOwnerCanZeroUsdDenominator() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setUsdChainlinkDenominator(address(0));
        vm.expectRevert(OracleFacet.NoPriceFeed.selector);
        OracleFacet(address(diamond)).getAssetPrice(mockERC20);
    }

    /// @dev Zero WETH address fail-closes {checkLiquidity} to Illiquid —
    ///      there is no quote asset so no asset/WETH pool can be derived.
    function testOwnerCanZeroWethContract() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setWethContract(address(0));
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidity(mockERC20);
        assertEq(
            uint8(status),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "weth=0 fail-closes to Illiquid"
        );
    }

    /// @dev Zero ETH/USD feed fail-closes {checkLiquidity} to Illiquid —
    ///      no way to price WETH or convert depth to USD.
    function testOwnerCanZeroEthUsdFeed() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setEthUsdFeed(address(0));
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidity(mockERC20);
        assertEq(
            uint8(status),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "ethNumeraireFeed=0 fail-closes to Illiquid"
        );
    }

    /// @dev Zero factory collapses {checkLiquidity} to Illiquid via the
    ///      fail-closed factory guard.
    function testOwnerCanZeroUniswapV3Factory() public {
        vm.clearMockedCalls();
        OracleAdminFacet(address(diamond)).setUniswapV3Factory(address(0));
        LibVaipakam.LiquidityStatus status =
            OracleFacet(address(diamond)).checkLiquidity(mockERC20);
        assertEq(
            uint8(status),
            uint8(LibVaipakam.LiquidityStatus.Illiquid),
            "factory=0 fail-closes to Illiquid"
        );
    }

    // ─── Post-audit bounds (ConfigKnobBoundsAudit-2026-05-14) ─────────
    //
    // Gap #2 — `setStableTokenFeed.symbol` is now capped at
    // MAX_STABLE_SYMBOL_LEN (10 bytes) to bound storage / observability
    // noise.
    //
    // Gap #3 — `setTierReferenceAssets.assets` is now capped at
    // MAX_TIER_REFERENCE_ASSETS (20) to bound the per-peer iteration
    // in the permissionless `refreshTierLtvCache` hot path.

    function testSetStableTokenFeed_AcceptsShortSymbol() public {
        // "EUR" (3 bytes) — well under the 10-byte cap.
        OracleAdminFacet(address(diamond)).setStableTokenFeed(
            "EUR",
            address(0x1234)
        );
        // No revert ⇒ accepted. (LibVaipakam stores the mapping;
        // the round-trip read happens via the peg-loop in
        // OracleFacet; not asserted here — the bounds check is the
        // unit under test.)
    }

    function testSetStableTokenFeed_AcceptsBoundarySymbol() public {
        // Exactly 10 bytes — at the boundary, must succeed.
        OracleAdminFacet(address(diamond)).setStableTokenFeed(
            "ABCDEFGHIJ",
            address(0x1234)
        );
    }

    function testSetStableTokenFeed_RevertsLongSymbol() public {
        // 11 bytes — just over the cap, must revert.
        bytes memory eleven = "ABCDEFGHIJK";
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.StableSymbolTooLong.selector,
                uint256(eleven.length),
                uint256(10)
            )
        );
        OracleAdminFacet(address(diamond)).setStableTokenFeed(
            string(eleven),
            address(0x1234)
        );
    }

    function testSetStableTokenFeed_RevertsHugeSymbol() public {
        // A pathological 200-byte symbol — exactly the "registers a
        // 100-KB symbol" exploit shape the cap defends against.
        // Build via concatenation to make the intent obvious.
        bytes memory big = new bytes(200);
        for (uint256 i = 0; i < 200; ++i) big[i] = 0x41; // 'A'
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.StableSymbolTooLong.selector,
                uint256(200),
                uint256(10)
            )
        );
        OracleAdminFacet(address(diamond)).setStableTokenFeed(
            string(big),
            address(0x1234)
        );
    }

    function testSetTierReferenceAssets_AcceptsAtBoundary() public {
        // 20 assets — exactly at the cap, must succeed.
        address[] memory assets = new address[](20);
        for (uint256 i = 0; i < 20; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
        // Confirm the persisted list has the expected length.
        address[] memory roundTrip =
            OracleAdminFacet(address(diamond)).getTierReferenceAssets(1);
        assertEq(roundTrip.length, 20);
    }

    function testSetTierReferenceAssets_RevertsAboveBoundary() public {
        // 21 assets — just over the cap, must revert.
        address[] memory assets = new address[](21);
        for (uint256 i = 0; i < 21; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.TierReferenceAssetsTooLong.selector,
                uint256(21),
                uint256(20)
            )
        );
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
    }

    function testSetTierReferenceAssets_RevertsHugeList() public {
        // 1000 assets — the "thousands-of-assets DoS the hot-path
        // refresh" exploit shape the cap defends against.
        address[] memory assets = new address[](1000);
        for (uint256 i = 0; i < 1000; ++i) {
            assets[i] = address(SafeCast.toUint160(0x1000 + i));
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                OracleAdminFacet.TierReferenceAssetsTooLong.selector,
                uint256(1000),
                uint256(20)
            )
        );
        OracleAdminFacet(address(diamond)).setTierReferenceAssets(1, assets);
    }
}
