// src/facets/ClaimViewFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibInterestLedger} from "../libraries/LibInterestLedger.sol";

/**
 * @title ClaimViewFacet
 * @notice The read side of the claim lanes: what each side of a loan may
 *         claim, the borrower's surplus lane, the fallback snapshot, and the
 *         owed-at-default and owed-at-internal-match records.
 * @dev    Split off {ClaimFacet} along its read / write seam when that facet
 *         reached EIP-170. The selectors, return shapes and storage reads are
 *         unchanged; only the runtime bytecode moved. Every function here is a
 *         view, so the two facets need no ordering when refreshed, but a
 *         Diamond refreshed with the new ClaimFacet and without this facet
 *         loses these reads (`FunctionDoesNotExist`), so they move together.
 */
contract ClaimViewFacet {
    /**
     * @notice Returns the claimable ERC-20 amount and claim status for a lender
     *         or borrower side of a loan.
     * @dev Returns (address(0), 0, false) if no claim has been recorded (e.g.
     *      loan still Active). For NFT-asset claims or held-for-lender funds
     *      use {getClaimable} — those cases carry `amount == 0` but are still
     *      claimable.
     * @param loanId The loan ID to query.
     * @param isLender True to query the lender side; false for the borrower side.
     * @return asset The ERC-20 token address claimable.
     * @return amount The claimable amount.
     * @return claimed Whether the funds have already been claimed.
     */
    function getClaimableAmount(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        // #1209 — the lender side reads what the holder is paid: the row less
        // the part the terminal split moves to past sellers.
        amount = isLender ? LibInterestLedger.holderClaimAmount(s, loanId) : claim.amount;
        return (claim.asset, amount, claim.claimed);
    }

    /// @notice Full claim payload for the requested side of a loan — use
    ///         this over `getClaimableAmount` when the claim may be an
    ///         NFT (ERC-721/1155) or when held-for-lender funds exist, as
    ///         those cases carry `amount == 0` but are still claimable.
    /// @dev Treat the claim as actionable when:
    ///         `!claimed && (amount > 0 || assetType != ERC20 ||
    ///                      heldForLender > 0 || hasRentalNftReturn)`
    ///      — mirroring the guards in `claimAsLender` / `claimAsBorrower`.
    ///      On the LENDER side a recorded claim is also actionable at a zero
    ///      `amount` (`asset != address(0)`, #2440): a forced close-out books
    ///      what arrived, so one that received nothing leaves a claim of zero
    ///      that still closes the position.
    function getClaimable(
        uint256 loanId,
        bool isLender
    )
        external
        view
        returns (
            address asset,
            uint256 amount,
            bool claimed,
            LibVaipakam.AssetType assetType,
            uint256 tokenId,
            uint256 quantity,
            uint256 heldForLender,
            bool hasRentalNftReturn
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.ClaimInfo storage claim = isLender
            ? s.lenderClaims[loanId]
            : s.borrowerClaims[loanId];
        asset = claim.asset;
        // #1209 — the lender side reads what the holder is paid: the row less
        // the part the terminal split moves to past sellers.
        amount = isLender ? LibInterestLedger.holderClaimAmount(s, loanId) : claim.amount;
        claimed = claim.claimed;
        assetType = claim.assetType;
        tokenId = claim.tokenId;
        quantity = claim.quantity;
        if (isLender) {
            heldForLender = s.heldForLender[loanId];
            // NFT-asset loans (ERC-721/1155 lent out) entitle the lender to
            // reclaim the NFT at resolution even when no fungible amount
            // was recorded against the claim struct.
            hasRentalNftReturn =
                s.loans[loanId].assetType != LibVaipakam.AssetType.ERC20;
        }
    }

    /// @notice #954 (§2.3) — the borrower-side frozen swap-to-repay principal
    ///         SURPLUS lane for a loan. Distinct from the collateral
    ///         `borrowerClaims` lane surfaced by {getClaimable} /
    ///         {getClaimableAmount}: a `swapToRepayFull` (or Fusion intent fill)
    ///         that closed while the current borrower-NFT holder was sanctioned
    ///         parks the principal surplus in `loan.borrower`'s vault, claimable
    ///         by the delisted holder via `claimAsBorrower`. A claim can owe BOTH
    ///         lanes in different assets, so this is a separate getter rather than
    ///         an overload of the single collateral asset/amount slot.
    /// @dev    Discoverable by the CURRENT holder: resolve the holder's loanIds
    ///         via `MetricsFacet.getUserPositionLoans(holder)` (NFT-owner-indexed)
    ///         and query this per loan; `MetricsFacet.getNFTPositionSummary`
    ///         also carries the surplus lane keyed by the position NFT.
    /// @param loanId The loan to query.
    /// @return asset   Principal asset of the frozen surplus (0x0 if none).
    /// @return amount  Surplus amount recorded (gross of the claimed flag).
    /// @return claimed Whether the surplus has already been claimed out.
    function getBorrowerSurplusClaim(uint256 loanId)
        external
        view
        returns (address asset, uint256 amount, bool claimed)
    {
        LibVaipakam.ClaimInfo storage sc =
            LibVaipakam.storageSlot().borrowerSurplusClaims[loanId];
        return (sc.asset, sc.amount, sc.claimed);
    }

    /// @notice Returns the fallback-path settlement snapshot for a loan.
    /// @dev    Emitted alongside `LiquidationFallback` and persisted to
    ///         `s.fallbackSnapshot[loanId]` whenever a liquid-collateral
    ///         loan falls through to the claim-time settlement path
    ///         (DEX swap reverted or exceeded the 6% slippage ceiling).
    ///         Frontends use this to render the lender / treasury /
    ///         borrower three-way collateral split alongside the
    ///         principal-due figures, without parsing logs. While
    ///         `active == false`, the loan never entered the fallback
    ///         path — the other view return values are zero.
    /// @param loanId Loan to query.
    /// @return lenderCollateral     Collateral units routed to the lender if
    ///                              the claim-time retry fails, capped at the
    ///                              available collateral. Computed by
    ///                              `LibFallback.computeFallbackEntitlements`
    ///                              (no late fee — #2428); a partial internal
    ///                              match after fallback entry scales it.
    /// @return treasuryCollateral   Collateral units routed to treasury
    ///                              (≈2% of principal, or zero if
    ///                              undercollateralized).
    /// @return borrowerCollateral   Remainder back to the borrower.
    /// @return lenderPrincipalDue   Principal-asset amount the lender is
    ///                              owed if the claim-time swap retry
    ///                              succeeds (drives the proceeds split).
    /// @return treasuryPrincipalDue Principal-asset amount routed to
    ///                              treasury when the retry succeeds.
    /// @return active               True iff this loan is in the fallback
    ///                              path (snapshot is meaningful).
    /// @return retryAttempted       True iff `ClaimFacet` already ran the
    ///                              one-shot claim-time retry against this
    ///                              snapshot.
    function getFallbackSnapshot(uint256 loanId)
        external
        view
        returns (
            uint256 lenderCollateral,
            uint256 treasuryCollateral,
            uint256 borrowerCollateral,
            uint256 lenderPrincipalDue,
            uint256 treasuryPrincipalDue,
            bool active,
            bool retryAttempted
        )
    {
        LibVaipakam.FallbackSnapshot storage snap =
            LibVaipakam.storageSlot().fallbackSnapshot[loanId];
        return (
            snap.lenderCollateral,
            snap.treasuryCollateral,
            snap.borrowerCollateral,
            snap.lenderPrincipalDue,
            snap.treasuryPrincipalDue,
            snap.active,
            snap.retryAttempted
        );
    }

    /// @notice #2374 — what `loanId` owed, in its principal asset, at the
    ///         moment it defaulted (left `Active` for `Defaulted` or for the
    ///         full-collateral fallback), as the protocol recorded it then.
    ///         Reported only while the loan STANDS defaulted — `Defaulted` or
    ///         `FallbackPending`; in any other status it reads as no record.
    /// @dev    GROSS debt — principal outstanding, accrued interest net of what
    ///         was already settled, and the late fee — on the basis a
    ///         swap-based forced close settles on. A fallback allocates
    ///         collateral on its own basis (principal plus interest plus a
    ///         lender bonus and a treasury share, no late fee), so for a
    ///         fallback this is the debt, not that allocation. The protocol's
    ///         share of `interest` and `lateFee` is taken before the lender is
    ///         paid, so this is not the lender's entitlement; no fee is taken
    ///         from `principal`. No record (`recordedAt == 0`) for a loan not
    ///         standing defaulted (never defaulted, cured, repaid, closed by an
    ///         internal match, or settled since), a default before this record
    ///         existed, or an NFT rental. The {LibOwedAtDefault} event keeps
    ///         the history.
    /// @return principal   Principal outstanding at default.
    /// @return interest    Accrued interest outstanding at default.
    /// @return lateFee     Late fee owed at default.
    /// @return recordedAt  Timestamp of the default; 0 when not reported.
    /// @return viaFallback True when the default entered the fallback, so its
    ///                     recovery may have arrived in more than one step.
    function getOwedAtDefault(uint256 loanId)
        external
        view
        returns (
            uint256 principal,
            uint256 interest,
            uint256 lateFee,
            uint64 recordedAt,
            bool viaFallback
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.LoanStatus st = s.loans[loanId].status;
        // The record is never cleared; it is meaningful only while the loan
        // still stands defaulted (see {LibOwedAtDefault}).
        if (st != LibVaipakam.LoanStatus.Defaulted && st != LibVaipakam.LoanStatus.FallbackPending) {
            return (0, 0, 0, 0, false);
        }
        LibVaipakam.OwedAtDefault storage o = s.owedAtDefault[loanId];
        return (o.principal, o.interest, o.lateFee, o.recordedAt, o.viaFallback);
    }

    /// @notice #2427 — what internal matching cleared from `loanId`, in its
    ///         principal asset, when a match step closed it from `Active`, and
    ///         what the lender side was paid for it, as the protocol recorded
    ///         them step by step. Reported only while the loan STANDS
    ///         `InternalMatched`.
    /// @dev    A match can clear a loan in several steps; each step adds the
    ///         debt it discharged on the {getOwedAtDefault} basis (principal
    ///         moved, the accrued interest on it now never charged, and the
    ///         late fee on it). `principal + interest + lateFee` is GROSS debt.
    ///         `lenderProceeds` is the moved principal less the matcher
    ///         incentive; interest and late fee are never charged on this path.
    ///         `incomplete` with no figures: the loan was matched while in the
    ///         fallback, or the lender had already been paid in part when the
    ///         first recorded step ran (a step before this record existed, or a
    ///         preclose / offset), so no whole figure exists. Neither set
    ///         (`recordedAt == 0`, `incomplete == false`): no record — the loan
    ///         is not standing `InternalMatched`, it was closed in one step
    ///         before this record existed, or it is an NFT rental.
    /// @return principal      Principal internal matching cleared.
    /// @return interest       Accrued interest on it, never charged.
    /// @return lateFee        Late fee on it, never charged.
    /// @return lenderProceeds What the matches paid the lender side.
    /// @return recordedAt     Timestamp of the closing step; 0 when not reported.
    /// @return incomplete     True when a record exists but is not whole.
    function getOwedAtInternalMatch(uint256 loanId)
        external
        view
        returns (
            uint256 principal,
            uint256 interest,
            uint256 lateFee,
            uint256 lenderProceeds,
            uint64 recordedAt,
            bool incomplete
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // The record is never cleared; it is meaningful only while the loan
        // still stands internally matched (see {LibOwedAtInternalMatch}).
        if (s.loans[loanId].status != LibVaipakam.LoanStatus.InternalMatched) {
            return (0, 0, 0, 0, 0, false);
        }
        LibVaipakam.OwedAtInternalMatch storage o = s.owedAtInternalMatch[loanId];
        if (o.incomplete) return (0, 0, 0, 0, 0, true);
        if (o.recordedAt == 0) return (0, 0, 0, 0, 0, false);
        return (o.principal, o.interest, o.lateFee, o.lenderProceeds, o.recordedAt, false);
    }
}
