// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

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
 * (Codex #2158 r8 P2). Native currency forced into a holder (it has no
 * `receive`) is likewise outside the ledger and the snapshot, reported by
 * {rewardCustodyNativeHeld} and recoverable only through
 * {sweepNativeFromRewardCustody} (Codex #2158 r13 P2). Configured VPFI that
 * lands at a RETIRED predecessor after its replacement is brought back into
 * the bound holder through {recoverVpfiFromPredecessor} (Codex #2158 r14
 * P2), where it shows as the unattributed remainder.
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
    /// @param holder    The holder swept (bound or previous).
    /// @param token     The ERC-20 moved.
    /// @param treasury  Where it went.
    /// @param requested How much was released from the holder.
    /// @param received  How much the treasury's balance actually grew by —
    ///                  the substantiated receipt (a fee-on-transfer token
    ///                  credits less than requested; Codex #2158 r9 P2).
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyForeignTokenSwept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 requested,
        uint256 received
    );

    /// @notice Configured VPFI that landed at a retired predecessor was
    ///         brought back into the bound holder as unattributed remainder.
    /// @param predecessor The retired holder it was found at.
    /// @param bound       The bound holder it went to.
    /// @param amount      How much moved — verified at both ends of the move,
    ///                    so there is no separate receipt to report.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyPredecessorVpfiRecovered(
        address indexed predecessor,
        address indexed bound,
        uint256 amount
    );

    /// @notice An ERC-721 that reached a holder was recovered to the treasury.
    /// @param holder   The holder it was found at (bound or previous).
    /// @param token    The ERC-721 contract.
    /// @param treasury The configured treasury it went to.
    /// @param tokenId  The token recovered.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyERC721Swept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 tokenId
    );

    /// @notice ERC-1155 units that reached a holder were recovered to the
    ///         treasury.
    /// @param holder    The holder they were found at (bound or previous).
    /// @param token     The ERC-1155 contract.
    /// @param treasury  The configured treasury they went to.
    /// @param id        The token id.
    /// @param requested How many were released.
    /// @param received  How many the treasury's balance actually grew by.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyERC1155Swept(
        address indexed holder,
        address indexed token,
        address indexed treasury,
        uint256 id,
        uint256 requested,
        uint256 received
    );

    /// @notice Native currency forced into a holder was recovered to the
    ///         treasury.
    /// @param holder    The holder swept (bound or previous).
    /// @param treasury  Where it went.
    /// @param requested How much was released from the holder.
    /// @param received  How much the treasury's balance actually grew by.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyNativeSwept(
        address indexed holder,
        address indexed treasury,
        uint256 requested,
        uint256 received
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
        s.rewardCustodyHolderConstructed[holder] = true;
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
     *         what was released AND that the previous holder now reads
     *         empty, THEN flip the pointer. A move either end cannot account
     *         for (a fee-on-transfer token; a token that credits without
     *         debiting) reverts the whole ceremony rather than leaving the
     *         pointer on a custody the ledger misdescribes or VPFI stranded
     *         at an address nothing can reach. The rows in storage are not touched — that
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
        s.rewardCustodyHolderConstructed[successor] = true;
        uint256 moving = IERC20(token).balanceOf(previous);
        // Both ends of the move are measured, in the one place every
        // holder-to-holder move of the configured VPFI is measured (Codex
        // #2158 r12 P2, r15 P2): the successor grew by exactly the release
        // AND the previous holder was debited by exactly the release — for a
        // whole-balance move, that is the previous holder reading empty. A
        // non-conforming token crediting without debiting would otherwise
        // strand configured VPFI at an address nothing can reach.
        uint256 before = _releaseMeasured(token, previous, successor, moving);

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
     *         this Diamond. The event carries both the requested amount and
     *         the treasury's MEASURED receipt, since an arbitrary foreign
     *         token may credit less than it was asked to move.
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
        _requireConstructedHere(s, holder);
        uint256 before = IERC20(token).balanceOf(treasury);
        RewardCustodyHolder(holder).release(token, treasury, amount);
        uint256 received = IERC20(token).balanceOf(treasury) - before;
        emit RewardCustodyForeignTokenSwept(holder, token, treasury, amount, received);
    }

    /**
     * @notice Recover native currency forced into a holder this Diamond
     *         constructed — the bound one or a previous one — to the
     *         treasury.
     * @dev    ADMIN. A holder has no `receive`, so native currency reaches it
     *         only by force (`SELFDESTRUCT`, a coinbase reward, value sent to
     *         the predicted address before construction); it is outside the
     *         attribution ledger and the VPFI snapshot, and would otherwise
     *         be stranded — silently, at a previous holder after a
     *         replacement (Codex #2158 r13 P2). Delivers to the configured
     *         treasury and nowhere else; the event carries the treasury's
     *         measured receipt.
     * @param  holder A holder this Diamond constructed (bound or previous).
     * @param  amount The amount to move to the treasury.
     */
    function sweepNativeFromRewardCustody(
        address holder,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        _requireConstructedHere(s, holder);
        uint256 before = treasury.balance;
        RewardCustodyHolder(holder).releaseNative(treasury, amount);
        uint256 received = treasury.balance - before;
        emit RewardCustodyNativeSwept(holder, treasury, amount, received);
    }

    /**
     * @notice Recover an ERC-721 that reached a holder this Diamond
     *         constructed — the bound one or a previous one — to the
     *         treasury.
     * @dev    ADMIN. A holder implements no receiver hook, so a safe transfer
     *         into a constructed holder is refused by the token; a non-safe
     *         `transferFrom`, or a token delivered to the predicted address
     *         before construction, still makes the holder its owner, and
     *         nothing else could ever move it (Codex #2158 r16 P2). Outside
     *         the attribution ledger and the VPFI snapshot like every foreign
     *         asset; delivers to the configured treasury and to nowhere else,
     *         and only from a holder in the constructed registry. A
     *         conforming ERC-721 reverts unless the transfer happened, so
     *         there is no separate receipt to measure.
     * @param  holder  A holder this Diamond constructed (bound or previous).
     * @param  token   The ERC-721 contract.
     * @param  tokenId The token to recover.
     */
    function sweepERC721FromRewardCustody(
        address holder,
        address token,
        uint256 tokenId
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (token == address(0)) revert IVaipakamErrors.InvalidAddress();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        _requireConstructedHere(s, holder);
        RewardCustodyHolder(holder).releaseERC721(token, treasury, tokenId);
        emit RewardCustodyERC721Swept(holder, token, treasury, tokenId);
    }

    /**
     * @notice Recover ERC-1155 units that reached a holder this Diamond
     *         constructed — the bound one or a previous one — to the
     *         treasury.
     * @dev    ADMIN. Same posture as {sweepERC721FromRewardCustody}; an
     *         ERC-1155 has only safe transfers, so units can reach a holder
     *         only at the predicted address before construction. The event
     *         carries the treasury's MEASURED receipt beside the request.
     * @param  holder A holder this Diamond constructed (bound or previous).
     * @param  token  The ERC-1155 contract.
     * @param  id     The token id.
     * @param  amount How many units to recover.
     */
    function sweepERC1155FromRewardCustody(
        address holder,
        address token,
        uint256 id,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (token == address(0)) revert IVaipakamErrors.InvalidAddress();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        _requireConstructedHere(s, holder);
        uint256 before = IERC1155(token).balanceOf(treasury, id);
        RewardCustodyHolder(holder).releaseERC1155(token, treasury, id, amount);
        uint256 received = IERC1155(token).balanceOf(treasury, id) - before;
        emit RewardCustodyERC1155Swept(holder, token, treasury, id, amount, received);
    }

    /**
     * @notice Bring configured VPFI that landed at a PREDECESSOR holder after
     *         its replacement back into the bound holder, as unattributed
     *         remainder.
     * @dev    ADMIN. A replacement proves the predecessor empty in the
     *         configured VPFI before its pointer is retired, so any VPFI
     *         found there later is an unsolicited deposit (Codex #2158 r14
     *         P2): nothing else drains a predecessor, the snapshot reads only
     *         the bound holder, and the foreign-token sweep refuses the
     *         configured VPFI by design. This is the one route for it — into
     *         the bound holder, never to the treasury or anywhere else — where
     *         it shows in {rewardCustodySnapshot} as the unattributed
     *         remainder. Refuses the bound holder itself (what it holds IS
     *         the custody) and any address this Diamond did not construct.
     *         Both ends of the move are verified before the event is emitted
     *         (Codex #2158 r15 P2), through the same measured move the
     *         replacement uses: the bound holder grew by exactly `amount`
     *         AND the predecessor was debited by exactly `amount`. A token
     *         that credits without debiting would otherwise report a
     *         recovery that moved nothing and could be repeated against a
     *         balance that never leaves.
     * @param  predecessor A retired holder this Diamond constructed.
     * @param  amount      How much configured VPFI to bring back.
     */
    function recoverVpfiFromPredecessor(
        address predecessor,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.RewardCustodyTokenUnset();
        address bound = s.rewardCustodyHolder;
        if (bound == address(0)) revert IVaipakamErrors.RewardCustodyHolderNotBound();
        if (predecessor == bound) {
            revert IVaipakamErrors.RewardCustodyRecoverTargetsBoundHolder(predecessor);
        }
        _requireConstructedHere(s, predecessor);
        _releaseMeasured(token, predecessor, bound, amount);
        emit RewardCustodyPredecessorVpfiRecovered(predecessor, bound, amount);
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
     *         side). Prefer the high estimate when uncertain — but never
     *         above the interaction pool's lifetime cap, which the call
     *         refuses: nothing honest can have paid out more than can ever
     *         be rewarded, and a mistyped figure would be irreversible.
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
        // Bounded to what can ever be rewarded (Codex #2158 r11 P1): the
        // call is one-shot and a floor, so a mistyped total above the pool
        // cap could never be lowered again and, on the canonical chain,
        // would be installed as `received` too.
        if (total > LibVaipakam.VPFI_INTERACTION_POOL_CAP) {
            revert IVaipakamErrors.ArmedFreshRebaseTotalExceedsCap(total, LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        }
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);

        uint256 paidBefore = s.rewardBudgetArmedFreshPaid;
        uint256 receivedBefore = s.rewardBudgetArmedFreshReceived;
        // The RESULT is bounded too (Codex #2158 r13 P1): a paid counter
        // already above the cap would survive `max` and, on the canonical
        // chain, be copied into `received` while both guards close. Such a
        // counter is refused here with the guard left OPEN, so it can be
        // examined and corrected rather than sealed in.
        if (paidBefore > LibVaipakam.VPFI_INTERACTION_POOL_CAP) {
            revert IVaipakamErrors.ArmedFreshRebaseTotalExceedsCap(paidBefore, LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        }
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

    /// @notice Whether `holder` is a `RewardCustodyHolder` this Diamond
    ///         constructed (the bound one or any predecessor).
    function rewardCustodyHolderConstructed(address holder) external view returns (bool) {
        return LibVaipakam.storageSlot().rewardCustodyHolderConstructed[holder];
    }

    /// @notice Native currency sitting at `holder` — outside the attribution
    ///         ledger and the VPFI snapshot, recoverable only through
    ///         {sweepNativeFromRewardCustody}. Reported for any address (a
    ///         predecessor included) so a forced deposit is never silent.
    function rewardCustodyNativeHeld(address holder) external view returns (uint256) {
        return holder.balance;
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

    /// @dev Only the sweeps take a holder address at all (to reach a
    ///      PREVIOUS holder after a replacement); binding and replacement
    ///      construct their own and REGISTER what they constructed. The
    ///      sweeps consult that registry — never a getter an arbitrary
    ///      contract could imitate (Codex #2158 r13 P2) — so `release` is
    ///      only ever called on a contract this Diamond created.
    function _requireConstructedHere(
        LibVaipakam.Storage storage s,
        address holder
    ) private view {
        if (!s.rewardCustodyHolderConstructed[holder]) {
            revert IVaipakamErrors.RewardCustodyHolderNotConstructedHere(holder);
        }
    }

    /**
     * @dev The ONE measured move of the configured VPFI out of a holder this
     *      Diamond constructed — the replacement (whole balance, predecessor
     *      → successor) and the predecessor recovery (an amount, predecessor
     *      → bound holder) both go through it, so both ends of every such
     *      move are verified in one place (Codex #2158 r12 P2, r15 P2): the
     *      destination grew by exactly `amount` AND the source was debited by
     *      exactly `amount`. A move either end cannot account for — a
     *      fee-on-transfer token, a token that credits without debiting —
     *      reverts the whole operation rather than leaving the ledger
     *      describing custody that is not there, VPFI stranded at an address
     *      nothing can reach, or an operation that can be repeated against a
     *      balance that never moves.
     * @param  token  The configured VPFI token.
     * @param  from   The holder released from (constructed here).
     * @param  to     The destination.
     * @param  amount What to move; zero moves nothing and verifies nothing
     *                moved.
     * @return toBefore The destination's balance before the move — what was
     *         already there, which a replacement reports as unattributed
     *         rather than refusing (Codex #2158 r3 P1).
     */
    function _releaseMeasured(
        address token,
        address from,
        address to,
        uint256 amount
    ) private returns (uint256 toBefore) {
        uint256 fromBefore = IERC20(token).balanceOf(from);
        toBefore = IERC20(token).balanceOf(to);
        if (amount != 0) {
            RewardCustodyHolder(from).release(token, to, amount);
        }
        uint256 credited = IERC20(token).balanceOf(to) - toBefore;
        if (credited != amount) {
            revert IVaipakamErrors.RewardCustodyMoveUnverified(amount, credited);
        }
        uint256 fromAfter = IERC20(token).balanceOf(from);
        uint256 debited = fromAfter > fromBefore ? 0 : fromBefore - fromAfter;
        if (debited != amount) {
            revert IVaipakamErrors.RewardCustodySourceNotDebited(from, amount, debited);
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
