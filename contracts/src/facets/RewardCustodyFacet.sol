// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
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

    /// @notice Configured VPFI that no ledger row describes was moved from
    ///         the BOUND holder to the treasury.
    /// @param holder             The bound holder.
    /// @param treasury           The configured treasury it went to.
    /// @param amount             How much moved — verified at both ends.
    /// @param unattributedBefore The unattributed remainder (held minus
    ///                           attributed) before the move — the bound the
    ///                           amount was checked against.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyUnattributedVpfiSwept(
        address indexed holder,
        address indexed treasury,
        uint256 amount,
        uint256 unattributedBefore
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
     *
     *         The pause it requires is the MANUAL one (Codex #2158 r18 P2):
     *         a watcher's auto-pause window lapses on its own, so a
     *         replacement run under it alone would be followed by service
     *         resuming by no one's decision, where the design requires a
     *         fresh Unpauser decision after every custody ceremony. Enforced
     *         here, whatever path the call arrives by.
     * @return successor The holder constructed and now bound.
     */
    function replaceRewardCustodyHolder()
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
        returns (address successor)
    {
        LibPausable.requireManuallyPaused();
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
        uint256 before = LibRewardCustody.releaseMeasured(token, previous, successor, moving);

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
     *         token may credit less than it was asked to move; the holder's
     *         debit, by contrast, must be exactly the amount (Codex #2158
     *         r22 P2) — a token that credits without debiting is refused
     *         rather than reported as recovered.
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
        LibRewardCustody.requireConstructedHere(s, holder);
        uint256 holderBefore = IERC20(token).balanceOf(holder);
        uint256 before = IERC20(token).balanceOf(treasury);
        RewardCustodyHolder(holder).release(token, treasury, amount);
        uint256 received = IERC20(token).balanceOf(treasury) - before;
        LibRewardCustody.requireDebited(holder, holderBefore, IERC20(token).balanceOf(holder), amount);
        LibRewardCustody.creditDiamondTreasury(s, token, received);
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
        // A Diamond that is its own treasury has no tracked native balance and
        // no native claim path (Codex #2158 post-cap P2): a native sweep into
        // it would move currency out of a holder that CAN release it into a
        // raw balance nothing can withdraw. Refused, with the reason named,
        // rather than reported as recovered.
        if (treasury == address(this)) revert IVaipakamErrors.RewardCustodyNativeToDiamondTreasury();
        LibRewardCustody.requireConstructedHere(s, holder);
        uint256 holderBefore = holder.balance;
        uint256 before = treasury.balance;
        RewardCustodyHolder(holder).releaseNative(treasury, amount);
        uint256 received = treasury.balance - before;
        // The holder's net debit must be exactly the amount (Codex #2158 r26
        // P2): a treasury whose receive path forces value back into the
        // holder would otherwise be reported as a completed sweep that can
        // be repeated.
        LibRewardCustody.requireDebited(holder, holderBefore, holder.balance, amount);
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
     *         and only from a holder in the constructed registry. Ownership
     *         is read back after the release and the sweep refuses unless the
     *         treasury owns the token (Codex #2158 r17 P2): a non-conforming
     *         token, or a proxy upgraded into an implementation whose
     *         transfer returns without moving anything, must not leave the
     *         NFT stranded behind a "recovered" event.
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
        // A Diamond that is its own treasury has no NFT withdrawal path
        // (Codex #2158 post-cap P2): delivering there would move the token
        // from a holder that CAN release it into raw Diamond ownership with
        // no supported exit. Refused, with the reason named; the token stays
        // at the holder, releasable to an external treasury.
        if (treasury == address(this)) revert IVaipakamErrors.RewardCustodyNftToDiamondTreasury();
        LibRewardCustody.requireConstructedHere(s, holder);
        // Ownership is read BEFORE the release too (Codex #2158 post-cap P2):
        // a token that already reports the treasury as owner — or that the
        // holder never held — must not produce a "recovered from holder"
        // event after a transfer that moved nothing.
        address ownerBefore = IERC721(token).ownerOf(tokenId);
        if (ownerBefore != holder) {
            revert IVaipakamErrors.RewardCustodyErc721NotAtHolder(token, tokenId, ownerBefore);
        }
        RewardCustodyHolder(holder).releaseERC721(token, treasury, tokenId);
        address owner = IERC721(token).ownerOf(tokenId);
        if (owner != treasury) {
            revert IVaipakamErrors.RewardCustodyErc721NotDelivered(token, tokenId, owner);
        }
        emit RewardCustodyERC721Swept(holder, token, treasury, tokenId);
    }

    /**
     * @notice Recover ERC-1155 units that reached a holder this Diamond
     *         constructed — the bound one or a previous one — to the
     *         treasury.
     * @dev    ADMIN. Same posture as {sweepERC721FromRewardCustody}; an
     *         ERC-1155 has only safe transfers, so units can reach a holder
     *         only at the predicted address before construction. The event
     *         carries the treasury's MEASURED receipt beside the request; the
     *         holder's debit must be exactly the amount (Codex #2158 r22 P2).
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
        // Same refusal as the ERC-721 sweep: no NFT withdrawal path exists on
        // a Diamond that is its own treasury (Codex #2158 post-cap P2).
        if (treasury == address(this)) revert IVaipakamErrors.RewardCustodyNftToDiamondTreasury();
        LibRewardCustody.requireConstructedHere(s, holder);
        uint256 holderBefore = IERC1155(token).balanceOf(holder, id);
        uint256 before = IERC1155(token).balanceOf(treasury, id);
        RewardCustodyHolder(holder).releaseERC1155(token, treasury, id, amount);
        uint256 received = IERC1155(token).balanceOf(treasury, id) - before;
        LibRewardCustody.requireDebited(holder, holderBefore, IERC1155(token).balanceOf(holder, id), amount);
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
     *         the custody — its own unattributed remainder has its own
     *         route, {sweepUnattributedVpfiFromRewardCustody}) and any
     *         address this Diamond did not construct.
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
        LibRewardCustody.requireConstructedHere(s, predecessor);
        LibRewardCustody.releaseMeasured(token, predecessor, bound, amount);
        emit RewardCustodyPredecessorVpfiRecovered(predecessor, bound, amount);
    }

    /**
     * @notice Move configured VPFI that NO ledger row describes — the
     *         unattributed remainder of the bound holder — to the treasury.
     * @dev    ADMIN, under the MANUAL pause. Anyone can transfer the
     *         configured VPFI straight to the bound holder's public address;
     *         no writer credits it, so it shows in {rewardCustodySnapshot} as
     *         `held - attributed` and would otherwise roll forward through
     *         every replacement with no supported disposition (Codex #2158
     *         r23 P2) — and the token-rotation runbook requires every
     *         old-token custody to be drained before a rotation, which an
     *         undrainable remainder would make impossible. This is that
     *         disposition, bounded by the substantiated excess: the amount
     *         may never exceed `held - attributed`, so attributed custody
     *         cannot be touched whatever the rows say, and the rows are not
     *         changed. Both ends of the move are verified (the treasury grew
     *         and the holder was debited by exactly the amount). Delivers to
     *         the configured treasury and to nowhere else. The manual pause
     *         is required so no protocol flow that credits the holder can be
     *         racing an operator's reading of the remainder.
     * @param  amount How much of the unattributed remainder to move.
     */
    function sweepUnattributedVpfiFromRewardCustody(
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address token = s.vpfiToken;
        if (token == address(0)) revert IVaipakamErrors.RewardCustodyTokenUnset();
        address bound = s.rewardCustodyHolder;
        if (bound == address(0)) revert IVaipakamErrors.RewardCustodyHolderNotBound();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        uint256 held = IERC20(token).balanceOf(bound);
        uint256 attributed = LibRewardCustody.attributedTotal(s);
        uint256 unattributed = held > attributed ? held - attributed : 0;
        if (amount > unattributed) {
            revert IVaipakamErrors.RewardCustodyExceedsUnattributed(amount, unattributed);
        }
        LibRewardCustody.releaseMeasured(token, bound, treasury, amount);
        LibRewardCustody.creditDiamondTreasury(s, token, amount);
        emit RewardCustodyUnattributedVpfiSwept(bound, treasury, amount, unattributed);
    }

    // ─── Paid-side migration importer ───────────────────────────────────────

    /**
     * @notice ONE-SHOT, PAUSED migration (the MANUAL pause — an auto-pause
     *         window does not qualify, Codex #2158 r18 P2): rebase the delivered-fresh ledger's
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
     * @param  total      The reconstructed absolute paid total.
     * @param  pauseEpoch The pause epoch — the pause library's transition
     *                    count — at which the caller established `total`
     *                    under the manual pause. The call refuses unless it
     *                    is still the live epoch (Codex #2158 r26/r27 P1): a
     *                    figure reconstructed from a live chain, or under a
     *                    pause that was lifted and re-applied since, may omit
     *                    a payout the old counter never charged, and this
     *                    one-shot would seal it. The contract holds the rule
     *                    so no tooling can pair a stale answer with a fresh
     *                    pause.
     */
    function rebaseArmedFreshPaid(
        uint256 total,
        uint64 pauseEpoch
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.armedFreshPaidRebased) {
            revert IVaipakamErrors.ArmedFreshPaidAlreadyRebased();
        }
        uint64 liveEpoch = LibPausable.pauseTransitions();
        if (pauseEpoch != liveEpoch) {
            revert IVaipakamErrors.ArmedFreshRebaseStalePauseEpoch(pauseEpoch, liveEpoch);
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

    // ─── #1566 slice 4 PR B — activation, funding and the bootstrap writers ─

    /// @notice The reward custody was activated on this chain: from here every
    ///         reward read and debit goes through the holder's rows.
    /// @param role                 The reward role at activation.
    /// @param received             The delivered ledger's received side, after
    ///                             any write-down.
    /// @param paid                 Its paid side.
    /// @param liveFresh            The live-fresh row verified against
    ///                             `received − paid`.
    /// @param recycled             The recycled row verified against the bucket.
    /// @param recovery             The recovery row verified against the
    ///                             recovery position.
    /// @param overage              The overage row verified against the
    ///                             overage position.
    /// @param mirrorGapWrittenDown Whether a mirror's imported `received − paid`
    ///                             was written down to what the holder backs.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyActivated(
        uint8 role,
        uint256 received,
        uint256 paid,
        uint256 liveFresh,
        uint256 recycled,
        uint256 recovery,
        uint256 overage,
        bool mirrorGapWrittenDown
    );

    /// @notice The registered funding writer credited the reward pool.
    /// @param funder        Who paid.
    /// @param amount        What arrived at the holder, verified.
    /// @param toLive        Allocated to the live-fresh row (new headroom).
    /// @param toRestitution Allocated to the restitution row (a deficit it
    ///                      closed; never headroom).
    /// @custom:event-category state-change/reward-custody
    event RewardPoolFunded(
        address indexed funder,
        uint256 amount,
        uint256 toLive,
        uint256 toRestitution
    );

    /// @notice A bootstrap writer backed a ledger figure with holder custody
    ///         ahead of activation.
    /// @param row                  The row credited.
    /// @param amount               What arrived at the holder, verified.
    /// @param relocatedFromDiamond True for a historical position relocated
    ///                             out of the Diamond's balance; false for
    ///                             replacement funding from the caller.
    /// @param ledgerFigure         The figure the row backs, for the record.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyRowBootstrapped(
        uint8 indexed row,
        uint256 amount,
        bool relocatedFromDiamond,
        uint256 ledgerFigure
    );

    /// @notice Overage custody — value that arrived above what any
    ///         entitlement could claim — was released to the treasury.
    /// @custom:event-category state-change/reward-custody
    event RewardCustodyOverageReleased(
        address indexed treasury,
        uint256 amount,
        uint256 overageAfter
    );

    /**
     * @notice ONE-SHOT, PAUSED (the MANUAL pause), epoch-pinned: switch this
     *         chain's reward custody reads and debits onto the holder
     *         (design §5d, the migration ceremony's "switch custody reads to
     *         the holder PR A bound").
     * @dev    Refuses unless every figure the holder must back IS backed —
     *         the check is the operation, so the ceremony cannot be skipped
     *         on the expectation that the figures are zero (they are, on
     *         every deployed chain today; the rule is stated so that a chain
     *         where they are not cannot activate over an empty holder):
     *
     *           - the role is configured (`Unconfigured` can never activate:
     *             its column stays at Diamond custody by design);
     *           - the paid-side rebase has run (the baseline verified below
     *             is the one it installed);
     *           - on `Canonical`, per-receipt recovery attribution is armed
     *             — arming retires the legacy pooled position, and a recovery
     *             row funded before that retirement would be left over-backed;
     *           - the recycled, recovery and overage rows each EQUAL their
     *             ledger figure (`recycleBucket`, `recovered − redispatched`,
     *             `strandedReturnOverage`) — funded, relocated or written
     *             down by the ceremony beforehand;
     *           - `Canonical`: `received == paid` (the zero-headroom
     *             baseline) and an empty live-fresh row — funding forward is
     *             `fundRewardPool` after the unpause, never a seed here;
     *             `Mirror`: the live-fresh row equals the imported
     *             `received − paid` gap (custody-only funded through
     *             {fundRewardCustodyRow}), OR the caller asks for the gap to
     *             be WRITTEN DOWN to what the holder backs — the two
     *             executable forms design §5c allows ("fund the history or
     *             shrink it"); `Detached`: an empty live-fresh row (its bound
     *             is zero);
     *           - the holder's balance is readable and covers the rows.
     *
     *         Arms the role freeze. An `Unconfigured` deployment that is
     *         later configured into a role (a fresh deploy, after
     *         `ConfigureRewardReporter`) runs this same ceremony.
     * @param  pauseEpoch          The pause library's transition count at
     *                             which the figures were established under
     *                             the manual pause; refused if no longer live.
     * @param  writeDownMirrorGap  `Mirror` only: write `received` down to
     *                             `paid + liveFreshRow` when the row backs
     *                             less than the imported gap.
     */
    function activateRewardCustody(
        uint64 pauseEpoch,
        bool writeDownMirrorGap
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.rewardCustodyActivated) revert IVaipakamErrors.RewardCustodyAlreadyActivated();
        uint64 liveEpoch = LibPausable.pauseTransitions();
        if (pauseEpoch != liveEpoch) {
            revert IVaipakamErrors.RewardCustodyActivationStalePauseEpoch(pauseEpoch, liveEpoch);
        }
        (address holder, address token) = LibRewardCustody.boundHolderAndToken(s);
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);
        if (role == LibVaipakam.RewardRole.Unconfigured) {
            revert IVaipakamErrors.RewardCustodyActivationRequiresConfiguredRole(uint8(role));
        }
        if (!s.armedFreshPaidRebased) revert IVaipakamErrors.RewardCustodyActivationRequiresRebase();
        if (role == LibVaipakam.RewardRole.Canonical && !s.recoveryAttributionArmed) {
            revert IVaipakamErrors.RewardCustodyActivationRequiresRecoveryArming();
        }
        _requireRowBacked(s, LibVaipakam.RewardCustodyRow.Recycled, s.recycleBucket);
        _requireRowBacked(
            s,
            LibVaipakam.RewardCustodyRow.Recovery,
            s.rewardBudgetRecovered - s.rewardBudgetRedispatched
        );
        _requireRowBacked(s, LibVaipakam.RewardCustodyRow.Overage, s.strandedReturnOverage);

        uint256 received = s.rewardBudgetArmedFreshReceived;
        uint256 paid = s.rewardBudgetArmedFreshPaid;
        uint256 live = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        bool writtenDown;
        if (role == LibVaipakam.RewardRole.Canonical) {
            if (received != paid) revert IVaipakamErrors.RewardCustodyBaselineNotVerified(received, paid);
            _requireRowBacked(s, LibVaipakam.RewardCustodyRow.LiveFresh, 0);
        } else {
            // `Mirror`: the imported gap; `Detached`: zero (its bound is zero,
            // and a detached chain carrying history could not have rebased).
            uint256 gap = role == LibVaipakam.RewardRole.Mirror && received > paid
                ? received - paid
                : 0;
            if (live != gap) {
                if (writeDownMirrorGap && role == LibVaipakam.RewardRole.Mirror && live < gap) {
                    // The write-down form: history retained in the event, the
                    // usable headroom reduced to what the holder actually
                    // backs (design §5c, "an imported POSITIVE received − paid
                    // is history, not money").
                    received = paid + live;
                    s.rewardBudgetArmedFreshReceived = received;
                    writtenDown = true;
                } else {
                    revert IVaipakamErrors.RewardCustodyRowUnbacked(
                        uint8(LibVaipakam.RewardCustodyRow.LiveFresh), gap, live
                    );
                }
            }
        }
        (bool known, uint256 held) = LibRewardCustody.tryBalance(token, holder);
        if (!known) revert IVaipakamErrors.RewardCustodyBalanceUnreadable();
        uint256 attributed = LibRewardCustody.attributedTotal(s);
        if (attributed > held) revert IVaipakamErrors.RewardCustodyUnderHeld(held, attributed);

        s.rewardCustodyActivated = true;
        s.rewardRoleChangesFrozen = true;
        emit RewardCustodyActivated(
            uint8(role),
            received,
            paid,
            live,
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Recycled],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Recovery],
            s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Overage],
            writtenDown
        );
    }

    /**
     * @notice The registered funding writer (design §5b, "credit — one
     *         event, and it is a TRANSFER"): move `amount` VPFI from the
     *         caller INTO THE HOLDER and credit the delivered ledger's
     *         received side in the same act, under the §5c deficit split.
     * @dev    ADMIN. Requires the custody to be activated (a funding writer
     *         cut before the payout paths read the holder would move tokens
     *         into custody no claim can spend — the reason PR A did not ship
     *         it) and an ACTIVE role, `Canonical` or `Mirror`: funding a
     *         `Detached` chain would credit headroom a zero bound cannot
     *         consume and strand the allocation across the next transition.
     *         The transfer is delta-checked against the HOLDER's balance;
     *         the resulting received counter is bounded by the interaction
     *         pool's lifetime cap, above which nothing can ever be paid.
     *         Not pause-gated: the design's ceremony funds forward AFTER the
     *         unpause.
     * @param  amount VPFI to fund; the caller has approved the Diamond.
     */
    function fundRewardPool(uint256 amount) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.active(s)) revert IVaipakamErrors.RewardCustodyNotActivated();
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);
        if (role != LibVaipakam.RewardRole.Canonical && role != LibVaipakam.RewardRole.Mirror) {
            revert IVaipakamErrors.RewardCustodyFundingRequiresActiveRole(uint8(role));
        }
        uint256 resulting = s.rewardBudgetArmedFreshReceived + amount;
        if (resulting > LibVaipakam.VPFI_INTERACTION_POOL_CAP) {
            revert IVaipakamErrors.RewardCustodyFundingExceedsCap(resulting, LibVaipakam.VPFI_INTERACTION_POOL_CAP);
        }
        LibRewardCustody.pullFromCaller(s, msg.sender, amount);
        (uint256 toLive, uint256 toRestitution) = LibRewardCustody.creditFreshIngress(s, amount);
        emit RewardPoolFunded(msg.sender, amount, toLive, toRestitution);
    }

    /**
     * @notice Bootstrap writer, form (a) — CUSTODY-ONLY replacement funding
     *         of a ledger figure ahead of activation: move `amount` from the
     *         caller into the holder and credit `row`, touching NO ledger
     *         counter. Bounded by `figure − row`.
     * @dev    ADMIN, MANUAL pause, before activation only. This is the writer
     *         design §5c says the disposition needs beside `fundRewardPool`,
     *         which cannot close an imported gap because it credits
     *         `received` as well ("fund 100 against a 100-gap and headroom
     *         reads 200 over a 100-token holder"). Serves the live-fresh row
     *         (a mirror's imported `received − paid`), the recycled row (the
     *         bucket), and the recovery and overage rows (the recovery
     *         position). The tokens are the caller's, so no other owner of
     *         the Diamond's balance can be seized by it.
     * @param  row    The row to back.
     * @param  amount VPFI to fund; the caller has approved the Diamond.
     */
    function fundRewardCustodyRow(
        LibVaipakam.RewardCustodyRow row,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 figure = _requireBootstrapRoom(s, row, amount, true);
        LibRewardCustody.fundFromCaller(s, row, msg.sender, amount);
        emit RewardCustodyRowBootstrapped(uint8(row), amount, false, figure);
    }

    /**
     * @notice Bootstrap writer, form (b) — RELOCATE a historical position out
     *         of the Diamond's own balance into the holder and credit `row`,
     *         touching NO ledger counter. Bounded by `figure − row`.
     * @dev    ADMIN, MANUAL pause, before activation only. For the recycled,
     *         recovery and overage rows — the historical pre-holder inventory
     *         the design's ceremony relocates "under the provenance-or-
     *         replacement rule of slice 0". The provenance proof is the
     *         ceremony record's, not this call's: on chain the move is
     *         measured at both ends and bounded by the ledger figure, and
     *         that is all a contract can verify. NEVER the live-fresh row:
     *         an imported `received − paid` is history, not money (design
     *         §5c) — the holder starts empty and a relocation there would be
     *         exactly the seed-from-ambient-custody mistake the rule forbids.
     * @param  row    The row to back.
     * @param  amount VPFI to relocate from the Diamond's balance.
     */
    function relocateRewardCustodyRow(
        LibVaipakam.RewardCustodyRow row,
        uint256 amount
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 figure = _requireBootstrapRoom(s, row, amount, false);
        LibRewardCustody.relocateToHolder(s, row, amount);
        emit RewardCustodyRowBootstrapped(uint8(row), amount, true, figure);
    }

    /**
     * @notice The overage row's disposition: release value that arrived
     *         above what any entitlement could claim to the treasury,
     *         retiring the same amount from the recorded overage position.
     * @dev    ADMIN, MANUAL pause, activated. Overage is operator custody —
     *         never uncharged redispatch capacity and never claimable backing
     *         — and had no exit at all before this; a row with no exit rolls
     *         forward through every replacement. Delivers to the configured
     *         treasury and nowhere else; a Diamond-as-treasury receives it as
     *         a tracked, claimable balance.
     * @param  amount How much overage to release.
     */
    function releaseRewardCustodyOverage(uint256 amount) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibPausable.requireManuallyPaused();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!LibRewardCustody.active(s)) revert IVaipakamErrors.RewardCustodyNotActivated();
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        address treasury = s.treasury;
        if (treasury == address(0)) revert IVaipakamErrors.RewardCustodyTreasuryUnset();
        uint256 recorded = s.strandedReturnOverage;
        if (amount > recorded) revert IVaipakamErrors.RewardCustodyOverageExceedsRecorded(amount, recorded);
        s.strandedReturnOverage = recorded - amount;
        LibRewardCustody.releaseFromRow(s, LibVaipakam.RewardCustodyRow.Overage, treasury, amount);
        LibRewardCustody.creditDiamondTreasury(s, s.vpfiToken, amount);
        emit RewardCustodyOverageReleased(treasury, amount, recorded - amount);
    }

    /// @dev The activation's per-row verification: the row EQUALS the ledger
    ///      figure it backs. Equality, not `>=`: a row above its figure is
    ///      custody no ledger describes, and it would be spendable by the
    ///      row's consumer against nothing.
    function _requireRowBacked(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow row,
        uint256 figure
    ) private view {
        uint256 held = s.rewardCustodyRows[row];
        if (held != figure) revert IVaipakamErrors.RewardCustodyRowUnbacked(uint8(row), figure, held);
    }

    /// @dev The bootstrap writers' shared bound: refuses after activation,
    ///      resolves the ledger figure the row backs (or refuses a row with
    ///      no bootstrap figure), and refuses a credit that would take the
    ///      row above it. Returns the figure for the event.
    function _requireBootstrapRoom(
        LibVaipakam.Storage storage s,
        LibVaipakam.RewardCustodyRow row,
        uint256 amount,
        bool allowLiveFresh
    ) private view returns (uint256 figure) {
        if (s.rewardCustodyActivated) revert IVaipakamErrors.RewardCustodyAlreadyActivated();
        if (amount == 0) revert IVaipakamErrors.InvalidAmount();
        if (row == LibVaipakam.RewardCustodyRow.LiveFresh) {
            if (!allowLiveFresh) revert IVaipakamErrors.RewardCustodyBootstrapRowNotAllowed(uint8(row));
            uint256 received = s.rewardBudgetArmedFreshReceived;
            uint256 paid = s.rewardBudgetArmedFreshPaid;
            figure = received > paid ? received - paid : 0;
        } else if (row == LibVaipakam.RewardCustodyRow.Recycled) {
            figure = s.recycleBucket;
        } else if (row == LibVaipakam.RewardCustodyRow.Recovery) {
            figure = s.rewardBudgetRecovered - s.rewardBudgetRedispatched;
        } else if (row == LibVaipakam.RewardCustodyRow.Overage) {
            figure = s.strandedReturnOverage;
        } else {
            revert IVaipakamErrors.RewardCustodyBootstrapRowNotAllowed(uint8(row));
        }
        uint256 held = s.rewardCustodyRows[row];
        uint256 room = figure > held ? figure - held : 0;
        if (amount > room) revert IVaipakamErrors.RewardCustodyBootstrapExceedsLedger(uint8(row), amount, room);
    }

    // ─── Diamond-internal custody entry points ──────────────────────────────
    //
    // The custody MUTATIONS every other reward path performs, reachable only
    // through the Diamond's own fallback (`msg.sender == address(this)`):
    // the claim's wallet payout, the transports' draw, the ingress
    // relocations, the absorption's in-holder move, the surplus release.
    // Hosted here — where the implementation already inlines — so the
    // facets at EIP-170 budget pay one call rather than the implementation.
    // Deliberately NOT `nonReentrant`: each runs inside a caller's guarded
    // frame, exactly as `VaultFactoryFacet.vaultCreditFromDiamondERC20` does.

    function _requireDiamondInternal() private view {
        if (msg.sender != address(this)) revert IVaipakamErrors.RewardCustodyOnlyDiamondInternal(msg.sender);
    }

    /// @notice Diamond-internal: {LibRewardCustody.relocateToHolder}.
    function custodyRelocateToRow(uint8 row, uint256 amount) external {
        _requireDiamondInternal();
        LibRewardCustody.relocateToHolder(LibVaipakam.storageSlot(), LibVaipakam.RewardCustodyRow(row), amount);
    }

    /// @notice Diamond-internal: {LibRewardCustody.move}.
    function custodyMove(uint8 from, uint8 to, uint256 amount) external {
        _requireDiamondInternal();
        LibRewardCustody.move(
            LibVaipakam.storageSlot(), LibVaipakam.RewardCustodyRow(from), LibVaipakam.RewardCustodyRow(to), amount
        );
    }

    /// @notice Diamond-internal: {LibRewardCustody.relocateFreshIngress}.
    function custodyRelocateFreshIngress(uint256 amount) external {
        _requireDiamondInternal();
        LibRewardCustody.relocateFreshIngress(LibVaipakam.storageSlot(), amount);
    }

    /// @notice Diamond-internal: {LibRewardCustody.uncreditFresh}.
    function custodyUncreditFresh(uint256 amount) external {
        _requireDiamondInternal();
        LibRewardCustody.uncreditFresh(LibVaipakam.storageSlot(), amount);
    }

    /// @notice Diamond-internal: {LibRewardCustody.releaseFromRow}.
    function custodyReleaseFromRow(uint8 row, address to, uint256 amount) external {
        _requireDiamondInternal();
        LibRewardCustody.releaseFromRow(LibVaipakam.storageSlot(), LibVaipakam.RewardCustodyRow(row), to, amount);
    }

    /// @notice Diamond-internal: the two-row WALLET payout — live-fresh by
    ///         `fresh`, recycled by `recycled`, the sum released to `to`,
    ///         measured at both ends.
    function custodyPayoutToWallet(address to, uint256 fresh, uint256 recycled) external {
        _requireDiamondInternal();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (address holder, address token) = LibRewardCustody.boundHolderAndToken(s);
        LibRewardCustody.debit(s, LibVaipakam.RewardCustodyRow.LiveFresh, fresh, to);
        LibRewardCustody.debit(s, LibVaipakam.RewardCustodyRow.Recycled, recycled, to);
        LibRewardCustody.releaseMeasured(token, holder, to, fresh + recycled);
    }

    /// @notice Diamond-internal: {LibRewardCustody.drawForTransport}.
    function custodyDrawForTransport(uint8 source, uint256 fresh, uint256 recycled) external {
        _requireDiamondInternal();
        LibRewardCustody.drawForTransport(
            LibVaipakam.storageSlot(),
            LibRewardCustody.TransportDraw({
                source: LibRewardCustody.TransportSource(source), fresh: fresh, recycled: recycled
            })
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

    /// @notice #1566 slice 4 PR B — whether reward custody reads and debits
    ///         the holder on this chain (the activation ceremony has run).
    function rewardCustodyActivated() external view returns (bool) {
        return LibVaipakam.storageSlot().rewardCustodyActivated;
    }

    /// @notice #1566 slice 4 PR B — whether effective reward-role changes are
    ///         refused (holder allocations exist or custody is activated;
    ///         cleared by slice 4 PR C's backfill).
    function rewardRoleChangesFrozen() external view returns (bool) {
        return LibVaipakam.storageSlot().rewardRoleChangesFrozen;
    }

    /**
     * @notice #1566 slice 4 PR B — the custody ledger, every row by name,
     *         beside the activation state. The versioned successor of the
     *         holder side of `InteractionRewardsLensFacet.getRecycleBackingSnapshot`
     *         (design §5d): that view keeps its shape and its meaning — its
     *         first result stays the Diamond's live VPFI balance — and this
     *         one exposes the holder's rows separately rather than
     *         redefining it. Read with {rewardCustodySnapshot} for the
     *         holder's balance against the rows' sum.
     */
    function rewardCustodyLedger()
        external
        view
        returns (
            bool activated,
            bool roleChangesFrozen,
            uint256 liveFresh,
            uint256 recycled,
            uint256 recovery,
            uint256 overage,
            uint256 pendingSurplus,
            uint256 intent,
            uint256 unclassified,
            uint256 restitution
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        activated = s.rewardCustodyActivated;
        roleChangesFrozen = s.rewardRoleChangesFrozen;
        liveFresh = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.LiveFresh];
        recycled = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Recycled];
        recovery = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Recovery];
        overage = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Overage];
        pendingSurplus = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.PendingSurplus];
        intent = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Intent];
        unclassified = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Unclassified];
        restitution = s.rewardCustodyRows[LibVaipakam.RewardCustodyRow.Restitution];
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
        (balanceKnown, held) = LibRewardCustody.tryBalance(token, holder);
        attributed = LibRewardCustody.attributedTotal(s);
    }
}
