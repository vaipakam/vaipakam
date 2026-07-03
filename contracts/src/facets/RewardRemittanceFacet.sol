// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInteractionRewards} from "../libraries/LibInteractionRewards.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {ICrossChainMessenger} from "../crosschain/ICrossChainMessenger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RewardRemittanceFacet — #776 Base→mirror reward-budget bridge (send).
 *
 * @notice The Base-only send side of the on-demand VPFI reward-budget bridge
 *         (Option C, see docs/DesignsAndPlans/CrossChainRewardBudgetBridge.md).
 *
 *         The cross-chain reward mesh finalizes accounting and broadcasts each
 *         day's global interest denominator to mirrors, which opens the local
 *         claim gate — but nothing funds the VPFI a mirror needs to pay those
 *         claims. This facet closes that gap: it computes each finalized day's
 *         per-chain reward slice and remits the VPFI over the CCIP token path
 *         to the mirror, where a {RewardRemittanceReceiver} (PR2) credits the
 *         mirror Diamond so the unchanged claim path can pay from balance.
 *
 *         On-demand + batched + idempotent, deliberately decoupled from the
 *         `finalizeDay` hot path so a large backlog can be drained in
 *         lane-sized chunks under the VPFI CCIP rate limits, and a failed
 *         batch is safe to retry (already-sent (chain,day) pairs are skipped).
 *
 * @dev    Base-only (`onlyCanonical`): the 69M interaction pool lives on the
 *         canonical chain, so only Base holds the VPFI to remit. Authorized to
 *         the ADMIN role, or an optional `rewardRemittanceKeeper` EOA for the
 *         apps/keeper automation loop.
 *
 *         Rides the value-carrying `crossChainMessenger` (the same CCIP adapter
 *         buyback uses) on its OWN dedicated `vpfi-reward-budget` channel — NOT
 *         the data-only `rewardMessenger`. Reusing the shared messenger is safe:
 *         on Base the Diamond is NOT a handler on it (the buyback inbound
 *         handler is the separate `BuybackRemittanceReceiver`, and reward data
 *         routes through `VaipakamRewardMessenger`), so `channelOf[Diamond]` is
 *         free and deploy wiring registers the Base Diamond as the reward-budget
 *         channel's handler; on each mirror the {RewardRemittanceReceiver} (a
 *         distinct address from the mirror Diamond) is that channel's handler,
 *         so the one-to-one `channelOf[handler]` binding never collides.
 *         `remitRewardBudget` reverts `RewardBudgetMessengerNotSet` until the
 *         messenger is configured (`TreasuryFacet.setCrossChainMessenger`).
 */
contract RewardRemittanceFacet is
    DiamondAccessControl,
    DiamondReentrancyGuard,
    DiamondPausable,
    IVaipakamErrors
{
    using SafeERC20 for IERC20;

    /// @notice Gas allotted to the mirror {RewardRemittanceReceiver} callback.
    ///         Matched to the buyback remittance receiver's budget.
    uint256 internal constant REWARD_BUDGET_DEST_GAS_LIMIT = 300_000;

    // ─── Events ───────────────────────────────────────────────────────────

    /// @notice Emitted when a reward-budget remittance is sent to a mirror.
    /// @param dstChainId Mirror funded.
    /// @param total      VPFI remitted in this batch (sum of un-remitted slices).
    /// @param fundedDayCount Number of days that ACTUALLY funded VPFI in this
    ///                   batch (skipped/duplicate/zero-slice days excluded) —
    ///                   matches the day set carried in the CCIP payload.
    /// @param messageId  CCIP message id, for tracing.
    /// @custom:event-category informational/reward-transport
    event RewardBudgetRemitted(
        uint32 indexed dstChainId,
        uint256 total,
        uint256 fundedDayCount,
        bytes32 messageId
    );

    /// @notice Emitted when the optional keeper automation role is set/cleared.
    /// @custom:event-category informational/config
    event RewardRemittanceKeeperUpdated(address indexed keeper);

    /// @notice Emitted (mirror side) when a reward budget is received + credited.
    /// @param sourceChainId Base chain id the budget came from.
    /// @param token         Local VPFI token credited.
    /// @param amount        VPFI credited to this Diamond.
    /// @param dayIds        The exact day ids the batch funded — the mirror
    ///                      keeps only `rewardBudgetReceivedTotal`, so this is
    ///                      the sole per-day reconciliation record (the design
    ///                      dropped a per-day map in favour of this event).
    /// @custom:event-category informational/reward-transport
    event RewardBudgetReceived(
        uint256 indexed sourceChainId,
        address indexed token,
        uint256 amount,
        uint256[] dayIds
    );

    /// @notice Emitted when the mirror-side receiver address is set/cleared.
    /// @custom:event-category informational/config
    event RewardRemittanceReceiverUpdated(address indexed receiver);

    // ─── Errors (facet-local; shared ones come from IVaipakamErrors) ──────

    /// @notice Caller is neither ADMIN nor the configured remittance keeper.
    error NotRewardRemitter(address caller);
    /// @notice The value-carrying cross-chain messenger is unset. Configure it
    ///         with `TreasuryFacet.setCrossChainMessenger` before remitting.
    error RewardBudgetMessengerNotSet();
    /// @notice A requested day has not been finalized on Base yet.
    error RewardDayNotFinalized(uint256 dayId);
    /// @notice No un-remitted, non-zero budget across the requested days.
    error NothingToRemit();
    /// @notice `dayIds` was empty.
    error EmptyDayList();
    /// @notice `perRemittanceCap` is zero or above the whole interaction pool.
    error InvalidRemittanceCap();
    /// @notice The batch total exceeds the caller-supplied per-call cap.
    error RemittanceExceedsCap(uint256 total, uint256 cap);
    /// @notice The batch would push remitted + Base-paid over the 69M pool cap.
    error RewardPoolCapExceeded(uint256 requested, uint256 remaining);
    /// @notice `msg.value` is below the quoted CCIP fee.
    error InsufficientRemittanceFee(uint256 provided, uint256 required);
    /// @notice Native fee refund to the caller failed.
    error RemittanceRefundFailed();
    /// @notice `onRewardBudgetReceived` called by an address other than the
    ///         configured mirror-side receiver.
    error NotRewardRemittanceReceiver(address caller);
    /// @notice The credited token is not this Diamond's VPFI token.
    error RewardBudgetTokenMismatch(address expected, address delivered);
    /// @notice A non-zero mirror-side receiver was set to an address with no
    ///         code (likely an EOA typo) — the ingress trusts the receiver.
    error RewardReceiverNotContract(address receiver);

    // ─── Modifiers ────────────────────────────────────────────────────────

    function _checkCanonical() private view {
        if (!LibVaipakam.storageSlot().isCanonicalRewardChain) {
            revert NotCanonicalRewardChain();
        }
    }

    /// @dev The pool lives on Base — remittance is a Base-only action.
    modifier onlyCanonical() {
        _checkCanonical();
        _;
    }

    function _checkRemitter() private view {
        if (LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender)) {
            return;
        }
        address keeper = LibVaipakam.storageSlot().rewardRemittanceKeeper;
        if (keeper == address(0) || msg.sender != keeper) {
            revert NotRewardRemitter(msg.sender);
        }
    }

    /// @dev ADMIN, or the optional keeper EOA (when configured).
    modifier onlyRemitter() {
        _checkRemitter();
        _;
    }

    // ─── Remittance ───────────────────────────────────────────────────────

    /**
     * @notice Remit the un-remitted VPFI reward budget for `dayIds` to
     *         mirror `dstChainId` over the CCIP token path.
     * @dev    Idempotent: a `(dstChainId, dayId)` already remitted is skipped
     *         (not re-sent), so re-running a partially-sent batch is safe.
     *         CEI order: mark + accounting BEFORE the external send; if the
     *         send reverts the whole tx (and the marks) roll back. Forwards
     *         exactly the quoted CCIP native fee and refunds any surplus
     *         `msg.value` to the caller.
     * @param dstChainId      Mirror to fund.
     * @param dayIds          Finalized days to remit (any already-sent are
     *                        skipped; every day must be finalized).
     * @param perRemittanceCap Caller-set ceiling on this batch's total, so the
     *                        operator/keeper keeps a single send under the live
     *                        VPFI CCIP lane bucket. Must be in (0, 69M].
     * @return messageId      CCIP message id.
     */
    function remitRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds,
        uint256 perRemittanceCap
    )
        external
        payable
        nonReentrant
        whenNotPaused
        onlyCanonical
        onlyRemitter
        returns (bytes32 messageId)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        if (dayIds.length == 0) revert EmptyDayList();
        if (
            perRemittanceCap == 0 ||
            perRemittanceCap > LibVaipakam.VPFI_INTERACTION_POOL_CAP
        ) {
            revert InvalidRemittanceCap();
        }

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert VPFITokenNotSet();
        address messenger = s.crossChainMessenger;
        if (messenger == address(0)) revert RewardBudgetMessengerNotSet();

        // Sum the un-remitted slices and mark each (chain, day) to block a
        // re-send. Every day must be finalized (its denominator is immutable).
        // Collect ONLY the days that actually contribute VPFI into `fundedDays`
        // (skipping already-remitted, zero-slice, and duplicate days) — that
        // filtered set, not the caller's raw `dayIds`, rides the payload so the
        // mirror's reconciliation events name exactly the funded days.
        uint256 total;
        uint256[] memory fundedDays = new uint256[](dayIds.length);
        uint256 fundedCount;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            if (!s.dailyGlobalFinalized[dayId]) {
                revert RewardDayNotFinalized(dayId);
            }
            if (s.rewardBudgetRemitted[dstChainId][dayId] == 0) {
                uint256 slice = LibInteractionRewards.chainRewardBudgetForDay(
                    s,
                    dstChainId,
                    dayId
                );
                if (slice > 0) {
                    s.rewardBudgetRemitted[dstChainId][dayId] = slice;
                    total += slice;
                    fundedDays[fundedCount] = dayId;
                    unchecked {
                        ++fundedCount;
                    }
                }
            }
            unchecked {
                ++i;
            }
        }
        if (total == 0) revert NothingToRemit();
        // Trim `fundedDays` to the days that actually funded (shrink the memory
        // array's length in place — safe, we only ever reduce it).
        assembly {
            mstore(fundedDays, fundedCount)
        }
        if (total > perRemittanceCap) {
            revert RemittanceExceedsCap(total, perRemittanceCap);
        }

        // Global 69M-cap guard: everything remitted so far, plus what Base has
        // itself paid out locally, plus this batch, must stay within the pool.
        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        uint256 remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
        if (total > remaining) revert RewardPoolCapExceeded(total, remaining);

        // Effects (CEI) — before the external send.
        s.rewardBudgetRemittedGlobal += total;
        s.rewardBudgetRemittedTotal[dstChainId] += total;

        // Interaction: approve the messenger for exactly `total`, then send the
        // VPFI + payload over the CCIP token path. `forceApprove` re-sets the
        // allowance to exactly `total` (handles non-standard ERC20s + any
        // leftover). The receiver validates delivered-vs-declared against the
        // `total` in the payload.
        IERC20(vpfi).forceApprove(messenger, total);

        bytes memory payload = abi.encode(fundedDays, total);
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});

        uint256 fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
        if (msg.value < fee) revert InsufficientRemittanceFee(msg.value, fee);

        messageId = ICrossChainMessenger(messenger).sendMessage{value: fee}(
            dstChainId,
            payload,
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );

        // Refund any fee overpayment to the caller (operator/keeper EOA).
        if (msg.value > fee) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - fee}("");
            if (!ok) revert RemittanceRefundFailed();
        }

        emit RewardBudgetRemitted(dstChainId, total, fundedCount, messageId);
    }

    // ─── Admin ────────────────────────────────────────────────────────────

    /**
     * @notice Set (or clear, with `address(0)`) the optional keeper EOA allowed
     *         to call {remitRewardBudget} alongside ADMIN.
     * @dev    ADMIN-only. Default unset = owner-only remittance.
     */
    function setRewardRemittanceKeeper(
        address keeper
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().rewardRemittanceKeeper = keeper;
        emit RewardRemittanceKeeperUpdated(keeper);
    }

    /**
     * @notice Set (or clear, with `address(0)`) the mirror-side
     *         {RewardRemittanceReceiver} authorized to call
     *         {onRewardBudgetReceived} on this (mirror) Diamond.
     * @dev    ADMIN-only. Base leaves this unset. A non-zero receiver MUST have
     *         code — the ingress trusts this address (it inflates
     *         `rewardBudgetReceivedTotal` + emits the reconciliation record
     *         without a balance-delta check), so an EOA typo'd here would let
     *         that EOA fabricate funded-day events. `address(0)` clears it.
     */
    function setRewardRemittanceReceiver(
        address receiver
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (receiver != address(0) && receiver.code.length == 0) {
            revert RewardReceiverNotContract(receiver);
        }
        LibVaipakam.storageSlot().rewardRemittanceReceiver = receiver;
        emit RewardRemittanceReceiverUpdated(receiver);
    }

    // ─── Mirror-side ingress ──────────────────────────────────────────────

    /**
     * @notice Record a reward budget the {RewardRemittanceReceiver} has already
     *         forwarded (as VPFI) into this mirror Diamond.
     * @dev    Monitoring-only: the VPFI is already in the Diamond's balance
     *         (the receiver transferred it before this call), and
     *         `claimInteractionRewards` pays from that balance. This just
     *         records the funded total + emits an event for reconciliation.
     *         Trust chain: gated to the registered receiver, whose own
     *         `onCrossChainMessage` is gated to the CCIP messenger.
     * @param token         Token credited — must be this Diamond's VPFI.
     * @param amount        VPFI amount credited.
     * @param dayIds        Days the batch covered (for the event log).
     * @param sourceChainId Base chain id the budget came from.
     */
    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId
    ) external nonReentrant whenNotPaused {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (msg.sender != s.rewardRemittanceReceiver) {
            revert NotRewardRemittanceReceiver(msg.sender);
        }
        if (token != s.vpfiToken) {
            revert RewardBudgetTokenMismatch(s.vpfiToken, token);
        }
        s.rewardBudgetReceivedTotal += amount;
        emit RewardBudgetReceived(sourceChainId, token, amount, dayIds);
    }

    // ─── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Plan a remittance: the un-remitted VPFI a {remitRewardBudget}
     *         call over `dayIds` would send to `dstChainId`, and the per-day
     *         breakdown. Non-reverting — non-finalized or already-remitted days
     *         contribute 0.
     * @dev    Mirrors {remitRewardBudget}'s in-call de-duplication: a `dayId`
     *         repeated in `dayIds` contributes only on its FIRST occurrence
     *         (later duplicates yield 0). Without this the quote would
     *         over-count a duplicated day — remit marks it on the first pass, so
     *         the send would fit under a cap the quote reported as too large.
     * @return total  Sum of the un-remitted slices (each day counted once).
     * @return perDay `perDay[i]` = amount `dayIds[i]` would contribute (0 if
     *                not finalized, already remitted, or a repeat of an earlier
     *                entry in `dayIds`).
     */
    function quoteRewardBudget(
        uint32 dstChainId,
        uint256[] calldata dayIds
    ) external view returns (uint256 total, uint256[] memory perDay) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        perDay = new uint256[](dayIds.length);
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            // Skip a day already seen earlier in THIS call — the send path
            // marks the first occurrence and no-ops the rest.
            bool seen;
            for (uint256 j; j < i; ) {
                if (dayIds[j] == dayId) {
                    seen = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }
            if (
                !seen &&
                s.dailyGlobalFinalized[dayId] &&
                s.rewardBudgetRemitted[dstChainId][dayId] == 0
            ) {
                uint256 slice = LibInteractionRewards.chainRewardBudgetForDay(
                    s,
                    dstChainId,
                    dayId
                );
                perDay[i] = slice;
                total += slice;
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Quote the CCIP native fee a {remitRewardBudget} over `dayIds`
     *         would cost, plus the VPFI total it would send.
     * @dev    The keeper/operator EOA cannot call
     *         `CcipMessenger.quoteMessageFee` directly — the messenger
     *         authorizes quotes by `channelOf[msg.sender]` and only the Diamond
     *         is a registered reward-budget handler. This view runs the quote
     *         AS the Diamond, building the exact same funded-day payload +
     *         token list the send would (same not-already-remitted /
     *         non-duplicate / non-zero-slice filter), so `fee` is what to pass
     *         as `msg.value` (overpayment is refunded anyway).
     *
     *         It is a faithful DRY-RUN of the send's intrinsic guards: it
     *         reverts `RewardDayNotFinalized` on an unfinalized day and
     *         `RewardPoolCapExceeded` when the batch would breach the 69M pool,
     *         exactly like {remitRewardBudget} — so a keeper that gets a
     *         successful quote knows the same send won't be rejected by those
     *         guards (the caller-supplied `perRemittanceCap` is the keeper's own
     *         concern, sized from the returned `total`). Returns (0, 0) when
     *         nothing is remittable, or the messenger/VPFI is unset.
     * @return fee   CCIP native fee for the send (0 if nothing to remit).
     * @return total VPFI the send would move (0 if nothing to remit).
     */
    function quoteRemittanceFee(
        uint32 dstChainId,
        uint256[] calldata dayIds
    ) external view returns (uint256 fee, uint256 total) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address messenger = s.crossChainMessenger;
        if (vpfi == address(0) || messenger == address(0)) return (0, 0);

        uint256[] memory fundedDays = new uint256[](dayIds.length);
        uint256 fundedCount;
        for (uint256 i; i < dayIds.length; ) {
            uint256 dayId = dayIds[i];
            // Mirror remit's revert on any unfinalized day so this quote never
            // reports a valid fee for a batch remit would reject.
            if (!s.dailyGlobalFinalized[dayId]) {
                revert RewardDayNotFinalized(dayId);
            }
            bool seen;
            for (uint256 j; j < i; ) {
                if (dayIds[j] == dayId) {
                    seen = true;
                    break;
                }
                unchecked {
                    ++j;
                }
            }
            if (!seen && s.rewardBudgetRemitted[dstChainId][dayId] == 0) {
                uint256 slice = LibInteractionRewards.chainRewardBudgetForDay(
                    s,
                    dstChainId,
                    dayId
                );
                if (slice > 0) {
                    fundedDays[fundedCount] = dayId;
                    unchecked {
                        ++fundedCount;
                    }
                    total += slice;
                }
            }
            unchecked {
                ++i;
            }
        }
        if (total == 0) return (0, 0);
        // Mirror remit's 69M pool-cap guard so a quote can't succeed for a batch
        // remit would reject near pool exhaustion.
        uint256 used = s.rewardBudgetRemittedGlobal + s.interactionPoolPaidOut;
        uint256 remaining = used >= LibVaipakam.VPFI_INTERACTION_POOL_CAP
            ? 0
            : LibVaipakam.VPFI_INTERACTION_POOL_CAP - used;
        if (total > remaining) revert RewardPoolCapExceeded(total, remaining);
        assembly {
            mstore(fundedDays, fundedCount)
        }

        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: vpfi, amount: total});
        fee = ICrossChainMessenger(messenger).quoteMessageFee(
            dstChainId,
            abi.encode(fundedDays, total),
            tokens,
            REWARD_BUDGET_DEST_GAS_LIMIT
        );
    }

    /// @notice VPFI already remitted for `(chainId, dayId)` (0 = not sent).
    function getRewardBudgetRemitted(
        uint32 chainId,
        uint256 dayId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemitted[chainId][dayId];
    }

    /// @notice Cumulative VPFI remitted to `chainId` across all days.
    function getRewardBudgetRemittedTotal(
        uint32 chainId
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemittedTotal[chainId];
    }

    /// @notice Σ VPFI remitted across every mirror.
    function getRewardBudgetRemittedGlobal() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetRemittedGlobal;
    }

    /// @notice The configured keeper EOA (address(0) = owner-only).
    function getRewardRemittanceKeeper() external view returns (address) {
        return LibVaipakam.storageSlot().rewardRemittanceKeeper;
    }

    /// @notice The mirror-side receiver authorized for {onRewardBudgetReceived}.
    function getRewardRemittanceReceiver() external view returns (address) {
        return LibVaipakam.storageSlot().rewardRemittanceReceiver;
    }

    /// @notice Cumulative VPFI reward budget received from Base on this mirror.
    function getRewardBudgetReceivedTotal() external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardBudgetReceivedTotal;
    }
}
