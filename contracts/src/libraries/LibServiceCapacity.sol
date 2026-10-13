// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibVpfiRecycle} from "./LibVpfiRecycle.sol";

/**
 * @title  LibServiceCapacity — #1219 (S-4): service capacity deposits — the
 *         record lifecycle (slice 1), the limiter (slice 2), the arming fee and
 *         the rotation epochs (slice 3).
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

    /// @notice Why a post would be refused — the post's own checks, in its order,
    ///         as {postWalk} returns them to the preview (the post reverts by name).
    uint8 internal constant POST_OK = 0;
    uint8 internal constant POST_CHANNEL_DARK = 1;         // ServiceCapacityDisabled
    uint8 internal constant POST_NOT_BOUND = 2;            // VPFITokenNotSet / ServiceCapacityEscrowNotBound
    uint8 internal constant POST_ARMING_DARK = 3;          // ServiceCapacityArmingDark
    uint8 internal constant POST_NOTHING_TO_ARM = 4;       // ServiceCapacityNothingToArm
    uint8 internal constant POST_RETIRED_BALANCE = 5;      // ServiceCapacityOldEpochBalanceStands
    uint8 internal constant POST_SANCTIONED = 6;           // a refusal status, or SanctionedAddress
    uint8 internal constant POST_SANCTIONS_UNAVAILABLE = 7; // ServiceCapacitySanctionsUnavailable

    /// @notice The least units a curve's per-action cost and free refill rate may
    ///         carry (#2459 r1): rounding then never costs more than a millionth
    ///         of an action, so no armed principal sits in a dead zone.
    uint256 internal constant CURVE_RESOLUTION = 1e6;

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
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 paid, uint256 postBalance, uint256 eligibleAfter
    );
    /// @notice Principal already deposited was ARMED without new principal (a zero-principal post): `armed` more is now eligible, `eligibleAfter` in all, of the `balance` the record holds.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositArmed(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, address token, uint256 armed, uint256 balance, uint256 eligibleAfter
    );
    /// @notice A deposit mutation was refused by a first authoritative sanctions flag on `party`; the marker was persisted; no value moved.
    /// @custom:event-category state-change/service-capacity
    event ServiceCapacitySanctionsRefused(uint8 indexed role, address indexed operator, address indexed party, uint8 status);
    /// @notice An authoritative clean read healed `party`'s stale persisted sanctions marker.
    /// @custom:event-category state-change/service-capacity
    event ServiceCapacitySanctionsMarkerHealed(address indexed party);
    /// @notice `role`'s capacity curve was set (slice 2); `epoch` is the new curve epoch every bucket must re-settle under. All-zero figures mean the curve was CLEARED by a VPFI token rotation (slice 3): dark until re-set; the epoch counter is kept.
    /// @custom:event-category informational/config
    event CapacityCurveSet(uint8 indexed role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost, uint64 epoch);
    /// @notice `actor` spent `cost` of `role` capacity for one executed item; the bucket now holds `balanceAfter` (units x 1e18).
    /// @custom:event-category state-change/service-capacity
    event CapacitySpent(uint8 indexed role, address indexed actor, uint256 cost, uint256 balanceAfter);
    /// @notice `initiator` spent `cost` of its FREE-TIER `role` bucket (the backstop route, or an unbound route) for one executed item; that bucket now holds `balanceAfter`.
    /// @custom:event-category state-change/service-capacity
    event CapacityFreeTierSpent(uint8 indexed role, address indexed initiator, uint256 cost, uint256 balanceAfter);
    /// @notice `actor`'s `role` bucket forfeited the credit it earned under curve epoch `fromEpoch` (the curve was retuned to `toEpoch`); it accrues under the new curve from the moment that curve was set.
    /// @custom:event-category state-change/service-capacity
    event CapacityBucketReset(uint8 indexed role, address indexed actor, uint64 fromEpoch, uint64 toEpoch);
    /// @notice `adapter`'s fills are charged to `operator` (actor rule 2).
    /// @custom:event-category informational/config
    event AdapterOperatorBound(address indexed adapter, address indexed operator);
    /// @notice The arming fee's shape changed (slice 3): `rate` (1e18 = the whole newly-armed principal; 0 = arming dark) over `floor`.
    /// @custom:event-category informational/config
    event ArmingFeeSet(uint256 rate, uint256 floor);
    /// @notice `operator` paid `fee` of the live VPFI into Diamond custody (recycled, never escrowed) for `capacityGranted` of principal newly armed for `role`; the deposit now buys `ceilingAfter`.
    /// @custom:event-category state-change/service-capacity
    event ArmingFeePaid(
        uint8 indexed role, address indexed operator, uint64 indexed rotationEpoch, uint256 fee, uint256 capacityGranted, uint256 ceilingAfter
    );
    /// @notice A VPFI token rotation RETIRED rotation epoch `epoch`: its principal (`total` of `token`) stays in `escrow`, keyed by the epoch, withdrawable in that asset; the live epoch is now `epoch + 1` under `newToken`; every role's curve was cleared.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositEpochArchived(uint64 indexed epoch, address indexed token, address indexed newToken, address escrow, uint256 total);
    /// @notice The first touch of a record in RETIRED epoch `epoch`: `operator`'s `role` deposit of `amount` of `token` is materialized as archived.
    /// @custom:event-category state-change/service-capacity
    event CapacityDepositMigrated(uint8 indexed role, address indexed operator, uint64 indexed epoch, address token, uint256 amount);

    /// @notice The terms a payer BINDS on a post (slice 3): the most fee they will
    ///         pay, the least capacity (ceiling) they expect afterwards, and the
    ///         rotation and curve epochs they quoted under. Any that moved refuses
    ///         by name, so a quote reviewed is the post executed.
    struct ArmingBind {
        uint256 maxFee;
        uint256 minCapacityAfter;
        uint64 expectedRotationEpoch;
        uint64 expectedCurveEpoch;
    }

    // ─── slice 2 — the limiter ───

    /// @notice Set `role`'s curve (ADMIN). Floors: every figure positive and
    ///         `freeTier >= classCost`, so a zero-deposit operator can always
    ///         complete one action — the permissionless baseline the whole design
    ///         preserves; `freeTier` small enough that the 4x ceiling fits a bucket.
    ///         Bumps the curve epoch and records when it was set: every bucket
    ///         settled under the old curve forfeits that credit at its next touch
    ///         and accrues under this curve from the moment it was set. Dark ⟺
    ///         `freeTier == 0`: unset, or cleared by a token rotation (slice 3); the
    ///         epoch counter survives the clearing so a re-set curve still retires
    ///         every bucket of the old regime.
    function setCurve(LibVaipakam.Storage storage s, uint8 role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost)
        internal
    {
        requireRole(role);
        // A RESOLUTION floor on the two unit figures (#2459 r1): capacity is
        // computed on whole units from the TOTAL armed principal, so rounding
        // loses less than one unit of ceiling and one unit per second of rate.
        // At a million units per action (and per second of the free refill) that
        // is under a millionth of an action — a curve coarse enough for rounding
        // to swallow a meaningful share of an action (e.g. one unit per action)
        // would make armed principal buy nothing until a threshold, the minimum
        // the curve exists not to have, while the arming fee was still charged.
        if (
            freeTier == 0 || freeRatePerSec < CURVE_RESOLUTION || bondAt4x == 0 || classCost < CURVE_RESOLUTION
                || freeTier < classCost || freeTier > type(uint128).max / 4
        ) {
            revert IVaipakamErrors.ServiceCapacityCurveInvalid(role);
        }
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        c.freeTier = freeTier;
        c.freeRatePerSec = freeRatePerSec;
        c.bondAt4x = bondAt4x;
        c.classCost = classCost;
        c.epoch += 1;
        c.setAt = uint64(block.timestamp);
        emit CapacityCurveSet(role, freeTier, freeRatePerSec, bondAt4x, classCost, c.epoch);
    }

    /// @dev The actor's eligible (armed) deposit for `role` in the live rotation epoch.
    function eligibleOf(LibVaipakam.Storage storage s, uint8 role, address actor) internal view returns (uint256) {
        return s.serviceDeposits[role][actor][s.vpfiRotationEpoch].eligibleAmount;
    }

    /// @dev The curve at `bond`: rate and ceiling grow LINEARLY from 1× at zero to
    ///      4× at `bondAt4x` and are flat beyond it — continuous, no threshold, no
    ///      minimum: rounding DOWN creates none, a zero bond being exactly the free
    ///      tier, because {setCurve} requires {CURVE_RESOLUTION} on the unit
    ///      figures, so what rounding loses is under a millionth of an action. `rate = free × (bondAt4x + 3 × min(bond, bondAt4x)) / bondAt4x`.
    function curveAt(LibVaipakam.CapacityCurve storage c, uint256 bond) internal view returns (uint256 rate, uint256 ceiling) {
        uint256 b = bond < c.bondAt4x ? bond : c.bondAt4x;
        uint256 num = c.bondAt4x + 3 * b;
        rate = (c.freeRatePerSec * num) / c.bondAt4x;
        ceiling = (c.freeTier * num) / c.bondAt4x;
    }

    /// @notice What `actor`'s `role` bucket holds NOW — the bonded bucket, or with
    ///         `freeOnly` the actor's free-tier bucket (rules 3 and 4): one free
    ///         action if unseen; otherwise settled at its own rate, clamped to its
    ///         own ceiling, from its own last touch — or, for a bucket of a retired
    ///         curve epoch, from the moment the live curve was set (the same rule
    ///         {settle} applies, through {_settledBalance}). Pure view.
    function accruedNow(LibVaipakam.Storage storage s, uint8 role, address actor, bool freeOnly)
        internal
        view
        returns (uint256 accrued, uint256 rate, uint256 ceiling, bool dark)
    {
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (c.freeTier == 0) return (0, 0, 0, true);
        (rate, ceiling) = curveAt(c, freeOnly ? 0 : eligibleOf(s, role, actor));
        LibVaipakam.CapacityBucket storage b = _bucket(s, role, actor, freeOnly);
        if (!b.seen) return (c.classCost, rate, ceiling, false);
        accrued = _settledBalance(b, c, rate, ceiling);
    }

    /// @dev The bucket a charge reads: the bonded `(role, actor)` bucket, or the
    ///      free-tier one for the backstop and unbound routes.
    function _bucket(LibVaipakam.Storage storage s, uint8 role, address actor, bool freeOnly)
        private
        view
        returns (LibVaipakam.CapacityBucket storage)
    {
        return freeOnly ? s.capacityFreeBuckets[role][actor] : s.capacityBuckets[role][actor];
    }

    /// @dev A SEEN bucket's balance now: on the live curve epoch, its stored balance
    ///      plus what it earned since its last touch; on a retired epoch, only what
    ///      it earned under the live curve since that curve was set (the old credit
    ///      is forfeited — never the bucket's future, which a refused spend would
    ///      otherwise roll back on every attempt). Clamped to `ceiling`.
    function _settledBalance(
        LibVaipakam.CapacityBucket storage b, LibVaipakam.CapacityCurve storage c, uint256 rate, uint256 ceiling
    ) private view returns (uint256) {
        uint256 raw = b.curveEpoch == c.epoch
            ? uint256(b.balance) + rate * (block.timestamp - b.lastTouch)
            : rate * (block.timestamp - c.setAt);
        return raw < ceiling ? raw : ceiling;
    }

    /// @notice Settle `actor`'s `role` bucket to now under the CURRENT curve and
    ///         deposit: an unseen bucket starts with ONE free action (the floor; a
    ///         refused spend reverts, so a first touch could never persist an empty
    ///         start, and the design's zero-deposit operator must complete one
    ///         action); a bucket on an older curve epoch is re-priced under the
    ///         CURRENT curve from the retune (`setAt`), clamped to its ceiling (event);
    ///         otherwise it accrues at its own rate
    ///         from its own last touch and is clamped to its own ceiling — so any
    ///         change of capacity (deposit up or down, retune) is settled under the
    ///         OLD terms by the previous touch and re-clamped under the new ones
    ///         here, never silently re-credited.
    function settle(LibVaipakam.Storage storage s, uint8 role, address actor, LibVaipakam.CapacityCurve storage c, bool freeOnly)
        internal
        returns (LibVaipakam.CapacityBucket storage b, uint256 ceiling)
    {
        b = _bucket(s, role, actor, freeOnly);
        uint256 rate;
        (rate, ceiling) = curveAt(c, freeOnly ? 0 : eligibleOf(s, role, actor));
        if (!b.seen) {
            // Exactly one action. Every first touch happens at ZERO eligible — a post
            // settles before it raises, and a post while the role is dark is refused
            // (slice 3) — so the ceiling here is the free tier, floored at one action.
            b.seen = true;
            b.balance = uint128(c.classCost);
        } else {
            // #1219 review P1: a retired-epoch bucket accrues from the live curve's
            // set time (`_settledBalance`) rather than restarting empty HERE — an empty
            // restart at the touch was rolled back by the refused spend it caused, so a
            // seen actor stayed locked out after any retune.
            if (b.curveEpoch != c.epoch) emit CapacityBucketReset(role, actor, b.curveEpoch, c.epoch);
            b.balance = uint128(_settledBalance(b, c, rate, ceiling));
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
        if (c.freeTier == 0 || units == 0) return;
        (LibVaipakam.CapacityBucket storage b, ) = settle(s, role, actor, c, freeOnly);
        uint256 cost = c.classCost * units;
        uint256 have = b.balance;
        if (have < cost) revert IVaipakamErrors.ServiceCapacityExhausted(role, actor, cost, have);
        b.balance = uint128(have - cost);
        if (freeOnly) emit CapacityFreeTierSpent(role, actor, cost, have - cost);
        else emit CapacitySpent(role, actor, cost, have - cost);
    }

    /// @notice Settle `actor`'s bucket under its current deposit — called by the
    ///         deposit paths when the deposit changes, so elapsed credit is settled
    ///         under the OLD capacity before the new one applies (the design's
    ///         fourth-site rule). A no-op while the role's limiter is dark.
    function settleOnDepositChange(LibVaipakam.Storage storage s, uint8 role, address actor) internal {
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (c.freeTier == 0) return;
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
        if (LibVaipakam.storageSlot().capacityCurves[role].freeTier == 0) return;
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

    /// @notice The ACTOR a fill or action by `caller` is charged to, by route — the
    ///         design's four rules, resolved in ONE place for the charge and the
    ///         preview: (1) a direct caller pays at its own capacity; (2) a registered
    ///         adapter is charged to the operator bound to it at creation, never the
    ///         adapter contract; (3) the backstop vault's fill is charged to the OUTER
    ///         initiator's FREE tier, deposit ignored, so no user can exhaust a shared
    ///         quota and rotation buys only the permissionless baseline; (4) a route
    ///         with no binding — an unbound adapter, or a backstop fill with no
    ///         recorded initiator — falls to the outer initiator's free tier, never to
    ///         an intermediate contract. The outer initiator of a route the Diamond
    ///         cannot see past is the transaction's originator: free-tier metering
    ///         only, never authorization.
    /// @param  backstopInitiator The initiator `backstopFill` recorded (zero in a preview).
    function routeActor(LibVaipakam.Storage storage s, address caller, address backstopInitiator)
        internal
        view
        returns (address actor, bool freeOnly)
    {
        if (caller == s.backstopVault) {
            return (backstopInitiator == address(0) ? tx.origin : backstopInitiator, true);
        }
        if (s.isAggregatorAdapter[caller]) {
            address op = s.adapterOperator[caller];
            return op == address(0) ? (tx.origin, true) : (op, false);
        }
        return (caller, false);
    }

    /// @notice The solver-route charge for `matchIntent`: one fill, to the actor
    ///         {routeActor} names for the caller.
    function chargeIntentFill(LibVaipakam.Storage storage s) internal {
        address initiator = msg.sender == s.backstopVault ? takeBackstopInitiator() : address(0);
        (address actor, bool freeOnly) = routeActor(s, msg.sender, initiator);
        charge(uint8(LibVaipakam.ServiceCapacityRole.Solver), actor, freeOnly);
    }

    /// @notice The keeper-route charge for an aggregator ADAPTER acting on its own
    ///         intent (rule 2; rule 4 when unbound): one action to its bound operator.
    function chargeAdapterAction(LibVaipakam.Storage storage s) internal {
        (address actor, bool freeOnly) = routeActor(s, msg.sender, address(0));
        charge(uint8(LibVaipakam.ServiceCapacityRole.Keeper), actor, freeOnly);
    }

    /// @notice Whether a fill by `caller` would clear its capacity charge now — the
    ///         previews' last check, through the same route rule and accrual as the
    ///         charge. True while the solver limiter is dark.
    function fillCovered(LibVaipakam.Storage storage s, address caller) internal view returns (bool) {
        uint8 solver = uint8(LibVaipakam.ServiceCapacityRole.Solver);
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[solver];
        if (c.freeTier == 0) return true;
        (address actor, bool freeOnly) = routeActor(s, caller, address(0));
        (uint256 accrued,,,) = accruedNow(s, solver, actor, freeOnly);
        return accrued >= c.classCost;
    }

    // ─── slice 3 — the arming fee ───

    /// @notice Set the arming fee rate (ADMIN; governance later): 1e18 = the whole
    ///         newly-armed principal. Zero keeps arming DARK (posting refused); a
    ///         positive rate must sit at or above a positive floor — the floor is
    ///         the code's guarantee that the fee is never configured away to a
    ///         token once lit.
    function setArmingFeeRate(LibVaipakam.Storage storage s, uint256 rate) internal {
        if (rate != 0 && (s.armingFeeFloor == 0 || rate < s.armingFeeFloor)) {
            revert IVaipakamErrors.ServiceCapacityArmingFeeBelowFloor(rate, s.armingFeeFloor);
        }
        s.armingFeeRate = rate;
        emit ArmingFeeSet(rate, s.armingFeeFloor);
    }

    /// @notice Raise the arming fee floor (ADMIN; raise-only, never back to zero).
    ///         A live rate under the new floor is refused rather than silently
    ///         re-priced: lift the rate first.
    function setArmingFeeFloor(LibVaipakam.Storage storage s, uint256 floor) internal {
        if (floor <= s.armingFeeFloor) revert IVaipakamErrors.ServiceCapacityArmingFloorNotRaised(s.armingFeeFloor, floor);
        if (s.armingFeeRate != 0 && s.armingFeeRate < floor) {
            revert IVaipakamErrors.ServiceCapacityArmingFeeBelowFloor(s.armingFeeRate, floor);
        }
        s.armingFeeFloor = floor;
        emit ArmingFeeSet(s.armingFeeRate, floor);
    }

    /// @notice The arming quote for posting `amount` into `operator`'s `role`
    ///         deposit. The ARMED (eligible) balance is the principal under the
    ///         knee `bondAt4x` as it stood when the principal was armed, and only it
    ///         buys capacity (#1219 review P2: a knee raised later arms nothing by
    ///         itself — principal deposited above the old knee stays unarmed until a
    ///         post arms it and pays for it). A post arms up to the live knee:
    ///         `eligibleAfter = max(eligibleBefore, min(principalAfter, bondAt4x))`;
    ///         `granted` is what that newly arms; `fee = ceil(granted × rate / 1e18)`
    ///         (rounded up, so no armed principal is ever free); `ceilingAfter` is
    ///         the capacity the armed balance buys. A zero-principal post therefore
    ///         arms already-deposited excess. `dark` (no positive rate, or the role's
    ///         curve unset) ⇒ zeros.
    function armingQuote(LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount)
        internal
        view
        returns (uint256 fee, uint256 granted, uint256 eligibleAfter, uint256 ceilingAfter, bool dark)
    {
        LibVaipakam.CapacityCurve storage c = s.capacityCurves[role];
        if (s.armingFeeRate == 0 || c.freeTier == 0) return (0, 0, 0, 0, true);
        LibVaipakam.ServiceCapacityDeposit storage d = s.serviceDeposits[role][operator][s.vpfiRotationEpoch];
        uint256 before = d.eligibleAmount;
        uint256 principalAfter = d.amount + amount;
        uint256 kneeArmed = principalAfter < c.bondAt4x ? principalAfter : c.bondAt4x;
        eligibleAfter = kneeArmed > before ? kneeArmed : before;
        granted = eligibleAfter - before;
        fee = granted == 0 ? 0 : (granted * s.armingFeeRate + 1e18 - 1) / 1e18;
        (, ceilingAfter) = curveAt(c, eligibleAfter);
    }

    /// @notice The post's own checks, in the post's order, without moving anything
    ///         — the ONE walk {post} executes (reverting by name) and the preview
    ///         returns (as a code), so a preview never quotes a post that would be
    ///         refused. The sanctions read is the post's three-way read; the post
    ///         alone persists a first flag.
    function postWalk(LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount)
        internal
        view
        returns (uint8 refusal, uint256 fee, uint256 granted, uint256 eligibleAfter, uint256 ceilingAfter)
    {
        requireRole(role);
        if (!s.serviceCapacityEnabled) return (POST_CHANNEL_DARK, 0, 0, 0, 0);
        if (s.vpfiToken == address(0) || s.serviceCapacityEscrow == address(0)) return (POST_NOT_BOUND, 0, 0, 0, 0);
        bool dark;
        (fee, granted, eligibleAfter, ceilingAfter, dark) = armingQuote(s, role, operator, amount);
        if (dark) return (POST_ARMING_DARK, 0, 0, 0, 0);
        if (amount == 0 && granted == 0) return (POST_NOTHING_TO_ARM, fee, granted, eligibleAfter, ceilingAfter);
        uint64 live = s.vpfiRotationEpoch;
        for (uint64 e = 0; e < live; e++) {
            if (s.serviceDeposits[role][operator][e].amount != 0) {
                return (POST_RETIRED_BALANCE, fee, granted, eligibleAfter, ceilingAfter);
            }
        }
        {
            LibVaipakam.SanctionsRead st = _screenRead(s, operator);
            if (st == LibVaipakam.SanctionsRead.Flagged) return (POST_SANCTIONED, fee, granted, eligibleAfter, ceilingAfter);
            if (st == LibVaipakam.SanctionsRead.Unavailable) {
                return (POST_SANCTIONS_UNAVAILABLE, fee, granted, eligibleAfter, ceilingAfter);
            }
        }
        refusal = POST_OK;
    }

    /// @dev The quote, then the bind: dark refuses by name; nothing to arm refuses by
    ///      name; each bound term that moved refuses by name, naming the term, what
    ///      was bound and what stands.
    function _quoteAndBind(
        LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount, uint64 epoch, ArmingBind calldata bind
    ) private view returns (uint256 fee, uint256 granted, uint256 eligibleAfter, uint256 ceilingAfter) {
        bool dark;
        (fee, granted, eligibleAfter, ceilingAfter, dark) = armingQuote(s, role, operator, amount);
        if (dark) revert IVaipakamErrors.ServiceCapacityArmingDark(role);
        if (amount == 0 && granted == 0) revert IVaipakamErrors.ServiceCapacityNothingToArm(role, operator);
        if (fee > bind.maxFee) revert IVaipakamErrors.ServiceCapacityTermsMoved(0, bind.maxFee, fee);
        if (ceilingAfter < bind.minCapacityAfter) {
            revert IVaipakamErrors.ServiceCapacityTermsMoved(1, bind.minCapacityAfter, ceilingAfter);
        }
        if (epoch != bind.expectedRotationEpoch) {
            revert IVaipakamErrors.ServiceCapacityTermsMoved(2, bind.expectedRotationEpoch, epoch);
        }
        uint64 curveEpoch = s.capacityCurves[role].epoch;
        if (curveEpoch != bind.expectedCurveEpoch) {
            revert IVaipakamErrors.ServiceCapacityTermsMoved(3, bind.expectedCurveEpoch, curveEpoch);
        }
    }

    /// @dev The rotation's permitted rejection branch: a post under the new token
    ///      waits until the operator has drained every RETIRED epoch's principal
    ///      for the role. Retired epochs are counted by rotations ever performed —
    ///      a handful, each a runbook-governed migration — so the honest shape is
    ///      this loop, not an index.
    function _requireNoRetiredBalance(LibVaipakam.Storage storage s, uint8 role, address operator, uint64 live) private view {
        for (uint64 e = 0; e < live; e++) {
            if (s.serviceDeposits[role][operator][e].amount != 0) {
                revert IVaipakamErrors.ServiceCapacityOldEpochBalanceStands(role, operator, e);
            }
        }
    }

    /// @dev The fee's move: operator → the DIAMOND (never the escrow), credited to
    ///      the recycle bucket through the fee's own provenance-verifying operation,
    ///      which measures the ingress by balance delta itself — one check of one
    ///      fact. Nothing is paid when nothing was newly armed.
    function _chargeArmingFee(
        uint8 role, address operator, uint64 epoch, address token, uint256 fee, uint256 granted, uint256 ceilingAfter
    ) private {
        if (fee == 0) return;
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(operator, address(this), fee);
        LibVpfiRecycle.creditServiceCapacityArmingFee((uint256(role) << 160) | uint256(uint160(operator)), fee, before);
        emit ArmingFeePaid(role, operator, epoch, fee, granted, ceilingAfter);
    }

    // ─── slice 3 — the rotation epochs ───

    /// @notice The hook `setVPFIToken` runs on a ROTATION (a non-zero previous
    ///         token): the epoch flip IS the transition. The live epoch is retired —
    ///         archived, its asset recorded — and a new one opened under the new
    ///         token in the same transaction; every role's curve is CLEARED (dark
    ///         until the admin sizes one for the new token: a differing-decimals
    ///         token must never inherit `bondAt4x` or the costs); archived principal
    ///         stays in the escrow, keyed by the retired epoch, in its original
    ///         asset. No per-record walk: records materialize lazily on first touch.
    function onTokenRotated(LibVaipakam.Storage storage s, address previous, address newToken) internal {
        uint64 old = s.vpfiRotationEpoch;
        s.rotationEpochArchived[old] = true;
        s.rotationEpochToken[old] = previous;
        s.vpfiRotationEpoch = old + 1;
        s.rotationEpochToken[old + 1] = newToken;
        for (uint8 r = 0; r <= uint8(LibVaipakam.ServiceCapacityRole.Keeper); r++) {
            LibVaipakam.CapacityCurve storage c = s.capacityCurves[r];
            if (c.freeTier == 0) continue;
            // The figures go; the epoch counter stays, so a curve re-set after the
            // rotation still retires every bucket settled under the old regime.
            c.freeTier = 0;
            c.freeRatePerSec = 0;
            c.bondAt4x = 0;
            c.classCost = 0;
            emit CapacityCurveSet(r, 0, 0, 0, 0, c.epoch);
        }
        emit CapacityDepositEpochArchived(old, previous, newToken, s.serviceCapacityEscrow, s.serviceDepositEscrowByEpoch[old]);
    }

    /// @notice Withdraw the WHOLE of `operator`'s `role` deposit in RETIRED rotation
    ///         `epoch`, in that epoch's own asset — the drain a rotation asks of every
    ///         operator before they post under the new token.
    function withdrawArchived(LibVaipakam.Storage storage s, uint8 role, address operator, uint64 epoch)
        internal
        returns (uint8 status, uint256 paid)
    {
        requireRole(role);
        if (!s.rotationEpochArchived[epoch]) revert IVaipakamErrors.ServiceCapacityEpochNotArchived(epoch);
        uint256 all = s.serviceDeposits[role][operator][epoch].amount;
        if (all == 0) revert IVaipakamErrors.ServiceCapacityInsufficient(role, operator, 0, 0);
        return withdraw(s, role, operator, epoch, all);
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

    /// @dev The deposit surface's ONE sanctions read (#2459 r1; design
    ///      "disabled-after-configured"). A chain that has NEVER configured an
    ///      oracle screens nothing — `Clean`, the deploy-window rule of the whole
    ///      Tier-1 surface. Once any oracle has been installed, a disabled one
    ///      reads `Unavailable`, exactly an outage: a flagged account can erase its
    ///      first-observation flag by reverting the outer frame, so "no persisted
    ///      flag" proves nothing after screening was live, and an off switch must
    ///      not reopen principal release. Every deposit mutation and the post's
    ///      preview read through here, so no path can skip the latch. Reinstalling
    ///      an oracle — a vendor's, or governance's own attested snapshot — is
    ///      what lets mutations through again.
    function _screenRead(LibVaipakam.Storage storage s, address who) private view returns (LibVaipakam.SanctionsRead) {
        if (s.sanctionsOracle == address(0) && !s.sanctionsOracleEverSet) return LibVaipakam.SanctionsRead.Clean;
        return LibVaipakam.sanctionsStatus(who);
    }

    /// @notice The registry-aware tri-state screen for a deposit MUTATION on
    ///         `party`. Returns true when the mutation may proceed. See the
    ///         library's SANCTIONS note for the four outcomes; the caller turns
    ///         a false into a returned status, never a revert.
    function screen(LibVaipakam.Storage storage s, uint8 role, address operator, address party) internal returns (bool ok) {
        LibVaipakam.SanctionsRead st = _screenRead(s, party); // never-configured: Clean; disabled after configured: an outage
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
    ///         `role` (a raise when the record already holds principal; with
    ///         `amount == 0`, the arming of principal already deposited), paying the
    ///         arming fee the quote names BESIDE it — never out of the principal.
    ///         The checks are {postWalk}'s, in its order: refused while the channel
    ///         is dark, while the escrow or token is unbound, while arming is dark
    ///         (no positive fee rate, or no curve for the role), when nothing would
    ///         be armed by a zero-principal post, while a bound term moved, and while
    ///         the operator still holds principal in a retired epoch. The armed
    ///         balance is the principal under the knee as of its arming
    ///         ({armingQuote}). A post on a parked record whose operator now reads
    ///         clean releases the park (nothing paid; the record is live again).
    /// @return status {STATUS_OK}, or {STATUS_REFUSED_SANCTIONED} with no value moved.
    function post(LibVaipakam.Storage storage s, uint8 role, address operator, uint256 amount, ArmingBind calldata bind)
        internal
        returns (uint8 status)
    {
        requireRole(role);
        if (!s.serviceCapacityEnabled) revert IVaipakamErrors.ServiceCapacityDisabled();
        (address escrow, address token) = escrowAndToken(s);
        uint64 epoch = s.vpfiRotationEpoch;
        (uint256 fee, uint256 granted, uint256 eligibleAfter, uint256 ceilingAfter) =
            _quoteAndBind(s, role, operator, amount, epoch, bind);
        _requireNoRetiredBalance(s, role, operator, epoch);
        if (!screen(s, role, operator, operator)) return STATUS_REFUSED_SANCTIONED;
        LibVaipakam.ServiceCapacityDeposit storage d = s.serviceDeposits[role][operator][epoch];
        bool raise = d.amount != 0;
        if (d.token == address(0)) {
            d.token = token;
            d.rotationEpoch = epoch;
        }
        // The screen just read the operator clean: a parked record is live again, and
        // its stale park cap goes with the park (#1219 review), so a later first flag
        // parks only what is then requested.
        bool releasedPark = d.state == LibVaipakam.ServiceDepositState.SanctionsParked;
        d.state = LibVaipakam.ServiceDepositState.Active;
        d.parkedRequest = 0;
        // Announced as the release found the record, BEFORE the raise (#2459 r1):
        // its balance and armed balance are the pre-post pair, consistent with
        // each other; the Posted/Raised/Armed event below carries the new pair.
        if (releasedPark) emit CapacityDepositParkReleased(role, operator, epoch, token, 0, d.amount, d.eligibleAmount);
        settleOnDepositChange(s, role, operator); // elapsed credit under the OLD capacity, before the raise
        if (amount != 0) _pull(token, operator, escrow, amount);
        d.amount += amount;
        d.eligibleAmount = eligibleAfter;
        s.serviceDepositEscrowByEpoch[epoch] += amount;
        if (amount == 0) emit CapacityDepositArmed(role, operator, epoch, token, granted, d.amount, d.eligibleAmount);
        else if (raise) emit CapacityDepositRaised(role, operator, epoch, token, amount, d.amount, d.eligibleAmount);
        else emit CapacityDepositPosted(role, operator, epoch, token, amount, d.amount, d.eligibleAmount);
        _chargeArmingFee(role, operator, epoch, token, fee, granted, ceilingAfter);
        return STATUS_OK;
    }

    /// @notice Withdraw `amount` of `operator`'s deposit for `role` in rotation
    ///         `epoch` — the LIVE epoch immediately (owner: unbond option (i)),
    ///         always callable, dark or not; a RETIRED epoch pays in that epoch's
    ///         own asset and settles no capacity (an archived epoch buys none),
    ///         announcing the record's first touch as its lazy materialization. A
    ///         first authoritative sanctions flag PARKS the request (capped to the
    ///         principal) instead of refusing it; a later authoritative clean read
    ///         releases a parked deposit's cap.
    /// @return status {STATUS_OK} with `paid`, or {STATUS_PARKED} with nothing paid.
    function withdraw(LibVaipakam.Storage storage s, uint8 role, address operator, uint64 epoch, uint256 amount)
        internal
        returns (uint8 status, uint256 paid)
    {
        requireRole(role);
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        bool live = epoch == s.vpfiRotationEpoch;
        if (!live && !s.rotationEpochArchived[epoch]) revert IVaipakamErrors.ServiceCapacityEpochNotArchived(epoch);
        LibVaipakam.ServiceCapacityDeposit storage d = s.serviceDeposits[role][operator][epoch];
        if (d.amount == 0) revert IVaipakamErrors.ServiceCapacityInsufficient(role, operator, 0, amount);
        address escrow = s.serviceCapacityEscrow;
        if (escrow == address(0)) revert IVaipakamErrors.ServiceCapacityEscrowNotBound();
        if (!live && !d.migrated) {
            d.migrated = true;
            emit CapacityDepositMigrated(role, operator, epoch, d.token, d.amount);
        }
        {
            LibVaipakam.SanctionsRead st = _screenRead(s, operator);
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
        if (live) settleOnDepositChange(s, role, operator); // elapsed credit under the OLD capacity; the decrease clamps at the next touch
        bool released;
        if (d.state == LibVaipakam.ServiceDepositState.SanctionsParked) {
            // The clean read releases the park and serves the request in hand with
            // it: the larger of the parked cap and this request, capped to the
            // principal (#1219 review: a retired epoch's drain asks for the whole
            // record and is paid it in one call; a retried request is not paid twice).
            uint256 want = d.parkedRequest > amount ? d.parkedRequest : amount;
            paid = want < d.amount ? want : d.amount;
            d.parkedRequest = 0;
            d.state = LibVaipakam.ServiceDepositState.Active;
            released = true;
        } else {
            if (amount > d.amount) revert IVaipakamErrors.ServiceCapacityInsufficient(role, operator, d.amount, amount);
            paid = amount;
        }
        d.amount -= paid;
        // The armed balance never exceeds the principal, and a withdrawal never arms
        // what it leaves behind (#1219 review P2): re-arming pays again.
        if (d.eligibleAmount > d.amount) d.eligibleAmount = d.amount;
        s.serviceDepositEscrowByEpoch[d.rotationEpoch] -= paid;
        _release(escrow, d.token, operator, paid);
        if (released) emit CapacityDepositParkReleased(role, operator, d.rotationEpoch, d.token, paid, d.amount, d.eligibleAmount);
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
