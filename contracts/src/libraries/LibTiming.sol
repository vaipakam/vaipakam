// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibTiming
 * @notice #3412 / #3443 — the one timing rule every user action and every
 *         fill passes through, with two bounds:
 *
 *         - **Valid until.** The deadline the user put on the call (or
 *           signed into its terms). A transaction that waited in a queue and
 *           lands after it is refused, so it can never execute on terms the
 *           user no longer wants. Required for price-exposed actions, optional
 *           for rescues. The deadline second itself is still valid (the rule
 *           every existing deadline in the protocol used): refused only when
 *           `block.timestamp > validUntil`.
 *         - **Not before.** The terms being filled were set at least
 *           {minTermsAgeSec} seconds earlier: an on-chain offer's
 *           `termsSetAt`, refreshed on every change of its terms, or a lender
 *           intent's. The minimum is at least one second, so a fill always
 *           lands in a later block than the one that set the terms, on every
 *           chain. That stops creating (or re-pricing) an offer and filling it
 *           in one transaction or one block. Measured in time, never block
 *           numbers: block times differ by chain, and Arbitrum's
 *           `block.number` is the L1 block.
 *
 * @dev    A `termsSetAt` of 0 carries no age: it marks terms that were never
 *         set on-chain ahead of the fill — a signed off-chain offer turned
 *         into an on-chain offer at the moment it is filled. Those are bound
 *         by the signature (its own deadline, and the taker's signed terms)
 *         rather than by an on-chain age.
 */
library LibTiming {
    /// @notice The default minimum age of an offer's terms at fill, used
    ///         while the admin has set none.
    uint32 internal constant DEFAULT_MIN_TERMS_AGE_SEC = 5;
    /// @notice The setter's floor: one second guarantees a later block on
    ///         every chain, so no block number needs storing.
    uint32 internal constant MIN_TERMS_AGE_SEC_MIN = 1;
    /// @notice The setter's ceiling: a longer age would make every fresh
    ///         offer wait for no further protection.
    uint32 internal constant MIN_TERMS_AGE_SEC_MAX = 60;

    /// @notice The call's deadline has passed.
    error DeadlinePassed(uint256 validUntil);
    /// @notice This action needs a deadline and was given none (0).
    error DeadlineRequired();
    /// @notice The offer's terms were set too recently to fill: it can be
    ///         filled from `readyAt` (unix seconds).
    error OfferTermsTooFresh(uint256 offerId, uint256 readyAt);
    /// @notice The lender intent's terms were set too recently to fill: it can
    ///         be filled from `readyAt` (unix seconds).
    error IntentTermsTooFresh(address lender, uint256 readyAt);

    /// @notice Refuses a missing or passed deadline. For price-exposed
    ///         actions, where the deadline is required.
    function requireDeadline(uint256 validUntil) internal view {
        if (validUntil == 0) revert DeadlineRequired();
        if (block.timestamp > validUntil) revert DeadlinePassed(validUntil);
    }

    /// @notice Refuses a passed deadline; 0 means the caller set none. For
    ///         rescue actions, where a late landing does no harm.
    function checkDeadline(uint256 validUntil) internal view {
        if (validUntil != 0 && block.timestamp > validUntil) {
            revert DeadlinePassed(validUntil);
        }
    }

    /// @notice The minimum age of terms at fill, in seconds: the admin's
    ///         setting, or {DEFAULT_MIN_TERMS_AGE_SEC} while none is set.
    function minTermsAgeSec() internal view returns (uint256) {
        uint32 v = LibVaipakam.storageSlot().cfgMinTermsAgeSec;
        return v == 0 ? DEFAULT_MIN_TERMS_AGE_SEC : v;
    }

    /// @notice The moment terms set at `termsSetAt` become fillable; 0 for
    ///         terms that carry no age (see the library note).
    function termsReadyAt(uint64 termsSetAt) internal view returns (uint256) {
        if (termsSetAt == 0) return 0;
        return uint256(termsSetAt) + minTermsAgeSec();
    }

    /// @notice True when terms set at `termsSetAt` may be filled now.
    function termsAged(uint64 termsSetAt) internal view returns (bool) {
        return block.timestamp >= termsReadyAt(termsSetAt);
    }

    /// @notice Refuses a fill of offer `offerId` whose terms are too fresh.
    function requireOfferAged(uint256 offerId, LibVaipakam.Offer storage offer) internal view {
        uint256 readyAt = termsReadyAt(offer.termsSetAt);
        if (block.timestamp < readyAt) revert OfferTermsTooFresh(offerId, readyAt);
    }

    /// @notice Refuses a fill of `lender`'s intent whose terms (set at
    ///         `termsSetAt`) are too fresh.
    function requireIntentAged(address lender, uint64 termsSetAt) internal view {
        uint256 readyAt = termsReadyAt(termsSetAt);
        if (block.timestamp < readyAt) revert IntentTermsTooFresh(lender, readyAt);
    }

    /// @notice Records that `offer`'s terms were set now. Every write of an
    ///         offer's terms calls this: creation and every edit.
    function stampOfferTerms(LibVaipakam.Offer storage offer) internal {
        offer.termsSetAt = uint64(block.timestamp);
    }
}
