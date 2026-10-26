// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAggregatorRouter, MockUniV3SwapRouter, MockBalancerV2Vault} from "./mocks/MockSwapVenues.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {PartialFillSwapAdapter} from "./mocks/PartialFillSwapAdapter.sol";
import {FeeOnTransferERC20Mock} from "./mocks/FeeOnTransferERC20Mock.sol";
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
 *   Section C — #2472 delivery rule: what an attempt spent and delivered
 *               is measured on the caller's side, and an attempt that
 *               breaks the rule is refused and unwound so the failover
 *               moves on to the next route.
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
        return new ZeroExAggregatorAdapter(address(this), router, seed);
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
        new ZeroExAggregatorAdapter(address(this), address(0), seed);
    }

    /// @dev Constructor must reject empty allowlist — an adapter with
    ///      no targets is structurally unusable (every execute call
    ///      reverts), and "no targets" is more often a deploy bug than
    ///      a real intent.
    function testZeroExConstructorRejectsEmptySwapTargetSeed() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AggregatorAdapterBase.InvalidInitialSwapTargets.selector);
        new ZeroExAggregatorAdapter(address(this), makeAddr("ah"), empty);
    }

    /// @dev Constructor rejects address(0) entries inside the seed —
    ///      catches a copy-paste deploy mistake.
    function testZeroExConstructorRejectsZeroEntryInSeed() public {
        address[] memory seed = new address[](2);
        seed[0] = makeAddr("settler");
        seed[1] = address(0);
        vm.expectRevert(AggregatorAdapterBase.InvalidInitialSwapTargets.selector);
        new ZeroExAggregatorAdapter(address(this), makeAddr("ah"), seed);
    }

    /// @dev Owner can add new Settler addresses (0x rotates them per
    ///      release). Non-owner callers are blocked by Ownable.
    function testAddSwapTargetGated() public {
        MockAggregatorRouter router = new MockAggregatorRouter();
        ZeroExAggregatorAdapter adapter = _newZeroExAdapter(address(router));
        address newSettler = makeAddr("settler-v2");

        // Owner (= the test contract, passed as initialOwner) can add.
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

    /// @dev #2743: the adapter is owned by the address the deploy names,
    ///      never by whoever sent the deploy transaction, so the deploying
    ///      key holds no allowlist authority over it.
    function testAdapterOwnerIsTheNamedOwnerNotTheDeployer() public {
        address governance = makeAddr("governance");
        address[] memory seed = new address[](1);
        seed[0] = makeAddr("settler");
        ZeroExAggregatorAdapter zeroEx = new ZeroExAggregatorAdapter(governance, makeAddr("ah"), seed);
        OneInchAggregatorAdapter oneInch = new OneInchAggregatorAdapter(governance, makeAddr("router"));
        assertEq(zeroEx.owner(), governance);
        assertEq(oneInch.owner(), governance);

        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", address(this)));
        zeroEx.addSwapTarget(makeAddr("hostile"));
        vm.prank(governance);
        zeroEx.addSwapTarget(makeAddr("settler-v2"));

        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new OneInchAggregatorAdapter(address(0), makeAddr("router"));
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
            address(this),
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
        OneInchAggregatorAdapter adapter = new OneInchAggregatorAdapter(address(this), address(router));

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

    // ─────────────────────────────────────────────────────────────
    // SECTION C — #2472 delivery rule
    // ─────────────────────────────────────────────────────────────

    /// @dev A harness with one 0x adapter (slot 0) over a mock router, the
    ///      harness funded with `fund` of the input token.
    function _harnessWithZeroEx(uint256 fund)
        internal
        returns (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router)
    {
        h = new SwapFailoverHarness();
        router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        adapter = _newZeroExAdapter(address(router));
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), fund);
    }

    /// @dev One-route try-list for slot 0 whose aggregator calldata sells
    ///      `quotedIn` (not necessarily the amount the caller offers).
    function _zeroExCall(
        address router,
        address adapter,
        uint256 quotedIn,
        uint256 quotedOut
    ) internal view returns (LibSwap.AdapterCall[] memory calls) {
        calls = new LibSwap.AdapterCall[](1);
        calls[0] = LibSwap.AdapterCall({
            adapterIdx: 0,
            data: _zeroExAdapterData(router, adapter, quotedIn, quotedOut)
        });
    }

    /// @notice The #2472 defect: calldata quoted for 600 while the caller
    ///         offers 1,000. The router spends 600, the adapter hands back
    ///         400, and the failover used to report a full sale, leaving the
    ///         400 on the caller's balance in nobody's claim. A forced sale
    ///         now refuses the attempt: its sale and approval unwind, nothing
    ///         reaches the recipient, and with no other route the caller gets
    ///         the ordinary "every route failed" result.
    function test_ExactSwap_PartialFillIsRefusedAndUnwound() public {
        (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router) =
            _harnessWithZeroEx(1000 ether);
        LibSwap.AdapterCall[] memory calls =
            _zeroExCall(address(router), address(adapter), 600 ether, 900 ether);

        vm.expectEmit(true, true, false, true, address(h));
        emit LibSwap.SwapAdapterAttempted(7, 0, address(adapter), false);
        (bool ok, uint256 out_, ) =
            h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);

        assertFalse(ok, "a partial sale is not a sale");
        assertEq(out_, 0);
        assertEq(tokenIn.balanceOf(address(h)), 1000 ether, "the whole offer is back on the caller");
        assertEq(tokenIn.balanceOf(address(router)), 0, "the venue's partial sale unwound");
        assertEq(tokenIn.balanceOf(address(adapter)), 0);
        assertEq(tokenOut.balanceOf(recipient), 0, "no proceeds were booked");
        assertEq(tokenIn.allowance(address(h), address(adapter)), 0, "approval unwound");
    }

    /// @notice The lender-first point of falling through: a stale quote at
    ///         the head of the try-list does not stop the routes behind it.
    ///         The partial attempt unwinds and the next route sells the whole
    ///         amount, so the sale completes in the lending asset.
    function test_ExactSwap_PartialFillFallsThroughToNextRoute() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockAggregatorRouter router = new MockAggregatorRouter();
        tokenOut.mint(address(router), 10_000 ether);
        ZeroExAggregatorAdapter stale = _newZeroExAdapter(address(router));
        MockSwapAdapter full = new MockSwapAdapter("full");
        tokenOut.mint(address(full), 10_000 ether);
        address[] memory adapters = new address[](2);
        adapters[0] = address(stale);
        adapters[1] = address(full);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.AdapterCall[] memory calls = new LibSwap.AdapterCall[](2);
        calls[0] = LibSwap.AdapterCall({
            adapterIdx: 0,
            data: _zeroExAdapterData(address(router), address(stale), 600 ether, 900 ether)
        });
        calls[1] = LibSwap.AdapterCall({adapterIdx: 1, data: bytes("")});

        (bool ok, uint256 out_, uint256 idx) =
            h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);

        assertTrue(ok);
        assertEq(idx, 1, "the second route committed");
        assertEq(out_, 1000 ether);
        assertEq(full.callCount(), 1);
        assertEq(tokenIn.balanceOf(address(h)), 0, "the whole offer was sold");
        assertEq(tokenIn.balanceOf(address(router)), 0, "the stale route's sale unwound");
        assertEq(tokenOut.balanceOf(recipient), 1000 ether, "only the committed route's proceeds");
    }

    /// @notice A Diamond that routes the failover callers but not the
    ///         attempt host is a deploy defect. It is refused by name rather
    ///         than read as "every route failed", which would send a
    ///         liquidation into the in-kind fallback with a working route
    ///         available.
    function test_Swap_RevertsWhenAttemptHostMissing() public {
        (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router) =
            _harnessWithZeroEx(1000 ether);
        h.setAttemptHostRouted(false);
        LibSwap.AdapterCall[] memory calls =
            _zeroExCall(address(router), address(adapter), 1000 ether, 900 ether);

        vm.expectRevert(LibSwap.SwapAttemptHostMissing.selector);
        h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);
    }

    /// @notice The up-to entry (swap-to-repay's) accepts the same partial
    ///         fill and reports what it spent, measured on the caller; the
    ///         unspent 400 is back on the caller for it to place.
    function test_UpToSwap_ReportsMeasuredSpendOnPartialFill() public {
        (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router) =
            _harnessWithZeroEx(1000 ether);
        LibSwap.AdapterCall[] memory calls =
            _zeroExCall(address(router), address(adapter), 600 ether, 900 ether);

        (bool ok, uint256 out_, uint256 idx, uint256 spent) =
            h.doSwapUpTo(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);

        assertTrue(ok);
        assertEq(out_, 900 ether);
        assertEq(idx, 0);
        assertEq(spent, 600 ether, "spend is the measured 600, not the offered 1000");
        assertEq(tokenIn.balanceOf(address(h)), 400 ether, "unspent input is back on the caller");
        assertEq(tokenIn.balanceOf(address(adapter)), 0, "adapter keeps nothing of the call");
        assertEq(tokenOut.balanceOf(recipient), 900 ether);
    }

    /// @notice A full fill still commits under the exact rule.
    function test_ExactSwap_CommitsOnFullFill() public {
        (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router) =
            _harnessWithZeroEx(1000 ether);
        LibSwap.AdapterCall[] memory calls =
            _zeroExCall(address(router), address(adapter), 1000 ether, 900 ether);

        (bool ok, uint256 out_, ) =
            h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);
        assertTrue(ok);
        assertEq(out_, 900 ether);
        assertEq(tokenIn.balanceOf(address(h)), 0);
    }

    /// @notice A balance an adapter already held (a donation) is not part of
    ///         any call: the adapter must not sweep it to the caller, where it
    ///         would read as unspent input and make every exact sale through
    ///         that adapter revert.
    function test_AggregatorAdapter_DonationIsNotSweptToCaller() public {
        (SwapFailoverHarness h, ZeroExAggregatorAdapter adapter, MockAggregatorRouter router) =
            _harnessWithZeroEx(1000 ether);
        tokenIn.mint(address(adapter), 5 ether); // donation
        LibSwap.AdapterCall[] memory calls =
            _zeroExCall(address(router), address(adapter), 1000 ether, 900 ether);

        (bool ok, , ) =
            h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 800 ether, recipient, calls);

        assertTrue(ok, "a full fill commits despite the donation");
        assertEq(tokenIn.balanceOf(address(adapter)), 5 ether, "donation stays on the adapter");
        assertEq(tokenIn.balanceOf(address(h)), 0, "caller spent exactly its offer");
    }

    function test_UniV3Adapter_DonationIsNotSweptToCaller() public {
        MockUniV3SwapRouter router = new MockUniV3SwapRouter();
        tokenOut.mint(address(router), 10_000 ether);
        UniV3Adapter adapter = new UniV3Adapter(address(router));
        tokenIn.mint(address(adapter), 5 ether); // donation

        uint256 traderBefore = tokenIn.balanceOf(trader);
        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        adapter.execute(address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, abi.encode(uint24(3000)));
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(address(adapter)), 5 ether, "donation stays on the adapter");
        assertEq(traderBefore - tokenIn.balanceOf(trader), 1000 ether, "caller spent exactly its offer");
    }

    function test_BalancerV2Adapter_DonationIsNotSweptToCaller() public {
        MockBalancerV2Vault vault = new MockBalancerV2Vault();
        tokenOut.mint(address(vault), 10_000 ether);
        BalancerV2Adapter adapter = new BalancerV2Adapter(address(vault));
        tokenIn.mint(address(adapter), 5 ether); // donation

        uint256 traderBefore = tokenIn.balanceOf(trader);
        vm.startPrank(trader);
        tokenIn.approve(address(adapter), 1000 ether);
        adapter.execute(address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, abi.encode(bytes32(uint256(1))));
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(address(adapter)), 5 ether, "donation stays on the adapter");
        assertEq(traderBefore - tokenIn.balanceOf(trader), 1000 ether, "caller spent exactly its offer");
    }

    /// @notice Proceeds are never booked above what arrived: an output token
    ///         that takes a fee on transfer delivers less than the adapter
    ///         reports, so the attempt is refused and unwound like any other
    ///         failed route.
    function test_Swap_ShortDeliveredOutputIsRefused() public {
        FeeOnTransferERC20Mock fotOut = new FeeOnTransferERC20Mock("FoT", "FOT", 18);
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("A");
        fotOut.mint(address(a), 10_000 ether);
        fotOut.setFeeBps(100); // 1%
        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        (bool ok, uint256 out_, ) =
            h.doSwap(7, address(tokenIn), address(fotOut), 1000 ether, 900 ether, recipient, _seqCalls(1));

        assertFalse(ok);
        assertEq(out_, 0);
        assertEq(tokenIn.balanceOf(address(h)), 1000 ether, "input unwound");
        assertEq(fotOut.balanceOf(recipient), 0, "no short proceeds kept");
        assertEq(fotOut.balanceOf(address(a)), 10_000 ether, "venue float untouched");
    }

    /// @notice An adapter that pays more than it reports (a conservative or
    ///         buggy return value) is booked at what ARRIVED: the surplus is
    ///         settled to the sale rather than left on the recipient's
    ///         balance with no ledger naming it (#2472, Codex r1).
    function test_Swap_UnderReportedOutputIsBookedAtWhatArrived() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        PartialFillSwapAdapter a = new PartialFillSwapAdapter();
        tokenOut.mint(address(a), 10_000 ether);
        a.setReportBps(9_000); // pays 1,000, reports 900
        address[] memory adapters = new address[](1);
        adapters[0] = address(a);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        (bool ok, uint256 out_, ) =
            h.doSwap(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, _seqCalls(1));

        assertTrue(ok);
        assertEq(out_, 1000 ether, "booked at what arrived, not at the report");
        assertEq(tokenOut.balanceOf(recipient), out_, "every booked token is held");
        assertEq(tokenIn.balanceOf(address(h)), 0, "whole input sold");
    }

    /// @notice The same rule per split leg: the split's total is the sum of
    ///         what each leg delivered.
    function test_Split_UnderReportedLegIsBookedAtWhatArrived() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("a");
        PartialFillSwapAdapter b = new PartialFillSwapAdapter();
        tokenOut.mint(address(a), 10_000 ether);
        tokenOut.mint(address(b), 10_000 ether);
        b.setReportBps(5_000); // pays 600, reports 300
        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.SplitCall[] memory splits = new LibSwap.SplitCall[](2);
        splits[0] = LibSwap.SplitCall({adapterIdx: 0, splitAmount: 400 ether, data: ""});
        splits[1] = LibSwap.SplitCall({adapterIdx: 1, splitAmount: 600 ether, data: ""});

        uint256 total = h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, splits);
        assertEq(total, 1000 ether, "split total is what the legs delivered");
        assertEq(tokenOut.balanceOf(recipient), total, "every booked token is held");
    }

    /// @notice A split leg that spends less than its share would leave the
    ///         rest on the caller after the loan is written down as sold; the
    ///         whole split reverts and every leg unwinds.
    function test_Split_RevertsWhenALegPartiallyFills() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter full = new MockSwapAdapter("full");
        PartialFillSwapAdapter partialLeg = new PartialFillSwapAdapter();
        tokenOut.mint(address(full), 10_000 ether);
        tokenOut.mint(address(partialLeg), 10_000 ether);
        partialLeg.setSpendBps(6_000);
        address[] memory adapters = new address[](2);
        adapters[0] = address(full);
        adapters[1] = address(partialLeg);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.SplitCall[] memory splits = new LibSwap.SplitCall[](2);
        splits[0] = LibSwap.SplitCall({adapterIdx: 0, splitAmount: 500 ether, data: ""});
        splits[1] = LibSwap.SplitCall({adapterIdx: 1, splitAmount: 500 ether, data: ""});

        vm.expectRevert(
            abi.encodeWithSelector(
                LibSwap.SwapInputSpendMismatch.selector,
                uint256(7),
                uint256(1),
                uint256(300 ether),
                uint256(500 ether)
            )
        );
        h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 0, recipient, splits);
    }

    /// @notice A split whose legs each spend their full share still commits.
    function test_Split_CommitsWhenEveryLegFills() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter a = new MockSwapAdapter("a");
        MockSwapAdapter b = new MockSwapAdapter("b");
        tokenOut.mint(address(a), 10_000 ether);
        tokenOut.mint(address(b), 10_000 ether);
        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.SplitCall[] memory splits = new LibSwap.SplitCall[](2);
        splits[0] = LibSwap.SplitCall({adapterIdx: 0, splitAmount: 400 ether, data: ""});
        splits[1] = LibSwap.SplitCall({adapterIdx: 1, splitAmount: 600 ether, data: ""});

        uint256 total = h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, splits);
        assertEq(total, 1000 ether);
        assertEq(tokenIn.balanceOf(address(h)), 0);
    }

    /// @notice #2724 — a leg whose route sends its output somewhere else
    ///         reverts the whole split on its own floor, even when an honest
    ///         leg delivers enough to cover the total floor by itself.
    function test_Split_RevertsWhenALegDivertsItsOutput() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        MockSwapAdapter honest = new MockSwapAdapter("honest");
        honest.setOutputMultiplierBps(20_000); // 500 in, 1,000 out: alone it covers the 900 total floor
        DivertingSwapAdapter diverter = new DivertingSwapAdapter(makeAddr("thief"));
        tokenOut.mint(address(honest), 10_000 ether);
        tokenOut.mint(address(diverter), 10_000 ether);
        address[] memory adapters = new address[](2);
        adapters[0] = address(honest);
        adapters[1] = address(diverter);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.SplitCall[] memory splits = new LibSwap.SplitCall[](2);
        splits[0] = LibSwap.SplitCall({adapterIdx: 0, splitAmount: 500 ether, data: ""});
        splits[1] = LibSwap.SplitCall({adapterIdx: 1, splitAmount: 500 ether, data: ""});

        vm.expectRevert(
            abi.encodeWithSelector(
                LibSwap.SwapOutputBelowFloor.selector, uint256(7), uint256(1), uint256(0), uint256(450 ether)
            )
        );
        h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, splits);
    }

    /// @notice #2724 — each leg's floor is its share of the total floor,
    ///         rounded up: a leg one wei short of its share reverts, a leg at
    ///         exactly its share commits.
    function test_Split_EachLegIsFlooredAtItsShare() public {
        SwapFailoverHarness h = new SwapFailoverHarness();
        PartialFillSwapAdapter a = new PartialFillSwapAdapter();
        PartialFillSwapAdapter b = new PartialFillSwapAdapter();
        tokenOut.mint(address(a), 10_000 ether);
        tokenOut.mint(address(b), 10_000 ether);
        a.setOutputPerInputBps(9_000); // 300 in -> 270 out, exactly its 270 share of 900
        b.setOutputPerInputBps(12_000); // 700 in -> 840 out, above its 630 share
        address[] memory adapters = new address[](2);
        adapters[0] = address(a);
        adapters[1] = address(b);
        h.setAdapters(adapters);
        tokenIn.mint(address(h), 1000 ether);

        LibSwap.SplitCall[] memory splits = new LibSwap.SplitCall[](2);
        splits[0] = LibSwap.SplitCall({adapterIdx: 0, splitAmount: 300 ether, data: ""});
        splits[1] = LibSwap.SplitCall({adapterIdx: 1, splitAmount: 700 ether, data: ""});
        uint256 total = h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether, recipient, splits);
        assertEq(total, 1110 ether, "both legs at or above their share commit");

        // One wei more on the floor puts leg 0's share (rounded up) one wei
        // above what it delivers. The mock refuses its own min-out first,
        // which is the floor LibSwap handed it.
        tokenIn.mint(address(h), 1000 ether);
        vm.expectRevert(bytes("PartialFillSwapAdapter: min-out"));
        h.doSplit(7, address(tokenIn), address(tokenOut), 1000 ether, 900 ether + 1, recipient, splits);
    }
}

/// @dev A route whose calldata pays its output to someone other than the
///      caller (what a permissionless liquidator could encode in aggregator
///      calldata): it takes the input, pays a third party, and reports 0.
contract DivertingSwapAdapter {
    address public immutable thief;

    constructor(address thief_) {
        thief = thief_;
    }

    function adapterName() external pure returns (string memory) {
        return "diverting";
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256, /* minOutputAmount: ignored, like calldata the caller wrote */
        address, /* recipient: ignored */
        bytes calldata /* adapterData */
    ) external returns (uint256) {
        ERC20Mock(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        ERC20Mock(outputToken).transfer(thief, inputAmount);
        return 0;
    }
}
