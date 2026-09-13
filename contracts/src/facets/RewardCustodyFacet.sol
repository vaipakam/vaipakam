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
 *  1. **The holder lifecycle.** The Diamond CONSTRUCTS its own holders —
 *     `bindRewardCustodyHolder` creates and binds the first one,
 *     `replaceRewardCustodyHolder` is the paused ceremony that creates a
 *     successor, moves the old holder's WHOLE balance into it and flips the
 *     pointer, all in one transaction. No externally supplied address is
 *     ever accepted as a holder (Codex #2158 r3 P1): authenticity is by
 *     construction, not by a getter an arbitrary contract could imitate,
 *     and because the successor does not exist before the transaction that
 *     switches to it, there is no scheduled window in which it can be
 *     targeted. The attribution ledger (Diamond storage, not the holder's)
 *     keeps describing the custody without a per-row migration.
 *  2. **The attribution ledger's read surface.** The rows of
 *     {LibVaipakam.RewardCustodyRow} and the holder's balance, side by side,
 *     so the invariant "attributed never exceeds held" is observable — and
 *     the surface says when the balance CANNOT be read rather than
 *     rendering zero.
 *  3. **`rebaseArmedFreshPaid`** — the paid-side importer §5b requires for a
 *     chain carrying history the vintage-blind ledger (#1566 closure 2) now
 *     charges. Paused, ADMIN, one-shot, a FLOOR rather than a set, and on the
 *     canonical chain it installs the zero-headroom baseline
 *     `received = paid` in the same call.
 *
 * **This PR is deployable dark.** No payout, gate or funding path reads the
 * holder or the rows yet, and no PROTOCOL writer can fund the holder; PR B's
 * role-branched cutover is where custody moves. Binding a holder on a fresh
 * deploy therefore changes no behaviour, and the rows all read zero because
 * nothing can credit them. The holder's address is public, so an UNSOLICITED
 * ERC-20 transfer to it is possible at any time (Codex #2158 r5 P2): such
 * value is not custody the ledger describes and must not be read as "the
 * dark holder is empty". In the CONFIGURED VPFI token it is visible as the
 * snapshot's unattributed remainder and moves with the balance at a
 * replacement; in ANY OTHER token (including a former VPFI after a token
 * rotation) it is invisible to the snapshot, stays behind at a replaced
 * holder, and is recoverable only through {sweepForeignTokenFromRewardCustody}
 * (Codex #2158 r8 P2).
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

    /// @notice The custody holder was constructed and bound for the first
    ///         time.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyHolderBound(address indexed holder);

    /// @notice The custody holder was replaced under the paused ceremony.
    /// @param previous             The holder that was bound.
    /// @param successor            The holder now bound, constructed in this
    ///                             transaction.
    /// @param token                The VPFI token whose balance moved.
    /// @param balanceMoved         The old holder's whole balance, now at
    ///                             the successor. Zero when the old holder
    ///                             was empty.
    /// @param successorPreBalance  What the successor's address already held
    ///                             before the move — value sent to the
    ///                             predicted address ahead of construction.
    ///                             It is custody no attribution row
    ///                             describes; the snapshot reports it as the
    ///                             unattributed remainder. Zero on the honest
    ///                             path.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyHolderReplaced(
        address indexed previous,
        address indexed successor,
        address indexed token,
        uint256 balanceMoved,
        uint256 successorPreBalance
    );

    /// @notice A token that is not the configured VPFI was recovered from a
    ///         holder to the treasury.
    /// @param holder   The holder swept (bound or previous).
    /// @param token    The ERC-20 moved.
    /// @param treasury Where it went.
    /// @param amount   How much.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyForeignTokenSwept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 amount
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
     * @notice Construct the Diamond's delivered reward custody holder and
     *         bind it. One-shot.
     * @dev    ADMIN. Not pause-gated: nothing reads the holder before PR B,
     *         so binding changes no live behaviour, and a fresh deploy binds
     *         inside `DeployDiamond` while the Diamond is still paused
     *         anyway. The holder is `new RewardCustodyHolder(address(this))`
     *         — constructed by the Diamond, answering only to the Diamond —
     *         so no address is taken and nothing can be imitated.
     * @return holder The holder constructed and bound.
     */
    function bindRewardCustodyHolder()
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (address holder)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.rewardCustodyHolder != address(0)) {
            revert IVaipakamErrors.RewardCustodyHolderAlreadyBound();
        }
        holder = address(new RewardCustodyHolder(address(this)));
        s.rewardCustodyHolder = holder;
        emit RewardCustodyHolderBound(holder);
    }

    /**
     * @notice Replace the bound holder: construct a successor, move the
     *         whole custody balance across, flip the pointer — one
     *         transaction.
     * @dev    ADMIN, PAUSED. The order is deliberate: construct the successor,
     *         read the old holder's whole balance and the successor's
     *         starting balance, release, verify the successor GREW by exactly
     *         what was released, THEN flip the pointer. A move the successor
     *         cannot account for (a fee-on-transfer token) reverts the whole
     *         ceremony rather than leaving the pointer on a custody the
     *         ledger overstates. The rows in storage are not touched — that
     *         is the point of keeping the ledger out of the holder.
     *
     *         A successor's address is predictable from the Diamond's nonce,
     *         so value can be sent to it ahead of construction. That is NOT
     *         a reason to refuse (Codex #2158 r3 P1 — a one-wei dusting
     *         would otherwise block every replacement at negligible cost):
     *         the delta check measures growth, not the starting balance, and
     *         whatever was there already is reported in the event and shows
     *         in {rewardCustodySnapshot} as the unattributed remainder,
     *         which no row describes and no path can spend as fresh.
     *
     *         Refuses while the Diamond has no VPFI token configured: with no
     *         token there is no balance to read, and flipping the pointer
     *         blind could strand a balance that a later `setVPFIToken`
     *         reveals at the OLD address.
     * @return successor The holder constructed and now bound.
     */
    function replaceRewardCustodyHolder()
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (address successor)
    {
        LibPausable.requirePaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address previous = s.rewardCustodyHolder;
        if (previous == address(0)) {
            revert IVaipakamErrors.RewardCustodyHolderNotBound();
        }
        address token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.RewardCustodyTokenUnset();

        successor = address(new RewardCustodyHolder(address(this)));
        uint256 moving = IERC20(token).balanceOf(previous);
        uint256 before = IERC20(token).balanceOf(successor);
        if (moving != 0) {
            RewardCustodyHolder(previous).release(token, successor, moving);
        }
        uint256 delta = IERC20(token).balanceOf(successor) - before;
        if (delta != moving) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(moving, delta);
        }

        s.rewardCustodyHolder = successor;
        emit RewardCustodyHolderReplaced(previous, successor, token, moving, before);
    }

    /**
     * @notice Recover an ERC-20 that is NOT the configured VPFI token from a
     *         holder this Diamond constructed — the bound one or a previous
     *         one — to the treasury.
     * @dev    ADMIN. The attribution ledger and {rewardCustodySnapshot} cover
     *         only `s.vpfiToken`; any other token that lands in a holder
     *         (an unsolicited transfer, or the former VPFI after a token
     *         rotation) is outside them and would otherwise be stranded —
     *         a replacement moves only the configured token, so such value
     *         stays at the previous holder. The sweep refuses the configured
     *         VPFI itself (that IS the custody, and leaves only through the
     *         reward outflows), delivers to the configured treasury and to
     *         nowhere else, and accepts only a holder whose `DIAMOND()` is
     *         this Diamond. Event-logged so the recovery is auditable.
     * @param  holder A holder this Diamond constructed (bound or previous).
     * @param  token  The ERC-20 to recover; never the configured VPFI.
     * @param  amount The amount to move to the treasury.
     */
    function sweepForeignTokenFromRewardCustody(
        address holder,
        address token,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (token == address(0)) revert IVaipakamErrors.InvalidAddress();
        if (token == s.vpfiToken) revert IVaipakamErrors.RewardCustodySweepIsVpfi();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        _requireOurHolder(holder);
        RewardCustodyHolder(holder).release(token, treasury, amount);
        emit RewardCustodyForeignTokenSwept(holder, token, treasury, amount);
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
     *         to write and is left alone.
     *
     *         On an INACTIVE role (`Unconfigured`, `Detached`) the call is
     *         accepted only when the chain is HISTORY-FREE on every side:
     *         nothing to import, nothing on the paid side and nothing on the
     *         received side (`total == 0 && paid == 0 && received == 0`).
     *         That is the fresh-deploy case, which consumes both guards so
     *         neither migration writer can ever run on a chain with no
     *         history. Anything else on an inactive role is REFUSED (Codex
     *         #2158 r1 P2, r5 P1): the role decides whether the received side
     *         is rewritten, and a one-shot that ran before the role was
     *         known would close the door on state the later role needs
     *         levelled — a raised `paid` without its baseline, or a
     *         pre-role-field chain detached before residual retirement
     *         (`received > 0`, `paid == 0`) that a direct promotion to
     *         Canonical would otherwise expose as spendable headroom with
     *         no way left to install `received = paid`. A detached chain
     *         carrying history on either side therefore keeps its guard
     *         OPEN until it is re-attached and the rebase runs under the
     *         active role.
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
        bool activeRole = role == LibVaipakam.RewardRole.Canonical
            || role == LibVaipakam.RewardRole.Mirror;
        if (!activeRole && (total != 0 || paidBefore != 0 || receivedBefore != 0)) {
            revert IVaipakamErrors.ArmedFreshRebaseRequiresActiveRole(
                uint8(role), total, paidBefore, receivedBefore
            );
        }
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
     *         `balanceKnown == false` when no holder is bound, when no VPFI
     *         token is configured, or when the configured token cannot answer
     *         `balanceOf` (an EOA, a non-conforming contract, a proxy
     *         upgraded into a reverting implementation — Codex #2158 r3 P2),
     *         so a reader cannot mistake "unreadable" for "empty".
     *         `attributed` is the sum of every row in
     *         {LibVaipakam.RewardCustodyRow}; the invariant every writer
     *         preserves is `attributed <= held` whenever `balanceKnown`, and
     *         `held - attributed` is the unattributed remainder (value sent
     *         to the holder outside any registered ingress, such as dust at
     *         a predicted successor address). All of this is about the
     *         CONFIGURED VPFI token only: any other ERC-20 in a holder is
     *         outside the snapshot and the ledger, and is recovered through
     *         {sweepForeignTokenFromRewardCustody}.
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
        (balanceKnown, held) = _tryBalance(token, holder);
        attributed = _attributedTotal(s);
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    /// @dev A holder this Diamond constructed answers `DIAMOND() == this`.
    ///      Only the foreign-token sweep takes a holder address at all (to
    ///      reach a PREVIOUS holder after a replacement); binding and
    ///      replacement construct their own. A codeless address or one
    ///      answering another Diamond is refused by name.
    function _requireOurHolder(address holder) private view {
        if (holder.code.length == 0) {
            revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
        }
        try RewardCustodyHolder(holder).DIAMOND() returns (address d) {
            if (d != address(this)) revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
        } catch {
            revert IVaipakamErrors.RewardCustodyHolderNotOurs(holder);
        }
    }

    /// @dev A balance read that cannot revert the snapshot: unbound holder,
    ///      unset or codeless token, a failed call, or a malformed answer all
    ///      report `known == false` — the reader is told the balance could
    ///      not be read, never handed a zero that means "empty".
    function _tryBalance(
        address token,
        address holder
    ) private view returns (bool known, uint256 held) {
        if (holder == address(0) || token == address(0) || token.code.length == 0) {
            return (false, 0);
        }
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IERC20.balanceOf, (holder)));
        if (!ok || ret.length != 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
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
