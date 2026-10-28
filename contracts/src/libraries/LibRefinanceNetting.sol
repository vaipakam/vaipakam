// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibRefinanceNetting
 * @notice The hand-off between a refinance's accept and its payoff (#3042).
 *
 * @dev    Every refinance completes in the transaction that accepts the
 *         refinance-tagged Borrower offer. The accept's net-principal delivery
 *         (`OfferAcceptFeeFacet.chargeBorrowerLifAndDeliver`) does NOT send the
 *         new lender's net principal to the borrower's wallet on such an accept:
 *         it leaves it in the new lender's vault and PARKS a record of exactly
 *         what it did not deliver. `RefinanceFacet` then TAKES that record and
 *         spends the parked amount on the payoff — old lender first, then the
 *         treasury fee, then any surplus to the borrower — pulling only a
 *         shortfall from the borrower's wallet.
 *
 *         One predicate, {isRefinanceAccept}, decides "this accept is a
 *         refinance" for both the park and the chain into `RefinanceFacet`, so
 *         the two can never disagree: an accept that parks always chains, and a
 *         chain always finds the record its accept parked.
 *
 *         Transient storage (EIP-1153): the record means "undelivered in THIS
 *         transaction". It cannot outlive the transaction, so a revert, or any
 *         path that ends the transaction, can never leave a stale record for a
 *         later one to spend. Keyed by the accepted offer's id, so several
 *         refinance accepts in one transaction each keep their own.
 */
library LibRefinanceNetting {
    /// @dev `keccak256("vaipakam.transient.refinanceNetting") - 1`: base of the
    ///      per-offer transient records, outside every storage layout.
    bytes32 internal constant SLOT =
        bytes32(uint256(keccak256("vaipakam.transient.refinanceNetting")) - 1);

    /// @notice A refinance payoff found no parked net principal for
    ///         `offerId`, or found one for a different lender or asset than the
    ///         replacement loan's.
    error RefinanceNetPrincipalMissing(uint256 offerId);
    /// @notice A second park for `offerId` in one transaction.
    error RefinanceNetPrincipalAlreadyParked(uint256 offerId);

    /// @notice The one rule for "this accept is a refinance": the accepted offer
    ///         is a Borrower offer tagged with the loan it refinances.
    function isRefinanceAccept(LibVaipakam.Offer storage offer)
        internal
        view
        returns (bool)
    {
        return
            offer.refinanceTargetLoanId != 0 &&
            offer.offerType == LibVaipakam.OfferType.Borrower;
    }

    /// @dev Records that `amount` of `asset`, the net principal of the loan
    ///      accepting `offerId`, stayed in `lender`'s vault for the payoff.
    ///      `amount` is never zero (the initiation fee is a fraction of the
    ///      principal), which is what lets {take} tell a record from none.
    function park(
        uint256 offerId,
        address lender,
        address asset,
        uint256 amount
    ) internal {
        bytes32 base = _base(offerId);
        uint256 held;
        assembly ("memory-safe") {
            held := tload(add(base, 2))
        }
        if (held != 0) revert RefinanceNetPrincipalAlreadyParked(offerId);
        assembly ("memory-safe") {
            tstore(base, lender)
            tstore(add(base, 1), asset)
            tstore(add(base, 2), amount)
        }
    }

    /// @dev Returns the amount parked for `offerId` and clears the record.
    ///      Refuses when nothing is parked, or when the parked lender or asset
    ///      is not `lender` / `asset` (the replacement loan's).
    function take(uint256 offerId, address lender, address asset)
        internal
        returns (uint256 amount)
    {
        bytes32 base = _base(offerId);
        address parkedLender;
        address parkedAsset;
        assembly ("memory-safe") {
            parkedLender := tload(base)
            parkedAsset := tload(add(base, 1))
            amount := tload(add(base, 2))
        }
        if (amount == 0 || parkedLender != lender || parkedAsset != asset) {
            revert RefinanceNetPrincipalMissing(offerId);
        }
        assembly ("memory-safe") {
            tstore(base, 0)
            tstore(add(base, 1), 0)
            tstore(add(base, 2), 0)
        }
    }

    /// @dev The first of the three transient words holding `offerId`'s record.
    function _base(uint256 offerId) private pure returns (bytes32) {
        return keccak256(abi.encode(SLOT, offerId));
    }
}
