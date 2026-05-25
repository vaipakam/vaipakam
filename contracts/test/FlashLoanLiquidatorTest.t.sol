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
        diamond.setSeizureAmount(COLLATERAL_SEIZED);
        swap.setIO(address(collateral), address(principal));
        swap.setRateMul(105);   // 1.05× = 5% profitable swap
        swap.setRateDiv(100);
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
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
        );
    }

    function testLiquidateViaBalancerV2RevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanLiquidator.NotOwner.selector);
        liquidator.liquidateViaBalancerV2(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
        );
    }

    function testWithdrawRevertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FlashLoanLiquidator.NotOwner.selector);
        liquidator.withdraw(address(principal), 1 ether);
    }

    // ─── Callback validation ─────────────────────────────────────────

    function testExecuteOperationRevertsIfNotInFlight() public {
        // Direct call to the callback — no flash-loan in-flight.
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

        vm.expectRevert(FlashLoanLiquidator.NotInFlight.selector);
        liquidator.receiveFlashLoan(toks, amts, fees, "");
    }

    // ─── Happy paths ─────────────────────────────────────────────────

    function testAaveV3HappyPath() public {
        uint256 balBefore = principal.balanceOf(address(liquidator));

        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
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
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
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

    function testRevertsWhenSwapProceedsBelowDebtPlusFee() public {
        // Tighten the swap rate to 0.99× — proceeds = 1039.5 ether,
        // which is BELOW debt + fee (1000.5 ether). Wait, 1039.5 > 1000.5.
        // Let me make it 0.95× = 997.5 ether < 1000.5.
        swap.setRateMul(95);
        swap.setRateDiv(100);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlashLoanLiquidator.InsufficientPostSwapBalance.selector,
                FLASH_LOAN_AMOUNT + FLASH_FEE,
                (COLLATERAL_SEIZED * 95) / 100
            )
        );
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
        );
    }

    function testRevertsWhenSwapTargetReverts() public {
        // Make the swap mock revert outright — simulates a stale
        // aggregator route or price-moved-since-quote scenario.
        swap.setShouldRevert(true);

        vm.prank(owner);
        vm.expectRevert(FlashLoanLiquidator.SwapFailed.selector);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
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
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
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
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
        );
    }

    // ─── Withdraw path ───────────────────────────────────────────────

    function testWithdrawSweepsProfitToOwner() public {
        // Run a successful liquidation first so there's profit
        // sitting in the contract.
        vm.prank(owner);
        liquidator.liquidateViaAaveV3(
            LOAN_ID,
            address(principal),
            address(collateral),
            FLASH_LOAN_AMOUNT,
            address(swap),
            address(swap),
            _swapCalldata()
        );

        uint256 profit = principal.balanceOf(address(liquidator));
        assertGt(profit, 0, "should have profit");
        uint256 ownerBefore = principal.balanceOf(owner);

        vm.prank(owner);
        liquidator.withdraw(address(principal), profit);

        assertEq(principal.balanceOf(owner) - ownerBefore, profit);
        assertEq(principal.balanceOf(address(liquidator)), 0);
    }

    // ─── Helpers ─────────────────────────────────────────────────────

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
    uint256 public seizureAmount;

    function setAssets(address p, address c) external {
        principal = p;
        collateral = c;
    }
    function setSeizureAmount(uint256 a) external { seizureAmount = a; }

    // Mimics `triggerLiquidationDiscounted` — pulls principal from
    // caller, sends collateral to recipient.
    function triggerLiquidationDiscounted(
        uint256 /* loanId */,
        address recipient,
        bytes calldata /* extraData */
    ) external {
        // Pull the debt amount from caller (must approve first).
        // For simplicity, pull the entire allowance.
        uint256 allowance = IERC20(principal).allowance(msg.sender, address(this));
        IERC20(principal).transferFrom(msg.sender, address(this), allowance);
        // Send seized collateral to recipient
        IERC20(collateral).transfer(recipient, seizureAmount);
    }
}

contract MockSwapAggregator {
    address public sellToken;
    address public buyToken;
    uint256 public rateMul = 100;
    uint256 public rateDiv = 100;
    bool public shouldRevert;

    function setIO(address sell, address buy) external {
        sellToken = sell;
        buyToken = buy;
    }
    function setRateMul(uint256 v) external { rateMul = v; }
    function setRateDiv(uint256 v) external { rateDiv = v; }
    function setShouldRevert(bool v) external { shouldRevert = v; }

    function swap(
        address sell,
        address buy,
        uint256 amount
    ) external {
        if (shouldRevert) revert("swap reverted");
        require(sell == sellToken, "wrong sell");
        require(buy == buyToken, "wrong buy");
        // Pull sell-token via approval
        IERC20(sell).transferFrom(msg.sender, address(this), amount);
        // Send buy-token at the configured rate
        uint256 proceeds = (amount * rateMul) / rateDiv;
        IERC20(buy).transfer(msg.sender, proceeds);
    }
}
