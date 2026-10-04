// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";
import {LibFacet} from "./LibFacet.sol";

/**
 * @title  LibServiceCapacity — #1219 (S-4): service capacity deposits, slice 1 —
 *         the record lifecycle.
 * @author Vaipakam Developer Team
 * @notice An operator posts VPFI into a dedicated escrow to buy operational
 *         capacity above the permissionless free tier for one role (the curve
 *         that prices it is the next slice). The deposit is refundable at
 *         will, earns nothing, and is never at risk: v1 has no slash predicate,
 *         so no path here ever moves principal anywhere but back to its owner.
 *         It is an operational capacity deposit — never called, nor treated
 *         as, a bond.
 * @dev    DARK by default: while `serviceCapacityEnabled` is false, posting is
 *         refused and withdrawals stand (the launch path, since VPFI is
 *         earn-only). Custody is a `RewardCustodyHolder` instance of its own —
 *         never the reward holder, never the Diamond's balance — so reward
 *         payouts, which read the reward holder's rows, never see it, and the
 *         Diamond-balance bounds gain no new subtraction. Every move is
 *         measured by balance delta on the destination.
 *
 *         SANCTIONS (every value-moving path, registry-aware tri-state, per
 *         selector): with no oracle configured the deploy-window rule of the
 *         rest of the Tier-1 surface applies and the screen passes; with one
 *         configured, `Flagged` on a wallet with NO persisted marker is a
 *         COMMITTED, value-unmoving refusal that persists the marker and
 *         returns a status (a revert would roll the marker back and hand the
 *         next outage a "never confirmed" wallet); `Flagged` with the marker
 *         persisted reverts, the central Tier-1 rule; `Unavailable` reverts for
 *         every party and persists nothing (fail-closed on an outage); `Clean`
 *         self-heals a stale marker. A withdrawal met by a first flag PARKS
 *         rather than refuses, so the frozen principal stays recorded and is
 *         released only by a later authoritative clean read.
 */
library LibServiceCapacity {
    using SafeERC20 for IERC20;

    /// @notice The mutation went through.
    uint8 internal constant STATUS_OK = 0;
    /// @notice Refused by a first authoritative sanctions flag; the marker was persisted; no value moved.
    uint8 internal constant STATUS_REFUSED_SANCTIONED = 1;
    /// @notice The withdrawal was PARKED by a first authoritative sanctions flag; nothing paid.
    uint8 internal constant STATUS_PARKED = 2;

    /// @custom:event-category informational/config
    event ServiceCapacityEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event ServiceCapacityEscrowBound(address indexed escrow);
    /// @notice A deposit opened: principal `amount` of `token` moved into the escrow; the record now holds `postBalance`, of which `eligibleAfter` is armed.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositPosted(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    /// @notice An existing deposit raised by `amount`.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositRaised(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    /// @notice Principal `amount` of `token` left the escrow for the operator; the record now holds `postBalance`.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositWithdrawn(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 amount, uint256 postBalance, uint256 eligibleAfter
    );
    /// @notice A withdrawal of `requested` was parked by a first authoritative sanctions flag; the park's cap is now `parkedRequest`.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositParked(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 requested, uint256 parkedRequest
    );
    /// @notice A parked withdrawal was released by an authoritative clean read: `paid` left the escrow; the record now holds `postBalance`.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositParkReleased(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 paid, uint256 postBalance
    );
    /// @notice A deposit mutation was refused by a first authoritative sanctions flag on `party`; the marker was persisted; no value moved.
    /// @custom:event-category state-change/service-capacity
    event ServiceCapacitySanctionsRefused(uint8 indexed role, address indexed operator, address indexed party, uint8 status);
    /// @notice An authoritative clean read healed `party`'s stale persisted sanctions marker.
    /// @custom:event-category state-change/service-capacity
    event ServiceCapacitySanctionsMarkerHealed(address indexed party);
    /// @notice `role`'s capacity curve was set (slice 2); `epoch` is the new curve epoch every bucket must re-settle under.
    /// @custom:event-category informational/config
    event CapacityCurveSet(uint8 indexed role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost, uint64 epoch);
    /// @notice `actor` spent `cost` of `role` capacity for one executed item; the bucket now holds `balanceAfter` (units x 1e18).
    /// @custom:event-category state-change/service-capacity
    event CapacitySpent(uint8 indexed role, address indexed actor, uint256 cost, uint256 balanceAfter);
    /// @notice `actor`'s `role` bucket was RESET to empty because its curve was retuned (epoch `fromEpoch` -> `toEpoch`).
    /// @custom:event-category state-change/service-capacity
    event CapacityBucketReset(uint8 indexed role, address indexed actor, uint64 fromEpoch, uint64 toEpoch);
    /// @notice `adapter`'s fills are charged to `operator` (actor rule 2).
    /// @custom:event-category informational/config
    event AdapterOperatorBound(address indexed adapter, address indexed operator);

    // ─── slice 2 — the limiter ───

    /// @notice Set `role`'s curve (ADMIN). Floors: every figure positive and
    ///         `freeTier >= classCost`, so a zero-deposit operator can always
    ///         complete one action — the permissionless baseline the whole design
    ///         preserves. Bumps the curve epoch: every bucket settled under the old
    ///         curve resets at its next touch (the conservative branch).
    function setCurve(LibVaipakam.Storage storage s, uint8 role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost)
        internal
    {
        requireRole(role);
        if (freeTier == 0 || freeRatePerSec == 0 || bondAt4x == 0 || classCost == 0 || freeTier < classCost) {
            revert IVaipakamErrors.ServiceCapacityCurveInvalid(role);
        }
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        c.freeTier = freeTier;
        c.freeRatePerSec = freeRatePerSec;
        c.bondAt4x = bondAt4x;
        c.classCost = classCost;
        c.epoch += 1;
        emit CapacityCurveSet(role, freeTier, freeRatePerSec, bondAt4x, classCost, c.epoch);
    }

    /// @dev The actor's eligible (armed) deposit for `role` in the live rotation epoch.
    function eligibleOf(LibVaipakam.Storage storage s, uint8 role, address actor) internal view returns (uint256) {
        return s.serviceDeposits[role][actor][s.vpfiRotationEpoch].eligibleAmount;
    }

    /// @dev The curve at `bond`: rate and ceiling grow LINEARLY from 1× at zero to
    ///      4× at `bondAt4x` and are flat beyond it — continuous, no threshold, no
    ///      minimum (rounding DOWN never creates one: a zero bond is exactly the
    ///      free tier). `rate = free × (bondAt4x + 3 × min(bond, bondAt4x)) / bondAt4x`.
    function curveAt(LibVaipakam.CapacityCurve storage c, uint256 bond) internal view returns (uint256 rate, uint256 ceiling) {
        uint256 b = bond < c.bondAt4x ? bond : c.bondAt4x;
        uint256 num = c.bondAt4x + 3 * b;
        rate = (c.freeRatePerSec * num) / c.bondAt4x;
        ceiling = (c.freeTier * num) / c.bondAt4x;
    }

    /// @notice What `actor`'s `role` bucket holds NOW: settled from its own last
    ///         touch at its own rate, clamped to its own ceiling; zero if the
    ///         bucket is unseen or belongs to a retired curve epoch. Pure view.
    function accruedNow(LibVaipakam.Storage storage s, uint8 role, address actor)
        internal
        view
        returns (uint256 accrued, uint256 rate, uint256 ceiling, bool dark)
    {
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (c.epoch == 0) return (0, 0, 0, true);
        (rate, ceiling) = curveAt(c, eligibleOf(s, role, actor));
        LibVaipakam.CapacityBucket storage b = s.capacityBuckets[role][actor];
        if (!b.seen) return (c.classCost < ceiling ? c.classCost : ceiling, rate, ceiling, false);
        if (b.curveEpoch != c.epoch) return (0, rate, ceiling, false);
        uint256 raw = uint256(b.balance) + rate * (block.timestamp - b.lastTouch);
        accrued = raw < ceiling ? raw : ceiling;
    }

    /// @notice Settle `actor`'s `role` bucket to now under the CURRENT curve and
    ///         deposit: an unseen bucket starts with ONE free action (the floor; a
    ///         refused spend reverts, so a first touch could never persist an empty
    ///         start, and the design's zero-deposit operator must complete one
    ///         action); a bucket on an older curve epoch RESETS to empty (event);
    ///         otherwise it accrues at its own rate
    ///         from its own last touch and is clamped to its own ceiling — so any
    ///         change of capacity (deposit up or down, retune) is settled under the
    ///         OLD terms by the previous touch and re-clamped under the new ones
    ///         here, never silently re-credited.
    function settle(LibVaipakam.Storage storage s, uint8 role, address actor, LibVaipakam.CapacityCurve storage c, bool freeOnly)
        internal
        returns (LibVaipakam.CapacityBucket storage b, uint256 ceiling)
    {
        b = s.capacityBuckets[role][actor];
        uint256 rate;
        (rate, ceiling) = curveAt(c, freeOnly ? 0 : eligibleOf(s, role, actor));
        if (!b.seen) {
            b.seen = true;
            b.balance = uint128(c.classCost < ceiling ? c.classCost : ceiling);
        } else if (b.curveEpoch != c.epoch) {
            emit CapacityBucketReset(role, actor, b.curveEpoch, c.epoch);
            b.balance = 0;
        } else {
            uint256 raw = uint256(b.balance) + rate * (block.timestamp - b.lastTouch);
            b.balance = uint128(raw < ceiling ? raw : ceiling);
        }
        b.lastTouch = uint64(block.timestamp);
        b.curveEpoch = c.epoch;
    }

    /// @notice Spend `units` executed items of `role` capacity by `actor`. With
    ///         the role's curve UNSET the limiter is dark and this is a no-op — the
    ///         permissionless baseline stands untouched on a fresh deployment.
    ///         Admission control: refused by name when the settled bucket cannot
    ///         cover the cost, so an admitted action is charged exactly once and a
    ///         reverting action is not charged at all.
    function spend(LibVaipakam.Storage storage s, uint8 role, address actor, uint256 units, bool freeOnly) internal {
        requireRole(role);
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (c.epoch == 0 || units == 0) return;
        (LibVaipakam.CapacityBucket storage b, ) = settle(s, role, actor, c, freeOnly);
        uint256 cost = c.classCost * units;
        uint256 have = b.balance;
        if (have < cost) revert IVaipakamErrors.ServiceCapacityExhausted(role, actor, cost, have);
        b.balance = uint128(have - cost);
        emit CapacitySpent(role, actor, cost, have - cost);
    }

    /// @notice Settle `actor`'s bucket under its current deposit — called by the
    ///         deposit paths when the deposit changes, so elapsed credit is settled
    ///         under the OLD capacity before the new one applies (the design's
    ///         fourth-site rule). A no-op while the role's limiter is dark.
    function settleOnDepositChange(LibVaipakam.Storage storage s, uint8 role, address actor) internal {
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (c.epoch == 0) return;
        settle(s, role, actor, c, false);
    }

    /// @notice The compact gate every charged route calls: ONE self-call into the
    ///         capacity facet, so the bucket arithmetic is compiled into that facet
    ///         alone and a gated facet pays only this encoding. Reverts bubble
    ///         typed, so `ServiceCapacityExhausted` reaches the caller by name.
    ///         DARK (no curve for the role) means no charge AND no self-call: a
    ///         fresh deployment pays nothing per fill or action, and a Diamond that
    ///         has not routed the capacity facet is not broken by the gate.
    function charge(uint8 role, address actor, bool freeOnly) internal {
        if (LibVaipakam.storageSlot().capacityCurves[role].epoch == 0) return;
        LibFacet.crossFacetCall(
            abi.encodeWithSignature("capacitySpendInternal(uint8,address,uint256,bool)", role, actor, uint256(1), freeOnly),
            IVaipakamErrors.ServiceCapacityCallFailed.selector
        );
    }

    /// @dev The keeper-route gate: the keeper that acted (never the owner acting alone) pays one action.
    function chargeKeeper() internal {
        charge(uint8(LibVaipakam.ServiceCapacityRole.Keeper), msg.sender, false);
    }

    /// @dev The solver-route gate for a direct solver: one fill at the solver's own capacity.
    function chargeSolver(address actor) internal {
        charge(uint8(LibVaipakam.ServiceCapacityRole.Solver), actor, false);
    }

    bytes32 internal constant BACKSTOP_INITIATOR_TSLOT = keccak256("vaipakam.service-capacity.backstop-initiator");

    /// @dev Actor rule 3 — `backstopFill` records its caller in TRANSIENT storage
    ///      before the vault's fill, so the inner `matchIntent` can charge the OUTER
    ///      initiator's free tier instead of the shared vault (EIP-1153: per-tx,
    ///      free at tx end, no vault ABI change).
    function setBackstopInitiator(address who) internal {
        bytes32 slot = BACKSTOP_INITIATOR_TSLOT;
        assembly ("memory-safe") {
            tstore(slot, who)
        }
    }

    function takeBackstopInitiator() internal returns (address who) {
        bytes32 slot = BACKSTOP_INITIATOR_TSLOT;
        assembly ("memory-safe") {
            who := tload(slot)
            tstore(slot, 0)
        }
    }

    /// @notice The solver-route charge for `matchIntent`, resolving the ACTOR by
    ///         route (the design's four rules): (1) a direct solver pays at its own
    ///         capacity; (2) a registered adapter's fill is charged to the operator
    ///         bound to it at creation — an adapter with no binding pays at its OWN
    ///         free tier (never a bypass; the admin binds legacy adapters before a
    ///         curve is set); (3) the backstop vault's fill is charged to the OUTER
    ///         initiator's FREE tier, deposit ignored, so no user can exhaust a
    ///         shared quota and rotation buys only the permissionless baseline.
    function chargeIntentFill(LibVaipakam.Storage storage s) internal {
        uint8 solver = uint8(LibVaipakam.ServiceCapacityRole.Solver);
        if (msg.sender == s.backstopVault) {
            address initiator = takeBackstopInitiator();
            charge(solver, initiator == address(0) ? msg.sender : initiator, true);
            return;
        }
        if (s.isAggregatorAdapter[msg.sender]) {
            address op = s.adapterOperator[msg.sender];
            if (op == address(0)) charge(solver, msg.sender, true);
            else charge(solver, op, false);
            return;
        }
        charge(solver, msg.sender, false);
    }

    /// @dev `role` must be a capacity role.
    function requireRole(uint8 role) internal pure {
        if (role > uint8(LibVaipakam.ServiceCapacityRole.Keeper)) revert IVaipakamErrors.ServiceCapacityRoleUnknown(role);
    }

    /// @dev The bound escrow and the live VPFI token; both must exist.
    function escrowAndToken(LibVaipakam.Storage storage s) internal view returns (address escrow, address token) {
        token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.VPFITokenNotSet();
        escrow = s.serviceCapacityEscrow;
        if (escrow == address(0)) revert IVaipakamErrors.ServiceCapacityEscrowNotBound();
    }

    /// @notice The registry-aware tri-state screen for a deposit MUTATION on
    ///         `party`. Returns true when the mutation may proceed. See the
    ///         library's SANCTIONS note for the four outcomes; the caller turns
    ///         a false into a returned status, never a revert.
    function screen(LibVaipakam.Storage storage s, uint8 role, address operator, address party) internal returns (bool ok) {
        if (s.sanctionsOracle == address(0)) return true; // the deploy-window rule of the whole Tier-1 surface
        LibVaipakam.SanctionsRead st = LibVaipakam.sanctionsStatus(party);
        if (st == LibVaipakam.SanctionsRead.Flagged) {
            if (s.sanctionsConfirmedFlagged[party]) revert LibVaipakam.SanctionedAddress(party);
            s.sanctionsConfirmedFlagged[party] = true;
            emit ServiceCapacitySanctionsRefused(role, operator, party, STATUS_REFUSED_SANCTIONED);
            return false;
        }
        if (st == LibVaipakam.SanctionsRead.Unavailable) revert IVaipakamErrors.ServiceCapacitySanctionsUnavailable(party);
        if (s.sanctionsConfirmedFlagged[party]) {
            delete s.sanctionsConfirmedFlagged[party];
            emit ServiceCapacitySanctionsMarkerHealed(party);
        }
        return true;
    }

    /// @notice Post `amount` of the live VPFI into `operator`'s deposit for
    ///         `role` (a raise when the record already holds principal).
    ///         Refused while the channel is dark. The eligible balance follows
    ///         the principal while no arming fee exists.
    /// @return status {STATUS_OK}, or {STATUS_REFUSED_SANCTIONED} with no value moved.
    function post(LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount) internal returns (uint8 status) {
        requireRole(role);
        if (!s.serviceCapacityEnabled) revert IVaipakamErrors.ServiceCapacityDisabled();
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        (address escrow, address token) = escrowAndToken(s);
        if (!screen(s, role, operator, operator)) return STATUS_REFUSED_SANCTIONED;
        uint64 epoch = s.vpfiRotationEpoch;
        LibVaipakam.ServiceCapacityDeposit storage d = s.serviceDeposits[role][operator][epoch];
        bool raise = d.amount != 0;
        if (d.token == address(0)) {
            d.token = token;
            d.rotationEpoch = epoch;
        }
        d.state = LibVaipakam.ServiceDepositState.Active;
        settleOnDepositChange(s, role, operator); // elapsed credit under the OLD capacity, before the raise
        _pull(token, operator, escrow, amount);
        d.amount += amount;
        d.eligibleAmount = d.amount;
        s.serviceDepositEscrowByEpoch[epoch] += amount;
        if (raise) emit CapacityDepositRaised(role, operator, epoch, token, amount, d.amount, d.eligibleAmount);
        else emit CapacityDepositPosted(role, operator, epoch, token, amount, d.amount, d.eligibleAmount);
        return STATUS_OK;
    }

    /// @notice Withdraw `amount` of `operator`'s deposit for `role` in the LIVE
    ///         rotation epoch — immediately (owner: unbond option (i)); always
    ///         callable, dark or not. A first authoritative sanctions flag PARKS
    ///         the request (capped to the principal) instead of refusing it; a
    ///         later authoritative clean read releases a parked deposit's cap.
    /// @return status {STATUS_OK} with `paid`, or {STATUS_PARKED} with nothing paid.
    function withdraw(LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount)
        internal
        returns (uint8 status, uint256 paid)
    {
        requireRole(role);
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        LibVaipakam.ServiceCapacityDeposit storage d = s.serviceDeposits[role][operator][s.vpfiRotationEpoch];
        if (d.amount == 0) revert IVaipakamErrors.ServiceCapacityInsufficient(role, operator, 0, amount);
        address escrow = s.serviceCapacityEscrow;
        if (escrow == address(0)) revert IVaipakamErrors.ServiceCapacityEscrowNotBound();
        if (s.sanctionsOracle != address(0)) {
            LibVaipakam.SanctionsRead st = LibVaipakam.sanctionsStatus(operator);
            if (st == LibVaipakam.SanctionsRead.Flagged) {
                if (s.sanctionsConfirmedFlagged[operator]) revert LibVaipakam.SanctionedAddress(operator);
                // The committed first-flag transition: persist the marker and park
                // the request; a revert would roll both back.
                s.sanctionsConfirmedFlagged[operator] = true;
                d.state = LibVaipakam.ServiceDepositState.SanctionsParked;
                uint256 cap = d.parkedRequest + amount;
                d.parkedRequest = cap < d.amount ? cap : d.amount;
                emit CapacityDepositParked(role, operator, d.rotationEpoch, amount, d.parkedRequest);
                return (STATUS_PARKED, 0);
            }
            if (st == LibVaipakam.SanctionsRead.Unavailable) revert IVaipakamErrors.ServiceCapacitySanctionsUnavailable(operator);
            if (s.sanctionsConfirmedFlagged[operator]) {
                delete s.sanctionsConfirmedFlagged[operator];
                emit ServiceCapacitySanctionsMarkerHealed(operator);
            }
        }
        settleOnDepositChange(s, role, operator); // elapsed credit under the OLD capacity; the decrease clamps at the next touch
        bool released;
        if (d.state == LibVaipakam.ServiceDepositState.SanctionsParked) {
            // The clean read releases the PARKED cap, never more; a further
            // amount is a new request on the released record.
            paid = d.parkedRequest < d.amount ? d.parkedRequest : d.amount;
            d.parkedRequest = 0;
            d.state = LibVaipakam.ServiceDepositState.Active;
            released = true;
        } else {
            if (amount > d.amount) revert IVaipakamErrors.ServiceCapacityInsufficient(role, operator, d.amount, amount);
            paid = amount;
        }
        d.amount -= paid;
        d.eligibleAmount = d.amount;
        s.serviceDepositEscrowByEpoch[d.rotationEpoch] -= paid;
        _release(escrow, d.token, operator, paid);
        if (released) emit CapacityDepositParkReleased(role, operator, d.rotationEpoch, paid, d.amount);
        else emit CapacityDepositWithdrawn(role, operator, d.rotationEpoch, d.token, paid, d.amount, d.eligibleAmount);
        return (STATUS_OK, paid);
    }

    /// @dev `from` → `to` by `safeTransferFrom`, measured on the destination.
    function _pull(address token, address from, address to, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from, to, amount);
        uint256 moved = IERC20(token).balanceOf(to) - before;
        if (moved != amount) revert IVaipakamErrors.ServiceCapacityMoveUnverified(amount, moved);
    }

    /// @dev escrow → `to` through the holder's Diamond-only release, measured on the destination.
    function _release(address escrow, address token, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = IERC20(token).balanceOf(to);
        RewardCustodyHolder(escrow).release(token, to, amount);
        uint256 moved = IERC20(token).balanceOf(to) - before;
        if (moved != amount) revert IVaipakamErrors.ServiceCapacityMoveUnverified(amount, moved);
    }
}
