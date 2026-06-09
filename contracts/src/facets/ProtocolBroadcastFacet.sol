// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";

/// @dev Outbound surface on `VaipakamRewardMessenger` for the per-user
///      tier push. Sub 2.B's external + quote pair.
interface IVaipakamRewardMessengerOutbound {
    function quoteSendTierUpdate(
        address user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 computedAt,
        uint256 nonce,
        uint40 tierExpirySec,
        uint16 tierTableVersion
    ) external view returns (uint256 nativeFee);

    function sendTierUpdate(
        address user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 computedAt,
        uint256 nonce,
        uint40 tierExpirySec,
        uint16 tierTableVersion,
        address payable refundAddress
    ) external payable;
}

/// @dev Internal cross-facet hook to the accumulator's effective-tier
///      resolution surface.
interface IVPFIDiscountAccumulatorInternal {
    function effectiveTierAndBps(address user)
        external
        view
        returns (uint8 effTier, uint16 effBps);
}

/**
 * @title ProtocolBroadcastFacet — T-087 Sub 2.D
 *
 * Orchestrates the protocol-funded cross-chain tier push that Sub 2.B
 * (outbound messenger surface) + Sub 2.C (mirror inbound receiver) made
 * possible. The single producer-facing entry is
 * `protocolBroadcastTierUpdate(user)`, called from
 * `VPFIDiscountAccumulatorFacet.rollupUserDiscount` after the cache is
 * advanced; everything mirror-side ripples from there.
 *
 * Trust + behaviour:
 *   - Producer call gated to `msg.sender == address(this)` (internal
 *     cross-facet only). EOAs can never invoke directly.
 *   - Silent skip when not configured (`rewardMessenger == address(0)`
 *     OR `s.broadcastDestinationCount == 0`). Lets the deploy land + be
 *     activated by a later admin call without breaking every stake /
 *     withdraw on the way (this is the local / testnet / pre-CCIP-wiring
 *     stance).
 *   - FAIL-CLOSED on budget exhaustion ONCE configured. Reverts
 *     `ProtocolBudgetExhausted(required, available)`. Operator must top
 *     up before downgrade-bearing mutations can land — the design's
 *     round-5 P1 #3 + round-6 P1 #2 ratification.
 *   - Anyone can `topUpBroadcastBudget()`; admin can `withdrawBudget()`.
 */
contract ProtocolBroadcastFacet {
    // ─── Events ─────────────────────────────────────────────────────────

    /// @custom:event-category state-change/broadcast-budget
    event BroadcastBudgetToppedUp(address indexed funder, uint256 amount, uint256 newBalance);
    /// @custom:event-category state-change/broadcast-budget
    event BroadcastBudgetWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    /// @custom:event-category state-change/broadcast-budget
    event BroadcastDestinationCountSet(uint8 oldCount, uint8 newCount);

    /// @custom:event-category informational/tier-transport
    event ProtocolTierBroadcastSent(
        address indexed user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint64 nonce,
        uint256 feePaid
    );
    /// @custom:event-category informational/tier-transport
    event ProtocolTierBroadcastSkipped(address indexed user, string reason);

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice External invocation by a non-self caller.
    error OnlyInternal(address caller);
    /// @notice Insufficient protocol broadcast budget for the quoted CCIP
    ///         fee — operator must top up before mutations can land.
    error ProtocolBudgetExhausted(uint256 required, uint256 available);
    /// @notice `setBroadcastDestinationCount` was called with 0 — that
    ///         disables broadcasts; use `setRewardMessenger(0)` for that
    ///         purpose explicitly.
    error ZeroBroadcastDestinationCount();
    /// @notice `withdrawBudget` would underflow the live balance.
    error WithdrawExceedsBudget(uint256 requested, uint256 available);
    /// @notice The treasury / `to` transfer reverted on withdraw.
    error WithdrawFailed();
    /// @notice `withdrawBudget` was called with `address(0)`. Other
    ///         cross-chain rescue paths reject zero recipients; this
    ///         does the same to prevent an unrecoverable operator
    ///         typo burning the budget (Codex Sub 2.D round-1 P2 #2).
    error ZeroRecipient();

    // ─── Producer call (rollup hook) ────────────────────────────────────

    /// @notice Called by `VPFIDiscountAccumulatorFacet.rollupUserDiscount`
    ///         via the diamond fallback after the ring-buffer + expiry
    ///         writes land. Bumps the user's push nonce + fans out a
    ///         single CCIP message to every configured destination.
    /// @dev    Returns silently when CCIP isn't wired (pre-mainnet local
    ///         / fork tests). Reverts ONCE wired if the budget can't
    ///         cover the quoted fee.
    function protocolBroadcastTierUpdate(address user) external {
        if (msg.sender != address(this)) revert OnlyInternal(msg.sender);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Base-only — mirrors and unconfigured chains skip silently.
        // The broadcast originates from the chain that ACTUALLY runs
        // the accumulator; mirrors only consume pushes, never originate
        // them. The runtime canonical flag is the same gate Sub 1.C
        // uses to dispatch the read path.
        if (!s.isCanonicalVpfiChain) {
            emit ProtocolTierBroadcastSkipped(user, "not-canonical-chain");
            return;
        }
        address msgr = s.rewardMessenger;
        if (msgr == address(0)) {
            emit ProtocolTierBroadcastSkipped(user, "messenger-not-configured");
            return;
        }
        if (s.broadcastDestinationCount == 0) {
            emit ProtocolTierBroadcastSkipped(user, "no-destinations");
            return;
        }

        // Resolve the current EFFECTIVE_TIER + BPS via the accumulator's
        // existing internal surface. The accumulator is `onlyInternal`
        // gated; calling via the diamond fallback satisfies the check
        // (`msg.sender == address(this)`).
        (uint8 effTier, uint16 effBps) =
            IVPFIDiscountAccumulatorInternal(address(this))
                .effectiveTierAndBps(user);

        // Resolve the payload values BEFORE the de-dup gate so the
        // gate has the full (tier, bps, expiry, version) tuple to
        // compare against the last-pushed cache.
        uint40 expiry = s.tierExpirySec[user];
        // Sub 2.A getter semantics — sentinel for never-rolled-up reads.
        if (expiry == 0) expiry = type(uint40).max;
        // Codex Sub 2.D round-1 P1 #2 — read the CANONICAL Base
        // version (`s.tierTableVersion`, which `ConfigFacet` bumps on
        // threshold / BPS change), NOT the mirror-side
        // `currentTierTableVersion`.
        uint16 version = s.tierTableVersion;

        // Codex Sub 2.D round-2 P1 #3 — a brand-new user whose first
        // rollup resolves to (0, 0) would otherwise burn protocol
        // budget pushing what mirrors already treat as the empty-
        // cache default. Silent-skip when both current AND last
        // pushed are zero — a tier-changing mutation (zero→positive
        // or positive→zero) still fires the broadcast because the
        // last-pushed snapshot disagrees with the current resolution.
        if (
            effTier == 0
                && effBps == 0
                && s.lastEffectiveTier[user] == 0
                && s.lastEffectiveBps[user] == 0
        ) {
            emit ProtocolTierBroadcastSkipped(user, "zero-tier-no-change");
            return;
        }

        // Codex Sub 2.D round-1 P2 #1 + round-2 P1 #1 — skip the
        // broadcast when the FULL push tuple is identical to the
        // last pushed. The tuple is (effTier, effBps, expiry,
        // version) — not just (tier, bps), because same-tier
        // mutations that change projected expiry or a governance
        // table bump that keeps tier still need to propagate. The
        // `lastEffectiveTier` / `lastEffectiveBps` /
        // `lastTierExpirySec` / `lastTierTableVersion` slots exist
        // for exactly this de-dup. Read-compare-skip; stamp AFTER
        // the successful send below.
        if (
            effTier == s.lastEffectiveTier[user]
                && effBps == s.lastEffectiveBps[user]
                && expiry == s.lastTierExpirySec[user]
                && version == s.lastTierTableVersion[user]
                && s.userTierPushNonce[user] != 0
        ) {
            emit ProtocolTierBroadcastSkipped(user, "tuple-unchanged");
            return;
        }

        // Bump the per-user push nonce (monotonic on Base; mirrors
        // enforce strictly-greater via the Sub 2.C check).
        uint64 nonce = ++s.userTierPushNonce[user];
        uint40 computedAt = uint40(block.timestamp);

        IVaipakamRewardMessengerOutbound m =
            IVaipakamRewardMessengerOutbound(msgr);
        uint256 fee = m.quoteSendTierUpdate(
            user, effTier, effBps, computedAt, nonce, expiry, version
        );

        // FAIL-CLOSED — operator must top up before mutations land.
        uint256 budget = s.protocolBroadcastBudget;
        if (budget < fee) {
            revert ProtocolBudgetExhausted(fee, budget);
        }
        s.protocolBroadcastBudget = budget - fee;

        // The messenger's `sendTierUpdate` is `nonReentrant`; refund of
        // surplus comes back to this diamond on the same call.
        m.sendTierUpdate{value: fee}(
            user,
            effTier,
            effBps,
            computedAt,
            nonce,
            expiry,
            version,
            payable(address(this))
        );

        // Stamp the "last pushed" tuple so the next rollup can de-dup
        // (round-1 P2 #1 + round-2 P1 #1 folds). Done AFTER the send
        // so a revert from inside the messenger leaves the stamps at
        // the prior values and the next rollup retries.
        s.lastEffectiveTier[user] = effTier;
        s.lastEffectiveBps[user] = effBps;
        s.lastTierExpirySec[user] = expiry;
        s.lastTierTableVersion[user] = version;

        emit ProtocolTierBroadcastSent(user, effTier, effBps, nonce, fee);
    }

    // ─── Budget admin ──────────────────────────────────────────────────

    /// @notice Anyone can top up the protocol broadcast budget. The
    ///         attached `msg.value` lands in the diamond's native
    ///         balance + the accounting slot.
    function topUpBroadcastBudget() external payable {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.protocolBroadcastBudget += msg.value;
        emit BroadcastBudgetToppedUp(
            msg.sender, msg.value, s.protocolBroadcastBudget
        );
    }

    /// @notice Admin can withdraw unused budget — useful if the
    ///         broadcast configuration changes (e.g., mirror set
    ///         shrinks) and surplus accumulates.
    function withdrawBudget(address payable to, uint256 amount)
        external
    {
        LibAccessControl.checkRole(LibAccessControl.ADMIN_ROLE, msg.sender);
        if (to == address(0)) revert ZeroRecipient();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 budget = s.protocolBroadcastBudget;
        if (amount > budget) revert WithdrawExceedsBudget(amount, budget);
        s.protocolBroadcastBudget = budget - amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit BroadcastBudgetWithdrawn(to, amount, s.protocolBroadcastBudget);
    }

    /// @notice Configure how many destinations the messenger broadcasts
    ///         to. The Diamond does not maintain the actual destination
    ///         list (the messenger does); it only needs to know whether
    ///         a broadcast SHOULD fire (count > 0) and to surface the
    ///         number for ops verification. Must match the messenger's
    ///         `broadcastDestinationChainIds.length`.
    function setBroadcastDestinationCount(uint8 count) external {
        LibAccessControl.checkRole(LibAccessControl.ADMIN_ROLE, msg.sender);
        if (count == 0) revert ZeroBroadcastDestinationCount();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint8 old = s.broadcastDestinationCount;
        s.broadcastDestinationCount = count;
        emit BroadcastDestinationCountSet(old, count);
    }

    // ─── Read surface ──────────────────────────────────────────────────

    function getProtocolBroadcastBudget() external view returns (uint256) {
        return LibVaipakam.storageSlot().protocolBroadcastBudget;
    }

    function getBroadcastDestinationCount() external view returns (uint8) {
        return LibVaipakam.storageSlot().broadcastDestinationCount;
    }

    function getUserTierPushNonce(address user) external view returns (uint64) {
        return LibVaipakam.storageSlot().userTierPushNonce[user];
    }
}
