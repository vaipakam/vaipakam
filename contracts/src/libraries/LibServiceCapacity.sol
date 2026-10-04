// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";

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
