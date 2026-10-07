// src/libraries/LibFallbackCustody.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";

/**
 * @title  LibFallbackCustody
 * @author Vaipakam Developer Team
 * @notice #1566 slice 2 - the one row primitive for liquidation-fallback
 *         custody. When a liquidation or default swap fails, the collateral
 *         it withdrew returns to the stored borrower's vault in the same
 *         transaction, under the loan's collateral lien, and the row
 *         `fallbackVaultCustody[loanId]` counts how much of that vault balance
 *         is the fallback episode's custody: the units the fallback snapshot
 *         splits between the lender, the treasury and the borrower. So no user
 *         asset rests in the Diamond across transactions (#2141; the ratified
 *         Option F: keep user value in the user's vault under a lien).
 *
 * @dev    What lives here, and why only this:
 *         - Transparent fund movements. Every change to the row is ONE
 *           explicit move with a kind, a counterparty, the asset, the amount
 *           and the custody left after it ({FallbackCustodyMoved}). A loan's
 *           custody therefore reconciles from its events alone: the credits
 *           minus the debits equal the row, and each debit names where the
 *           value went.
 *         - One notify rule. The row is an input to the VPFI fee-tier
 *           exclusion (`LibTierExclusion`, its FallbackPending clause), so
 *           every mutator re-derives that exclusion through
 *           `LibEncumbrance.notifyTierExclusion` after writing, exactly as
 *           every per-loan encumbrance mutator does. No call site can forget.
 *         - One custody discriminator. {isLegacy} is the only definition of
 *           "this snapshot's custody rests in the Diamond": a pre-slice-2 row
 *           on a Diamond refreshed in place. Owner decision O1 = A
 *           (2026-10-07): every chain that runs slice 2 is a fresh deploy and
 *           there is no migration, so such a row FAILS CLOSED by name at every
 *           consumer ({requireVaultHeld}) instead of being paid out of the
 *           Diamond's own balance, where it would draw on same-token value
 *           that belongs to others.
 *
 *         Token transfers, the lien and the tracked vault balance are NOT
 *         here. The multi-step flows that combine them with a row move
 *         (fallback entry, the claim-time retry, the in-kind split) have ONE
 *         host, `FallbackCustodyFacet`, so each flow's ordering is written
 *         once; the consumers outside it (cure, curing repayment, internal
 *         match) move the row beside the lien and nothing else, because
 *         their custody either stays in the vault or leaves it through the
 *         match's single vault leg.
 *
 *         Direction is part of the move: {credit} accepts only the two credit
 *         kinds and {debit} only the debit kinds, so an event can never name a
 *         move the row did not make. A zero amount is a no-op (nothing moves,
 *         so no row is written and no event is emitted), matching the lien
 *         primitives in `LibEncumbrance`.
 */
library LibFallbackCustody {
    /// @notice The kind of a fallback custody move.
    /// @dev    Credits (the row grows):
    ///           - `Entered`: fallback entry deposits the failed swap's
    ///             collateral into the borrower's vault;
    ///           - `RetryRestored`: a failed claim-time retry swap puts the
    ///             custody it pulled back into that vault.
    ///         Debits that move tokens out of the borrower's vault:
    ///           - `ToTreasury`, `ToLender`, `ToBackstop`: the in-kind split;
    ///           - `RetryPulled`: pulled into the Diamond for the retry swap,
    ///             inside the same transaction;
    ///           - `MatchToLender`, `MatchToMatcher`: an internal-match leg
    ///             and its incentive.
    ///         Debits that move no token:
    ///           - `RetainedForBorrower`: the borrower's slice stays in the
    ///             same vault, under the same lien, as the borrower's
    ///             residual claim;
    ///           - `ReturnedToPledge` ({returnToPledge} only): a cure, a
    ///             curing repayment or an internal-match full rescue turns the
    ///             custody back into ordinary pledged collateral.
    ///         Append-only: an indexer decodes `move` by position.
    enum Move {
        Entered,
        ToTreasury,
        ToLender,
        ToBackstop,
        RetainedForBorrower,
        RetryPulled,
        RetryRestored,
        MatchToLender,
        MatchToMatcher,
        ReturnedToPledge
    }

    /// @notice One explicit move of a loan's fallback custody row.
    /// @dev    The custody's provenance: replaying a loan's events reproduces
    ///         the row (`custodyAfter`), and every amount is attributed to a
    ///         kind and a counterparty. Declared once here so every facet that
    ///         moves the row emits the same topic.
    /// @param loanId       The loan whose fallback custody moved.
    /// @param move         The kind of move ({Move}).
    /// @param counterparty The other side of the move, as the caller names it:
    ///                     the recipient of a debit that leaves the vault
    ///                     (treasury, lender, backstop vault, matcher, or the
    ///                     Diamond for `RetryPulled`); the stored borrower for
    ///                     the credits and for the debits that keep the value
    ///                     in the borrower's vault.
    /// @param asset        The collateral asset (`loan.collateralAsset`).
    /// @param amount       Units moved; never zero.
    /// @param custodyAfter The row after the move.
    /// @custom:event-category state-change/loan-mutation
    event FallbackCustodyMoved(
        uint256 indexed loanId,
        Move indexed move,
        address indexed counterparty,
        address asset,
        uint256 amount,
        uint256 custodyAfter
    );

    /// @notice The loan's active fallback snapshot describes custody that does
    ///         not rest in the borrower's vault: a pre-slice-2 Diamond-held row
    ///         on a Diamond refreshed in place. Refused rather than paid out of
    ///         the Diamond (O1 = A: no migration path exists).
    error FallbackCustodyNotVaultHeld(uint256 loanId);

    /// @notice A debit exceeded the custody row. The row is a sum of explicit
    ///         moves, so this is bookkeeping drift: surfaced loudly rather than
    ///         saturated, like `LibEncumbrance.EncumbranceUnderflow`.
    error FallbackCustodyUnderflow(uint256 loanId, uint256 amount, uint256 held);

    /// @notice A move kind was used in the wrong direction: a credit kind
    ///         passed to {debit}, a debit kind to {credit}, or
    ///         `ReturnedToPledge` outside {returnToPledge}. A code defect; the
    ///         event would otherwise mislabel the move.
    error FallbackCustodyMoveMisdirected(uint256 loanId, Move move);

    // --- Reads ------------------------------------------------------------

    /// @notice The loan's fallback custody held in `loan.borrower`'s vault.
    function held(uint256 loanId) internal view returns (uint256) {
        return LibVaipakam.storageSlot().fallbackVaultCustody[loanId];
    }

    /// @notice The fallback snapshot's collateral total: the lender,
    ///         treasury and borrower slices.
    /// @dev    Read it with `active`: a resolved snapshot keeps its fields
    ///         (they are not zeroed on resolution) but describes nothing held.
    function snapshotTotal(uint256 loanId) internal view returns (uint256) {
        LibVaipakam.FallbackSnapshot storage snap =
            LibVaipakam.storageSlot().fallbackSnapshot[loanId];
        return snap.lenderCollateral + snap.treasuryCollateral + snap.borrowerCollateral;
    }

    /// @notice True iff the loan's fallback snapshot is active and its total
    ///         differs from the custody row: its custody rests in the Diamond.
    /// @dev    THE custody discriminator, defined once. Every slice-2 flow
    ///         keeps an active snapshot's total equal to the row at each
    ///         transaction boundary: entry credits exactly the total, a partial
    ///         internal match rescales the snapshot to the row it leaves, and
    ///         every other move ends the episode. A pre-slice-2 row was written
    ///         before the row existed, so it reads `total > 0, row == 0`.
    ///         Why not "row == 0": a partial match can scale a snapshot to
    ///         zero (active, total 0, row 0), which is vault-held and empty,
    ///         not legacy; equality classifies it correctly.
    ///         Evaluate it at a consumer's entry, before anything moves:
    ///         inside a flow (between a debit and the caller's snapshot update)
    ///         the two legitimately differ.
    function isLegacy(uint256 loanId) internal view returns (bool) {
        return
            LibVaipakam.storageSlot().fallbackSnapshot[loanId].active &&
            snapshotTotal(loanId) != held(loanId);
    }

    /// @notice Revert `FallbackCustodyNotVaultHeld` on a legacy row.
    /// @dev    Every consumer calls this first, before it reads a slice or
    ///         mutates the snapshot: a cure or curing repayment deletes the
    ///         snapshot, which is the discriminator's other input, so the check
    ///         cannot be left to a later row move.
    function requireVaultHeld(uint256 loanId) internal view {
        if (isLegacy(loanId)) revert FallbackCustodyNotVaultHeld(loanId);
    }

    // --- Mutators ---------------------------------------------------------

    /// @notice Grow the custody row by `amount` of collateral the caller has
    ///         ALREADY deposited into `loan.borrower`'s vault.
    /// @param move         `Entered` or `RetryRestored`.
    /// @param counterparty The stored borrower whose vault received it.
    function credit(uint256 loanId, uint256 amount, Move move, address counterparty) internal {
        if (move != Move.Entered && move != Move.RetryRestored) {
            revert FallbackCustodyMoveMisdirected(loanId, move);
        }
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        _write(s, loanId, move, counterparty, amount, s.fallbackVaultCustody[loanId] + amount);
    }

    /// @notice Shrink the custody row by `amount`, BEFORE the caller moves
    ///         the tokens (if any) out of `loan.borrower`'s vault.
    /// @dev    Debit first, so the tier exclusion drops before the vault
    ///         balance does: the exclusion never exceeds what the vault holds,
    ///         and no restamp in between can see the stamp dip.
    /// @param move         Any debit kind except `ReturnedToPledge`.
    /// @param counterparty The recipient (see {FallbackCustodyMoved}).
    function debit(uint256 loanId, uint256 amount, Move move, address counterparty) internal {
        if (
            move == Move.Entered ||
            move == Move.RetryRestored ||
            move == Move.ReturnedToPledge
        ) revert FallbackCustodyMoveMisdirected(loanId, move);
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cur = s.fallbackVaultCustody[loanId];
        if (amount > cur) revert FallbackCustodyUnderflow(loanId, amount, cur);
        uint256 custodyAfter;
        unchecked {
            custodyAfter = cur - amount;
        }
        _write(s, loanId, move, counterparty, amount, custodyAfter);
    }

    /// @notice End the episode's custody without moving a token: the whole
    ///         row becomes ordinary pledged collateral of the loan (a cure, a
    ///         curing repayment, or an internal-match full rescue).
    /// @dev    The tokens are already in `loan.borrower`'s vault under the
    ///         loan's lien, so neither the vault nor the lien changes; only the
    ///         label does, recorded as a `ReturnedToPledge` move to the stored
    ///         borrower.
    ///         Notifies even when the row is already empty, because the notify
    ///         is what re-derives the borrower side's tier record once the loan
    ///         has left FallbackPending by an edge that does not re-sync it
    ///         itself (the cure back to Active, a plain `LibLifecycle`
    ///         transition): call this AFTER such an edge, or the record is
    ///         re-derived while the loan still reads FallbackPending and is
    ///         left charged at zero. An edge through
    ///         `EncumbranceMutateFacet.terminalize*` re-syncs on its own.
    ///         Does not check {requireVaultHeld}: by the time it runs a cure
    ///         has deleted the snapshot, so the caller checks on entry.
    /// @return returned The units relabelled (the row before the call).
    function returnToPledge(uint256 loanId) internal returns (uint256 returned) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        returned = s.fallbackVaultCustody[loanId];
        if (returned != 0) {
            _write(s, loanId, Move.ReturnedToPledge, s.loans[loanId].borrower, returned, 0);
        } else {
            // Nothing to relabel, but the status edge still needs the re-derive.
            LibEncumbrance.notifyTierExclusion(loanId, false);
        }
    }

    /// @dev The one write: row, then event, then the tier-exclusion notify
    ///      (the exclusion reads the row, so it re-derives after the write).
    function _write(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        Move move,
        address counterparty,
        uint256 amount,
        uint256 custodyAfter
    ) private {
        s.fallbackVaultCustody[loanId] = custodyAfter;
        emit FallbackCustodyMoved(
            loanId,
            move,
            counterparty,
            s.loans[loanId].collateralAsset,
            amount,
            custodyAfter
        );
        LibEncumbrance.notifyTierExclusion(loanId, false);
    }
}
