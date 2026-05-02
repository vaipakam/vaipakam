// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {OracleAdminFacet} from "../src/facets/OracleAdminFacet.sol";
import {OracleFacet} from "../src/facets/OracleFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";

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
        setupHelper();

        OracleAdminFacet adminFacet = new OracleAdminFacet();
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = OracleAdminFacet.setChainlinkRegistry.selector;
        selectors[1] = OracleAdminFacet.setUsdChainlinkDenominator.selector;
        selectors[2] = OracleAdminFacet.setEthChainlinkDenominator.selector;
        selectors[3] = OracleAdminFacet.setWethContract.selector;
        selectors[4] = OracleAdminFacet.setEthUsdFeed.selector;
        selectors[5] = OracleAdminFacet.setUniswapV3Factory.selector;
        selectors[6] = OracleAdminFacet.setStableTokenFeed.selector;
        selectors[7] = OracleAdminFacet.setFeedOverride.selector;
        selectors[8] = OracleAdminFacet.getFeedOverride.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(adminFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: selectors
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
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
}
