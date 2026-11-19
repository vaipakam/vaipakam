// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title  ILenderSideHost
/// @notice #3760 — the `address(this)`-gated entries of `LenderSideFacet`
///         that `LibLenderSide` and the takers of the lender-side stores
///         self-call, declared apart so the inlined library needs no import of
///         the facet (the `ISettlementLegHost` precedent).
interface ILenderSideHost {
    /// @notice Book an open-loan arrival of `amount` of `asset` for `loanId`'s
    ///         lender position against its open advance.
    /// @return part What the advance took (set aside under its lien).
    function bookArrival(uint256 loanId, address asset, uint256 amount) external returns (uint256 part);

    /// @notice The final lender claim of `loanId` is now `amount` in all.
    ///         `inKind`: the fallback's in-kind slice after the one retry.
    /// @return kept The holder's part the row now names.
    function bookFinal(uint256 loanId, uint256 amount, bool inKind) external returns (uint256 kept);

    /// @notice A taker is about to take from `loanId`'s lender-side stores.
    ///         `loanEnded`: the final claim is being consumed, so whatever the
    ///         advance is still owed is its shortfall. Then pays what is set
    ///         aside to the slot owner when that can be done now (a flagged
    ///         slot owner's part stays set aside for it).
    function settleAtTake(uint256 loanId, bool loanEnded) external;

    /// @notice A backstop absorb pays `amount` of the lending asset for
    ///         `loanId`'s lender slice from `fromOwner`'s vault: the advance's
    ///         part goes into the stored lender's vault, set aside for the slot
    ///         owner.
    /// @return part What went to the advance; the caller pays the holder the
    ///         rest.
    function absorbArrival(uint256 loanId, address fromOwner, uint256 amount) external returns (uint256 part);
}
