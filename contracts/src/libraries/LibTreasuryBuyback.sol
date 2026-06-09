// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title LibTreasuryBuyback — T-087 Sub 3.B
 *
 * Internal helpers for the buyback arm of the IntentDispatchFacet.
 * The Fusion `commit → fill → settle` lifecycle is broken into three
 * library entry points the surrounding facets call:
 *
 *   commitBuyback   — admin-only; reserves `amountIn` of `token` out
 *                     of `s.baseBuybackBudget` into
 *                     `s.baseBuybackReserved` and records the buyback
 *                     order ledger. Called from
 *                     `TreasuryFacet.commitBuybackIntent`.
 *   onFill          — called from `IntentDispatchFacet.postInteraction`
 *                     when the dispatch hits a BUYBACK kind. Releases
 *                     the reservation, credits the delivered VPFI to
 *                     `s.stakingPoolBuybackBudget`, marks the order
 *                     Filled, and clears the order-kind discriminator.
 *   expireBuyback   — permissionless; anyone can poke after a buyback
 *                     order's `expiresAt`. Rolls the reservation back
 *                     to `s.baseBuybackBudget`, marks the order
 *                     Expired, and clears the order-kind
 *                     discriminator. The matching Fusion order
 *                     becomes a noop on subsequent fills because
 *                     `s.orderHashKind[orderHash] == 0` causes the
 *                     dispatch facet to revert
 *                     `UnknownOrderKind`.
 *
 * Per the Sub 3.B card the actual 1inch Fusion intent submission +
 * TWAP order shape live in Sub 3.C — this library only knows about
 * the on-chain ledger.
 */
library LibTreasuryBuyback {
    using SafeERC20 for IERC20;

    // ─── Errors ──────────────────────────────────────────────────────

    /// @notice `commitBuyback` was called with a zero `amountIn`.
    error BuybackZeroAmount();
    /// @notice `commitBuyback` was called with a zero `token`.
    error BuybackZeroToken();
    /// @notice `commitBuyback` was called with `amountIn` that
    ///         doesn't fit in `uint96`. This caps a single buyback
    ///         at ~7.9e28 raw token units (more than any reasonable
    ///         protocol will accumulate); the cap exists so the
    ///         packed storage slot stays in a single word.
    error BuybackAmountOverflow(uint256 amountIn);
    /// @notice `commitBuyback` was called with `expiresAt` that
    ///         doesn't fit in `uint64`. Hard cap on the deadline.
    error BuybackExpiryOverflow(uint256 expiresAt);
    /// @notice `commitBuyback` was called with `expiresAt` in the
    ///         past. Operator typo; refuse before debiting the
    ///         budget.
    error BuybackExpiryInPast(uint64 expiresAt, uint256 nowSec);
    /// @notice `commitBuyback` was called twice with the same
    ///         orderHash. The first commit already stamped the
    ///         discriminator; a second commit would let the operator
    ///         double-reserve.
    error BuybackOrderHashInUse(bytes32 orderHash);
    /// @notice The Base-side consolidated budget cannot cover the
    ///         requested commit amount.
    error BuybackBudgetInsufficient(
        address token, uint256 requested, uint256 available
    );
    /// @notice `onFill` or `expireBuyback` referenced an unknown
    ///         orderHash (never committed, OR already terminal).
    error BuybackOrderNotPending(bytes32 orderHash, uint8 status);
    /// @notice `expireBuyback` was called before the order's
    ///         deadline; only the operator can fast-cancel before
    ///         expiry, and that path is intentionally absent in Sub
    ///         3.B (a stuck order's recovery is the operator's job
    ///         until the deadline; everyone else waits).
    error BuybackNotYetExpired(uint64 expiresAt, uint256 nowSec);
    /// @notice Codex Sub 3.B round-1 P1 #1 — `preInteractionImpl`
    ///         or `postInteractionImpl` was called by an address
    ///         that is not the configured 1inch
    ///         `cfgFusionLimitOrderProtocol`. Without this gate a
    ///         random caller could fabricate a fill and credit the
    ///         staking-pool budget with a phantom VPFI delta.
    error BuybackUnauthorizedCaller(address caller);
    /// @notice Codex Sub 3.B round-1 P1 #3 — `commitBuyback` was
    ///         called before `cfgFusionLimitOrderProtocol` is set.
    ///         The LOP allowance grant would otherwise approve the
    ///         zero address and Fusion fills would revert at fill
    ///         time.
    error BuybackLopNotConfigured();
    /// @notice Codex Sub 3.B round-1 P2 #1 — a Fusion fill landed
    ///         AFTER the on-chain `expiresAt`. We refuse to settle
    ///         late fills so the buyback budget isn't drained on a
    ///         stale order; the operator can `expireBuybackIntent`
    ///         + re-commit if it's still wanted.
    error BuybackPastDeadline(uint64 expiresAt, uint256 nowSec);

    // ─── Events ──────────────────────────────────────────────────────

    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentCommitted(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn,
        uint64 expiresAt
    );
    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentFilled(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn,
        uint256 deliveredVPFI
    );
    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentExpired(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn
    );

    // ─── Lifecycle ───────────────────────────────────────────────────

    /**
     * @dev Reserve `amountIn` of `token` for a future Fusion fill on
     *      `orderHash`. Debits `baseBuybackBudget`, credits
     *      `baseBuybackReserved`, records the buyback ledger entry,
     *      stamps `orderHashKind[orderHash] = ORDER_KIND_BUYBACK`,
     *      and emits `BuybackIntentCommitted`.
     *
     *      Auth is the FACET'S responsibility (admin-gated in
     *      `TreasuryFacet.commitBuybackIntent`); this helper just
     *      enforces shape + accounting invariants.
     */
    function commitBuyback(
        bytes32 orderHash,
        address token,
        uint256 amountIn,
        uint256 expiresAt
    ) internal {
        if (token == address(0)) revert BuybackZeroToken();
        if (amountIn == 0) revert BuybackZeroAmount();
        if (amountIn > type(uint96).max) revert BuybackAmountOverflow(amountIn);
        if (expiresAt > type(uint64).max) revert BuybackExpiryOverflow(expiresAt);
        if (expiresAt <= block.timestamp) {
            revert BuybackExpiryInPast(uint64(expiresAt), block.timestamp);
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Reject re-use of the same orderHash — covers both BUYBACK
        // and SWAP_TO_REPAY kinds. Stamping a non-zero discriminator
        // is the existence proof.
        if (s.orderHashKind[orderHash] != bytes32(0)) {
            revert BuybackOrderHashInUse(orderHash);
        }

        uint256 budget = s.baseBuybackBudget[token];
        if (amountIn > budget) {
            revert BuybackBudgetInsufficient(token, amountIn, budget);
        }
        // Codex Sub 3.B round-1 P1 #3 — LOP must be configured
        // before we can grant the allowance Fusion fills need to
        // pull the source token from the diamond.
        address lop = s.cfgFusionLimitOrderProtocol;
        if (lop == address(0)) revert BuybackLopNotConfigured();

        // CEI — accounting moves before the discriminator stamp.
        s.baseBuybackBudget[token] = budget - amountIn;
        s.baseBuybackReserved[token] += amountIn;

        s.buybackOrders[orderHash] = LibVaipakam.BuybackOrderInfo({
            token: token,
            amountIn: uint96(amountIn),
            expiresAt: uint64(expiresAt),
            status: LibVaipakam.BUYBACK_ORDER_STATUS_PENDING
        });
        s.orderHashKind[orderHash] = LibVaipakam.ORDER_KIND_BUYBACK;

        // Codex Sub 3.B round-1 P1 #3 — grant LOP an allowance for
        // the reserved amount via the shared aggregate counter so
        // it can pull the source token at fill time. The aggregate
        // is the same slot the swap-to-repay path uses; both arms
        // share LOP + the same approval slot, so we coexist by
        // summing into the counter and re-applying as the cap.
        s.intentAggregateAllowance[token] += amountIn;
        IERC20(token).forceApprove(lop, s.intentAggregateAllowance[token]);

        emit BuybackIntentCommitted(
            orderHash, token, uint96(amountIn), uint64(expiresAt)
        );
    }

    /**
     * @dev Codex Sub 3.B round-1 P1 #1 + P1 #2 — BUYBACK arm of
     *      the dispatcher's `preInteraction`. Auth-pinned to the
     *      configured 1inch LOP + snapshots the diamond's VPFI
     *      balance into transient storage keyed by orderHash. The
     *      matching `postInteractionImpl` reads the snapshot to
     *      compute the delivered-VPFI delta — `makingAmount` from
     *      Fusion can't be trusted (it's the source-side maker
     *      amount, not the VPFI received).
     */
    function preInteractionImpl(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.cfgFusionLimitOrderProtocol) {
            revert BuybackUnauthorizedCaller(msg.sender);
        }
        // EIP-1153 transient storage; per-tx-scoped, free at tx-end.
        uint256 baseline = IERC20(s.vpfiToken).balanceOf(address(this));
        assembly ("memory-safe") {
            tstore(orderHash, baseline)
        }
    }

    /**
     * @dev Settle a Fusion-filled buyback: auth-check, expiry-check,
     *      release the source-token reservation, credit the
     *      delivered VPFI to the staking-pool budget, decrement +
     *      re-apply the shared LOP allowance counter, mark the
     *      order Filled, and clear the order-kind discriminator.
     */
    function postInteractionImpl(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Codex round-1 P1 #1 — auth-pinned to the configured LOP.
        if (msg.sender != s.cfgFusionLimitOrderProtocol) {
            revert BuybackUnauthorizedCaller(msg.sender);
        }

        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        if (info.status != LibVaipakam.BUYBACK_ORDER_STATUS_PENDING) {
            revert BuybackOrderNotPending(orderHash, info.status);
        }
        // Codex round-1 P2 #1 — refuse to settle past the on-chain
        // deadline. A stale fill would otherwise drain the buyback
        // budget on an order the operator may have already moved on
        // from off-chain.
        if (block.timestamp > info.expiresAt) {
            revert BuybackPastDeadline(info.expiresAt, block.timestamp);
        }

        // Codex round-1 P1 #2 — measure VPFI delivered via balance
        // delta against the preInteraction snapshot. `makingAmount`
        // is the maker-side (source-token sold), not the VPFI
        // received — passing it through unaudited credited the
        // staking pool in the wrong units.
        uint256 baseline;
        assembly ("memory-safe") {
            baseline := tload(orderHash)
            tstore(orderHash, 0)
        }
        uint256 actualVpfi =
            IERC20(s.vpfiToken).balanceOf(address(this)) - baseline;

        // Release the reservation.
        s.baseBuybackReserved[info.token] -= info.amountIn;

        // Credit the delivered VPFI to the staking-pool buyback
        // budget — Sub 3 add-on #472 will later split between
        // rewards-budget + keeper-budget + staking-pool.
        s.stakingPoolBuybackBudget += actualVpfi;

        // Codex round-1 P1 #3 — decrement the shared aggregate
        // allowance + re-apply the cap so an in-flight commit on
        // the same token still has a valid pull-through.
        address lop = s.cfgFusionLimitOrderProtocol;
        s.intentAggregateAllowance[info.token] -= info.amountIn;
        IERC20(info.token).forceApprove(lop, 0);
        if (s.intentAggregateAllowance[info.token] != 0) {
            IERC20(info.token).forceApprove(
                lop, s.intentAggregateAllowance[info.token]
            );
        }

        // Mark Filled + clear the kind discriminator so any later
        // replay against this orderHash is rejected.
        s.buybackOrders[orderHash].status =
            LibVaipakam.BUYBACK_ORDER_STATUS_FILLED;
        delete s.orderHashKind[orderHash];

        emit BuybackIntentFilled(
            orderHash, info.token, info.amountIn, actualVpfi
        );
    }

    /**
     * @dev Permissionless rollback after a buyback order's deadline.
     *      Releases the reservation back to `baseBuybackBudget`,
     *      marks the order Expired, and clears the kind
     *      discriminator. Useful for unwinding orders the Fusion
     *      solver never filled (offer not competitive, network
     *      congestion past expiry, etc.).
     */
    function expireBuyback(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        if (info.status != LibVaipakam.BUYBACK_ORDER_STATUS_PENDING) {
            revert BuybackOrderNotPending(orderHash, info.status);
        }
        if (block.timestamp < info.expiresAt) {
            revert BuybackNotYetExpired(info.expiresAt, block.timestamp);
        }

        // Roll the reservation back to the spendable budget.
        s.baseBuybackReserved[info.token] -= info.amountIn;
        s.baseBuybackBudget[info.token] += info.amountIn;

        // Roll the LOP allowance back via the shared aggregate
        // counter so the dispatcher's invariants hold for any
        // other in-flight commits on the same token.
        address lop = s.cfgFusionLimitOrderProtocol;
        s.intentAggregateAllowance[info.token] -= info.amountIn;
        if (lop != address(0)) {
            IERC20(info.token).forceApprove(lop, 0);
            if (s.intentAggregateAllowance[info.token] != 0) {
                IERC20(info.token).forceApprove(
                    lop, s.intentAggregateAllowance[info.token]
                );
            }
        }

        s.buybackOrders[orderHash].status =
            LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED;
        delete s.orderHashKind[orderHash];

        emit BuybackIntentExpired(orderHash, info.token, info.amountIn);
    }
}
