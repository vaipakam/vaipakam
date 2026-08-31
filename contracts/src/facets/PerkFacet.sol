// src/facets/PerkFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVpfiRecycle} from "../libraries/LibVpfiRecycle.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";

/**
 * @title  PerkFacet
 * @notice #1204 (E-2, plan §M6) — the SPEND-GATED perk channel: a user buys a
 *         consumable perk entitlement with VPFI from their own vault, and the
 *         spend credits the recycle bucket as genuine absorption.
 *
 * @dev    WHAT THIS FACET DELIBERATELY DOES NOT DO.
 *
 *         It sells entitlements; it does not decide what a perk MEANS. The
 *         design note's open decisions — which perks ship, at what price, and
 *         whether the listing-visibility boost ships at all — are the owner's,
 *         and this facet is built so that they stay CONFIGURATION rather than
 *         code:
 *
 *          - a perk with no configured price cannot be bought at all, and zero
 *            is the deploy default, so the whole channel ships DARK and each
 *            perk is armed individually;
 *          - the entitlement is a plain per-user record (an expiry, or a
 *            credit count), so a consumer facet reads it when — and only
 *            when — that perk's own behaviour is decided and built.
 *
 *         That split is what lets the absorption channel land now without
 *         pre-empting a product decision. It also matches the plan's framing:
 *         §M6 counts perks complete when the spend "charges VPFI → credit(…)",
 *         which is this file; the per-perk EFFECT rides its own card.
 *
 *         ABSORPTION CLASS. Perk spend is fresh-from-user value that has never
 *         been counted on any chain, so it credits through
 *         {LibVpfiRecycle.credit} with the appended `SpendGatedPerk` source —
 *         NOT `creditCustodyRelocated`, which exists for value already
 *         Ā-counted elsewhere and deliberately skips the day feed.
 *
 *         ORDERING. Pull → rollup → credit, the sequence
 *         `LibNotificationFee.bill` and `LibFeeEntitlement.resolveAndCharge`
 *         both follow: the withdraw must land the tokens on the Diamond
 *         BEFORE `credit()`, whose backing check reverts otherwise, and the
 *         discount accumulator must be re-stamped at the POST-mutation
 *         balance or the payer keeps a stale tier (#973 / L26).
 *
 *         NO REFUNDS, deliberately. A purchase is a consumable fee-for-service
 *         — the legal shape the design note is built around. Refundability is
 *         what makes a deposit, and a deposit is the service-bond shape
 *         (#1219), which is a different instrument on a different card.
 */
contract PerkFacet is
    DiamondPausable,
    DiamondAccessControl,
    DiamondReentrancyGuard,
    IVaipakamErrors
{
    /// @notice Emitted once per purchase. The recycle credit itself is
    ///         observable on `VpfiRecycled` with the same `perkId` as its
    ///         reference; this event carries what that one cannot — who
    ///         bought, and what they now hold.
    event PerkPurchased(
        address indexed buyer,
        uint256 indexed perkId,
        uint256 units,
        uint256 vpfiSpent,
        uint64 entitledUntil,
        uint256 creditsAfter
    );

    /// @notice Emitted when governance arms, re-prices or disarms a perk.
    ///         `priceVpfi == 0` means the perk is not for sale.
    event PerkConfigured(
        uint256 indexed perkId,
        uint256 priceVpfi,
        uint32 durationSeconds
    );

    /// @notice Emitted when a consumer facet spends one counted unit.
    event PerkCreditConsumed(
        address indexed user,
        uint256 indexed perkId,
        uint256 creditsAfter
    );

    /// @notice The perk has no configured price, so it is not for sale.
    ///         Distinct from a priced perk the buyer cannot afford — this one
    ///         is a governance state, not a user state.
    error PerkNotForSale(uint256 perkId);

    /// @notice `units` was zero. A no-op purchase would emit a receipt for
    ///         nothing and credit nothing; refusing is clearer than silence.
    error PerkUnitsZero();

    /// @notice The caller holds no unspent counted units of this perk.
    error PerkNoCreditsHeld(address user, uint256 perkId);

    /// @notice The perk cost more than the buyer agreed to pay. Governance can
    ///         re-price between a purchase being signed and mined, so the
    ///         buyer states a ceiling and the charge is bound by it.
    error PerkPriceExceedsMax(uint256 spend, uint256 maxTotalVpfi);

    /// @notice The perk no longer grants what the buyer agreed to buy. Bound
    ///         EXACTLY, in both directions: a lengthened entitlement is still
    ///         not the one that was signed for, and refusing is honest where
    ///         silently substituting terms is not.
    error PerkTermsChanged(uint32 expected, uint32 actual);

    /// @notice The perk has sold at least one unit, so its mode is frozen.
    ///         Price may still change; duration may not. See `perkUnitsSold`.
    error PerkModeLocked(uint256 perkId);

    /// @notice Arms, re-prices, or disarms one perk.
    /// @param  perkId          Opaque identifier, agreed with the consumer.
    /// @param  priceVpfi       VPFI wei per unit. ZERO DISARMS the perk —
    ///                         existing entitlements are untouched, but no
    ///                         further units can be bought.
    /// @param  durationSeconds Seconds of entitlement one unit grants. Zero
    ///                         makes the perk a COUNTED consumable instead,
    ///                         redeemed through {consumePerkCredit}. FROZEN
    ///                         once the perk has sold a unit — see
    ///                         {PerkModeLocked}.
    /// @dev    NOT `whenNotPaused`, deliberately. Disarming a perk is a
    ///         containment action, and a pause is when you most need it: the
    ///         purchase path below IS paused, so this setter cannot arm a
    ///         channel that a pause has closed, only shut one that is open.
    ///         Gating it behind the pause would take the lever away at
    ///         exactly the moment it is wanted.
    function setPerkConfig(
        uint256 perkId,
        uint256 priceVpfi,
        uint32 durationSeconds
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // The mode is frozen once anything has been sold. Entitlements are
        // per-user records that no setter can walk, so flipping a timed perk
        // to a counted one would strand every holder on a basis the perk no
        // longer reads — and flipping back would resurrect expiries that were
        // meant to be gone. Re-pricing and disarming stay available.
        if (
            s.perkUnitsSold[perkId] != 0
                && s.perkDurationSeconds[perkId] != durationSeconds
        ) {
            revert PerkModeLocked(perkId);
        }
        s.perkPriceVpfi[perkId] = priceVpfi;
        s.perkDurationSeconds[perkId] = durationSeconds;
        emit PerkConfigured(perkId, priceVpfi, durationSeconds);
    }

    /// @notice Buys `units` of `perkId`, paying from the caller's own vault.
    /// @param  perkId                  Perk to buy.
    /// @param  units                   How many units.
    /// @param  maxTotalVpfi            Ceiling on the TOTAL charge, in VPFI
    ///                                 wei. The buyer's own number, not a
    ///                                 quote read back from the chain.
    /// @param  expectedDurationSeconds The duration the buyer is buying, bound
    ///                                 exactly. Zero means "a counted perk".
    /// @dev    Sanctions-gated as a Tier-1 state-creating entry point: this
    ///         creates an entitlement and moves funds, which is exactly the
    ///         class `_assertNotSanctioned` covers.
    ///
    ///         BOTH TERMS ARE BOUND because governance can re-price and
    ///         re-shape a perk while a purchase sits in the mempool, and the
    ///         two failure modes differ: a price rise over-debits a buyer who
    ///         agreed to less, while a duration change hands them something
    ///         other than what they agreed to buy. Passing the terms in makes
    ///         the transaction self-describing — what the buyer signed is on
    ///         the wire, so neither substitution can pass silently.
    function purchasePerk(
        uint256 perkId,
        uint256 units,
        uint256 maxTotalVpfi,
        uint32 expectedDurationSeconds
    ) external nonReentrant whenNotPaused {
        LibVaipakam._assertNotSanctioned(msg.sender);
        if (units == 0) revert PerkUnitsZero();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 price = s.perkPriceVpfi[perkId];
        if (price == 0) revert PerkNotForSale(perkId);

        uint32 dur = s.perkDurationSeconds[perkId];
        if (dur != expectedDurationSeconds) {
            revert PerkTermsChanged(expectedDurationSeconds, dur);
        }

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) revert PerkVpfiTokenNotSet();

        uint256 spend = price * units;
        if (spend > maxTotalVpfi) {
            revert PerkPriceExceedsMax(spend, maxTotalVpfi);
        }

        // 1. Pull the spend into Diamond custody. Reverts if the buyer has no
        //    vault or too little VPFI — the same failure surface the
        //    notification tariff presents, and for the same reason.
        VaultFactoryFacet(address(this)).vaultWithdrawERC20(
            msg.sender,
            vpfi,
            address(this),
            spend
        );

        // 2. Re-stamp the payer's time-weighted discount accumulator at the
        //    POST-mutation tracked balance. Spending VPFI lowers the buyer's
        //    hold tier, and the accumulator has to learn that at the moment it
        //    happens or the buyer keeps a tier they no longer hold (#973/L26).
        LibVPFIDiscount.rollupUserDiscount(
            msg.sender,
            s.protocolTrackedVaultBalance[msg.sender][vpfi]
        );

        // 3. Credit the bucket now the tokens are on the Diamond.
        LibVpfiRecycle.credit(
            LibVpfiRecycle.RecycleSource.SpendGatedPerk,
            perkId,
            spend
        );
        s.perkSpendCumulative += spend;
        // Records the sale, which FREEZES this perk's mode from here on.
        s.perkUnitsSold[perkId] += units;

        // 4. Grant the entitlement. A timed perk EXTENDS from whichever is
        //    later — now, or the buyer's existing expiry — so buying early
        //    stacks rather than burning the unused remainder.
        uint64 until = s.perkEntitlementUntil[msg.sender][perkId];
        uint256 creditsAfter = s.perkCredits[msg.sender][perkId];
        if (dur == 0) {
            creditsAfter += units;
            s.perkCredits[msg.sender][perkId] = creditsAfter;
        } else {
            uint256 from = until > block.timestamp ? until : block.timestamp;
            uint256 end = from + uint256(dur) * units;
            // SATURATE rather than truncate. The arithmetic above is checked,
            // but the cast is not: a large enough `units` would wrap a far
            // future expiry into a near one and silently sell the buyer LESS
            // than they paid for. Saturating is the honest direction — a
            // uint64 second is past the year 500 billion, so the clamp is
            // unreachable in practice and exists so the failure mode is not
            // silent if it ever is reached.
            until = end > type(uint64).max ? type(uint64).max : uint64(end);
            s.perkEntitlementUntil[msg.sender][perkId] = until;
        }

        emit PerkPurchased(msg.sender, perkId, units, spend, until, creditsAfter);
    }

    /// @notice Spends one counted unit of `perkId` held by `user`.
    /// @dev    `address(this)`-gated: a perk is redeemed by the facet that
    ///         DELIVERS it, on the user's behalf, through a cross-facet call.
    ///         Leaving this open would let anyone burn another user's credits.
    function consumePerkCredit(address user, uint256 perkId) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 held = s.perkCredits[user][perkId];
        if (held == 0) revert PerkNoCreditsHeld(user, perkId);
        unchecked {
            held -= 1;
        }
        s.perkCredits[user][perkId] = held;
        emit PerkCreditConsumed(user, perkId, held);
    }

    /// @notice Price and duration of one perk. `priceVpfi == 0` ⇒ not for sale.
    /// @return priceVpfi       VPFI wei per unit.
    /// @return durationSeconds Seconds one unit grants; zero ⇒ counted perk.
    /// @return unitsSold       Units ever sold. Non-zero ⇒ the mode is frozen,
    ///                         so an operator can see before calling whether
    ///                         {setPerkConfig} will accept a duration change.
    function getPerkConfig(uint256 perkId)
        external
        view
        returns (uint256 priceVpfi, uint32 durationSeconds, uint256 unitsSold)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (
            s.perkPriceVpfi[perkId],
            s.perkDurationSeconds[perkId],
            s.perkUnitsSold[perkId]
        );
    }

    /// @notice Whether `user` currently holds `perkId`, and on what basis.
    /// @return active      True if a timed entitlement has not lapsed, or the
    ///                     user holds at least one counted unit.
    /// @return until       Expiry of the timed entitlement (0 if counted).
    /// @return credits     Unspent counted units (0 if timed).
    function getPerkEntitlement(address user, uint256 perkId)
        external
        view
        returns (bool active, uint64 until, uint256 credits)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        until = s.perkEntitlementUntil[user][perkId];
        credits = s.perkCredits[user][perkId];
        active = until > block.timestamp || credits != 0;
    }

    /// @notice Lifetime VPFI absorbed through perk purchases on this chain.
    function getPerkSpendCumulative() external view returns (uint256) {
        return LibVaipakam.storageSlot().perkSpendCumulative;
    }
}
