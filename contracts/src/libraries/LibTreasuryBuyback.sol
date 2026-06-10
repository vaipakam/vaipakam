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
    ///         AT-OR-AFTER the on-chain `expiresAt`. We refuse to
    ///         settle late fills so the buyback budget isn't drained
    ///         on a stale order; the operator can
    ///         `expireBuybackIntent` + re-commit if it's still
    ///         wanted. The `>=` cutoff (round-2 P2 #1) ensures the
    ///         fill and expire paths never both succeed at the
    ///         exact `expiresAt` boundary.
    error BuybackPastDeadline(uint64 expiresAt, uint256 nowSec);
    /// @notice Codex Sub 3.B round-2 P1 #3 — `postInteractionImpl`
    ///         was called WITHOUT a prior `preInteractionImpl` for
    ///         this orderHash, so the VPFI baseline is unset. A
    ///         Fusion order that drops the pre-interaction call
    ///         would otherwise credit the diamond's entire current
    ///         VPFI balance as freshly delivered.
    error BuybackPreNotFired(bytes32 orderHash);
    /// @notice Codex Sub 3.B round-2 P2 #2 — Fusion delivered a
    ///         partial fill. Sub 3.B accepts only full fills
    ///         (operator must commit orders with
    ///         `allowPartialFills: false` and `allowMultipleFills:
    ///         false`); partial fills would otherwise release the
    ///         full reservation on the first partial settlement.
    error BuybackPartialFill(uint256 consumed, uint256 expected);
    /// @notice Codex Sub 3.B round-3 P1 #1 — actual VPFI delivered
    ///         was below the operator-pinned floor. Stops
    ///         underpriced fills from draining the source-token
    ///         reservation against a token-of-no-value VPFI tranche.
    error BuybackBelowMinVpfiOut(uint256 actualVpfi, uint128 minVpfiOut);
    /// @notice Codex Sub 3.B round-3 P1 #2 — the diamond's
    ///         source-token balance did NOT drop by `amountIn`
    ///         between preInteraction and postInteraction. Catches
    ///         the case where the Fusion order's maker asset is
    ///         different from the committed `info.token` (e.g.
    ///         orderHash points at an order against another token).
    error BuybackSourceTokenNotSpent(uint256 expected, uint256 actual);
    /// @notice Codex Sub 3.B round-3 P2 — `amountIn` exceeded the
    ///         per-token tranche cap; the operator must either
    ///         commit a smaller amount or first raise the cap via
    ///         governance.
    error BuybackTrancheCapExceeded(
        address token, uint256 requested, uint256 cap
    );

    // ─── Events ──────────────────────────────────────────────────────

    /// @custom:event-category state-change/buyback-intent
    event BuybackIntentCommitted(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 amountIn,
        uint128 minVpfiOut,
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
    /// @custom:event-category state-change/buyback-intent
    /// @notice T-087 Sub 3.C — emitted ONCE per orderHash, on the
    ///         FINAL partial fill that completes the TWAP order.
    ///         Indexer treats this as the terminal-fill signal.
    event BuybackIntentClosed(
        bytes32 indexed orderHash,
        address indexed token,
        uint96 totalAmountIn
    );
    /// @custom:event-category state-change/buyback-intent
    /// @notice T-087 Sub 3.C — set when the operator's order
    ///         template passed `LibBuybackOrderValidation`. The
    ///         dispatcher's `isValidSignature` returns the ERC-1271
    ///         magic value only for orderHashes with this flag.
    event BuybackIntentValidated(bytes32 indexed orderHash);

    /// @custom:event-category state-change/buyback-priority-router
    /// @notice T-087 Sub 3 add-on #472 — emitted per partial fill,
    ///         after the priority cascade. `delivered` is the total
    ///         VPFI delta; `toRewards` + `toKeepers` + `toStaking`
    ///         sum to `delivered`. Indexer uses this to attribute
    ///         the buyback proceeds to each destination budget.
    event BuybackPrioritySplit(
        uint256 delivered,
        uint256 toRewards,
        uint256 toKeepers,
        uint256 toStaking
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
        uint256 minVpfiOut,
        uint256 expiresAt
    ) internal {
        if (token == address(0)) revert BuybackZeroToken();
        if (amountIn == 0) revert BuybackZeroAmount();
        if (amountIn > type(uint96).max) revert BuybackAmountOverflow(amountIn);
        if (minVpfiOut > type(uint128).max) {
            // Codex round-3 P1 #1 — minVpfiOut is packed as uint128
            // in the order struct; refuse to silently truncate.
            revert BuybackAmountOverflow(minVpfiOut);
        }
        if (expiresAt > type(uint64).max) revert BuybackExpiryOverflow(expiresAt);
        if (expiresAt <= block.timestamp) {
            revert BuybackExpiryInPast(uint64(expiresAt), block.timestamp);
        }

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Codex round-3 P2 — per-token raw-amount tranche cap.
        // 0 disables the cap; non-zero enforces it.
        uint256 cap = s.cfgBuybackMaxTranche[token];
        if (cap != 0 && amountIn > cap) {
            revert BuybackTrancheCapExceeded(token, amountIn, cap);
        }

        // Reject re-use of the same orderHash — covers both BUYBACK
        // and SWAP_TO_REPAY kinds. Stamping a non-zero discriminator
        // is the existence proof.
        if (s.orderHashKind[orderHash] != bytes32(0)) {
            revert BuybackOrderHashInUse(orderHash);
        }
        // Codex Sub 3.B round-4 P2 #1 — also reject orderHashes
        // that previously held a buyback intent (Filled / Expired).
        // The off-chain Fusion order signed against this hash is
        // still valid; reusing the hash would let an old signed
        // order fill against the new reservation with stale terms.
        // Status NONE (0) is the only acceptable seed state.
        if (s.buybackOrders[orderHash].status !=
            LibVaipakam.BUYBACK_ORDER_STATUS_NONE) {
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
            minVpfiOut: uint128(minVpfiOut),
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

        // Codex Sub 3.B round-2 P1 #1 — bump the shared live-commit
        // counter so `IntentConfigFacet.setFusionLimitOrderProtocol`
        // refuses to rotate LOP while a buyback intent is in
        // flight. Without this the rotation would leave the
        // outgoing LOP holding a stranded allowance.
        s.intentLiveCommitCount += 1;

        emit BuybackIntentCommitted(
            orderHash,
            token,
            uint96(amountIn),
            uint128(minVpfiOut),
            uint64(expiresAt)
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
    /// @dev T-087 Sub 3.B round-3 P1 #2 — domain-separator constant
    ///      for the source-token baseline transient slot. Derived
    ///      key prevents collision between the VPFI baseline (at
    ///      `orderHash`) and the source baseline (at
    ///      `orderHash ^ SRC_BASELINE_KEY`).
    uint256 private constant SRC_BASELINE_KEY =
        uint256(keccak256("vaipakam.buyback.src.baseline"));

    /// @notice T-087 Sub 3.C — set the Sub-3.C "validated against
    ///         the canonical Fusion order template" flag. Called
    ///         from `TreasuryFacet.commitBuybackIntentValidated`
    ///         after `LibBuybackOrderValidation.validateBuybackOrder`
    ///         returns clean. The dispatcher's `isValidSignature`
    ///         returns the ERC-1271 magic value only when this flag
    ///         is set AND the order is still Pending.
    function markValidated(bytes32 orderHash) internal {
        LibVaipakam.storageSlot().buybackValidated[orderHash] = true;
        emit BuybackIntentValidated(orderHash);
    }

    function preInteractionImpl(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.cfgFusionLimitOrderProtocol) {
            revert BuybackUnauthorizedCaller(msg.sender);
        }
        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        // Codex Sub 3.B round-2 P1 #3 — store `baseline + 1` so a
        // tload reading zero in `postInteractionImpl` reliably
        // signals "pre-interaction never fired", regardless of
        // whether the actual VPFI balance happened to be zero. EIP-
        // 1153 transient storage; per-tx-scoped, free at tx-end.
        uint256 vpfiBaseline = IERC20(s.vpfiToken).balanceOf(address(this));
        uint256 vpfiMarker = vpfiBaseline + 1;
        // Codex round-3 P1 #2 — also snapshot the source-token
        // baseline so postInteractionImpl can verify the diamond's
        // INFO.TOKEN balance dropped by exactly `amountIn` (i.e.
        // the maker asset of the filled order was the committed
        // one, not a colliding orderHash on another token).
        uint256 srcBaseline = IERC20(info.token).balanceOf(address(this));
        uint256 srcMarker = srcBaseline + 1;
        uint256 srcKey = uint256(orderHash) ^ SRC_BASELINE_KEY;
        assembly ("memory-safe") {
            tstore(orderHash, vpfiMarker)
            tstore(srcKey, srcMarker)
        }
    }

    /**
     * @dev Settle a Fusion-filled buyback: auth-check, expiry-check,
     *      release the source-token reservation, credit the
     *      delivered VPFI to the staking-pool budget, decrement +
     *      re-apply the shared LOP allowance counter, mark the
     *      order Filled, and clear the order-kind discriminator.
     */
    function postInteractionImpl(bytes32 orderHash, uint256 consumed) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Codex round-1 P1 #1 — auth-pinned to the configured LOP.
        if (msg.sender != s.cfgFusionLimitOrderProtocol) {
            revert BuybackUnauthorizedCaller(msg.sender);
        }

        LibVaipakam.BuybackOrderInfo memory info = s.buybackOrders[orderHash];
        if (info.status != LibVaipakam.BUYBACK_ORDER_STATUS_PENDING) {
            revert BuybackOrderNotPending(orderHash, info.status);
        }
        // Codex round-1 P2 #1 + round-2 P2 #1 — refuse to settle
        // AT-OR-AFTER the on-chain deadline. The `>=` cutoff stops a
        // race with `expireBuyback` (which accepts at the boundary)
        // at the exact expiresAt second.
        if (block.timestamp >= info.expiresAt) {
            revert BuybackPastDeadline(info.expiresAt, block.timestamp);
        }

        // T-087 Sub 3.C — partial-fill aware. TWAP buyback orders
        // (`allowPartialFills=true`, `allowMultipleFills=true`) can
        // fire postInteraction multiple times against the same
        // orderHash; each fill consumes part of the makerAmount.
        // Track `consumedSoFar`; reject overflow; mark Filled only
        // when the cumulative consumed amount reaches `amountIn`.
        uint256 consumedSoFarBefore = uint256(s.buybackConsumedSoFar[orderHash]);
        uint256 remaining = uint256(info.amountIn) - consumedSoFarBefore;
        if (consumed == 0 || consumed > remaining) {
            revert BuybackPartialFill(consumed, remaining);
        }
        uint256 consumedSoFarAfter = consumedSoFarBefore + consumed;

        // Codex round-1 P1 #2 + round-2 P1 #3 — measure VPFI
        // delivered via balance delta against the preInteraction
        // snapshot. The +1 marker (see `preInteractionImpl`) lets
        // us reject a missing pre-interaction call.
        uint256 vpfiMarker;
        uint256 srcMarker;
        uint256 srcKey = uint256(orderHash) ^ SRC_BASELINE_KEY;
        assembly ("memory-safe") {
            vpfiMarker := tload(orderHash)
            srcMarker := tload(srcKey)
            tstore(orderHash, 0)
            tstore(srcKey, 0)
        }
        if (vpfiMarker == 0) revert BuybackPreNotFired(orderHash);
        uint256 vpfiBaseline = vpfiMarker - 1;
        uint256 srcBaseline = srcMarker - 1;
        uint256 actualVpfi =
            IERC20(s.vpfiToken).balanceOf(address(this)) - vpfiBaseline;

        // T-087 Sub 3.C round-1 P2 — cumulative pro-rata floor. A
        // pure per-partial floor with floor-division (`floor(minVpfiOut
        // * consumed / amountIn)`) lets rounding loss compound: many
        // tiny fills each round their share down to 0 and the order
        // can settle with total delivered VPFI below minVpfiOut.
        // Compare cumulative actual VPFI (tracked in
        // `stakingPoolBuybackBudget` delta against the start-of-order
        // snapshot taken at commit-time) against cumulative required.
        //
        // Trick: we only need to track *cumulative delivered VPFI per
        // order* across partials. We could persist it as another
        // mapping, but we can derive it inline using the order's
        // stakingPoolBuybackBudget contribution. The simplest correct
        // approach is to require, on every partial: cumulative
        // required <= cumulative delivered. Cumulative delivered =
        // prior delivered + actualVpfi (where prior delivered is
        // tracked in `s.buybackVpfiDeliveredSoFar[orderHash]`).
        uint256 priorVpfiDelivered =
            uint256(s.buybackVpfiDeliveredSoFar[orderHash]);
        uint256 cumulativeVpfi = priorVpfiDelivered + actualVpfi;
        uint256 cumulativeRequiredVpfi =
            (uint256(info.minVpfiOut) * consumedSoFarAfter) / uint256(info.amountIn);
        if (cumulativeVpfi < cumulativeRequiredVpfi) {
            revert BuybackBelowMinVpfiOut(
                cumulativeVpfi, uint128(cumulativeRequiredVpfi)
            );
        }
        s.buybackVpfiDeliveredSoFar[orderHash] = uint128(cumulativeVpfi);

        // Codex round-3 P1 #2 — verify `info.token` actually left
        // the diamond. Per-partial check: source delta must >=
        // `consumed`. A colliding orderHash on a different maker
        // asset would leave the diamond's `info.token` balance
        // unchanged.
        uint256 srcNow = IERC20(info.token).balanceOf(address(this));
        uint256 srcSpent = srcBaseline > srcNow ? srcBaseline - srcNow : 0;
        if (srcSpent < consumed) {
            revert BuybackSourceTokenNotSpent(consumed, srcSpent);
        }

        // Release the proportional reservation.
        s.baseBuybackReserved[info.token] -= consumed;

        // T-087 Sub 3 add-on #472 — priority router. Cascade the
        // delivered VPFI through:
        //   1. rewardEmissionsBudget (target-bounded; offsets
        //      fresh-mint emissions)
        //   2. keeperRewardBudget (target-bounded; funds keeper
        //      operational rewards)
        //   3. stakingPoolBuybackBudget (final overflow → stakers)
        // Each step claims up to its (target - current) gap; the
        // remainder cascades. Zero target disables the step.
        _routePriority(s, actualVpfi);

        // Codex round-1 P1 #3 — decrement the shared aggregate
        // allowance + re-apply the cap so an in-flight commit on
        // the same token still has a valid pull-through.
        address lop = s.cfgFusionLimitOrderProtocol;
        s.intentAggregateAllowance[info.token] -= consumed;
        IERC20(info.token).forceApprove(lop, 0);
        if (s.intentAggregateAllowance[info.token] != 0) {
            IERC20(info.token).forceApprove(
                lop, s.intentAggregateAllowance[info.token]
            );
        }

        // Persist the partial-fill accumulator.
        s.buybackConsumedSoFar[orderHash] = uint128(consumedSoFarAfter);

        // Final partial settles the order — flip Filled + clear the
        // kind discriminator + release the live-commit slot. Earlier
        // partials leave Pending status intact so subsequent fills
        // re-enter through the dispatcher.
        bool isFinal = consumedSoFarAfter == uint256(info.amountIn);
        if (isFinal) {
            // Codex round-2 P1 #1 — release the shared live-commit
            // counter only on the FINAL partial.
            s.intentLiveCommitCount -= 1;
            s.buybackOrders[orderHash].status =
                LibVaipakam.BUYBACK_ORDER_STATUS_FILLED;
            delete s.orderHashKind[orderHash];
            // Validation flag clears at terminal so re-stamping a
            // historic orderHash cannot re-enable its old magic.
            delete s.buybackValidated[orderHash];
            // Clear the partial-fill accumulators so they don't
            // strand storage; preserves the gas-refund pattern for
            // settled orders.
            delete s.buybackConsumedSoFar[orderHash];
            delete s.buybackVpfiDeliveredSoFar[orderHash];
            // Final partial event uses the cumulative actualVpfi
            // total — but we only have this partial's delta. Emit
            // `BuybackIntentFilled` with the per-partial figure and
            // also `BuybackIntentClosed` summarising the order.
            emit BuybackIntentFilled(
                orderHash, info.token, uint96(consumed), actualVpfi
            );
            emit BuybackIntentClosed(orderHash, info.token, info.amountIn);
        } else {
            emit BuybackIntentFilled(
                orderHash, info.token, uint96(consumed), actualVpfi
            );
        }
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

        // T-087 Sub 3.C — release ONLY the unconsumed portion. Any
        // amount already swapped via partial fills has already been
        // released proportionally in `postInteractionImpl`.
        uint256 consumedSoFar = uint256(s.buybackConsumedSoFar[orderHash]);
        uint256 unconsumed = uint256(info.amountIn) - consumedSoFar;

        if (unconsumed > 0) {
            // Roll the unconsumed reservation back to the spendable
            // budget.
            s.baseBuybackReserved[info.token] -= unconsumed;
            s.baseBuybackBudget[info.token] += unconsumed;

            // Roll the LOP allowance back via the shared aggregate
            // counter so the dispatcher's invariants hold for any
            // other in-flight commits on the same token.
            address lop = s.cfgFusionLimitOrderProtocol;
            s.intentAggregateAllowance[info.token] -= unconsumed;
            if (lop != address(0)) {
                IERC20(info.token).forceApprove(lop, 0);
                if (s.intentAggregateAllowance[info.token] != 0) {
                    IERC20(info.token).forceApprove(
                        lop, s.intentAggregateAllowance[info.token]
                    );
                }
            }
        }

        // Codex round-2 P1 #1 — release the live-commit slot.
        s.intentLiveCommitCount -= 1;

        s.buybackOrders[orderHash].status =
            LibVaipakam.BUYBACK_ORDER_STATUS_EXPIRED;
        delete s.orderHashKind[orderHash];
        // Validation flag clears on terminal to prevent ghost-magic.
        delete s.buybackValidated[orderHash];
        // Clear partial-fill accumulators.
        delete s.buybackConsumedSoFar[orderHash];
        delete s.buybackVpfiDeliveredSoFar[orderHash];

        emit BuybackIntentExpired(orderHash, info.token, uint96(unconsumed));
    }

    /**
     * @dev T-087 Sub 3 add-on #472 — priority router. Cascade
     *      `delivered` VPFI through the destination budgets in
     *      priority order. Each step claims up to the gap between
     *      its target and its current budget; the remainder
     *      cascades. A zero target effectively disables the step
     *      (the gap evaluates to 0 in that branch).
     *
     *      Sum invariant: `toRewards + toKeepers + toStaking == delivered`.
     */
    function _routePriority(LibVaipakam.Storage storage s, uint256 delivered)
        private
    {
        uint256 remaining = delivered;
        uint256 toRewards = 0;
        uint256 toKeepers = 0;

        // ── Step 1: rewardEmissionsBudget ──────────────────────────
        uint256 rewardsTarget = s.cfgRewardEmissionsTopUpTarget;
        uint256 currentRewards = s.rewardEmissionsBudget;
        if (rewardsTarget > currentRewards) {
            uint256 rewardsGap;
            unchecked {
                rewardsGap = rewardsTarget - currentRewards;
            }
            toRewards = remaining < rewardsGap ? remaining : rewardsGap;
            s.rewardEmissionsBudget = currentRewards + toRewards;
            unchecked {
                remaining -= toRewards;
            }
        }

        // ── Step 2: keeperRewardBudget ─────────────────────────────
        if (remaining != 0) {
            uint256 keepersTarget = s.cfgKeeperRewardTopUpTarget;
            uint256 currentKeepers = s.keeperRewardBudget;
            if (keepersTarget > currentKeepers) {
                uint256 keepersGap;
                unchecked {
                    keepersGap = keepersTarget - currentKeepers;
                }
                toKeepers = remaining < keepersGap ? remaining : keepersGap;
                s.keeperRewardBudget = currentKeepers + toKeepers;
                unchecked {
                    remaining -= toKeepers;
                }
            }
        }

        // ── Step 3: staking pool — final overflow ──────────────────
        if (remaining != 0) {
            s.stakingPoolBuybackBudget += remaining;
        }

        emit BuybackPrioritySplit(delivered, toRewards, toKeepers, remaining);
    }
}
