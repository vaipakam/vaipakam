// src/libraries/LibInterestLedger.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {SellerClaimFacet} from "../facets/SellerClaimFacet.sol";

/**
 * @title LibInterestLedger
 * @author Vaipakam Developer Team
 * @notice #1808 + #1209 — the ONE book of the interest an ERC-20 loan's lender
 *         side has earned and not yet been paid, and the ONE writer of the two
 *         fields that price it: `loan.principal` and `loan.interestRateBps`.
 *
 * @dev    Per loan there is one record for the CURRENT lender-position holder
 *         ({LibVaipakam.InterestLedger}) and a short list of seller claims
 *         ({LibVaipakam.SellerInterestClaim}), oldest first. The rules
 *         (docs/DesignsAndPlans/LenderSaleSellerInterestClaimDesign.md):
 *
 *         - **Checkpoint** ({touch}): interest from the last checkpoint to now,
 *           priced seconds-precise at the principal and rate in force over that
 *           segment, is added to the holder's earned figure. It runs before
 *           every principal or rate change ({setPrincipal}, {setRate},
 *           {writeOffPrincipal}), at every sale ({recordSale}) and at every
 *           interest payout ({paySellersFirst}). Because principal and rate
 *           change only through this library, each segment is priced on the
 *           terms that were actually in force over it.
 *         - **Payout**: interest the borrower pays towards the lender side pays
 *           the open seller claims first, oldest first, each up to what it is
 *           owed, then the holder ({holderPaid}). A share held fail-closed for
 *           a flagged holder is not paid to them in this sense, so the caller
 *           does not report it and the holder's earned figure keeps it.
 *         - **Sale** ({recordSale}): the seller's earned figure becomes a
 *           seller claim and the buyer starts at zero. At most
 *           {MAX_SELLER_CLAIMS} claims are open per loan.
 *
 *         NFT rentals carry no ledger: a rental position cannot be sold
 *         (`SaleExitVerdictFacet` refuses it on both routes), so nothing here
 *         runs for one. The setters still write the field for any loan.
 *
 *         The seller payouts themselves (vault deposits, the reservation, the
 *         terminal split and the claim) live on {SellerClaimFacet}: this
 *         library is inlined into every facet that changes principal or rate
 *         or pays interest, so it carries only the bookkeeping and one
 *         self-call, made only when a seller claim is open.
 */
library LibInterestLedger {
    /// @notice The most seller claims a loan may carry open at once. Every
    ///         interest payout walks them, so the bound is a gas bound; a
    ///         seller who resold the position to themselves cannot grow it.
    uint256 internal constant MAX_SELLER_CLAIMS = 4;

    /// @notice A sale would open more seller claims than {MAX_SELLER_CLAIMS}.
    ///         It lifts as older claims are paid.
    error SellerClaimsFull(uint256 loanId, uint256 openClaims);

    /// @notice A sale turned the seller's earned interest into a claim.
    /// @param grossAdded The interest this sale moved into the claim.
    /// @param grossOwed  What the claim is owed after this sale (a seller who
    ///                   sells the position again while their own claim is the
    ///                   newest has the two merged).
    /// @param openClaims The number of open claims after this sale.
    /// @custom:event-category state-change/claim-mutation
    event SellerInterestClaimRecorded(
        uint256 indexed loanId,
        address indexed seller,
        uint256 grossAdded,
        uint256 grossOwed,
        uint256 openClaims
    );

    /// @notice One seller's share of an interest payout or a terminal split.
    /// @param seller The seller.
    /// @param gross  The gross interest taken off their claim.
    /// @param net    What they are paid for it, net of the fee.
    struct SellerShare {
        address seller;
        uint256 gross;
        uint256 net;
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    /// @notice Interest earned on `loan` between its last checkpoint and now,
    ///         at its current principal and rate.
    function accruedSinceTouch(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        // Interest accrues to the lender side only while the loan is Active.
        // Past its terminal, what the lender side is owed is its claim row.
        if (loan.status != LibVaipakam.LoanStatus.Active) return 0;
        uint256 from = _touchedAt(s.interestLedger[loan.id], loan);
        if (block.timestamp <= from) return 0;
        return (loan.principal * loan.interestRateBps * (block.timestamp - from))
            / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice What the current holder has earned and not been paid, as of now.
    function holderEarnedNow(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return 0;
        return s.interestLedger[loan.id].holderEarnedGross + accruedSinceTouch(s, loan);
    }

    /// @notice The principal the lender side is owed, which a terminal split
    ///         ranks first. Follows every repayment but not a write-off.
    function principalOwed(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256) {
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        return l.touchedAt == 0 ? loan.principal : l.principalOwed;
    }

    /// @notice Whether a sale by `seller` would find room for its claim: the
    ///         list is below {MAX_SELLER_CLAIMS}, or `seller` holds the newest
    ///         claim (the two merge). The sale verdict reads this.
    function saleClaimRoom(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address seller
    ) internal view returns (bool) {
        LibVaipakam.SellerInterestClaim[] storage claims = s.sellerInterestClaims[loanId];
        uint256 n = claims.length;
        return n < MAX_SELLER_CLAIMS || claims[n - 1].seller == seller;
    }

    /// @notice The gross interest the open seller claims on `loanId` are owed,
    ///         at most `cap`: the part of an interest slice of `cap` that goes
    ///         to past sellers before the holder. The yield-fee discount reads
    ///         it, so a holder's discount never prices a seller's interest.
    function sellersPart(LibVaipakam.Storage storage s, uint256 loanId, uint256 cap)
        internal
        view
        returns (uint256 owed)
    {
        LibVaipakam.SellerInterestClaim[] storage claims = s.sellerInterestClaims[loanId];
        for (uint256 i; i < claims.length && owed < cap; ++i) owed += claims[i].grossOwed;
        if (owed > cap) owed = cap;
    }

    /// @notice Who, if anyone, stops a sale by `seller` from paying out the
    ///         interest parked for a frozen holder: the loan's recorded frozen
    ///         lender-side claimant when that is a different address and the
    ///         position-move gate still blocks it (flagged, or unverifiable
    ///         after a confirmed flag). Parked funds wait on that recorded
    ///         address whoever holds the position, so the sale is refused
    ///         rather than paying them to another wallet. A frozen `seller`
    ///         is not a blocker: the share lands locked in their own vault and
    ///         `claimAsSeller` screens them fail-closed. The sale and the sale
    ///         verdict both read this.
    function parkedSaleBlocker(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address seller
    ) internal view returns (address) {
        if (s.interestLedger[loanId].parkedInterestNet == 0) return address(0);
        address frozen = s.sanctionsLockedLenderClaimant[loanId];
        if (frozen == address(0) || frozen == seller) return address(0);
        return LibVaipakam.positionMovePartyBlocked(frozen) ? frozen : address(0);
    }

    // ─── Checkpoint and the single writer ──────────────────────────────────

    /// @notice Opens the ledger of a loan being originated, at its start time,
    ///         principal and rate. Origination is the one place `loan.principal`
    ///         and `loan.interestRateBps` are written outside this library.
    function open(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        l.touchedAt = loan.startTime;
        l.holderEarnedGross = 0;
        l.principalOwed = loan.principal;
    }

    /// @notice Folds the interest earned since the last checkpoint into the
    ///         holder's earned figure. No-op for a non-ERC-20 loan.
    /// @dev    A ledger that was never opened opens here at the loan's start
    ///         time and current principal. That is exact, not a guess: neither
    ///         field can have changed since origination without passing through
    ///         this library, which checkpoints first.
    function touch(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        if (l.touchedAt == 0) {
            l.touchedAt = loan.startTime;
            l.principalOwed = loan.principal;
        }
        // Only an Active loan accrues. A loan that is not Active keeps its
        // checkpoint, so a fallback cured back to Active still prices the
        // whole stretch since it, as the borrower is charged for it.
        if (loan.status == LibVaipakam.LoanStatus.Active && block.timestamp > l.touchedAt) {
            l.holderEarnedGross += (loan.principal * loan.interestRateBps * (block.timestamp - l.touchedAt))
                / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
            l.touchedAt = uint64(block.timestamp);
        }
    }

    /// @notice Sets `loan.principal`, checkpointing the old principal first and
    ///         moving the owed principal by the same amount.
    function setPrincipal(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 newPrincipal
    ) internal {
        touch(s, loan);
        uint256 old = loan.principal;
        loan.principal = newPrincipal;
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        if (newPrincipal < old) {
            uint256 repaid = old - newPrincipal;
            l.principalOwed = l.principalOwed > repaid ? l.principalOwed - repaid : 0;
        } else {
            l.principalOwed += newPrincipal - old;
        }
    }

    /// @notice Zeroes `loan.principal` for a shortfall written off at a
    ///         terminal. The owed principal is KEPT: it was not repaid, and the
    ///         holder's claim on what the loan recovers ranks it first.
    function writeOffPrincipal(LibVaipakam.Storage storage s, LibVaipakam.Loan storage loan) internal {
        touch(s, loan);
        loan.principal = 0;
    }

    /// @notice Sets `loan.interestRateBps`, checkpointing the old rate first.
    function setRate(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 newRateBps
    ) internal {
        touch(s, loan);
        loan.interestRateBps = newRateBps;
    }

    // ─── Sale ──────────────────────────────────────────────────────────────

    /// @notice Turns `seller`'s earned interest into a seller claim as the
    ///         lender position is sold, and starts the buyer at zero.
    /// @dev    Called from {LibLoan.migrateLenderPosition}, the one place a
    ///         lender position changes hands by sale, so both sale routes record
    ///         the claim the same way. Reverts {SellerClaimsFull} when the list
    ///         has no room; the sale verdict refuses that case earlier.
    function recordSale(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address seller,
        address heldAt
    ) internal {
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
        touch(s, loan);
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        // Interest the borrower already paid but that was parked for a frozen
        // holder is in the held balance, not owed by the loan: the seller is
        // paid it now, out of that balance, instead of carrying it as a claim
        // the buyer's held tokens would otherwise leave unbacked.
        if (l.parkedInterestNet != 0) {
            LibFacet.crossFacetCall(
                abi.encodeCall(SellerClaimFacet.settleParkedInterestAtSale, (loan.id, seller, heldAt)),
                bytes4(0)
            );
        }
        uint256 earned = l.holderEarnedGross;
        if (earned == 0) return;
        l.holderEarnedGross = 0;
        LibVaipakam.SellerInterestClaim[] storage claims = s.sellerInterestClaims[loan.id];
        uint256 n = claims.length;
        uint256 owed;
        if (n > 0 && claims[n - 1].seller == seller) {
            owed = claims[n - 1].grossOwed + earned;
            claims[n - 1].grossOwed = owed;
        } else {
            if (n >= MAX_SELLER_CLAIMS) revert SellerClaimsFull(loan.id, n);
            claims.push(LibVaipakam.SellerInterestClaim({seller: seller, grossOwed: earned}));
            owed = earned;
            ++n;
        }
        emit SellerInterestClaimRecorded(loan.id, seller, earned, owed, n);
    }

    // ─── Payout ────────────────────────────────────────────────────────────

    /// @notice The first step of every interest payout to the lender side of an
    ///         OPEN loan: checkpoints, then pays the open seller claims out of
    ///         the slice before the holder sees any of it.
    /// @param payer    Where the sellers' shares come from: a wallet that
    ///                 approved the Diamond (a partial repayment), or
    ///                 `address(0)` when the slice already sits in the Diamond.
    /// @param asset    The asset the slice is paid in (the principal asset).
    /// @param interestGross The slice's gross interest, before the fee.
    /// @param interestNet   What the lender side receives of it, after the fee.
    /// @return sellersGross The gross interest the sellers' claims took.
    /// @return sellersNet   What reached the sellers' vaults for it; the caller
    ///                      pays the holder that much less.
    function paySellersFirst(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        address payer,
        address asset,
        uint256 interestGross,
        uint256 interestNet
    ) internal returns (uint256 sellersGross, uint256 sellersNet) {
        touch(s, loan);
        if (interestGross == 0 || s.sellerInterestClaims[loan.id].length == 0) return (0, 0);
        (sellersGross, sellersNet) = abi.decode(
            LibFacet.crossFacetCallReturn(
                abi.encodeCall(
                    SellerClaimFacet.paySellersFirst,
                    (loan.id, payer, asset, interestGross, interestNet)
                ),
                bytes4(0)
            ),
            (uint256, uint256)
        );
    }

    /// @notice Records that the current holder was PAID `holderGross` of gross
    ///         interest (the slice less the sellers' part). Call it only when
    ///         the holder actually received it: a share held fail-closed for a
    ///         flagged holder is not reported, so their earned figure keeps it.
    ///         Saturates at zero (a full-term floor can pay more than accrued).
    function holderPaid(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 holderGross
    ) internal {
        if (holderGross == 0 || loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        l.holderEarnedGross = l.holderEarnedGross > holderGross ? l.holderEarnedGross - holderGross : 0;
    }

    /// @notice Records that the current holder's part of an interest slice was
    ///         paid into `heldForLender` rather than to the holder: parked
    ///         because the holder is sanctions-frozen, or credited there by an
    ///         obligation handover. The earned figure keeps it; a sale settles
    ///         it to the seller from the held balance.
    /// @param holderGross The holder's gross part of the slice.
    /// @param holderNet   The holder's net part of the slice.
    /// @param parked      What the held balance received for the holder's part
    ///                    (principal included, so it may exceed `holderNet`).
    /// @param reserved    Whether the held credit sits under the active-held
    ///                    reservation (a frozen park) or not (a handover).
    function holderParked(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 holderGross,
        uint256 holderNet,
        uint256 parked,
        bool reserved
    ) internal {
        if (holderNet == 0 || parked == 0 || loan.assetType != LibVaipakam.AssetType.ERC20) return;
        LibVaipakam.InterestLedger storage l = s.interestLedger[loan.id];
        // A short arrival (a token that charges on transfer) parks less; the
        // interest counts first, at the slice's own net-to-gross proportion.
        uint256 net = holderNet < parked ? holderNet : parked;
        l.parkedInterestNet += net;
        l.parkedInterestGross += (holderGross * net) / holderNet;
        if (reserved) l.parkedInterestReservedNet += net;
    }

    /// @notice Takes an interest slice off the open seller claims, oldest
    ///         first, each up to what it is owed, and returns each seller's
    ///         share. Each net is the gross taken less the loan's own yield fee
    ///         (`effectiveTreasuryFeeBps`, the rate the terminal split nets a
    ///         claim at), never more than the slice still has: the holder's
    ///         yield-fee discount is the holder's, so it neither lowers nor
    ///         raises a seller's fee ({LibVPFIDiscount.resolveLenderYieldFeeFor}
    ///         prices it on the holder's part only). Fully paid claims leave the
    ///         list.
    /// @dev    Bookkeeping only; {SellerClaimFacet} moves the funds. `shares`
    ///         has one entry per claim that was open; an entry the slice did
    ///         not reach is left empty (zero seller and amounts).
    function takeForSellers(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        uint256 interestGross,
        uint256 interestNet
    ) internal returns (SellerShare[] memory shares, uint256 sellersGross, uint256 sellersNet) {
        LibVaipakam.SellerInterestClaim[] storage claims = s.sellerInterestClaims[loanId];
        uint256 n = claims.length;
        shares = new SellerShare[](n);
        uint256 remaining = interestGross;
        uint256 netLeft = interestNet;
        uint256 keepBps = LibVaipakam.BASIS_POINTS - LibVaipakam.effectiveTreasuryFeeBps(s.loans[loanId]);
        uint256 paidOff;
        for (uint256 i; i < n && remaining > 0; ++i) {
            uint256 owed = claims[i].grossOwed;
            uint256 take = owed < remaining ? owed : remaining;
            remaining -= take;
            uint256 net = (take * keepBps) / LibVaipakam.BASIS_POINTS;
            if (net > netLeft) net = netLeft;
            netLeft -= net;
            shares[i] = SellerShare({seller: claims[i].seller, gross: take, net: net});
            sellersGross += take;
            sellersNet += net;
            if (take == owed) {
                ++paidOff;
            } else {
                claims[i].grossOwed = owed - take;
            }
        }
        _dropPaid(claims, paidOff);
    }

    /// @notice Closes every open seller claim, returning them (oldest first)
    ///         for a terminal split.
    function closeAll(LibVaipakam.Storage storage s, uint256 loanId)
        internal
        returns (LibVaipakam.SellerInterestClaim[] memory closed)
    {
        closed = s.sellerInterestClaims[loanId];
        delete s.sellerInterestClaims[loanId];
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    function _touchedAt(LibVaipakam.InterestLedger storage l, LibVaipakam.Loan storage loan)
        private
        view
        returns (uint256)
    {
        return l.touchedAt == 0 ? uint256(loan.startTime) : uint256(l.touchedAt);
    }

    /// @dev Removes the first `k` claims (the fully paid prefix), keeping order.
    function _dropPaid(LibVaipakam.SellerInterestClaim[] storage claims, uint256 k) private {
        if (k == 0) return;
        uint256 n = claims.length;
        for (uint256 i = k; i < n; ++i) {
            claims[i - k] = claims[i];
        }
        for (uint256 i; i < k; ++i) {
            claims.pop();
        }
    }
}
