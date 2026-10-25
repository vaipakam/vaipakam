// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";

/// @dev Outbound surface on `VaipakamRewardMessenger` for the per-user
///      tier push, one broadcast lane at a time (#898 / #911).
interface IVaipakamRewardMessengerOutbound {
    function getBroadcastDestinations() external view returns (uint256[] memory);

    function quoteSendTierUpdateTo(
        uint256 destChainId,
        address user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 computedAt,
        uint256 nonce,
        uint40 tierExpirySec,
        uint16 tierTableVersion
    ) external view returns (uint256 nativeFee);

    function sendTierUpdateTo(
        uint256 destChainId,
        address user,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 computedAt,
        uint256 nonce,
        uint40 tierExpirySec,
        uint16 tierTableVersion,
        address payable refundAddress
    ) external payable returns (bytes32 messageId);
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
 * @title ProtocolBroadcastFacet — the cross-chain tier push (T-087 Sub 2.D,
 *        reworked by #898 / #911)
 *
 * Base resolves a user's effective tier; mirrors cache it. This facet
 * carries the tier from one to the other, one broadcast lane at a time, and
 * NEVER makes the user's action fail (`TierPushDeliveryDesign.md`):
 *
 *   - COMMIT. Each broadcasting rollup calls `protocolBroadcastTierUpdate`.
 *     When the resolved `(tier, bps, expiry, version)` differs from the
 *     user's latest committed push, a new push is committed: the user's
 *     push nonce goes up and the tuple is recorded (`lastEffectiveTier` and
 *     siblings). Consent off forces `(0, 0)`.
 *   - OWED. Every broadcast lane whose delivered nonce (`tierLanePush`) is
 *     below the committed nonce is owed that push. A lane whose delivered
 *     tuple already has the same effect (both tier 0, or identical) is
 *     settled without a message.
 *   - DELIVER. Each owed lane is quoted and sent on its own; a lane that
 *     cannot be quoted or sent stays owed and emits {TierPushDeferred} with
 *     the reason, without touching any other lane. A caller's `msg.value`
 *     (only through {deliverTierPush}) pays first, unrate-limited. The
 *     protocol budget pays a push that lowers the lane's tier or bps at
 *     once, and any other push at most once per spacing window per lane,
 *     which bounds what tier churn can drain.
 *   - GAS. Each call to the messenger (the destination list, a lane's
 *     quote, a lane's send) is made only with at least a fixed gas floor in
 *     hand, well above what the call needs; with less, the whole action
 *     reverts {TierPushOutOfGas} before the call. A caller therefore cannot
 *     tune the transaction's gas so that the call, or any call nested inside
 *     it, runs out: a failure it does return is the lane's own. Starving the
 *     call can fail the user's action, never skip its push.
 *   - FUNDS. A budget-paid send debits exactly what left the Diamond (the
 *     fee less any refund the messenger returned); a caller-paid send never
 *     touches the budget, and the caller's unspent value is returned.
 *
 *   Producer call gated to `msg.sender == address(this)`. Mirrors and
 *   unconfigured chains skip silently, as before.
 */
contract ProtocolBroadcastFacet is DiamondReentrancyGuard, DiamondPausable {
    /// @notice Why an owed lane was left owed.
    enum TierPushDeferral {
        Spacing, // the push does not lower the lane and its window has not elapsed
        Budget, // the protocol budget cannot cover the lane's fee
        Quote, // the lane's quote reverted
        Send, // the lane's send reverted
        Destinations, // the messenger's destination list could not be read
        NoDestinations // no broadcast lane is configured
    }

    /// @notice One lane as {getTierPushStatus} reports it.
    struct TierLaneStatus {
        uint256 destChainId;
        LibVaipakam.TierLanePush delivered;
        bool owed;
        /// @dev When the protocol budget may next pay this lane's owed push
        ///      (0 when nothing is owed; the current time or earlier when it
        ///      may pay now, budget permitting).
        uint40 budgetEligibleAt;
    }

    /// @dev The committed push one delivery pass carries.
    struct Push {
        address user;
        uint64 nonce;
        uint8 tier;
        uint16 bps;
        uint40 expiry;
        uint16 version;
    }

    // ─── Gas floors ─────────────────────────────────────────────────────

    /// @notice Gas a call to the messenger is sure to receive, per call kind
    ///         (see {_requireGas}). Each is several times what the call
    ///         costs through the reward messenger, the CCIP adapter and the
    ///         router, so it must be raised (by a facet refresh) only if CCIP
    ///         itself grows far more expensive. Too low a floor never blocks
    ///         a push; it only weakens the guarantee that a failure was the
    ///         lane's own. They are the gas a tier-pushing action must carry
    ///         while a lane is owed, not gas it spends.
    uint256 internal constant LIST_GAS_FLOOR = 100_000;
    /// @notice See {LIST_GAS_FLOOR}.
    uint256 internal constant QUOTE_GAS_FLOOR = 300_000;
    /// @notice See {LIST_GAS_FLOOR}.
    uint256 internal constant SEND_GAS_FLOOR = 1_000_000;
    /// @dev The cost of the CALL itself that the 63/64 rule is applied
    ///      after: base, cold-account and value-transfer charges, rounded up.
    uint256 private constant CALL_OVERHEAD_GAS = 20_000;

    // ─── Events ─────────────────────────────────────────────────────────

    /// @custom:event-category state-change/broadcast-budget
    event BroadcastBudgetToppedUp(address indexed funder, uint256 amount, uint256 newBalance);
    /// @custom:event-category state-change/broadcast-budget
    event BroadcastBudgetWithdrawn(address indexed to, uint256 amount, uint256 newBalance);
    /// @custom:event-category state-change/broadcast-budget
    event TierPushSpacingSet(uint32 previous, uint32 current);

    /// @custom:event-category informational/tier-transport
    /// @notice A new push was committed for `user`; every broadcast lane is
    ///         owed it until delivered.
    event TierPushCommitted(
        address indexed user,
        uint64 nonce,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint40 tierExpirySec,
        uint16 tierTableVersion
    );
    /// @custom:event-category informational/tier-transport
    /// @notice The push `nonce` went out on lane `destChainId`. `feePaid` is
    ///         what left the Diamond for it; `callerFunded` says whether the
    ///         caller's value or the protocol budget paid.
    event ProtocolTierBroadcastSent(
        address indexed user,
        uint256 indexed destChainId,
        uint8 effectiveTier,
        uint16 effectiveBps,
        uint64 nonce,
        uint256 feePaid,
        bool callerFunded
    );
    /// @custom:event-category informational/tier-transport
    /// @notice Lane `destChainId` already held a tuple with the same effect
    ///         as push `nonce`, so it was settled without a message.
    event TierPushLaneSettled(address indexed user, uint256 indexed destChainId, uint64 nonce);
    /// @custom:event-category informational/tier-transport
    /// @notice Lane `destChainId` (0 when no lane could be named) is still
    ///         owed push `nonce`. Anyone may deliver it with {deliverTierPush}.
    event TierPushDeferred(
        address indexed user, uint256 indexed destChainId, uint64 nonce, TierPushDeferral reason
    );
    /// @custom:event-category informational/tier-transport
    event ProtocolTierBroadcastSkipped(address indexed user, string reason);

    // ─── Errors ─────────────────────────────────────────────────────────

    /// @notice External invocation by a non-self caller.
    error OnlyInternal(address caller);
    /// @notice Less than the fixed gas floor was left for a call to the
    ///         messenger; the whole action reverts so a push can never be
    ///         skipped by withholding gas.
    error TierPushOutOfGas();
    /// @notice {deliverTierPush} on a chain that does not originate pushes
    ///         (not canonical, or no messenger configured).
    error TierPushNotConfigured();
    /// @notice The caller's unspent value could not be returned.
    error TierPushRefundFailed();
    /// @notice {setTierPushSpacingSec} outside its bounds.
    error TierPushSpacingOutOfRange(uint32 value, uint32 min, uint32 max);
    /// @notice `withdrawBudget` would underflow the live balance.
    error WithdrawExceedsBudget(uint256 requested, uint256 available);
    /// @notice The treasury / `to` transfer reverted on withdraw.
    error WithdrawFailed();
    /// @notice `withdrawBudget` was called with `address(0)`. Other
    ///         cross-chain rescue paths reject zero recipients; this
    ///         does the same to prevent an unrecoverable operator
    ///         typo burning the budget (Codex Sub 2.D round-1 P2 #2).
    error ZeroRecipient();
    /// @notice `withdrawBudget` was called with `to == address(this)`.
    ///         The diamond's `receive()` would accept the value, the
    ///         accounting slot would decrement, but the native ETH
    ///         would stay in-contract as un-budgeted balance with no
    ///         path to re-credit. Reject upfront (Codex Sub 2.D round-4
    ///         P3 #3).
    error WithdrawToSelf();

    // ─── Producer call (rollup hook) ────────────────────────────────────

    /// @notice Called by `VPFIDiscountAccumulatorFacet.rollupUserDiscount`
    ///         via the diamond fallback after the ring-buffer + expiry
    ///         writes land. Commits a new push when the user's resolved
    ///         tuple changed, then delivers every owed lane it can.
    /// @dev    Never reverts on a lane, the budget or the destination list;
    ///         only {TierPushOutOfGas} (too little gas for a call) escapes.
    function protocolBroadcastTierUpdate(address user) external {
        if (msg.sender != address(this)) revert OnlyInternal(msg.sender);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Base-only — mirrors and unconfigured chains skip silently.
        if (!s.isCanonicalVpfiChain) {
            emit ProtocolTierBroadcastSkipped(user, "not-canonical-chain");
            return;
        }
        address msgr = s.rewardMessenger;
        if (msgr == address(0)) {
            emit ProtocolTierBroadcastSkipped(user, "messenger-not-configured");
            return;
        }

        bool committed = _commit(s, user);
        if (s.userTierPushNonce[user] == 0) return; // nothing ever committed
        _deliver(s, msgr, _committedPush(s, user), 0, committed);
    }

    /**
     * @notice Deliver every lane still owed `user`'s latest committed tier
     *         push. Open to anyone: `msg.value` pays owed lanes first, in
     *         destination-list order and without the spacing limit; a lane
     *         it does not cover is paid by the protocol budget under the
     *         usual rule (a lowered tier at once, anything else once per
     *         spacing window). The unspent value is returned to the caller.
     * @dev    Sends the committed push only; it never re-resolves the tier
     *         (the user's own `pokeMyTier` does that). Each lane that stays
     *         owed emits {TierPushDeferred}.
     */
    function deliverTierPush(address user) external payable nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address msgr = s.rewardMessenger;
        if (!s.isCanonicalVpfiChain || msgr == address(0)) revert TierPushNotConfigured();

        uint256 unspent = msg.value;
        if (s.userTierPushNonce[user] != 0) {
            unspent = _deliver(s, msgr, _committedPush(s, user), msg.value, true);
        }
        if (unspent != 0) {
            (bool ok,) = payable(msg.sender).call{value: unspent}("");
            if (!ok) revert TierPushRefundFailed();
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────

    /// @dev Resolve `user`'s tuple and commit it when it differs from the
    ///      latest committed push. Returns whether a push was committed.
    function _commit(LibVaipakam.Storage storage s, address user) private returns (bool) {
        (uint8 effTier, uint16 effBps) =
            IVPFIDiscountAccumulatorInternal(address(this)).effectiveTierAndBps(user);
        // Consent is applied at commit time: a consent-off user's mirrors
        // must stop applying a discount (T-087 Sub 4 round-3 P2 #2).
        if (!s.vpfiDiscountConsent[user]) {
            effTier = 0;
            effBps = 0;
        }
        uint40 expiry = s.tierExpirySec[user];
        if (expiry == 0) expiry = type(uint40).max; // never-rolled-up sentinel
        uint16 version = s.tierTableVersion;

        // Tier 0 against a committed tier 0 is no news to any mirror,
        // whatever the version (a mirror reads tier 0 as no discount).
        if (effTier == 0 && effBps == 0 && s.lastEffectiveTier[user] == 0 && s.lastEffectiveBps[user] == 0) {
            return false;
        }
        if (
            s.userTierPushNonce[user] != 0 && effTier == s.lastEffectiveTier[user]
                && effBps == s.lastEffectiveBps[user] && expiry == s.lastTierExpirySec[user]
                && version == s.lastTierTableVersion[user]
        ) {
            return false;
        }

        uint64 nonce = ++s.userTierPushNonce[user];
        s.lastEffectiveTier[user] = effTier;
        s.lastEffectiveBps[user] = effBps;
        s.lastTierExpirySec[user] = expiry;
        s.lastTierTableVersion[user] = version;
        emit TierPushCommitted(user, nonce, effTier, effBps, expiry, version);
        return true;
    }

    /// @dev The user's latest committed push.
    function _committedPush(LibVaipakam.Storage storage s, address user) private view returns (Push memory p) {
        p.user = user;
        p.nonce = s.userTierPushNonce[user];
        p.tier = s.lastEffectiveTier[user];
        p.bps = s.lastEffectiveBps[user];
        p.expiry = s.lastTierExpirySec[user];
        p.version = s.lastTierTableVersion[user];
    }

    /// @dev Deliver `p` to every owed lane. `callerFunds` is value the
    ///      caller attached (0 on the rollup path); returns what is left of
    ///      it. `announce` emits a deferral when no lane can be named.
    function _deliver(
        LibVaipakam.Storage storage s,
        address msgr,
        Push memory p,
        uint256 callerFunds,
        bool announce
    ) private returns (uint256) {
        uint256[] memory dsts;
        _requireGas(LIST_GAS_FLOOR);
        try IVaipakamRewardMessengerOutbound(msgr).getBroadcastDestinations() returns (uint256[] memory d) {
            dsts = d;
        } catch {
            if (announce) emit TierPushDeferred(p.user, 0, p.nonce, TierPushDeferral.Destinations);
            return callerFunds;
        }
        if (dsts.length == 0) {
            if (announce) emit TierPushDeferred(p.user, 0, p.nonce, TierPushDeferral.NoDestinations);
            return callerFunds;
        }
        for (uint256 i; i < dsts.length; ++i) {
            callerFunds = _deliverLane(s, IVaipakamRewardMessengerOutbound(msgr), p, dsts[i], callerFunds);
        }
        return callerFunds;
    }

    /// @dev Deliver `p` to lane `dst` if it is owed; returns what is left
    ///      of `callerFunds`.
    function _deliverLane(
        LibVaipakam.Storage storage s,
        IVaipakamRewardMessengerOutbound m,
        Push memory p,
        uint256 dst,
        uint256 callerFunds
    ) private returns (uint256) {
        LibVaipakam.TierLanePush storage lane = s.tierLanePush[p.user][dst];
        if (lane.nonce >= p.nonce) return callerFunds;

        if (_sameEffect(lane, p)) {
            lane.nonce = p.nonce;
            emit TierPushLaneSettled(p.user, dst, p.nonce);
            return callerFunds;
        }

        // A spaced lane with no caller value cannot be paid this time:
        // leave it owed without spending a quote on it.
        uint256 eligibleAt = _budgetEligibleAt(lane, p);
        if (callerFunds == 0 && block.timestamp < eligibleAt) {
            emit TierPushDeferred(p.user, dst, p.nonce, TierPushDeferral.Spacing);
            return callerFunds;
        }

        uint40 computedAt = uint40(block.timestamp);
        uint256 fee;
        _requireGas(QUOTE_GAS_FLOOR);
        try m.quoteSendTierUpdateTo(dst, p.user, p.tier, p.bps, computedAt, p.nonce, p.expiry, p.version)
        returns (uint256 q) {
            fee = q;
        } catch {
            emit TierPushDeferred(p.user, dst, p.nonce, TierPushDeferral.Quote);
            return callerFunds;
        }

        bool callerPays = callerFunds >= fee;
        if (!callerPays) {
            if (block.timestamp < eligibleAt) {
                emit TierPushDeferred(p.user, dst, p.nonce, TierPushDeferral.Spacing);
                return callerFunds;
            }
            if (s.protocolBroadcastBudget < fee) {
                emit TierPushDeferred(p.user, dst, p.nonce, TierPushDeferral.Budget);
                return callerFunds;
            }
        }

        uint256 before = address(this).balance;
        _requireGas(SEND_GAS_FLOOR);
        try m.sendTierUpdateTo{value: fee}(
            dst, p.user, p.tier, p.bps, computedAt, p.nonce, p.expiry, p.version, payable(address(this))
        ) {
            // What actually left the Diamond: the fee less any refund the
            // messenger returned in the same call.
            uint256 cost = before - address(this).balance;
            if (callerPays) callerFunds -= cost;
            else s.protocolBroadcastBudget -= cost;
            lane.nonce = p.nonce;
            lane.tier = p.tier;
            lane.bps = p.bps;
            lane.tierExpirySec = p.expiry;
            lane.tierTableVersion = p.version;
            lane.sentAt = computedAt;
            emit ProtocolTierBroadcastSent(p.user, dst, p.tier, p.bps, p.nonce, cost, callerPays);
        } catch {
            emit TierPushDeferred(p.user, dst, p.nonce, TierPushDeferral.Send);
        }
        return callerFunds;
    }

    /// @dev Whether the lane already holds a tuple with the same effect as
    ///      `p`: both tier 0 (a mirror reads tier 0 as no discount, whatever
    ///      the version), or the identical tuple.
    function _sameEffect(LibVaipakam.TierLanePush storage lane, Push memory p) private view returns (bool) {
        if (p.tier == 0 && p.bps == 0 && lane.tier == 0 && lane.bps == 0) return true;
        return lane.tier == p.tier && lane.bps == p.bps && lane.tierExpirySec == p.expiry
            && lane.tierTableVersion == p.version;
    }

    /// @dev When the protocol budget may pay `p` on `lane`: at once for a
    ///      push that lowers the lane's tier or bps (and for a lane that has
    ///      never carried a message, `sentAt == 0`), otherwise one spacing
    ///      window after the lane's last send.
    function _budgetEligibleAt(LibVaipakam.TierLanePush storage lane, Push memory p)
        private
        view
        returns (uint256)
    {
        if (lane.sentAt == 0 || p.tier < lane.tier || p.bps < lane.bps) return 0;
        return uint256(lane.sentAt) + LibVaipakam.cfgTierPushSpacingSecEffective();
    }

    /// @dev Revert unless the next call to the messenger is sure to receive
    ///      at least `floor` gas. The call forwards all but 1/64 of what is
    ///      left after its own cost (up to the value-transfer and cold-access
    ///      charges, covered by `CALL_OVERHEAD_GAS`), so holding
    ///      `floor * 64 / 63 + CALL_OVERHEAD_GAS` guarantees the callee
    ///      `floor`. The floors sit well above what each call needs through
    ///      the messenger, its CCIP adapter and the router, so a failure the
    ///      call returns cannot be one the caller induced by tuning gas, at
    ///      any depth of the call (Codex #2853 r1 P1). All gas is forwarded,
    ///      not capped: a call that costs more than expected still succeeds
    ///      when the caller supplied enough.
    function _requireGas(uint256 floor) private view {
        if (gasleft() < (floor * 64) / 63 + CALL_OVERHEAD_GAS) revert TierPushOutOfGas();
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
        if (to == address(this)) revert WithdrawToSelf();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 budget = s.protocolBroadcastBudget;
        if (amount > budget) revert WithdrawExceedsBudget(amount, budget);
        s.protocolBroadcastBudget = budget - amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit BroadcastBudgetWithdrawn(to, amount, s.protocolBroadcastBudget);
    }

    // ─── Read surface ──────────────────────────────────────────────────

    function getProtocolBroadcastBudget() external view returns (uint256) {
        return LibVaipakam.storageSlot().protocolBroadcastBudget;
    }

    function getUserTierPushNonce(address user) external view returns (uint64) {
        return LibVaipakam.storageSlot().userTierPushNonce[user];
    }

    /**
     * @notice `user`'s latest committed tier push and every broadcast
     *         lane's delivery state: what it last received, whether it is
     *         still owed, and when the protocol budget may next pay it.
     *         `lanes` is empty when this chain does not originate pushes or
     *         the messenger's destination list cannot be read.
     */
    function getTierPushStatus(address user)
        external
        view
        returns (
            uint64 nonce,
            uint8 effectiveTier,
            uint16 effectiveBps,
            uint40 tierExpirySec,
            uint16 tierTableVersion,
            TierLaneStatus[] memory lanes
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        Push memory p = _committedPush(s, user);
        nonce = p.nonce;
        effectiveTier = p.tier;
        effectiveBps = p.bps;
        tierExpirySec = p.expiry;
        tierTableVersion = p.version;
        address msgr = s.rewardMessenger;
        if (!s.isCanonicalVpfiChain || msgr == address(0)) return (nonce, effectiveTier, effectiveBps, tierExpirySec, tierTableVersion, lanes);
        uint256[] memory dsts;
        try IVaipakamRewardMessengerOutbound(msgr).getBroadcastDestinations() returns (uint256[] memory d) {
            dsts = d;
        } catch {
            return (nonce, effectiveTier, effectiveBps, tierExpirySec, tierTableVersion, lanes);
        }
        lanes = new TierLaneStatus[](dsts.length);
        for (uint256 i; i < dsts.length; ++i) {
            LibVaipakam.TierLanePush storage lane = s.tierLanePush[user][dsts[i]];
            lanes[i].destChainId = dsts[i];
            lanes[i].delivered = lane;
            lanes[i].owed = lane.nonce < p.nonce && !_sameEffect(lane, p);
            if (lanes[i].owed) lanes[i].budgetEligibleAt = uint40(_budgetEligibleAt(lane, p));
        }
    }

    /// @notice The protocol budget's per-lane spacing for a tier push that
    ///         does not lower the lane's tier.
    function getTierPushSpacingSec() external view returns (uint32) {
        return LibVaipakam.cfgTierPushSpacingSecEffective();
    }

    /// @notice Set the per-lane spacing, within [1 hour, 7 days]. ADMIN_ROLE.
    function setTierPushSpacingSec(uint32 value) external {
        LibAccessControl.checkRole(LibAccessControl.ADMIN_ROLE, msg.sender);
        if (value < LibVaipakam.MIN_TIER_PUSH_SPACING_SEC || value > LibVaipakam.MAX_TIER_PUSH_SPACING_SEC) {
            revert TierPushSpacingOutOfRange(
                value, LibVaipakam.MIN_TIER_PUSH_SPACING_SEC, LibVaipakam.MAX_TIER_PUSH_SPACING_SEC
            );
        }
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint32 previous = LibVaipakam.cfgTierPushSpacingSecEffective();
        s.cfgTierPushSpacingSec = value;
        emit TierPushSpacingSet(previous, value);
    }
}
