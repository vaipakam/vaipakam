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
            ORDER, address(token), AMOUNT, 0, expiresAt
        );

        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, 0, expiresAt);

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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ZeroToken() public {
        vm.expectRevert(LibTreasuryBuyback.BuybackZeroToken.selector);
        _t().commitBuybackIntent(
            ORDER, address(0), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ZeroAmount() public {
        vm.expectRevert(LibTreasuryBuyback.BuybackZeroAmount.selector);
        _t().commitBuybackIntent(
            ORDER, address(token), 0, 0, uint64(block.timestamp + 1 hours)
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
            ORDER, address(token), huge, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_ExpiryInPast() public {
        vm.expectRevert();
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp - 1)
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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_RevertWhen_RecommitExpiredHash() public {
        // Codex round-4 P2 #1 — an expired orderHash must not be
        // re-usable. The off-chain Fusion order signed against the
        // hash is still valid and could fill against the new
        // reservation with stale terms.
        // Anchor block.timestamp explicitly so the second commit's
        // recomputed expiresAt is a fresh value (foundry seeds the
        // test at block.timestamp = 1; the simpler `+ 1 hours` math
        // was triggering a cached-expression quirk).
        vm.warp(1_000_000);
        _seedBaseBudget(AMOUNT * 2);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(1_000_000 + 1 hours)
        );
        // Expire it.
        vm.warp(1_000_000 + 2 hours);
        _t().expireBuybackIntent(ORDER);
        // Re-commit the SAME orderHash.
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackOrderHashInUse.selector, ORDER
            )
        );
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(1_000_000 + 3 hours)
        );
    }

    function test_Commit_RevertWhen_DoubleCommitSameOrderHash() public {
        _seedBaseBudget(AMOUNT * 2);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, 0, expiresAt);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackOrderHashInUse.selector, ORDER
            )
        );
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, 0, expiresAt);
    }

    // ─── expire ──────────────────────────────────────────────────────

    function test_Expire_HappyPath() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
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
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, 0, expiresAt);

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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
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

    function test_IsValidSignature_BuybackReturnsInvalidInSub3B() public {
        // Codex round-4 P1 — BUYBACK signature validation is OFF in
        // Sub 3.B. The full Fusion-order-template validation ships
        // in Sub 3.C; until then isValidSignature always returns
        // 0xffffffff for BUYBACK orderHashes so no Fusion fill can
        // succeed through the diamond's ERC-1271 hook.
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        bytes4 ret = _d().isValidSignature(ORDER, "");
        assertEq(ret, bytes4(0xffffffff));
    }

    function test_IsValidSignature_UnknownReturnsInvalid() public view {
        bytes4 ret = _d().isValidSignature(bytes32(uint256(0xDEADBEEF)), "");
        assertEq(ret, bytes4(0xffffffff));
    }

    function test_IsValidSignature_AfterExpireReturnsInvalid() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        // LOP is the only authorised caller.
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");
    }

    function test_PreInteraction_RevertWhen_UnauthorisedCaller() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        uint256 stakingPre = _t().getStakingPoolBuybackBudget();
        uint256 delivered = 12_345e18;

        IOrderMixin.Order memory order;
        // preInteraction snapshots VPFI baseline.
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Simulate Fusion delivering VPFI into the diamond AND
        // pulling the committed source token out (round-3 P1 #2
        // verifies the source-token delta).
        vpfi.mint(address(diamond), delivered);
        vm.prank(address(diamond));
        token.transfer(lop, AMOUNT);

        vm.expectEmit(true, true, false, true, address(diamond));
        emit LibTreasuryBuyback.BuybackIntentFilled(
            ORDER, address(token), AMOUNT, delivered
        );

        // postInteraction reads the VPFI delta + verifies the
        // source-token spent (round-3 P1 #2). `makingAmount` must
        // equal the full reservation (round-2 P2 #2).
        vm.prank(lop);
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");

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
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackUnauthorizedCaller.selector,
                address(this)
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_PastDeadline() public {
        _seedBaseBudget(AMOUNT);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _t().commitBuybackIntent(ORDER, address(token), AMOUNT, 0, expiresAt);

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Warp to AT-OR-AFTER expiresAt. Round-2 P2 #1 — the cutoff
        // is `>=` so the exact boundary is rejected too.
        vm.warp(uint256(expiresAt));

        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackPastDeadline.selector,
                expiresAt,
                block.timestamp
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_PartialFill() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Half the reservation — partial fill.
        uint256 halfFill = AMOUNT / 2;
        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackPartialFill.selector, halfFill, AMOUNT
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), halfFill, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_PreNotFired() public {
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        // Skip preInteraction — call postInteraction directly.
        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackPreNotFired.selector, ORDER
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_BelowMinVpfiOut() public {
        // Codex round-3 P1 #1 — minVpfiOut floor enforced.
        uint128 minVpfiOut = 100e18;
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER,
            address(token),
            AMOUNT,
            uint256(minVpfiOut),
            uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Deliver less than the floor.
        uint256 delivered = 50e18;
        vpfi.mint(address(diamond), delivered);
        vm.prank(address(diamond));
        token.transfer(lop, AMOUNT);

        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackBelowMinVpfiOut.selector,
                delivered,
                minVpfiOut
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");
    }

    function test_PostInteraction_RevertWhen_SourceNotSpent() public {
        // Codex round-3 P1 #2 — source-token spent verification.
        _seedBaseBudget(AMOUNT);
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );

        IOrderMixin.Order memory order;
        vm.prank(lop);
        _d().preInteraction(order, "", ORDER, address(0), 0, 0, 0, "");

        // Deliver VPFI but DON'T burn/transfer the source token —
        // simulates a collision where the orderHash actually
        // settled an order on another maker asset.
        vpfi.mint(address(diamond), 1e18);

        vm.prank(lop);
        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackSourceTokenNotSpent.selector,
                uint256(AMOUNT),
                uint256(0)
            )
        );
        _d().postInteraction(order, "", ORDER, address(0), AMOUNT, 0, 0, "");
    }

    // ─── Round-3 P2 — tranche cap ────────────────────────────────────

    function test_Commit_RevertWhen_TrancheCapExceeded() public {
        _seedBaseBudget(AMOUNT);
        // Cap below AMOUNT.
        uint256 cap = AMOUNT - 1;
        _t().setBuybackMaxTranche(address(token), cap);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibTreasuryBuyback.BuybackTrancheCapExceeded.selector,
                address(token),
                uint256(AMOUNT),
                cap
            )
        );
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );
    }

    function test_Commit_TrancheCapZero_Disables() public {
        _seedBaseBudget(AMOUNT);
        // Default cap is 0 — no restriction.
        _t().commitBuybackIntent(
            ORDER, address(token), AMOUNT, 0, uint64(block.timestamp + 1 hours)
        );
        assertEq(_t().getBuybackMaxTranche(address(token)), 0);
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
