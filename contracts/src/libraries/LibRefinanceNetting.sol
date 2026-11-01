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
 *         moves the whole parked amount to the old lender's vault. The
 *         borrower's wallet pays the rest of the old lender's due and the
 *         whole treasury fee. A parked amount above the old lender's due is
 *         refused rather than paid anywhere: a refinance request never asks
 *         for more than the old loan's outstanding principal, so it cannot
 *         arise.
 *
 *         Parked funds are COMMITTED, not free. Between the park and the take,
 *         the accept still runs code that reads the new lender's free balance
 *         (the per-party Full VPFI tariff, when VPFI is the lending asset), and
 *         a free-balance read that counted the parked amount would let that
 *         code spend money already promised to the old lender. So the park
 *         also keeps a per-(owner, asset) total, {parkedOf}, which
 *         `LibEncumbrance.freeBalance` subtracts alongside the owner's liens:
 *         every free-balance reader and the vault withdraw guard see the
 *         parked amount as held. The take clears that total before it moves
 *         the funds, so the payoff's own withdrawal passes the guard.
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

    /// @dev `keccak256("vaipakam.transient.refinanceNetting.owner") - 1`: base of
    ///      the per-(owner, asset) parked totals read by {parkedOf}.
    bytes32 internal constant OWNER_SLOT =
        bytes32(uint256(keccak256("vaipakam.transient.refinanceNetting.owner")) - 1);

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
        bytes32 ownerKey = _ownerKey(lender, asset);
        assembly ("memory-safe") {
            tstore(base, lender)
            tstore(add(base, 1), asset)
            tstore(add(base, 2), amount)
            tstore(ownerKey, add(tload(ownerKey), amount))
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
        // The owner total holds at least `amount`: {park} added it and only
        // this take, for this record, removes it.
        bytes32 ownerKey = _ownerKey(lender, asset);
        assembly ("memory-safe") {
            tstore(base, 0)
            tstore(add(base, 1), 0)
            tstore(add(base, 2), 0)
            tstore(ownerKey, sub(tload(ownerKey), amount))
        }
    }

    /// @notice How much of `owner`'s `asset` is parked for a refinance payoff
    ///         in this transaction: committed to an old lender and therefore
    ///         not free. Zero outside a refinance accept.
    function parkedOf(address owner, address asset)
        internal
        view
        returns (uint256 amount)
    {
        bytes32 ownerKey = _ownerKey(owner, asset);
        assembly ("memory-safe") {
            amount := tload(ownerKey)
        }
    }

    /// @dev The first of the three transient words holding `offerId`'s record.
    function _base(uint256 offerId) private pure returns (bytes32) {
        return keccak256(abi.encode(SLOT, offerId));
    }

    /// @dev The transient word holding `owner`'s parked total in `asset`.
    function _ownerKey(address owner, address asset) private pure returns (bytes32) {
        return keccak256(abi.encode(OWNER_SLOT, owner, asset));
    }
}
