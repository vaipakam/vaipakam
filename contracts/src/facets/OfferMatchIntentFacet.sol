// src/facets/OfferMatchIntentFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAuth} from "../libraries/LibAuth.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibOfferMatchExecute} from "../libraries/LibOfferMatchExecute.sol";
import {OfferMatchFacet} from "./OfferMatchFacet.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibPriorityRouting} from "../libraries/LibPriorityRouting.sol";
import {LibIntentFill} from "../libraries/LibIntentFill.sol";

/**
 * @title  OfferMatchIntentFacet
 * @author Vaipakam Developer Team
 * @notice #393 v1-b — the standing-intent fill: a solver (directly, through an
 *         aggregator adapter, or through the backstop vault) fills a lender's
 *         STANDING INTENT against an on-chain borrower offer, materializing the
 *         lender slice and initiating the loan through the shared match core.
 * @dev    #1219 (S-4) — split out of `OfferMatchFacet`, which sat 293 B under
 *         the EIP-170 ceiling when the capacity gates arrived (less than one
 *         cross-facet call), so the three fill gates could not inline there.
 *         This entry is the one the capacity design names for the solver,
 *         backstop and adapter routes, so it is the clean host for its gate.
 *         The execution core runs through `OfferMatchFacet.matchCoreInternal`
 *         (#3635 A: inlined here it put this facet over EIP-170 once the rate
 *         link joined the core), with the solver named as the matcher, so the
 *         match share still goes to `msg.sender` (the solver / LIF recipient). Same storage, same Diamond, same selector: callers change
 *         nothing. The testnets route `matchIntent` to the old host until their
 *         refresh replaces it onto this facet (`RefreshAllFacetsInPlace` cuts it
 *         as a Replace); no mainnet exists yet.
 */
contract OfferMatchIntentFacet is DiamondReentrancyGuard, DiamondPausable {
    // ─── #393 v1-b — LenderIntentVault fill path ─────────────────────────

    /// @notice A keeper/solver filled a lender's standing intent against an
    ///         on-chain borrower counterparty, materializing the slice loan.
    event IntentMatched(
        address indexed lender,
        address indexed matcher,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 sliceOfferId,
        uint256 counterpartyOfferId,
        uint256 loanId,
        uint256 fillAmount
    );

    /// @notice #633 — the #398 aggregator-adapter feature is paused by governance,
    ///         so an aggregator's intent cannot be filled (user intents still can).
    error AggregatorAdaptersPaused();

    /// @notice #393 v1-b — fill a lender's STANDING INTENT against an on-chain
    ///         borrower counterparty. The solver (`msg.sender`) earns the 1% LIF.
    ///         Materializes a single-fill lender offer from the intent's bounds —
    ///         rate floor `[minRateBps, MAX_INTEREST_BPS]`, the counterparty's
    ///         term (≤ `maxDurationDays`), and the collateral the intent's
    ///         `maxInitLtvBps` requires — with `creator = lender`, then routes it
    ///         through the same audited `executeMatch` as `matchOffers`. The
    ///         lender stays lender-of-record (`loan.lender == lender`), so every
    ///         downstream claim/VPFI/KYC/sanctions site is unchanged.
    /// @param lender              The standing-intent owner (= loan lender).
    /// @param lendingAsset        ERC-20 the lender supplies (intent key).
    /// @param collateralAsset     ERC-20 collateral the lender accepts (intent key).
    /// @param slot                #3626 — which of the lender's intents on the pair
    ///                            fills (intent key). The caller names it; the
    ///                            protocol does not choose between a lender's slots.
    /// @param counterpartyOfferId The on-chain BORROWER offer to fill against.
    /// @param fillAmount          Principal this match fills.
    /// @return loanId             The initiated loan.
    function matchIntent(
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external nonReentrant whenNotPaused returns (uint256 loanId) {
        LibVaipakam._assertNotSanctioned(msg.sender); // solver = LIF recipient
        LibVaipakam._assertNotSanctioned(lender);
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Master gates: the matcher machinery (partialFillEnabled) + the
        // intent-path kill-switch. Both default off on a fresh deploy.
        if (!s.protocolCfg.partialFillEnabled) revert LibOfferMatchExecute.FunctionDisabled(3);
        if (!s.protocolCfg.lenderIntentEnabled) revert LibOfferMatchExecute.FunctionDisabled(4);
        // #633 — when the aggregator-adapter feature is paused, freeze fills of an
        // aggregator's intent specifically (user/backstop intents keep matching).
        if (
            s.isAggregatorAdapter[lender] &&
            LibVaipakam.cfgAggregatorAdaptersPaused()
        ) revert AggregatorAdaptersPaused();

        LibVaipakam.LenderIntent memory intent =
            s.lenderIntent[lender][lendingAsset][collateralAsset][slot];
        // The slot is active and its terms have stood the minimum age (#3443),
        // the one rule every slot fill runs ({LibIntentFill}).
        LibIntentFill.requireSlotLive(intent, lender);
        // #393 v1-c — permissioned-solver gate. A `requiresKeeperAuth` intent may
        // only be filled by the lender themselves or a solver the lender has
        // authorized for `KEEPER_ACTION_SIGNED_FILL` (pre-loan, principal-keyed).
        // An un-opted intent (the default) stays openly fillable by any solver.
        if (intent.requiresKeeperAuth) {
            LibAuth.requireKeeperForPrincipal(
                LibVaipakam.KEEPER_ACTION_SIGNED_FILL, lender
            );
        }

        // The loan's term is the counterparty's (offers carry one
        // `durationDays` and the match requires both sides agree), and it
        // inherits the counterparty's lifecycle terms. {LibIntentFill.admitFill}
        // runs the fill-level rule: smallest fill, exposure, longest term,
        // lend-until (#3618), lifecycle (#3619), and the collateral the slot's
        // init-LTV ceiling requires (unresolvable ⇒ refused).
        LibVaipakam.Offer storage cp = s.offers[counterpartyOfferId];
        uint256 reqColl = LibIntentFill.admitFill(
            s, intent, lender, lendingAsset, collateralAsset, slot,
            cp.durationDays, cp.useFullTermInterest, cp.allowsPartialRepay, fillAmount
        );

        // #393 v1-d — the fill is drawn from the slot's capital lien (a fill can
        // never lend more than the lender has funded) and materialized as a
        // single-fill lender slice (creator = lender) at the slot's floor rate.
        uint256 sliceOfferId = LibIntentFill.drawAndMaterialize(
            lender, lendingAsset, collateralAsset, slot, fillAmount, reqColl,
            intent.minRateBps, cp.durationDays, cp.useFullTermInterest, cp.allowsPartialRepay
        );

        // Shared core (lender direction; borrower is the counterparty), hosted
        // once on OfferMatchFacet; the solver is named as the matcher.
        loanId = OfferMatchFacet(address(this)).matchCoreInternal(sliceOfferId, counterpartyOfferId, 0, msg.sender);
        // #1219 — one fill, charged to the actor the route names (direct solver,
        // the adapter's bound operator, or the outer initiator's free tier — see
        // `LibServiceCapacity.routeActor`), LAST, so a refused charge reverts the
        // fill whole and `previewIntent` reports it as its last check. A
        // keeper-authorized fill is ONE executed item: the keeper-auth check above
        // stays an authorization, not a second charge.
        // #2550 — when the solver's capacity would REFUSE it, an opted-in intent
        // whose owner holds a priority credit spends that credit instead
        // (`LibPriorityRouting.chargeFill`; otherwise this is `chargeSolver()`).
        LibPriorityRouting.chargeFill(s, lender, lendingAsset, collateralAsset, slot, loanId);

        // The originating slot key (so the release survives a lender-position
        // sale), the roll-discovery entry and, on the ledger's host, the slot's
        // live principal and figures; then retire the orphaned lender slice.
        LibIntentFill.recordSlotLoan(
            s, loanId, lender, lendingAsset, collateralAsset, slot, fillAmount
        );
        LibIntentFill.retireLenderSlice(s, sliceOfferId);

        emit IntentMatched(
            lender,
            msg.sender,
            lendingAsset,
            collateralAsset,
            slot,
            sliceOfferId,
            counterpartyOfferId,
            loanId,
            fillAmount
        );
    }

}
