// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAggregatorRouter, MockUniV3SwapRouter, MockBalancerV2Vault} from "./mocks/MockSwapVenues.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {SwapFailoverHarness} from "./helpers/SwapFailoverHarness.sol";
import {ZeroExAggregatorAdapter} from "../src/adapters/ZeroExAggregatorAdapter.sol";
import {OneInchAggregatorAdapter} from "../src/adapters/OneInchAggregatorAdapter.sol";
import {UniV3Adapter} from "../src/adapters/UniV3Adapter.sol";
import {BalancerV2Adapter} from "../src/adapters/BalancerV2Adapter.sol";
import {AggregatorAdapterBase} from "../src/adapters/AggregatorAdapterBase.sol";
import {LibSwap} from "../src/libraries/LibSwap.sol";

/**
 * @title SwapAdapterTest — Phase 7a adapter + LibSwap failover coverage.
 *
 * Tests structured as:
 *   Section A — individual adapter happy paths + input validation.
 *   Section B — LibSwap.swapWithFailover chain behaviour.
 */
contract SwapAdapterTest is Test {
    // Shared fixtures
    ERC20Mock internal tokenIn;
    ERC20Mock internal tokenOut;
    address internal trader;
    address internal recipient;

    function setUp() public {
        tokenIn = new ERC20Mock("InputToken", "IN", 18);
        tokenOut = new ERC20Mock("OutputToken", "OUT", 18);
        trader = makeAddr("trader");
        recipient = makeAddr("recipient");
        // Trader (acts as "the liquidation facet" in these tests)
        // holds input tokens. Each adapter will pull from trader via
        // the pre-granted allowance set in the test body.
        tokenIn.mint(trader, 10_000_000 ether);
    }

    // ─────────────────────────────────────────────────────────────
    // SECTION A — adapter happy paths + rejection of bad inputs
    // ─────────────────────────────────────────────────────────────

    function testAggregatorAdapterHappyPath() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);

        ZeroExAggregatorAdapter adapter = new ZeroExAggregatorAdapter(address(router));

        // Keeper-supplied calldata: abi.encode of the mock's expected args.
        uint256 amountIn = 1000 ether;
        uint256 amountOut = 900 ether;
        bytes memory data = abi.encode(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            amountOut,
            address(adapter)
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), amountIn);
        uint256 received = adapter.execute(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            800 ether, // minOut
            recipient,
            data
        );
        vm.stopPrank();

        assertEq(received, amountOut);
        assertEq(tokenOut.balanceOf(recipient), amountOut);
    }

    function testAggregatorAdapterRevertsWhenRouterReverts() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        ZeroExAggregatorAdapter adapter = new ZeroExAggregatorAdapter(address(router));
        router.setRevert(true);

        bytes memory data = abi.encode(
            address(tokenIn),
            address(tokenOut),
            uint256(1000 ether),
            uint256(900 ether),
            address(adapter)
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        vm.expectRevert();
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            800 ether,
            recipient,
            data
        );
        vm.stopPrank();
        // Input should have been returned to trader on revert.
        assertEq(tokenIn.balanceOf(trader), 10_000_000 ether);
        assertEq(tokenIn.balanceOf(address(adapter)), 0);
    }

    function testAggregatorAdapterRevertsOnInsufficientOutput() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        ZeroExAggregatorAdapter adapter = new ZeroExAggregatorAdapter(address(router));
        // Make router deliver 50% of requested.
        router.setOutputMultiplier(5_000);

        bytes memory data = abi.encode(
            address(tokenIn),
            address(tokenOut),
            uint256(1000 ether),
            uint256(900 ether),
            address(adapter)
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        vm.expectRevert();
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            800 ether, // min — router will deliver 450, triggers revert
            recipient,
            data
        );
        vm.stopPrank();
        assertEq(tokenOut.balanceOf(recipient), 0);
    }

    function testAggregatorAdapterRejectsEmptyAdapterData() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        ZeroExAggregatorAdapter adapter = new ZeroExAggregatorAdapter(address(router));

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        vm.expectRevert(AggregatorAdapterBase.AdapterDataRequired.selector);
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            800 ether,
            recipient,
            bytes("")
        );
        vm.stopPrank();
    }

    function testOneInchAdapterHappyPath() public {
        // Confirms the OneInch subclass works via the shared base.
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        OneInchAggregatorAdapter adapter = new OneInchAggregatorAdapter(address(router));

        uint256 amountIn = 500 ether;
        uint256 amountOut = 480 ether;
        bytes memory data = abi.encode(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            amountOut,
            address(adapter)
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), amountIn);
        uint256 received = adapter.execute(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            400 ether,
            recipient,
            data
        );
        vm.stopPrank();

        assertEq(received, amountOut);
        assertEq(tokenOut.balanceOf(recipient), amountOut);
        assertEq(keccak256(bytes(adapter.adapterName())), keccak256("OneInch"));
    }

    function testUniV3AdapterHappyPath() public {
        MockUniV3SwapRouter router = new MockUniV3SwapRouter();
        tokenOut.mint(address(router), 10_000 ether);
        UniV3Adapter adapter = new UniV3Adapter(address(router));

        uint256 amountIn = 1000 ether;
        bytes memory data = abi.encode(uint24(500));

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), amountIn);
        uint256 received = adapter.execute(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            900 ether,
            recipient,
            data
        );
        vm.stopPrank();

        assertEq(received, amountIn); // rate 1x default
        assertEq(tokenOut.balanceOf(recipient), amountIn);
    }

    function testUniV3AdapterRejectsEmptyData() public {
        MockUniV3SwapRouter router = new MockUniV3SwapRouter();
        UniV3Adapter adapter = new UniV3Adapter(address(router));
        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1 ether);
        vm.expectRevert(UniV3Adapter.AdapterDataRequired.selector);
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1 ether,
            0,
            recipient,
            bytes("")
        );
        vm.stopPrank();
    }

    function testBalancerV2AdapterHappyPath() public {
        MockBalancerV2Vault vault = new MockBalancerV2Vault();
        tokenOut.mint(address(vault), 10_000 ether);
        BalancerV2Adapter adapter = new BalancerV2Adapter(address(vault));

        uint256 amountIn = 1000 ether;
        bytes32 poolId = keccak256("some-pool");
        bytes memory data = abi.encode(poolId);

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), amountIn);
        uint256 received = adapter.execute(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            900 ether,
            recipient,
            data
        );
        vm.stopPrank();

        assertEq(received, amountIn);
        assertEq(tokenOut.balanceOf(recipient), amountIn);
    }

    function testBalancerV2AdapterRejectsEmptyData() public {
        MockBalancerV2Vault vault = new MockBalancerV2Vault();
        BalancerV2Adapter adapter = new BalancerV2Adapter(address(vault));
        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1 ether);
        vm.expectRevert(BalancerV2Adapter.AdapterDataRequired.selector);
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1 ether,
            0,
            recipient,
            bytes("")
        );
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────
    // SECTION B — LibSwap.swapWithFailover chain behaviour
    // ─────────────────────────────────────────────────────────────

    /// @dev Helpers: build an AdapterCall[] of the given length with
    ///      the indices mirroring slot positions and empty data. Tests
    ///      that want custom ordering build the array inline.
    function _seqCalls(uint256 n) internal pure returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](n);
        for (uint256 i = 0; i < n; ++i) {
            calls[i] = LibSwap.AdapterCall({adapterIdx: i, data: bytes("")});
        }
    }

    function testSwapFailoverNoAdaptersConfiguredReverts() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        // No adapters registered → NoSwapAdaptersConfigured.
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](0);
        vm.expectRevert(LibSwap.NoSwapAdaptersConfigured.selector);
        h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1 ether,
            1,
            recipient,
            calls
        );
    }

    function testSwapFailoverEmptyCallListReturnsFalse() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1 ether);

        // Adapters registered but empty try-list — returns total-fail
        // without reverting.
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](0);
        (bool ok, uint256 out_, uint256 idx) = h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1 ether,
            1,
            recipient,
            calls
        );
        assertFalse(ok);
        assertEq(out_, 0);
        assertEq(idx, type(uint256).max);
        assertEq(a.callCount(), 0);
    }

    function testSwapFailoverOutOfRangeIndexReverts() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1 ether);

        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](1);
        // adapter idx 5 doesn't exist.
        calls[0] = LibSwap.AdapterCall({adapterIdx: 5, data: bytes("")});
        vm.expectRevert(
            abi.encodeWithSelector(
                LibSwap.AdapterIndexOutOfRange.selector,
                uint256(5),
                uint256(1)
            )
        );
        h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1 ether,
            1,
            recipient,
            calls
        );
    }

    function testSwapFailoverCommitsOnFirstSuccess() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        MockSwapAdapter b = new MockSwapAdapter("B");
        tokenOut.mint(address(a), 10_000 ether); // only A needs output

        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = _seqCalls(2);
        (bool ok, uint256 out_, uint256 idx) = h.doSwap(
            42,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );

        assertTrue(ok);
        assertEq(out_, 1000 ether);
        assertEq(idx, 0);
        assertEq(a.callCount(), 1);
        assertEq(b.callCount(), 0); // never tried
        assertEq(tokenOut.balanceOf(recipient), 1000 ether);
    }

    function testSwapFailoverFollowsCallerOrderNotStorageOrder() public {
        // Frontend ranks B as best-quote → submits B first even though
        // B is adapter slot 1. Library must try B first and commit.
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        MockSwapAdapter b = new MockSwapAdapter("B");
        tokenOut.mint(address(b), 10_000 ether);

        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        // Caller-ranked order: B (idx 1) first, A (idx 0) second.
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](2);
        calls[0] = LibSwap.AdapterCall({adapterIdx: 1, data: bytes("")});
        calls[1] = LibSwap.AdapterCall({adapterIdx: 0, data: bytes("")});

        (bool ok, , uint256 committedIdx) = h.doSwap(
            42,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );
        assertTrue(ok);
        assertEq(committedIdx, 1); // B's storage index
        assertEq(a.callCount(), 0); // A never tried
        assertEq(b.callCount(), 1);
    }

    function testSwapFailoverSkipsRevertingAdapters() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        MockSwapAdapter b = new MockSwapAdapter("B");
        MockSwapAdapter c = new MockSwapAdapter("C");
        tokenOut.mint(address(c), 10_000 ether);

        a.setShouldRevert(true);
        b.setShouldRevert(true);

        address[] memory adapters = new address[](3);
        adapters[0] = address(a);
        adapters[1] = address(b);
        adapters[2] = address(c);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = _seqCalls(3);
        (bool ok, uint256 out_, uint256 idx) = h.doSwap(
            42,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );

        assertTrue(ok);
        assertEq(out_, 1000 ether);
        assertEq(idx, 2); // third adapter was the one that committed
        // a + b reverted; EVM rolled back their callCount increment. We
        // can only observe that the commit landed on idx=2 — sufficient
        // evidence the failover ran through both reverting adapters
        // first, since LibSwap reaches the third slot only by failing
        // the first two. c's counter proves it actually ran.
        assertEq(c.callCount(), 1);
    }

    function testSwapFailoverAllRevertReturnsFalse() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        MockSwapAdapter b = new MockSwapAdapter("B");
        a.setShouldRevert(true);
        b.setShouldRevert(true);

        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = _seqCalls(2);
        (bool ok, uint256 out_, uint256 idx) = h.doSwap(
            99,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );

        assertFalse(ok);
        assertEq(out_, 0);
        assertEq(idx, type(uint256).max);
        assertEq(tokenOut.balanceOf(recipient), 0);
        // Input tokens remain on the harness, available for fallback.
        assertEq(tokenIn.balanceOf(address(h)), 1000 ether);
    }

    function testSwapFailoverApprovalRevokedAfterSuccess() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        tokenOut.mint(address(a), 10_000 ether);

        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = _seqCalls(1);
        h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );

        // Post-swap: no residual allowance on the adapter.
        assertEq(tokenIn.allowance(address(h), address(a)), 0);
    }

    function testSwapFailoverApprovalRevokedAfterAllReverts() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        MockSwapAdapter b = new MockSwapAdapter("B");
        a.setShouldRevert(true);
        b.setShouldRevert(true);

        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = _seqCalls(2);
        h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            900 ether,
            recipient,
            calls
        );

        assertEq(tokenIn.allowance(address(h), address(a)), 0);
        assertEq(tokenIn.allowance(address(h), address(b)), 0);
    }

    function testSwapFailoverAllowsDuplicateAdapterEntries() public {
        // Caller can submit the same adapter twice with different
        // routing data (e.g. UniV3 fee=500 first try, fee=3000 fallback).
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        tokenOut.mint(address(a), 10_000 ether);

        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 500 ether);

        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](2);
        calls[0] = LibSwap.AdapterCall({adapterIdx: 0, data: hex"01"});
        calls[1] = LibSwap.AdapterCall({adapterIdx: 0, data: hex"02"});

        (bool ok, , ) = h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            500 ether,
            500 ether,
            recipient,
            calls
        );
        assertTrue(ok);
        assertEq(a.callCount(), 1); // first succeeded, second never tried
    }
}
