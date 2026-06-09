// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {IntentDispatchFacet} from "../src/facets/IntentDispatchFacet.sol";
import {IntentConfigFacet} from "../src/facets/IntentConfigFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {LibTreasuryBuyback} from "../src/libraries/LibTreasuryBuyback.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IOrderMixin} from
    "@1inch/limit-order-protocol/contracts/interfaces/IOrderMixin.sol";

/// @dev Trivial contract stub for setBuybackRemittanceReceiver.
contract _ContractStub {}

/// @dev Stand-in for the 1inch LOP — only needs an address.
contract _MockLOP {}

/// @title BuybackIntentLedgerTest
/// @notice T-087 Sub 3.B — buyback ledger + BUYBACK arm of
///         IntentDispatchFacet (post-round-1 fold).
contract BuybackIntentLedgerTest is SetupTest {
    ERC20Mock internal token;
    ERC20Mock internal vpfi;
    address internal receiver;
    address internal lop;
    bytes32 internal constant ORDER = keccak256("vaipakam.test.order.0");
    uint96 internal constant AMOUNT = 1_000e6;

    function setUp() public {
        setupHelper();
        token = new ERC20Mock("USDC", "USDC", 6);
        vpfi = new ERC20Mock("VPFI", "VPFI", 18);
        receiver = address(new _ContractStub());
        lop = address(new _MockLOP());

        // Required by Sub 3.B's BUYBACK pre/postInteraction arms.
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        IntentConfigFacet(address(diamond)).setFusionLimitOrderProtocol(lop);
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    function _d() internal view returns (IntentDispatchFacet) {
        return IntentDispatchFacet(address(diamond));
    }

    function _seedBaseBudget(uint256 amount) internal {
        _t().setBuybackRemittanceReceiver(receiver);
        // Fund the diamond with the source token so the LOP can pull
        // at fill time (the receiver normally forwards delivered
        // tokens — for tests we mint directly).
        token.mint(address(diamond), amount);
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

        assertEq(_t().getBaseBuybackBudget(address(token)), 0, "budget drained");
        assertEq(
            _t().getOrderHashKind(ORDER),
            LibVaipakam.ORDER_KIND_BUYBACK,
            "kind stamped"
        );
        // LOP allowance granted (round-1 P1 #3).
        assertEq(
            token.allowance(address(diamond), lop),
            AMOUNT,
            "LOP allowance granted"
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
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        vm.warp(block.timestamp + 2 hours);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentExpired(
            ORDER, address(token), AMOUNT
        );

        address anyone = makeAddr("keeper");
        vm.prank(anyone);
        _t().expireBuybackIntent(ORDER);

        assertEq(_t().getBaseBuybackBudget(address(token)), AMOUNT, "budget restored");
        assertEq(_t().getOrderHashKind(ORDER), bytes32(0), "kind cleared");
        // LOP allowance rolled back to 0 (no other in-flight commits).
        assertEq(token.allowance(address(diamond), lop), 0, "LOP allowance cleared");
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
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );
        vm.warp(block.timestamp + 2 hours);
        _t().expireBuybackIntent(ORDER);

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

        bytes4 ret = _d().isValidSignature(ORDER, "");
        assertEq(ret, bytes4(0xffffffff));
    }

    // ─── IntentDispatchFacet — preInteraction (BUYBACK arm) ────────

    function test_PreInteraction_BuybackSnapshotsBaseline() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        // LOP is the only authorised caller.
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");
    }

    function test_PreInteraction_RevertWhen_UnauthorisedCaller() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        // Default test caller is not the LOP.
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackUnauthorizedCaller.selector,
                address(this)
            )
        );
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

    function test_PostInteraction_BuybackFillCreditsStakingPoolViaDelta() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        uint256 stakingPre = _t().getStakingPoolBuybackBudget();
        uint256 delivered = 12_345e18;

        IOrderMixin.Order memory order;
        // preInteraction snapshots VPFI baseline.
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Simulate Fusion delivering VPFI into the diamond before
        // calling postInteraction.
        vpfi.mint(address(diamond), delivered);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentFilled(
            ORDER, address(token), AMOUNT, delivered
        );

        // postInteraction reads the delta; makingAmount is ignored
        // for buyback (round-1 P1 #2).
        vm.prank(lop);
        _d().postInteraction(order, "", ORDER, address(0), 999, 0, 0, "");

        assertEq(
            _t().getStakingPoolBuybackBudget(),
            stakingPre + delivered,
            "staking pool credited by VPFI delta"
        );
        LibVaipakam.BuybackOrderInfo memory info = _t().getBuybackOrder(ORDER);
        assertEq(uint256(info.status), uint256(LibVaipakam.BUYBACK_ORDER_STATUS_FILLED));
        assertEq(_t().getOrderHashKind(ORDER), bytes32(0), "kind cleared on fill");
        // LOP allowance decremented to 0 (no other in-flight commits).
        assertEq(token.allowance(address(diamond), lop), 0, "LOP allowance cleared");
    }

    function test_PostInteraction_RevertWhen_UnauthorisedCaller() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackUnauthorizedCaller.selector,
                address(this)
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), 1, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_PastDeadline() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, expiresAt);

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Warp past deadline before postInteraction lands.
        vm.warp(uint256(expiresAt) + 1);

        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackPastDeadline.selector,
                expiresAt,
                block.timestamp
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), 1, 0, 0, "");
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
}
