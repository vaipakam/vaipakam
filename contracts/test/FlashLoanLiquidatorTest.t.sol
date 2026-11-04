// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FlashLoanLiquidator} from "../src/keeper/FlashLoanLiquidator.sol";
import {
    IAaveV3Pool,
    IFlashLoanSimpleReceiver
} from "../src/interfaces/IAaveV3Pool.sol";
import {
    IBalancerV2Vault,
    IFlashLoanRecipient
} from "../src/interfaces/IBalancerV2Vault.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LibDiscountedLiquidation} from "../src/libraries/LibDiscountedLiquidation.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {ZeroExAggregatorAdapter} from "../src/adapters/ZeroExAggregatorAdapter.sol";
import {AggregatorAdapterBase} from "../src/adapters/AggregatorAdapterBase.sol";

/// @title FlashLoanLiquidatorTest
/// @notice Unit tests for the FlashLoanLiquidator reference contract
///         from `docs/DesignsAndPlans/FlashLoanLiquidationPath.md`
///         Phase 3. Tests use lightweight mock providers (Aave V3
///         Pool + Balancer V2 Vault), a mock Vaipakam diamond
///         that returns seized collateral on call, and a mock
///         swap aggregator that converts collateral back to
///         principal at a profitable rate. Fork tests against real
///         Aave / Balancer / 1inch are a separate work item.
contract FlashLoanLiquidatorTest is Test {
    FlashLoanLiquidator liquidator;
    MockAaveV3Pool aavePool;
    MockBalancerV2Vault balancerVault;
    MockDiamond diamond;
    MockSwapAggregator swap;
    /// The Diamond-registered aggregator adapter every run sells through
    /// (#2734): pinned allowance target and allow-listed call target `swap`.
    ZeroExAggregatorAdapter adapter;

    ERC20Mock principal;
    ERC20Mock collateral;

    address owner = makeAddr("owner");
    address attacker = makeAddr("attacker");

    uint256 constant FLASH_LOAN_AMOUNT = 1_000 ether;
    uint256 constant AAVE_PREMIUM_BPS = 5;   // 0.05% — Aave V3 default
    uint256 constant FLASH_FEE = (FLASH_LOAN_AMOUNT * AAVE_PREMIUM_BPS) / 10_000;
    // Mock-diamond seizes 1_050 ether of collateral on each
    // `triggerLiquidationDiscounted` (Tier-3 default 5% discount on
    // a 1:1 oracle-priced loan).
    uint256 constant COLLATERAL_SEIZED = 1_050 ether;
    // Mock-swap converts 1 collateral → 1.05 principal (a 5%
    // profitable trade — emulates a healthy DEX where the
    // liquidator's discount cleanly nets after swap slippage).
    uint256 constant SWAP_PROCEEDS = 1_102 ether + 500_000_000_000_000_000; // 1102.5 ether
    uint256 constant LOAN_ID = 42;

    function setUp() public {
        principal = new ERC20Mock("Principal", "PRI", 18);
        collateral = new ERC20Mock("Collateral", "COL", 18);

        aavePool = new MockAaveV3Pool();
        balancerVault = new MockBalancerV2Vault();
        diamond = new MockDiamond();
        swap = new MockSwapAggregator();

        // Pre-fund the providers + diamond + swap so the mock-
        // flash-loan flow has real ERC20 movements.
        principal.mint(address(aavePool), 10_000 ether);
        principal.mint(address(balancerVault), 10_000 ether);
        collateral.mint(address(diamond), 10_000 ether);
        principal.mint(address(swap), 10_000 ether);

        liquidator = new FlashLoanLiquidator(
            owner,
            address(diamond),
            address(aavePool),
            address(balancerVault)
        );

        // Wire the mock components so they know each other's
        // addresses where the flow needs cross-talk.
        aavePool.setPrincipal(address(principal));
        aavePool.setPremiumBps(AAVE_PREMIUM_BPS);
        balancerVault.setPrincipal(address(principal));
        diamond.setAssets(address(principal), address(collateral));
        diamond.setDebt(FLASH_LOAN_AMOUNT);
        diamond.setSeizureAmount(COLLATERAL_SEIZED);
        swap.setIO(address(collateral), address(principal));
        swap.setRateMul(105);   // 1.05× = 5% profitable swap
        swap.setRateDiv(100);

        address[] memory targets = new address[](1);
        targets[0] = address(swap);
        adapter = new ZeroExAggregatorAdapter(address(this), address(swap), targets);
        diamond.addSwapAdapter(address(adapter));
    }

    // ─── Constructor guards ──────────────────────────────────────────

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(bytes("owner"));
        new FlashLoanLiquidator(
            address(0),
            address(diamond),
            address(aavePool),
            address(balancerVault)
        );
    }

    function testConstructorRejectsZeroDiamond() public {
        vm.expectRevert(bytes("diamond"));
        new FlashLoanLiquidator(
            owner,
            address(0),
            address(aavePool),
            address(balancerVault)
        );
    }

    function testConstructorRejectsNoProviders() public {
        vm.expectRevert(bytes("no provider"));
        new FlashLoanLiquidator(owner, address(diamond), address(0), address(0));
    }

    function testConstructorAllowsAaveOnlyChain() public {
        // Chains without Balancer V2 (e.g. BNB) — should construct.
        FlashLoanLiquidator l = new FlashLoanLiquidator(
            owner,
            address(diamond),
            address(aavePool),
            address(0)
        );
        assertEq(l.BALANCER_V2_VAULT(), address(0));
        assertEq(l.AAVE_V3_POOL(), address(aavePool));
    }

    function testConstructorAllowsBalancerOnlyChain() public {
        // Symmetric — Balancer V2 only, no Aave.
        FlashLoanLiquidator l = new FlashLoanLiquidator(
            owner,
            address(diamond),
            address(0),
            address(balancerVault)
        );
        assertEq(l.AAVE_V3_POOL(), address(0));
        assertEq(l.BALANCER_V2_VAULT(), address(balancerVault));
    }

    // ─── Owner-gate enforcement ──────────────────────────────────────

    function testLiquidateViaAaveV3RevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanLiquidator.NotOwner.selector);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    function testLiquidateViaBalancerV2RevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanLiquidator.NotOwner.selector);
        liquidator.liquidateViaBalancerV2(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    function testWithdrawRevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanLiquidator.NotOwner.selector);
        liquidator.withdraw(address(principal), 1 ether);
    }

    // ─── Callback validation ─────────────────────────────────────────

    function testExecuteOperationRevertsIfNotInFlight() public {
        // The provider itself calling back with no run committed.
        vm.prank(address(aavePool));
        vm.expectRevert(FlashLoanLiquidator.NotInFlight.selector);
        liquidator.executeOperation(
            address(principal),
            FLASH_LOAN_AMOUNT,
            FLASH_FEE,
            address(liquidator),
            ""
        );
    }

    function testReceiveFlashLoanRevertsIfNotInFlight() public {
        IERC20[] memory toks = new IERC20[](1);
        toks[0] = IERC20(address(principal));
        uint256[] memory amts = new uint256[](1);
        amts[0] = FLASH_LOAN_AMOUNT;
        uint256[] memory fees = new uint256[](1);
        fees[0] = 0;

        vm.prank(address(balancerVault));
        vm.expectRevert(FlashLoanLiquidator.NotInFlight.selector);
        liquidator.receiveFlashLoan(toks, amts, fees, "");
    }

    function testCallbackFromNonProviderReverts() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(FlashLoanLiquidator.NotFlashLoanProvider.selector, address(aavePool), attacker)
        );
        liquidator.executeOperation(address(principal), 1, 0, address(liquidator), "");
    }

    // ─── #2697 one run per owner call ────────────────────────────────

    /// A nested Balancer loan opened mid-run (Balancer accepts any
    /// recipient) cannot run a second liquidation with its own calldata.
    function testNestedBalancerLoanDuringAaveRunIsRefused() public {
        NestingSwap nester = _nester();
        nester.arm(NestingSwap.Via.Balancer, abi.encode(uint256(1)));
        _runAaveVia(nester);
        assertEq(nester.nestedRevert(), FlashLoanLiquidator.NotInFlight.selector, "nested callback refused");
    }

    /// Even the run's own parameters, replayed through the same provider,
    /// are refused: the first callback spent the commitment.
    function testReplayedCallbackDuringRunIsRefused() public {
        NestingSwap nester = _nester();
        nester.arm(NestingSwap.Via.AaveReplay, "");
        _runAaveVia(nester);
        assertEq(nester.nestedRevert(), FlashLoanLiquidator.NotInFlight.selector, "replay refused");
    }

    /// The nesting route behind its own registered aggregator adapter, which
    /// pins the nester as both allowance and call target.
    function _nester() internal returns (NestingSwap nester) {
        nester = new NestingSwap(liquidator, aavePool, balancerVault, swap, principal);
        principal.mint(address(nester), 10_000 ether);
        address[] memory targets = new address[](1);
        targets[0] = address(nester);
        ZeroExAggregatorAdapter nestAdapter = new ZeroExAggregatorAdapter(address(this), address(nester), targets);
        diamond.addSwapAdapter(address(nestAdapter));
        nester.setAdapter(address(nestAdapter));
    }

    function _runAaveVia(NestingSwap nester) internal {
        bytes memory data = nester.adapterData();
        address nestAdapter = nester.adapter();
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, nestAdapter, data);
    }

    // ─── Happy paths ─────────────────────────────────────────────────

    function testAaveV3HappyPath() public {
        uint256 balBefore = principal.balanceOf(address(liquidator));

        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );

        // Net profit = swap proceeds (1102.5 ether) - debt (1000) - fee (0.5)
        //            = 102 ether
        uint256 balAfter = principal.balanceOf(address(liquidator));
        assertEq(
            balAfter - balBefore,
            SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE,
            "net profit"
        );
        // All collateral seized was swapped out.
        assertEq(collateral.balanceOf(address(liquidator)), 0, "no collateral left");
    }

    function testBalancerV2HappyPath() public {
        uint256 balBefore = principal.balanceOf(address(liquidator));

        vm.prank(owner);
        liquidator.liquidateViaBalancerV2(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );

        // Balancer V2 mock has zero fee — net profit = swap proceeds - debt
        uint256 balAfter = principal.balanceOf(address(liquidator));
        assertEq(
            balAfter - balBefore,
            SWAP_PROCEEDS - FLASH_LOAN_AMOUNT,
            "net profit"
        );
        assertEq(collateral.balanceOf(address(liquidator)), 0, "no collateral left");
    }

    // ─── Unprofitable trade reverts ─────────────────────────────────

    /// @dev #2734 — the adapter is told what the run needs back (debt, fee
    ///      and `minProfit`) and refuses a sale that delivers less.
    function testRevertsWhenSwapProceedsBelowDebtPlusFee() public {
        // 0.95× = 997.5 ether < debt + fee 1000.5.
        swap.setRateMul(95);
        swap.setRateDiv(100);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorAdapterBase.InsufficientOutput.selector,
                (COLLATERAL_SEIZED * 95) / 100,
                FLASH_LOAN_AMOUNT + FLASH_FEE
            )
        );
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    function testRevertsWhenSwapTargetReverts() public {
        // Make the swap mock revert outright — simulates a stale
        // aggregator route or price-moved-since-quote scenario.
        swap.setShouldRevert(true);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorAdapterBase.RouterCallFailed.selector,
                abi.encodeWithSignature("Error(string)", "swap reverted")
            )
        );
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    // ─── Provider-not-configured branches ───────────────────────────

    function testRevertsAaveV3WhenAaveNotConfigured() public {
        FlashLoanLiquidator l = new FlashLoanLiquidator(
            owner,
            address(diamond),
            address(0),
            address(balancerVault)
        );
        vm.prank(owner);
        vm.expectRevert(FlashLoanLiquidator.ProviderNotConfigured.selector);
        l.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    function testRevertsBalancerV2WhenBalancerNotConfigured() public {
        FlashLoanLiquidator l = new FlashLoanLiquidator(
            owner,
            address(diamond),
            address(aavePool),
            address(0)
        );
        vm.prank(owner);
        vm.expectRevert(FlashLoanLiquidator.ProviderNotConfigured.selector);
        l.liquidateViaBalancerV2(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
    }

    // ─── #961 — measured against this run, not the standing balance ─

    /// @dev The contract keeps earned profit until the owner sweeps it.
    ///      A swap that under-delivers must revert even when that
    ///      standing balance could cover the shortfall.
    ///      Run through an adapter that ignores its minimum, so the
    ///      liquidator's own balance check is what refuses it.
    function testRevertsWhenLossIsCoveredOnlyByStandingBalance() public {
        uint256 standing = 500 ether;
        principal.mint(address(liquidator), standing);
        swap.setRateMul(95); // proceeds 997.5 < debt + fee 1000.5
        swap.setRateDiv(100);
        LaxAdapter lax = _laxAdapter();

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.InsufficientPostSwapBalance.selector,
                standing + FLASH_LOAN_AMOUNT + FLASH_FEE,
                standing + (COLLATERAL_SEIZED * 95) / 100
            )
        );
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(lax), _adapterData()
        );
    }

    /// @dev `netProfit` is this run's gain, not the standing balance
    ///      plus it.
    function testNetProfitExcludesStandingBalance() public {
        uint256 standing = 500 ether;
        principal.mint(address(liquidator), standing);

        vm.expectEmit(true, true, true, true, address(liquidator));
        emit FlashLoanLiquidator.FlashLoanLiquidationCompleted(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            FLASH_FEE,
            COLLATERAL_SEIZED,
            COLLATERAL_SEIZED,
            SWAP_PROCEEDS,
            SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE
        );
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
        assertEq(
            principal.balanceOf(address(liquidator)),
            standing + SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE,
            "standing balance kept, profit added"
        );
    }

    /// @dev Collateral left over from an earlier run is neither counted
    ///      as seized nor offered to this run's swap.
    function testStandingCollateralIsNotCountedOrApproved() public {
        uint256 standingCollateral = 100 ether;
        collateral.mint(address(liquidator), standingCollateral);

        vm.expectEmit(true, true, true, true, address(liquidator));
        emit FlashLoanLiquidator.FlashLoanLiquidationCompleted(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            FLASH_FEE,
            COLLATERAL_SEIZED,
            COLLATERAL_SEIZED,
            SWAP_PROCEEDS,
            SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE
        );
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );
        assertEq(collateral.balanceOf(address(liquidator)), standingCollateral, "standing collateral untouched");
        assertEq(collateral.allowance(address(liquidator), address(adapter)), 0, "no allowance left");
    }

    // ─── Withdraw path ───────────────────────────────────────────────

    function testWithdrawSweepsProfitToOwner() public {
        // Run a successful liquidation first so there's profit
        // sitting in the contract.
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            COLLATERAL_SEIZED,
            0,
            address(adapter), _adapterData()
        );

        uint256 profit = principal.balanceOf(address(liquidator));
        assertGt(profit, 0, "should have profit");
        uint256 ownerBefore = principal.balanceOf(owner);

        vm.prank(owner);
        liquidator.withdraw(address(principal), profit);

        assertEq(principal.balanceOf(owner) - ownerBefore, profit);
        assertEq(principal.balanceOf(address(liquidator)), 0);
    }

    // ─── #2697 — the preview sizes the run ──────────────────────────

    /// @dev The flash loan is the debt the Diamond previews in the same
    ///      transaction, not a figure the caller supplies.
    function testFlashBorrowsExactlyThePreviewedDebt() public {
        uint256 debt = 987 ether;
        diamond.setDebt(debt);
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
        assertEq(aavePool.lastAmount(), debt, "flash-borrowed the previewed debt");
        assertEq(principal.allowance(address(liquidator), address(diamond)), 0, "no Diamond allowance left");
    }

    /// @dev A Diamond that pulls less than it previewed leaves no allowance
    ///      behind: it is cleared after the call whatever it consumed.
    function testDiamondAllowanceClearedAfterTrigger() public {
        diamond.setPull(FLASH_LOAN_AMOUNT - 1 ether);
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
        assertEq(principal.allowance(address(liquidator), address(diamond)), 0, "allowance cleared");
    }

    function testRevertsWhenPreviewSaysNotLiquidatable() public {
        diamond.setStatus(LibDiscountedLiquidation.Status.Healthy);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.NotLiquidatable.selector,
                LOAN_ID,
                uint8(LibDiscountedLiquidation.Status.Healthy)
            )
        );
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
    }

    /// @dev Refused before any flash loan when the preview already delivers
    ///      less than the swap was quoted for.
    function testRevertsBeforeFlashWhenPreviewSeizureBelowQuote() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.SeizureBelowQuote.selector, COLLATERAL_SEIZED, COLLATERAL_SEIZED + 1
            )
        );
        liquidator.liquidateViaBalancerV2(
            LOAN_ID, COLLATERAL_SEIZED + 1, 0, address(adapter), _adapterData()
        );
        assertEq(aavePool.lastAmount(), 0, "no flash loan taken");
    }

    /// @dev Measured again after the trigger: a delivery short of the quote
    ///      reverts the run.
    function testRevertsWhenDeliveredSeizureBelowQuote() public {
        diamond.setDelivered(COLLATERAL_SEIZED - 1);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.SeizureBelowQuote.selector, COLLATERAL_SEIZED - 1, COLLATERAL_SEIZED
            )
        );
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
    }

    /// @dev Only the quoted amount is offered to the swap; the rest of the
    ///      seizure stays here as standing balance and the event says so.
    function testSellsOnlyTheQuotedAmount() public {
        uint256 seized = COLLATERAL_SEIZED + 50 ether;
        diamond.setSeizureAmount(seized);
        vm.expectEmit(true, true, true, true, address(liquidator));
        emit FlashLoanLiquidator.FlashLoanLiquidationCompleted(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            FLASH_FEE,
            seized,
            COLLATERAL_SEIZED,
            SWAP_PROCEEDS,
            SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE
        );
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
        assertEq(collateral.balanceOf(address(liquidator)), 50 ether, "unsold seizure kept");
        assertEq(collateral.allowance(address(liquidator), address(adapter)), 0, "no allowance left");
    }

    /// @dev The run must keep `minProfit` on top of the flash-loan fee:
    ///      the adapter is asked for it, and the liquidator checks its own
    ///      balance whatever the adapter does (here one ignoring its minimum).
    function testMinProfitIsEnforced() public {
        uint256 profit = SWAP_PROCEEDS - FLASH_LOAN_AMOUNT - FLASH_FEE;
        LaxAdapter lax = _laxAdapter();
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.InsufficientPostSwapBalance.selector,
                FLASH_LOAN_AMOUNT + FLASH_FEE + profit + 1,
                SWAP_PROCEEDS
            )
        );
        liquidator.liquidateViaAaveV3(
            LOAN_ID, COLLATERAL_SEIZED, profit + 1, address(lax), _adapterData()
        );

        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, profit, address(adapter), _adapterData());
        assertEq(principal.balanceOf(address(liquidator)), profit, "exactly the floor kept");
    }

    // ─── #2734 — the sale runs only through a Diamond-routed adapter ──

    /// @dev A swap target named directly (the quote API's own router) is not
    ///      a registered adapter, so the run is refused before any flash loan.
    function testRefusesAnAdapterTheDiamondDoesNotRoute() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FlashLoanLiquidator.SwapAdapterNotRouted.selector, address(swap)));
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(swap), _swapCalldata());
        assertEq(aavePool.lastAmount(), 0, "no flash loan taken");
    }

    /// @dev Governance disabling the venue on the Diamond disables it here.
    function testRefusesAnAdapterTheDiamondDisabled() public {
        diamond.setDisabled(address(adapter), true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FlashLoanLiquidator.SwapAdapterNotRouted.selector, address(adapter)));
        liquidator.liquidateViaBalancerV2(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
    }

    /// @dev A hostile quote naming a call target outside the adapter's
    ///      allow-list (here the principal token, to move this contract's
    ///      standing profit) is refused by the adapter, and the approval
    ///      never reaches anything but the adapter.
    function testHostileQuoteTargetIsRefusedByTheAdapter() public {
        principal.mint(address(liquidator), 500 ether);
        bytes memory hostile = abi.encode(
            address(principal), abi.encodeWithSelector(IERC20.transfer.selector, attacker, 500 ether)
        );
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AggregatorAdapterBase.SwapTargetNotAllowed.selector, address(principal))
        );
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), hostile);
        assertEq(principal.balanceOf(attacker), 0, "nothing moved");
    }

    /// @dev Only the adapter is ever approved, and the approval is cleared.
    function testOnlyTheAdapterIsApprovedAndItIsCleared() public {
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
        assertEq(collateral.allowance(address(liquidator), address(adapter)), 0, "adapter allowance cleared");
        assertEq(collateral.allowance(address(liquidator), address(swap)), 0, "router never approved");
    }

    /// @dev The event reports the collateral the adapter actually took: a
    ///      router filling part of the order leaves the rest here.
    function testCollateralSoldIsMeasured() public {
        swap.setFillBps(8_000); // sells 80% of what it is offered
        swap.setRateMul(130); // at a rate that still repays the run
        uint256 sold = (COLLATERAL_SEIZED * 8_000) / 10_000;
        uint256 proceeds = (sold * 130) / 100;
        vm.expectEmit(true, true, true, true, address(liquidator));
        emit FlashLoanLiquidator.FlashLoanLiquidationCompleted(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            FLASH_FEE,
            COLLATERAL_SEIZED,
            sold,
            proceeds,
            proceeds - FLASH_LOAN_AMOUNT - FLASH_FEE
        );
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(LOAN_ID, COLLATERAL_SEIZED, 0, address(adapter), _adapterData());
        assertEq(collateral.balanceOf(address(liquidator)), COLLATERAL_SEIZED - sold, "unsold part returned");
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /// The quote bytes the registered aggregator adapter takes.
    function _adapterData() internal view returns (bytes memory) {
        return abi.encode(address(swap), _swapCalldata());
    }

    /// A registered adapter that ignores its minimum output, so a test can
    /// reach the liquidator's own balance check.
    function _laxAdapter() internal returns (LaxAdapter lax) {
        lax = new LaxAdapter();
        diamond.addSwapAdapter(address(lax));
    }

    function _swapCalldata() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            MockSwapAggregator.swap.selector,
            address(collateral),
            address(principal),
            COLLATERAL_SEIZED
        );
    }
}

// ─── Mocks ───────────────────────────────────────────────────────────

contract MockAaveV3Pool is IAaveV3Pool {
    address public principalAsset;
    uint16 public premiumBpsLocal;
    uint256 public lastAmount;

    function setPrincipal(address a) external { principalAsset = a; }
    function setPremiumBps(uint256 bps) external { premiumBpsLocal = SafeCast.toUint16(bps); }

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128) {
        return uint128(premiumBpsLocal);
    }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        uint256 premium = (amount * premiumBpsLocal) / 10_000;
        lastAmount = amount;
        // Send funds to receiver
        IERC20(asset).transfer(receiver, amount);
        // Sync callback — must return true
        bool ok = IFlashLoanSimpleReceiver(receiver).executeOperation(
            asset,
            amount,
            premium,
            receiver,
            params
        );
        require(ok, "callback false");
        // Pull principal + premium back
        IERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }
}

contract MockBalancerV2Vault is IBalancerV2Vault {
    address public principalAsset;

    function setPrincipal(address a) external { principalAsset = a; }

    function flashLoan(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        // Send funds
        for (uint256 i = 0; i < tokens.length; ++i) {
            IERC20(tokens[i]).transfer(address(recipient), amounts[i]);
        }
        // Fees are zero on this mock (Balancer V2's actual fee
        // model is fee-less for most assets).
        uint256[] memory fees = new uint256[](tokens.length);

        // Convert address[] to IERC20[]
        IERC20[] memory tokenInterfaces = new IERC20[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) {
            tokenInterfaces[i] = IERC20(tokens[i]);
        }
        recipient.receiveFlashLoan(tokenInterfaces, amounts, fees, userData);
        // Repayment was already pushed by receiver — no pull here.
    }
}

contract MockDiamond {
    address public principal;
    address public collateral;
    uint256 public debt;
    uint256 public seizureAmount;
    /// @dev What the trigger actually delivers / pulls, when it differs
    ///      from the preview (0 = same as the preview).
    uint256 public deliveredOverride;
    uint256 public pullOverride;
    LibDiscountedLiquidation.Status public status = LibDiscountedLiquidation.Status.Ready;

    function setAssets(address p, address c) external {
        principal = p;
        collateral = c;
    }
    function setDebt(uint256 d) external { debt = d; }
    function setSeizureAmount(uint256 a) external { seizureAmount = a; }
    function setDelivered(uint256 a) external { deliveredOverride = a; }
    function setPull(uint256 a) external { pullOverride = a; }
    function setStatus(LibDiscountedLiquidation.Status s) external { status = s; }

    address[] internal adapters;
    mapping(address => bool) internal disabled;

    function addSwapAdapter(address a) external { adapters.push(a); }
    function setDisabled(address a, bool d) external { disabled[a] = d; }

    /// Mimics `AdminFacet.getSwapAdapters` / `isSwapAdapterDisabled`.
    function getSwapAdapters() external view returns (address[] memory) { return adapters; }
    function isSwapAdapterDisabled(address a) external view returns (bool) { return disabled[a]; }

    /// Mimics `ForcedSaleFacet.previewDiscountedLiquidation`.
    function previewDiscountedLiquidation(uint256)
        external
        view
        returns (LibDiscountedLiquidation.Preview memory p)
    {
        p.status = status;
        p.principalAsset = principal;
        p.collateralAsset = collateral;
        if (status != LibDiscountedLiquidation.Status.Ready) return p;
        p.tier = 3;
        p.discountBps = 500;
        p.debt = debt;
        p.seized = seizureAmount;
    }

    // Mimics `triggerLiquidationDiscounted` — pulls exactly the debt from
    // the caller (as `LibDelivery.pullExact` does), sends the seizure.
    function triggerLiquidationDiscounted(
        uint256 /* loanId */,
        address recipient,
        bytes calldata /* extraData */
    ) external {
        IERC20(principal).transferFrom(msg.sender, address(this), pullOverride == 0 ? debt : pullOverride);
        IERC20(collateral).transfer(recipient, deliveredOverride == 0 ? seizureAmount : deliveredOverride);
    }
}

contract MockSwapAggregator {
    address public sellToken;
    address public buyToken;
    uint256 public rateMul = 100;
    uint256 public rateDiv = 100;
    bool public shouldRevert;
    uint256 public fillBps = 10_000;

    // forge-lint: disable-next-line(mixed-case-function)
    function setIO(address sell, address buy) external {
        sellToken = sell;
        buyToken = buy;
    }
    function setRateMul(uint256 v) external { rateMul = v; }
    function setRateDiv(uint256 v) external { rateDiv = v; }
    function setShouldRevert(bool v) external { shouldRevert = v; }
    function setFillBps(uint256 v) external { fillBps = v; }

    function swap(
        address sell,
        address buy,
        uint256 amount
    ) external {
        if (shouldRevert) revert("swap reverted");
        require(sell == sellToken, "wrong sell");
        require(buy == buyToken, "wrong buy");
        // Pull sell-token via approval (a partial fill takes less).
        amount = (amount * fillBps) / 10_000;
        IERC20(sell).transferFrom(msg.sender, address(this), amount);
        // Send buy-token at the configured rate
        uint256 proceeds = (amount * rateMul) / rateDiv;
        IERC20(buy).transfer(msg.sender, proceeds);
    }
}

/// A swap route that, mid-run, tries to make the liquidator run a second
/// callback, records how that attempt reverted, then swaps honestly.
contract NestingSwap {
    enum Via { Balancer, AaveReplay }

    FlashLoanLiquidator immutable liquidator;
    MockAaveV3Pool immutable aave;
    MockBalancerV2Vault immutable balancer;
    MockSwapAggregator immutable honest;
    IERC20 immutable principal;
    address public adapter;
    Via via;
    bytes params;
    bytes4 public nestedRevert;

    constructor(
        FlashLoanLiquidator l,
        MockAaveV3Pool a,
        MockBalancerV2Vault b,
        MockSwapAggregator h,
        IERC20 p
    ) {
        liquidator = l;
        aave = a;
        balancer = b;
        honest = h;
        principal = p;
    }

    function setAdapter(address ad) external {
        adapter = ad;
    }

    /// The adapter quote bytes routing a sale through this contract.
    function adapterData() public view returns (bytes memory) {
        return abi.encode(
            address(this),
            abi.encodeWithSelector(this.swap.selector, honest.sellToken(), address(principal), 1_050 ether)
        );
    }

    function arm(Via v, bytes calldata p) external {
        via = v;
        params = p;
    }

    function swap(address sell, address buy, uint256 amount) external {
        bytes memory replay = params;
        if (via == Via.AaveReplay) {
            // The run's own params, read back from the outer call.
            replay = _outerParams();
        }
        try this.nest(replay) {
            nestedRevert = bytes4(0);
        } catch (bytes memory reason) {
            nestedRevert = bytes4(reason);
        }
        // Then swap at 1.05x, like the honest aggregator.
        IERC20(sell).transferFrom(msg.sender, address(this), amount);
        IERC20(buy).transfer(msg.sender, (amount * 105) / 100);
    }

    function nest(bytes memory p) external {
        if (via == Via.Balancer) {
            address[] memory toks = new address[](1);
            toks[0] = address(principal);
            uint256[] memory amts = new uint256[](1);
            amts[0] = 1;
            balancer.flashLoan(IFlashLoanRecipient(address(liquidator)), toks, amts, p);
        } else {
            aave.flashLoanSimple(address(liquidator), address(principal), 1, p, 0);
        }
    }

    function _outerParams() private view returns (bytes memory) {
        return abi.encode(
            FlashLoanLiquidator.Run({
                loanId: 42,
                collateralAsset: honest.sellToken(),
                sellAmount: 1_050 ether,
                minProfit: 0,
                swapAdapter: adapter,
                adapterData: adapterData()
            })
        );
    }
}

/// A registered adapter that sells through the aggregator but ignores
/// `minOutputAmount`, standing in for a venue whose own check is weaker
/// than the run needs.
contract LaxAdapter is ISwapAdapter {
    function adapterName() external pure returns (string memory) {
        return "Lax";
    }

    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256, /* minOutputAmount, ignored */
        address recipient,
        bytes calldata adapterData
    ) external returns (uint256 outputAmount) {
        (address target, bytes memory cd) = abi.decode(adapterData, (address, bytes));
        IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount);
        IERC20(inputToken).approve(target, inputAmount);
        uint256 before = IERC20(outputToken).balanceOf(address(this));
        (bool ok,) = target.call(cd);
        require(ok, "lax swap");
        outputAmount = IERC20(outputToken).balanceOf(address(this)) - before;
        IERC20(outputToken).transfer(recipient, outputAmount);
    }
}
