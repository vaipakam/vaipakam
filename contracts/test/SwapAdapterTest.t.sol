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

    /// @dev `adapterData` for the aggregator base is now
    ///      `abi.encode(address swapTarget, bytes swapCalldata)`.
    ///      The inner blob is whatever the keeper would have got
    ///      from `transaction.data` (0x v2) or `tx.data` (1inch v6).
    function _zeroExAdapterData(
        address swapTarget,
        address adapter,
        uint256 amountIn,
        uint256 amountOut
    ) internal view returns (bytes memory) {
        bytes memory inner = abi.encode(
            address(tokenIn),
            address(tokenOut),
            amountIn,
            amountOut,
            adapter
        );
        return abi.encode(swapTarget, inner);
    }

    /// @dev Convenience for tests that deploy a 0x adapter with the
    ///      router serving as both allowanceTarget AND the singleton
    ///      seed in the swap-target allowlist (matches today's mock
    ///      where one address handles both roles).
    function _newZeroExAdapter(address router) internal returns (ZeroExAggregatorAdapter) {
        address[] memory seed = new address[](1);
        seed[0] = router;
        return new ZeroExAggregatorAdapter(router, seed);
    }

    function testAggregatorAdapterHappyPath() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);

        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));

        // Keeper-supplied calldata: abi.encode of the mock's expected args.
        uint256 amountIn = 1000 ether;
        uint256 amountOut = 900 ether;
        bytes memory data = _zeroExAdapterData(
            address(router),
            address(adapter),
            amountIn,
            amountOut
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
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));
        router.setRevert(true);

        bytes memory data = _zeroExAdapterData(
            address(router),
            address(adapter),
            1000 ether,
            900 ether
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
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));
        // Make router deliver 50% of requested.
        router.setOutputMultiplier(5_000);

        bytes memory data = _zeroExAdapterData(
            address(router),
            address(adapter),
            1000 ether,
            900 ether
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
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));

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

    /// @dev Adapter rejects a swap target that is NOT in the
    ///      owner-managed allowlist — even if the keeper points it at
    ///      a real-looking router address. Defends against a
    ///      compromised keeper trying to redirect funds.
    function testAggregatorAdapterRejectsUnallowlistedSwapTarget() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));

        address rogue = makeAddr("rogue-settler");
        bytes memory data = _zeroExAdapterData(
            rogue, // not in allowlist
            address(adapter),
            1000 ether,
            900 ether
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorAdapterBase.SwapTargetNotAllowed.selector,
                rogue
            )
        );
        adapter.execute(
            address(tokenIn),
            address(tokenOut),
            1000 ether,
            800 ether,
            recipient,
            data
        );
        vm.stopPrank();
    }

    /// @dev Constructor must reject zero allowance target — an
    ///      unrecoverable misconfiguration where every approve()
    ///      would land on address(0).
    function testZeroExConstructorRejectsZeroAllowanceTarget() public {
        address[] memory seed = new address[](1);
        seed[0] = makeAddr("settler");
        vm.expectRevert(AggregatorAdapterBase.InvalidAllowanceTarget.selector);
        new ZeroExAggregatorAdapter(address(0), seed);
    }

    /// @dev Constructor must reject empty allowlist — an adapter with
    ///      no targets is structurally unusable (every execute call
    ///      reverts), and "no targets" is more often a deploy bug than
    ///      a real intent.
    function testZeroExConstructorRejectsEmptySwapTargetSeed() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AggregatorAdapterBase.InvalidInitialSwapTargets.selector);
        new ZeroExAggregatorAdapter(makeAddr("ah"), empty);
    }

    /// @dev Constructor rejects address(0) entries inside the seed —
    ///      catches a copy-paste deploy mistake.
    function testZeroExConstructorRejectsZeroEntryInSeed() public {
        address[] memory seed = new address[](2);
        seed[0] = makeAddr("settler");
        seed[1] = address(0);
        vm.expectRevert(AggregatorAdapterBase.InvalidInitialSwapTargets.selector);
        new ZeroExAggregatorAdapter(makeAddr("ah"), seed);
    }

    /// @dev Owner can add new Settler addresses (0x rotates them per
    ///      release). Non-owner callers are blocked by Ownable.
    function testAddSwapTargetGated() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));
        address newSettler = makeAddr("settler-v2");

        // Owner (= deployer = this test contract) can add.
        adapter.addSwapTarget(newSettler);
        assertTrue(adapter.swapTargetAllowed(newSettler));
        assertEq(adapter.swapTargetCount(), 2);

        // Non-owner blocked.
        vm.prank(trader);
        vm.expectRevert();
        adapter.addSwapTarget(makeAddr("settler-v3"));

        // Adding twice reverts.
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorAdapterBase.SwapTargetAlreadyAllowed.selector,
                newSettler
            )
        );
        adapter.addSwapTarget(newSettler);
    }

    /// @dev Owner can remove Settlers but the LAST target is sticky —
    ///      forces the operator to {addSwapTarget} a replacement
    ///      first if they're rotating, preventing an accidentally
    ///      bricked adapter.
    function testRemoveSwapTargetGatedAndProtectsLastEntry() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));
        address newSettler = makeAddr("settler-v2");

        adapter.addSwapTarget(newSettler);
        assertEq(adapter.swapTargetCount(), 2);

        // Remove the original — leaves count=1.
        adapter.removeSwapTarget(address(router));
        assertFalse(adapter.swapTargetAllowed(address(router)));
        assertEq(adapter.swapTargetCount(), 1);

        // Try to remove the last one → revert.
        vm.expectRevert(
            AggregatorAdapterBase.LastSwapTargetCannotBeRemoved.selector
        );
        adapter.removeSwapTarget(newSettler);

        // Removing a never-allowed address reverts with NotAllowed.
        address ghost = makeAddr("ghost");
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorAdapterBase.SwapTargetNotAllowed.selector,
                ghost
            )
        );
        adapter.removeSwapTarget(ghost);

        // Non-owner blocked.
        vm.prank(trader);
        vm.expectRevert();
        adapter.removeSwapTarget(newSettler);
    }

    /// @dev Approval lands on `allowanceTarget` (the AllowanceHolder
    ///      analogue), NOT on the swap target. With the two
    ///      addresses split, a swap target trying to draw via
    ///      `transferFrom(adapter, ...)` reverts because the adapter
    ///      never approved it. This is the structural defence
    ///      against the 0x footgun.
    function testApprovalLandsOnAllowanceTargetNotSwapTarget() public {
        MockAggregatorRouter ah = new MockAggregatorRouter(); // serves as AllowanceHolder
        MockAggregatorRouter settler = new MockAggregatorRouter(); // call destination

        // Pre-fund the SETTLER (which is what would deliver tokenOut
        // in a real swap), and let it pull from the ADAPTER on the
        // call. Since approval will land on `ah`, settler's
        // transferFrom of tokenIn from the adapter MUST fail.
        tokenOut.mint(address(settler), 10_000 ether);

        address[] memory seed = new address[](1);
        seed[0] = address(settler);
        ZeroExAggregatorAdapter adapter = new ZeroExAggregatorAdapter(
            address(ah),
            seed
        );

        bytes memory data = _zeroExAdapterData(
            address(settler),
            address(adapter),
            1000 ether,
            900 ether
        );

        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        // Settler tries `transferFrom(adapter, settler, 1000)` →
        // reverts because adapter approved `ah`, not settler.
        // Adapter wraps that as RouterCallFailed.
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

        // Adapter's allowance to `ah` must be zeroed post-call (clear
        // happens regardless of outcome).
        assertEq(tokenIn.allowance(address(adapter), address(ah)), 0);
        // Adapter never approved the settler.
        assertEq(tokenIn.allowance(address(adapter), address(settler)), 0);
    }

    function testOneInchAdapterHappyPath() public {
        // Confirms the OneInch subclass works via the shared base.
        // OneInch coalesces allowanceTarget + swapTarget into the
        // single AggregationRouter; the constructor seeds the
        // singleton allowlist itself.
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        OneInchAggregatorAdapter adapter = new OneInchAggregatorAdapter(address(router));

        uint256 amountIn = 500 ether;
        uint256 amountOut = 480 ether;
        bytes memory data = _zeroExAdapterData(
            address(router),
            address(adapter),
            amountIn,
            amountOut
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

    function testSwapFailoverEmptyCallListReverts() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1 ether);

        // #1005 (S9, Codex #1087 r1 P1) — adapters registered but empty try-list
        // ⇒ zero routes attempted ⇒ reverts `NoEnabledSwapRoute` (previously a
        // soft `(false, 0)` return). Callers must not treat "no route tried" as
        // "every route failed" and route into the collateral fallback.
        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](0);
        vm.expectRevert(abi.encodeWithSelector(LibSwap.NoEnabledSwapRoute.selector, uint256(1)));
        h.doSwap(
            1,
            address(tokenIn),
            address(tokenOut),
            1 ether,
            1,
            recipient,
            calls
        );
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
