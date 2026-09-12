// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";

/**
 * @title RewardCustodyFacet — the delivered reward custody's lifecycle and
 *        the paid-side migration importer (#1566 slice 4 PR A, design §5d)
 *
 * Three things live here, and nothing else:
 *
 *  1. **The holder binding.** `bindRewardCustodyHolder` points the Diamond
 *     at its `RewardCustodyHolder` once; `replaceRewardCustodyHolder` is the
 *     paused ceremony that swaps it for a successor — the old holder's WHOLE
 *     balance moves in one Diamond-gated call and the pointer flips in the
 *     same transaction, so the attribution ledger (Diamond storage, not the
 *     holder's) keeps describing the custody without a per-row migration.
 *  2. **The attribution ledger's read surface.** The rows of
 *     {LibVaipakam.RewardCustodyRow} and the holder's balance, side by side,
 *     so the invariant "attributed never exceeds held" is observable.
 *  3. **`rebaseArmedFreshPaid`** — the paid-side importer §5b requires for a
 *     chain carrying history the vintage-blind ledger (#1566 closure 2) now
 *     charges. Paused, ADMIN, one-shot, a FLOOR rather than a set, and on the
 *     canonical chain it installs the zero-headroom baseline
 *     `received = paid` in the same call.
 *
 * **This PR is deployable dark.** No payout, gate or funding path reads the
 * holder or the rows yet; PR B's role-branched cutover is where custody
 * moves. Binding a holder on a fresh deploy therefore changes no behaviour,
 * and the rows all read zero because nothing can credit them.
 *
 * @dev Why a separate facet rather than a corner of `RewardReporterFacet`
 *      (which hosts the older one-shot seeder): the reporter is a cross-chain
 *      ingress surface at EIP-170 budget, and custody lifecycle is a
 *      different concern with a different reviewer — a paused ceremony an
 *      operator runs, not a message a messenger delivers. The seeder stays
 *      where it is; the rebase consumes its guard from here.
 */
contract RewardCustodyFacet is DiamondAccessControl {
    // ─── Events ─────────────────────────────────────────────────────────────

    /// @notice The custody holder was bound for the first time.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyHolderBound(address indexed holder);

    /// @notice The custody holder was replaced under the paused ceremony.
    /// @param previous     The holder that was bound.
    /// @param successor    The holder now bound.
    /// @param token        The VPFI token whose balance moved.
    /// @param balanceMoved The old holder's whole balance, now at the
    ///                     successor. Zero when the old holder was empty.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyHolderReplaced(
        address indexed previous,
        address indexed successor,
        address indexed token,
        uint256 balanceMoved
    );

    /// @notice The delivered-fresh ledger's paid side was rebased to an
    ///         absolute total (and, on the canonical chain, the received side
    ///         to the same figure).
    /// @param role              The reward role resolved at the call, as
    ///                          {LibVaipakam.RewardRole} ordinal — it decides
    ///                          whether the received side was rewritten.
    /// @param requestedTotal    The total the operator reconstructed.
    /// @param paidBefore        The paid counter before the call.
    /// @param paidAfter         `max(paidBefore, requestedTotal)`.
    /// @param receivedBefore    The received counter before the call.
    /// @param receivedAfter     Equal to `paidAfter` on the canonical chain,
    ///                          unchanged elsewhere.
    /// @custom:event-category state-change/reward-compensation
    event ArmedFreshPaidRebased(
        uint8 role,
        uint256 requestedTotal,
        uint256 paidBefore,
        uint256 paidAfter,
        uint256 receivedBefore,
        uint256 receivedAfter
    );

    // ─── Holder lifecycle ───────────────────────────────────────────────────

    /**
     * @notice Bind the Diamond's delivered reward custody holder. One-shot.
     * @dev    ADMIN. Not pause-gated: nothing reads the holder before PR B,
     *         so binding changes no live behaviour, and a fresh deploy binds
     *         inside `DeployDiamond` while the Diamond is still paused
     *         anyway. The holder must answer to THIS Diamond — its
     *         `DIAMOND()` must be `address(this)` — or the Diamond could
     *         never release from it.
     * @param  holder The `RewardCustodyHolder` constructed for this Diamond.
     */
    function bindRewardCustodyHolder(
        address holder
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.rewardCustodyHolder != address(0)) {
            revert IVaipakamErrors.RewardCustodyHolderAlreadyBound();
        }
        _requireOurHolder(holder);
        s.rewardCustodyHolder = holder;
        emit RewardCustodyHolderBound(holder);
    }

    /**
     * @notice Replace the bound holder with a successor, moving the whole
     *         custody balance across in the same transaction.
     * @dev    ADMIN, PAUSED. The order is deliberate: read the old holder's
     *         whole balance, release it to the successor, verify the
     *         successor's balance grew by exactly that amount, THEN flip the
     *         pointer. A move the successor cannot account for (a
     *         fee-on-transfer token, a successor that rejects tokens) reverts
     *         the whole ceremony rather than leaving the pointer on a custody
     *         the ledger no longer describes. The rows in storage are not
     *         touched — that is the point of keeping the ledger out of the
     *         holder.
     *
     *         Refuses while the Diamond has no VPFI token configured: with no
     *         token there is no balance to read, and flipping the pointer
     *         blind could strand a balance that a later `setVPFIToken`
     *         reveals at the OLD address.
     * @param  successor A `RewardCustodyHolder` constructed for this
     *                   Diamond, different from the one bound.
     */
    function replaceRewardCustodyHolder(
        address successor
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requirePaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.rewardCustodyHolder;
        if (previous == address(0)) {
            revert IVaipakamErrors.RewardCustodyHolderNotBound();
        }
        if (successor == previous) {
            revert IVaipakamErrors.RewardCustodyHolderUnchanged();
        }
        address token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.RewardCustodyTokenUnset();
        _requireOurHolder(successor);

        uint256 moving = IERC20(token).balanceOf(previous);
        // The successor must start EMPTY: a pre-funded successor would carry
        // value no attribution row describes, and the delta check below
        // cannot see it (it measures growth, not the starting balance).
        // A successor is constructed for the ceremony, so this costs
        // nothing on the honest path.
        uint256 before = IERC20(token).balanceOf(successor);
        if (before != 0) {
            revert IVaipakamErrors.RewardCustodySuccessorNotEmpty(successor, before);
        }
        if (moving != 0) {
            RewardCustodyHolder(previous).release(token, successor, moving);
        }
        uint256 delta = IERC20(token).balanceOf(successor);
        if (delta != moving) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(moving, delta);
        }

        s.rewardCustodyHolder = successor;
        emit RewardCustodyHolderReplaced(previous, successor, token, moving);
    }

    // ─── Paid-side migration importer ───────────────────────────────────────

    /**
     * @notice ONE-SHOT, PAUSED migration: rebase the delivered-fresh ledger's
     *         paid side to an absolute reconstructed total, never below what
     *         it already holds, and on the canonical chain set the received
     *         side to the same figure.
     * @dev    Why this exists next to `seedArmedFreshPaid` (design §5c):
     *         the seeder is additive and one-shot, and on a live mirror it
     *         may already have been consumed by the P1-b migration — so it
     *         cannot serve a chain whose paid history #1566 closure 2 just
     *         widened (every vintage is now charged, not only coordinated-mode
     *         days). Reconciling an absolute total needs a SET with a FLOOR:
     *         importing a total on top of an existing counter double-counts;
     *         importing below it would republish delivered headroom that an
     *         earlier administrative retirement had already withdrawn.
     *
     *         `total` is the DEDUPLICATED sum of every genuine historical
     *         fresh outflow the vintage-blind ledger now charges — per-user
     *         payouts, expiry and forfeit absorptions, and the fresh portions
     *         of every non-recovery remittance and compensation dispatch —
     *         with recovery redispatches excluded. Any existing counter or
     *         retirement watermark is a FLOOR applied here, not a term to add
     *         off-chain: 60 of payouts followed by a retirement at 100 is
     *         `total = 100`, and `max` keeps it there.
     *
     *         On the CANONICAL chain the received side is set to the
     *         resulting paid figure — the zero-headroom baseline. With no
     *         provenance ledger to bootstrap from, this is the only call a
     *         canonical deployment has to bring `received` up from zero;
     *         without it the chain would sit at `paid = P, received = 0`,
     *         negative headroom, swallowing every later delivery until
     *         funding exceeded `P`. A MIRROR's received side is the messenger's
     *         to write and is left alone. `Unconfigured` and `Detached` never
     *         read this ledger (the bound is `max` and `0` respectively), so
     *         on those roles the call is inert beyond consuming the guards —
     *         which is exactly what a fresh deploy uses it for.
     *
     *         Consumes {LibVaipakam.Storage.armedFreshPaidSeeded} as well as
     *         its own guard: if the P1-b seeder never ran, it would otherwise
     *         remain callable and a stale migration call would ADD historical
     *         paid value on top of the absolute total just installed — a
     *         one-way loss of delivered headroom that arrives after the
     *         one-shot rebase can no longer correct it.
     *
     *         Direction of error, so an operator chooses deliberately: too
     *         LOW re-opens a double-spend; too HIGH strands legitimate funding
     *         until further deliveries arrive (recoverable, the conservative
     *         side). Prefer the high estimate when uncertain.
     * @param  total The reconstructed absolute paid total.
     */
    function rebaseArmedFreshPaid(
        uint256 total
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requirePaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.armedFreshPaidRebased) {
            revert IVaipakamErrors.ArmedFreshPaidAlreadyRebased();
        }
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);

        uint256 paidBefore = s.rewardBudgetArmedFreshPaid;
        uint256 receivedBefore = s.rewardBudgetArmedFreshReceived;
        uint256 paidAfter = total > paidBefore ? total : paidBefore;

        s.rewardBudgetArmedFreshPaid = paidAfter;
        if (role == LibVaipakam.RewardRole.Canonical) {
            s.rewardBudgetArmedFreshReceived = paidAfter;
        }
        s.armedFreshPaidRebased = true;
        s.armedFreshPaidSeeded = true;

        emit ArmedFreshPaidRebased(
            uint8(role),
            total,
            paidBefore,
            paidAfter,
            receivedBefore,
            s.rewardBudgetArmedFreshReceived
        );
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice The bound custody holder, or zero while unbound.
    function rewardCustodyHolder() external view returns (address) {
        return LibVaipakam.storageSlot().rewardCustodyHolder;
    }

    /// @notice Whether the one-shot paid-side rebase has run on this chain.
    function armedFreshPaidRebased() external view returns (bool) {
        return LibVaipakam.storageSlot().armedFreshPaidRebased;
    }

    /// @notice The delivered-fresh ledger's two counters, raw. The bound
    ///         (`RewardRemittanceLensFacet.getDeliveredFreshBound`) reports
    ///         paid and REMAINING, which is `max` on a canonical chain and
    ///         saturates at zero on an over-paid mirror — so neither
    ///         `received` nor a deficit can be read back from it. The
    ///         migration ceremonies (design §5d) verify `received == paid`
    ///         after the rebase, and an over-paid mirror's deficit is what
    ///         the §5c deficit split acts on; both need the pair as stored.
    /// @return received What has been delivered and counted as fresh.
    /// @return paid     What has been charged as fresh, any vintage.
    function armedFreshLedger()
        external
        view
        returns (uint256 received, uint256 paid)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        received = s.rewardBudgetArmedFreshReceived;
        paid = s.rewardBudgetArmedFreshPaid;
    }

    /// @notice One attribution row of the custody ledger.
    /// @param  row The row to read.
    function rewardCustodyRow(
        LibVaipakam.RewardCustodyRow row
    ) external view returns (uint256) {
        return LibVaipakam.storageSlot().rewardCustodyRows[row];
    }

    /**
     * @notice The custody as a whole: where it is, what token it is in, what
     *         it holds, and how much of that the ledger attributes.
     * @dev    Says what it does not know rather than rendering a figure it
     *         cannot substantiate: `held` is reported as zero with
     *         `balanceKnown == false` when no holder is bound or no VPFI
     *         token is configured, so a reader cannot mistake "unreadable"
     *         for "empty". `attributed` is the sum of every row in
     *         {LibVaipakam.RewardCustodyRow}; the invariant every writer
     *         preserves is `attributed <= held` whenever `balanceKnown`.
     * @return holder       The bound holder (zero while unbound).
     * @return token        The VPFI token the Diamond recognises (zero while
     *                      unset).
     * @return balanceKnown Whether `held` was actually read.
     * @return held         The holder's balance in `token`, when known.
     * @return attributed   The sum of the attribution rows.
     */
    function rewardCustodySnapshot()
        external
        view
        returns (
            address holder,
            address token,
            bool balanceKnown,
            uint256 held,
            uint256 attributed
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        holder = s.rewardCustodyHolder;
        token = s.vpfiToken;
        balanceKnown = holder != address(0) && token != address(0);
        if (balanceKnown) held = IERC20(token).balanceOf(holder);
        attributed = _attributedTotal(s);
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev The offered holder must be a `RewardCustodyHolder` whose
    ///      `DIAMOND` is this Diamond. A zero address, an EOA, a contract
    ///      without that getter, or a holder built for another Diamond all
    ///      land in the same named revert — the distinction does not change
    ///      what the operator has to do (construct one for THIS Diamond).
    function _requireOurHolder(address holder) private view {
        if (holder == address(0)) revert IVaipakamErrors.InvalidAddress();
        if (holder.code.length == 0) {
            revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
        }
        try RewardCustodyHolder(holder).DIAMOND() returns (address diamond) {
            if (diamond != address(this)) {
                revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
            }
        } catch {
            revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
        }
    }

    /// @dev Sum of every {LibVaipakam.RewardCustodyRow}. Iterates the enum
    ///      by ordinal up to its last member so a row appended later is
    ///      picked up by updating one constant rather than a hand-written
    ///      list.
    function _attributedTotal(
        LibVaipakam.Storage storage s
    ) private view returns (uint256 total) {
        uint256 last = uint256(LibVaipakam.RewardCustodyRow.Restitution);
        for (uint256 i = 0; i <= last; ++i) {
            total += s.rewardCustodyRows[LibVaipakam.RewardCustodyRow(i)];
        }
    }
}
