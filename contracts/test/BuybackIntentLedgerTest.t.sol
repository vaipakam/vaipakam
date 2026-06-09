// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {LibTreasuryBuyback} from "../src/libraries/LibTreasuryBuyback.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IOrderMixin} from
    "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

/// @title BuybackIntentLedgerTest
/// @notice T-087 Sub 3.B — exercises the buyback ledger commit /
///         expire surface on TreasuryFacet + the BUYBACK arm of
///         IntentDispatchFacet. Doesn't cover SWAP_TO_REPAY's existing
///         tests in `SwapToRepayIntentFacetTest.t.sol` — those still
///         pass with the dispatcher routing.
contract BuybackIntentLedgerTest is SetupTest {
    ERC20Mock internal token;
    address internal receiver;
    bytes32 internal constant ORDER = keccak256("vaipakam.test.order.0");
    uint96 internal constant AMOUNT = 1_000e6;

    function setUp() public {
        setupHelper();
        token = new ERC20Mock("USDC", "USDC", 6);
        receiver = address(new _Stub());
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _d() internal view returns (IntentDispatchFacet) {
        return IntentDispatchFacet(address(diamond));
    }

    /// @dev Seed the Base-side buyback budget by calling the
    ///      sender-restricted `absorbRemittance` — same path Sub 3.A's
    ///      receiver uses on real CCIP delivery.
    function _seedBaseBudget(uint256 amount) internal {
        _t().setBuybackRemittanceReceiver(receiver);
        vm.prank(receiver);
        _t().absorbRemittance(address(token), amount, 11_155_111);
    }

    // ─── commit ──────────────────────────────────────────────────────

    function test_Commit_HappyPath() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentCommitted(
            ORDER, address(token), AMOUNT, expiresAt
        );

        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);

        // Reservation moved from budget to reserved.
        assertEq(_t().getBaseBuybackBudget(address(token)), 0, "budget drained");
        // The kind is stamped + the ledger entry recorded.
        assertEq(
            _t().getOrderHashKind(ORDER),
            LibVaipakam.ORDER_KIND_BUYBACK,
            "kind stamped"
        );
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(ORDER);
        assertEq(info.token, address(token));
        assertEq(uint256(info.amountIn), uint256(AMOUNT));
        assertEq(uint256(info.expiresAt), uint256(expiresAt));
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_PENDING));
    }

    function test_Commit_RevertWhen_NotAdmin() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ZeroToken() public {
        vm.expectRevert(LibTreasuryBuyback.BuybackZeroToken.selector);
        _t().commitBuybackIntent(
            ORDER, address(0), AMOUNT, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ZeroAmount() public {
        vm.expectRevert(LibTreasuryBuyback.BuybackZeroAmount.selector);
        _t().commitBuybackIntent(
            ORDER, address(token), 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_AmountOverflow() public {
        // 2^96 — one too many for uint96.
        uint256 huge = uint256(type(uint96).max) + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackAmountOverflow.selector, huge
            )
        );
        _t().commitBuybackIntent(
            ORDER, address(token), huge, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ExpiryInPast() public {
        vm.expectRevert();
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp - 1)
        );
    }

    function test_Commit_RevertWhen_BudgetInsufficient() public {
        _seedBaseBudget(AMOUNT / 2);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackBudgetInsufficient.selector,
                address(token),
                uint256(AMOUNT),
                uint256(AMOUNT / 2)
            )
        );
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_DoubleCommitSameOrderHash() public {
        _seedBaseBudget(AMOUNT * 2);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);
        // Re-commit on the same orderHash.
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackOrderHashInUse.selector, ORDER
            )
        );
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);
    }

    // ─── expire ──────────────────────────────────────────────────────

    function test_Expire_HappyPath() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);

        // Past expiry.
        vm.warp(block.timestamp + 2 hours);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentExpired(
            ORDER, address(token), AMOUNT
        );

        // Permissionless caller.
        address anyone = makeAddr("keeper");
        vm.prank(anyone);
        _t().expireBuybackIntent(ORDER);

        // Reservation rolled back to budget.
        assertEq(_t().getBaseBuybackBudget(address(token)), AMOUNT, "budget restored");
        // Kind discriminator cleared.
        assertEq(_t().getOrderHashKind(ORDER), bytes32(0), "kind cleared");
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(ORDER);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED));
    }

    function test_Expire_RevertWhen_NotYetExpired() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackNotYetExpired.selector,
                uint64(expiresAt),
                block.timestamp
            )
        );
        _t().expireBuybackIntent(ORDER);
    }

    function test_Expire_RevertWhen_NotPending() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);
        vm.warp(block.timestamp + 2 hours);
        _t().expireBuybackIntent(ORDER);

        // Re-expire on the same orderHash (now Expired status).
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackOrderNotPending.selector,
                ORDER,
                uint8(LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED)
            )
        );
        _t().expireBuybackIntent(ORDER);
    }

    // ─── IntentDispatchFacet — isValidSignature ───────────────────

    function test_IsValidSignature_BuybackPendingReturnsMagic() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        bytes4 magic = _d().isValidSignature(ORDER, "");
        assertEq(magic, IERC1271.isValidSignature.selector);
    }

    function test_IsValidSignature_UnknownReturnsInvalid() public view {
        bytes4 ret = _d().isValidSignature(bytes32(uint256(0xDEADBEEF)), "");
        assertEq(ret, bytes4(0xffffffff));
    }

    function test_IsValidSignature_AfterExpireReturnsInvalid() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );
        vm.warp(block.timestamp + 2 hours);
        _t().expireBuybackIntent(ORDER);

        // Kind cleared on expire — discriminator zero → invalid.
        bytes4 ret = _d().isValidSignature(ORDER, "");
        assertEq(ret, bytes4(0xffffffff));
    }

    // ─── IntentDispatchFacet — preInteraction (BUYBACK no-op) ─────

    function test_PreInteraction_BuybackNoOp() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        // For BUYBACK the dispatch arm returns silently; no revert.
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");
    }

    function test_PreInteraction_RevertWhen_UnknownKind() public {
        IOrderMixin.Order memory order;
        bytes32 stray = keccak256("never-committed");
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentDispatchFacet.UnknownOrderKind.selector, stray
            )
        );
        _d().preInteraction(order, "", stray, address(0), 0, 0, 0, "");
    }

    // ─── IntentDispatchFacet — postInteraction (BUYBACK arm) ──────

    function test_PostInteraction_BuybackFillCreditsStakingPool() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        uint256 stakingPre = _t().getStakingPoolBuybackBudget();

        uint256 delivered = 12_345e18; // amount of VPFI Fusion would have filled.

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentFilled(
            ORDER, address(token), AMOUNT, delivered
        );

        IOrderMixin.Order memory order;
        _d().postInteraction(order, "", ORDER, address(0), delivered, 0, 0, "");

        assertEq(
            _t().getStakingPoolBuybackBudget(),
            stakingPre + delivered,
            "staking pool credited"
        );
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(ORDER);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_FILLED));
        assertEq(_t().getOrderHashKind(ORDER), bytes32(0), "kind cleared on fill");
    }

    function test_PostInteraction_RevertWhen_UnknownKind() public {
        IOrderMixin.Order memory order;
        bytes32 stray = keccak256("never-committed-2");
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentDispatchFacet.UnknownOrderKind.selector, stray
            )
        );
        _d().postInteraction(order, "", stray, address(0), 1, 0, 0, "");
    }

    // ─── Helpers ─────────────────────────────────────────────────────

}

/// @dev A trivial contract used wherever the test needs to satisfy the
///      EOA-rejection guards (`buybackRemittanceReceiver` setter).
contract _Stub {}
