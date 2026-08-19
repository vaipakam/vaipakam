// src/libraries/LibLoan.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibRevert} from "./LibRevert.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {LibMetricsHooks} from "./LibMetricsHooks.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";

/// @title LibLoan
/// @notice Shared helpers for mid-life loan mutations. Consolidates the
///         burn-old / mint-new NFT migration pattern used when a loan's
///         lender or borrower is replaced (loan-sale, obligation-transfer).
///         Keeps `nextTokenId` bumps, status labels, and token-id
///         assignments in lockstep with the NFT facet so no facet can
///         drift out of sync as metadata evolves in Phase 2.
library LibLoan {
    /// @dev Replaces the lender on an existing loan: burns the current
    ///      lender NFT, mints a fresh LoanInitiated NFT to `newLender`,
    ///      and updates both `loan.lender` and `loan.lenderTokenId`.
    ///      Callers must already have validated authorization, compliance,
    ///      and lender-favorability constraints.
    function migrateLenderPosition(
        uint256 loanId,
        address newLender
    ) internal returns (uint256 newTokenId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        // #1503 item 28 — the incoming lender is "paid through" the moment they
        // acquire the position, so their forfeiture window opens here and carries
        // none of the seller's. Without this the seller's mark would credit every
        // later seller in turn: lender A is paid through T and sells, then B
        // resells and has A's window deducted from their forfeiture though B
        // never received it, at treasury's expense, once per resale.
        //
        // Set unconditionally, and never below the mark it replaces: a sale is
        // always "now", which is at or after any boundary already settled.
        //
        // #1801 — this also CLEARS the freeze void. The flag is sticky for a
        // lender's tenure because a frozen stretch makes their delivery
        // non-contiguous, but none of that history is the buyer's: their window
        // opens here, at this principal, and carries nothing from before the
        // sale. Stamping through the shared writer is what keeps the recorded
        // principal in step with the mark.
        LibEntitlement.stampInterestDeliveredForNewLender(s, loanId, block.timestamp);
        // #998 S10 Class B NOTE — the dedicated active-held reservation is NOT
        // migrated here: the sale callers withdraw `priorHeld` from the OLD
        // lender's vault BEFORE calling this helper, so the reservation must be
        // moved off the old lender EARLIER (right after `releaseLenderProceeds`,
        // before that withdrawal) or the withdraw's free-balance guard reverts
        // (Codex #1122-rework fresh-round P2). Each sale caller does that; the
        // consolidation path migrates via `rekeyLienToHolder` at step 5 (also
        // before its held move).
        address diamond = address(this);

        (bool success, bytes memory data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                loan.lenderTokenId
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTBurnFailed.selector);

        unchecked {
            newTokenId = ++s.nextTokenId;
        }

        (success, data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                newLender,
                newTokenId,
                loan.offerId,
                loanId,
                true, // isLender
                LibVaipakam.LoanPositionStatus.LoanInitiated
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTMintFailed.selector);

        // #1503 design item 25 — carry the reverse index with the position.
        // `loanIdByPositionTokenId` is written in exactly one other place,
        // `LibMetricsHooks` at loan creation, and nothing refreshed it when a
        // position migrated. So after any lender sale the BUYER's new token id
        // resolved to 0 through `MetricsFacet.getLoanIdByPositionTokenId` and the
        // paginated position views built on it, while the SELLER's superseded
        // token id still resolved to this loan — the buyer could not find the
        // position they had just paid for, and the index answered with the party
        // who no longer held it.
        //
        // Done here rather than at each sale path deliberately: this helper is
        // the single point every lender migration passes through, and the same
        // omission would otherwise have to be remembered separately by the
        // listed route, the direct route, and anything added later. That is the
        // shape of the guard-remembered-twice defect recorded on #1503.
        _rekeyPositionIndex(s, loan.lenderTokenId, newTokenId, loanId);
        // #1503 item 25, second half (Codex #1818 r1 P2) — the token mapping
        // above serves NFT-keyed discovery; the dashboard and history views
        // walk `userLoanIds`, so the buyer must also receive the REAL loan id
        // there or the acquired position is absent from every list view.
        _indexLoanForHolder(s, loan.lender, newLender, loan.borrower, loanId);
        // Item 25's notification-policy half, decided as "each holder pays
        // separately": the flag is reset so the incoming lender cannot consume
        // notification service funded by the seller's VPFI tariff, and is
        // billed on their own first use instead. Only when the holder actually
        // CHANGES (Codex #1818 r2 P2) — the supported self-purchase keeps the
        // same economic holder, and clearing their own paid flag would bill
        // them twice for service they already funded.
        if (newLender != loan.lender) loan.lenderNotifBilled = false;

        loan.lender = newLender;
        loan.lenderTokenId = newTokenId;
    }

    /// @dev Moves `loanIdByPositionTokenId` from a superseded position token to
    ///      the token that replaces it. Both halves matter: the stale entry has
    ///      to go, or a burned token keeps resolving to a live loan, and the new
    ///      entry has to exist, or the current holder's token resolves to
    ///      nothing.
    function _rekeyPositionIndex(
        LibVaipakam.Storage storage s,
        uint256 oldTokenId,
        uint256 newTokenId,
        uint256 loanId
    ) private {
        if (oldTokenId != 0) delete s.loanIdByPositionTokenId[oldTokenId];
        if (newTokenId != 0) s.loanIdByPositionTokenId[newTokenId] = loanId;
    }

    /// @dev Appends `loanId` to the INCOMING holder's `userLoanIds` with O(1)
    ///      dedup via `userLoanIndexed` — item 25 forbids reusing the
    ///      consolidation path's linear lifetime-array scan, whose gas grows
    ///      with the buyer's history and can turn a funded-looking fill into a
    ///      seller-burning revert.
    ///
    ///      The map is trusted only for loans in the exact regime
    ///      (`loanHolderIndexExact`, stamped at creation alongside the
    ///      original parties' pushes). For those, every CURRENT holder's bit
    ///      is faithful by induction — creation stamped both parties, and
    ///      every migration stamps its acquirer — so a false bit on the
    ///      incoming holder genuinely means "not in the array" and a bare
    ///      push is correct.
    ///
    ///      Grandfathered loans (created before the map shipped) admit no
    ///      such O(1) inference (Codex #1818 r3 P2): original parties sit in
    ///      the array unstamped, while a holder who acquired through a
    ///      pre-map migration is in NEITHER — that absence is the item-25
    ///      bug itself. An earlier revision stamped the outgoing holder on
    ///      the assumption "indexed by construction", which records false
    ///      membership for exactly those pre-map acquirers and turns their
    ///      later reacquisition into a permanent absence (the dedup skips
    ///      an append the array never received). Instead, every migration
    ///      of a grandfathered loan establishes the incoming holder's and
    ///      the counterparty's membership by scan and stamps them
    ///      truthfully. The loan is deliberately NOT promoted to the exact
    ///      regime afterwards: a FORMER pre-map holder is still ambiguous
    ///      (maybe original-and-present, maybe acquirer-and-absent), and a
    ///      promoted flag would hand their reacquisition to the bare-push
    ///      path — a duplicate row for originals, the mirror image of the
    ///      absence this fixes. The stamp makes each user's scan a one-time
    ///      cost: once stamped, every later encounter is the O(1) bit read.
    ///      The scan item 25 forbids is the unbounded per-fill one; this one
    ///      amortizes to once per (user, legacy loan) pair, and the legacy
    ///      population is closed.
    ///
    ///      Also marks a first-time buyer as a seen protocol user — the
    ///      creation path does this for original parties, and item 25 requires
    ///      it of migration.
    function _indexLoanForHolder(
        LibVaipakam.Storage storage s,
        address, // outgoing — deliberately no write here (see above)
        address incoming,
        address counterparty,
        uint256 loanId
    ) private {
        LibMetricsHooks.markUserSeen(s, incoming);
        if (!s.loanHolderIndexExact[loanId]) {
            _establishMembership(s, incoming, loanId);
            _establishMembership(s, counterparty, loanId);
            return;
        }
        if (s.userLoanIndexed[incoming][loanId]) return;
        s.userLoanIndexed[incoming][loanId] = true;
        s.userLoanIds[incoming].push(loanId);
    }

    /// @dev Hard ceiling on the legacy membership scan (Codex #1818 r4 P2).
    ///      An UNBOUNDED repair scan re-creates on the legacy corner exactly
    ///      the failure item 25 forbids: a party with a long-enough lifetime
    ///      array makes the fill run out of gas, the revert rolls back the
    ///      stamp, and every retry repeats the full scan — the position is
    ///      unmigratable. 1,024 cold reads is ≈2.2M gas, comfortably inside
    ///      a fill; no account on the CLOSED pre-map population approaches
    ///      it, so in practice the cap never binds.
    uint256 private constant MAX_LEGACY_MEMBERSHIP_SCAN = 1024;

    /// @dev Grandfathered-loan repair: make `userLoanIndexed[user][loanId]`
    ///      faithful by scanning the lifetime array once, appending only on
    ///      genuine absence. Each user pays this at most once per legacy
    ///      loan (the stamp makes every later encounter an O(1) bit read);
    ///      the exact regime never calls this.
    ///
    ///      The scan walks BACKWARDS and stops at the cap: a legacy party's
    ///      entry for this loan is either their creation-time append or a
    ///      repair append, both of which sit within the pre-map population's
    ///      modest history. If the entry is genuinely deeper than the cap,
    ///      the append below records a DUPLICATE row — chosen deliberately
    ///      over the unbounded scan's alternative, an out-of-gas revert that
    ///      leaves the position permanently unmigratable. A duplicate is a
    ///      cosmetic double-listing on one legacy corner; a bricked fill is
    ///      a loss.
    function _establishMembership(
        LibVaipakam.Storage storage s,
        address user,
        uint256 loanId
    ) private {
        if (s.userLoanIndexed[user][loanId]) return;
        uint256[] storage ids = s.userLoanIds[user];
        uint256 n = ids.length;
        uint256 floor = n > MAX_LEGACY_MEMBERSHIP_SCAN
            ? n - MAX_LEGACY_MEMBERSHIP_SCAN
            : 0;
        for (uint256 i = n; i > floor; ) {
            unchecked {
                --i;
            }
            if (ids[i] == loanId) {
                s.userLoanIndexed[user][loanId] = true;
                return;
            }
        }
        s.userLoanIndexed[user][loanId] = true;
        s.userLoanIds[user].push(loanId);
    }

    /// @dev Replaces the borrower on an existing loan. Symmetric to
    ///      {migrateLenderPosition}: burns the current borrower NFT,
    ///      mints a fresh LoanInitiated NFT to `newBorrower`, and updates
    ///      both `loan.borrower` and `loan.borrowerTokenId`.
    function migrateBorrowerPosition(
        uint256 loanId,
        address newBorrower,
        address previousBorrower
    ) internal returns (uint256 newTokenId) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address diamond = address(this);

        (bool success, bytes memory data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.burnNFT.selector,
                loan.borrowerTokenId
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTBurnFailed.selector);

        unchecked {
            newTokenId = ++s.nextTokenId;
        }

        (success, data) = diamond.call(
            abi.encodeWithSelector(
                VaipakamNFTFacet.mintNFT.selector,
                newBorrower,
                newTokenId,
                loan.offerId,
                loanId,
                false, // isLender = false (borrower)
                LibVaipakam.LoanPositionStatus.LoanInitiated
            )
        );
        LibRevert.bubbleOnFailureTyped(success, data, IVaipakamErrors.NFTMintFailed.selector);

        // #1503 design item 25, borrower side. The item is written about lender
        // migration, because that is where the sale routes surfaced it — but the
        // index is keyed by POSITION TOKEN, not by side, and this function
        // supersedes a borrower token exactly the same way. An obligation
        // transfer left the incoming borrower's token resolving to nothing and
        // the departed borrower's still resolving to the loan.
        //
        // Fixed here rather than filed as a second item: it is the same defect
        // in the symmetric half of the same helper, and splitting it would leave
        // a known gap open for the sake of matching the audit's wording.
        _rekeyPositionIndex(s, loan.borrowerTokenId, newTokenId, loanId);
        // #1503 item 25, borrower side — same list-view discovery as the
        // lender half, same dedup, same notification policy. The departing
        // holder arrives as an explicit PARAMETER (Codex #1818 r4 P2):
        // `transferObligationViaOffer` rewrites `loan.borrower` well before
        // it reaches this helper, so a comparison against the field here was
        // always false and the paid-notification flag silently travelled to
        // every incoming borrower — the exact free-ride the each-holder-pays
        // policy exists to refuse.
        _indexLoanForHolder(s, previousBorrower, newBorrower, loan.lender, loanId);
        if (newBorrower != previousBorrower) loan.borrowerNotifBilled = false;

        loan.borrower = newBorrower;
        loan.borrowerTokenId = newTokenId;
    }
}
