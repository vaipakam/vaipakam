// src/seaport/IVaipakamPrepayCallbacks.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVaipakamPrepayCallbacks
 * @notice Minimal interface the `CollateralListingExecutor` calls back
 *         into the Vaipakam diamond with at Seaport fill time. The
 *         diamond hosts the implementation on a privileged facet method
 *         that asserts `msg.sender == collateralListingExecutor` before
 *         touching loan state.
 *
 * @dev   T-086 step 5 partitions the executor↔diamond responsibility
 *         this way:
 *           - Executor verifies the Seaport order satisfies the live
 *             floor + recipient invariants at fill time (so a paused
 *             diamond can't accept a stale-signature theft).
 *           - Diamond owns `loans[loanId].status` mutation,
 *             `LibERC721._unlock(borrowerNftId)` invocation, and the
 *             load-bearing `LibVPFIDiscount.settleBorrowerLifProper`
 *             call — anything that touches diamond storage stays in
 *             the diamond.
 *
 *         The diamond-side method is added in step 5 alongside this
 *         executor; step 6 wires the borrower-facing entry points
 *         (`postPrepayListing` etc) that PRODUCE the orders the
 *         executor later signs + finalizes.
 */
interface IVaipakamPrepayCallbacks {
    /// @notice Finalize a Seaport prepay-listing fill. Marks the loan
    ///         Settled, unlocks the borrower NFT, and calls
    ///         `LibVPFIDiscount.settleBorrowerLifProper` so the
    ///         borrower's VPFI rebate (Phase-5 LIF) accrues correctly
    ///         on this proper-close path.
    /// @dev    The diamond's implementation MUST assert:
    ///           - `msg.sender == collateralListingExecutor` (the
    ///             diamond's stored executor address — only this
    ///             singleton can finalize).
    ///           - `loan.status == LoanStatus.Active` (re-validates
    ///             the executor's own check; defense-in-depth).
    ///         and then atomically:
    ///           - `loan.status = LoanStatus.Settled` via LibLifecycle.
    ///           - `LibERC721._unlock(loan.borrowerTokenId)`.
    ///           - `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
    function executorFinalizePrepaySale(uint256 loanId) external;

    // ─── T-086 Round-8 (#358) — offer-keyed callbacks ──────────────────
    //
    // §19.7 introduces three new callbacks for the no-loan branch's
    // pre-loan sale-fill terminal. All three share the SAME caller-gate
    // shape (round-3.2 against Codex round-3.2 P1 #4 line 4803 +
    // round-3.4 widening per Codex round-3.2 P2 line 4838):
    //
    //   `msg.sender == s.offerPrepayListingExecutor[offerId]`
    //   revert `NotOfferExecutor(offerId, msg.sender)` otherwise
    //
    // Note the gate keys by OFFER (not by global executor singleton)
    // because Round-8's per-offer parallel-sale architecture pins an
    // executor per offer at offer-create time. A governance rotation
    // of the global `s.collateralListingExecutor` between offer-create
    // and pre-loan fill MUST NOT authorize a different executor to
    // call these methods against an already-recorded offer; the
    // per-offer pin closes that gap.

    /// @notice T-086 Round-8 (#358) §19.4 Scenario A — marks
    ///         `s.offerConsumedBySale[offerId] = true` (the no-loan-
    ///         sale terminal bit, mirror of `s.offerCancelled`).
    ///         Distinct from `OfferCancelFacet.cancelOffer` because
    ///         the cancel-refund path attempts to withdraw the
    ///         collateral NFT back to the borrower, which would
    ///         either revert or double-withdraw after the Seaport
    ///         buyer already received the NFT.
    /// @dev    Round-3.2 against Codex round-3.2 P1 #2 line 4802 —
    ///         the terminal IS the parallel mapping (NOT a phantom
    ///         `OfferStatus.ConsumedBySale` enum value; the current
    ///         `Offer` storage model has no `status` field, see
    ///         `LibVaipakam.sol:1173`).
    function markOfferConsumedBySale(uint96 offerId) external;

    /// @notice T-086 Round-8 (#358) §19.4 Scenario A — credits the
    ///         pre-loan sale proceeds to the borrower's vault
    ///         protocol-tracked balance. Round-3.1 against Codex
    ///         round-3 P1 #1 line 4390: the pre-loan branch routes
    ///         `consideration[0]` to `address(diamond)` (not directly
    ///         to the vault), so the diamond's callback runs the
    ///         credit afterwards via `LibVaipakam.recordVaultDeposit`
    ///         (= the existing protocol-tracked balance accountant
    ///         used by `vaultDepositERC20` / `vaultDepositERC20From`).
    ///         This makes the proceeds withdrawable through the
    ///         standard `vaultWithdrawERC20` path; routing directly
    ///         to the vault contract balance would have stranded
    ///         them outside the borrower's withdrawable balance.
    /// @param  offerId        Offer being settled.
    /// @param  principalAsset Asset of `consideration[0]` (matches
    ///                        the lending-asset constraint pinned at
    ///                        sign-time on `OfferContext.principalAsset`).
    /// @param  amount         Net proceeds amount (the consideration
    ///                        leg's value, after Seaport's own
    ///                        fee-leg routing has split out any
    ///                        OpenSea / creator legs).
    function recordOfferSaleProceeds(
        uint96 offerId,
        address principalAsset,
        uint256 amount
    ) external;

    /// @notice T-086 Round-8 (#358) §19.4 Scenario A — diamond-hosted
    ///         live sanctions recheck during pre-loan fill. Round-3
    ///         against Raja P1 #3 + Codex round-2 P1 #4 — the executor
    ///         CANNOT call `LibVaipakam._assertNotSanctioned` directly
    ///         because `LibVaipakam.storageSlot()` keys by
    ///         `address(this)`, so an executor-context call would read
    ///         the EXECUTOR's storage slot (which has no sanctions
    ///         oracle configured), silently failing open. This callback
    ///         runs inside the diamond's storage slot so the oracle
    ///         lookup hits the diamond-configured address.
    /// @dev    Reverts `SanctionedAddress(borrowerWallet)` if the
    ///         oracle flags the wallet. Otherwise no-op (no state
    ///         mutation; pure precondition check).
    ///
    ///         Round-3.4 against Codex round-3.2 P2 line 4838 —
    ///         widened with `offerId` arg (the round-3.2 signature
    ///         `assertOfferFillNotSanctioned(address)` made the
    ///         executor-gate read impossible because the gate needs
    ///         the offerId to resolve which executor slot to read).
    function assertOfferFillNotSanctioned(uint96 offerId, address borrowerWallet) external;
}
