// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibServiceCapacity} from "./LibServiceCapacity.sol";
import {LibFacet} from "./LibFacet.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibPriorityRouting
 * @notice #2550 — the EFFECT of the first spend-gated perk, "priority solver
 *         routing for intents" (design: `docs/DesignsAndPlans/VpfiPriorityRoutingPerkDesign.md`).
 *
 *         A fill of a lender intent that the solver's service capacity (#1219)
 *         would REFUSE goes through anyway when the intent's owner has opted the
 *         intent into priority routing and holds a credit of this perk: the OWNER's
 *         credit is spent instead of the solver's capacity. Whenever the solver's
 *         capacity covers the fill, it is charged exactly as before and no credit is
 *         spent — a credit only ever buys a fill that would otherwise have been
 *         refused. Nobody is reordered and nobody pays more, which keeps the
 *         ratified perk rule: a perk may change what its buyer gets, never what
 *         other participants see.
 *
 * @dev    WHY A LIBRARY. `OfferMatchIntentFacet.matchIntent` already runs close to
 *         the viaIR stack budget (see that facet's note on its separate frames), so
 *         the fill gains ONE call here rather than inline branches. The same
 *         predicate also backs the read view, so a solver's pre-check and the fill
 *         cannot disagree about whether a credit applies ("make the check be the
 *         operation").
 *
 *         Every write of the opt-in goes through {writeFlag}, which emits on every
 *         change, so consent history is reconstructable from logs alone.
 */
library LibPriorityRouting {
    /// @notice The perk id this effect consumes. A COUNTED perk (one credit = one
    ///         capacity-free fill); `PerkFacet` refuses a timed configuration of it.
    uint256 internal constant PERK_ID = 1;

    /// @notice An intent's priority-routing opt-in changed. Emitted by every write:
    ///         the owner's toggle, the reset when the intent is (re)written by
    ///         `setLenderIntent`, and the clear on `cancelLenderIntent`.
    /// @custom:event-category informational/config
    event LenderIntentPrioritySet(
        address indexed owner, address indexed lendingAsset, address indexed collateralAsset, bool enabled
    );

    /// @notice The priority-routing effect was ARMED: the first priced, counted
    ///         configuration of perk 1 written by this version. Emitted once.
    /// @custom:event-category informational/config
    event PriorityRoutingPerkArmed(uint256 priceVpfi);

    /// @notice A fill the solver's capacity would have refused went through on the
    ///         intent owner's priority credit. The mined event is the authoritative
    ///         record that a credit was spent (a preview is only a block snapshot).
    /// @custom:event-category informational/config
    event IntentPriorityFill(
        address indexed owner,
        address indexed lendingAsset,
        address indexed collateralAsset,
        uint256 loanId,
        address solver,
        uint256 creditsLeft
    );

    /// @notice Whether the perk can be DELIVERED right now — the one predicate the
    ///         sale guard reads (#2558 r2). The Solver capacity curve must be lit
    ///         (otherwise no fill is ever refused for capacity, so a credit unlocks
    ///         nothing), and intent matching must be live: `matchIntent` reverts
    ///         outright while either master gate is off. The perk must also be
    ///         configured COUNTED: the fill only ever reads credits, so a timed
    ///         configuration (possible only as legacy state from before #2550,
    ///         Codex #2563 r2) would sell an expiry the effect never honours.
    ///         And the effect must have been ARMED by this version
    ///         (`priorityRoutingPerkArmed`, Codex #2563 r5), so a priced counted
    ///         configuration inherited from before #2550 does not start selling
    ///         by itself. Any future precondition of the fill joins THIS predicate
    ///         rather than a second check.
    function deliverable(LibVaipakam.Storage storage s) internal view returns (bool) {
        return s.capacityCurves[uint8(LibVaipakam.ServiceCapacityRole.Solver)].freeTier != 0
            && s.protocolCfg.partialFillEnabled && s.protocolCfg.lenderIntentEnabled
            && s.perkDurationSeconds[PERK_ID] == 0 && s.priorityRoutingPerkArmed;
    }

    /// @notice Whether `owner`'s intent for the pair is opted in AND `owner` holds a
    ///         credit — i.e. a capacity refusal on its fill would be lifted. Only
    ///         once the effect is armed: id-1 credits from before #2550 were bought
    ///         for no effect and must not acquire one (Codex #2563 r5).
    function covers(LibVaipakam.Storage storage s, address owner, address lendingAsset, address collateralAsset)
        internal
        view
        returns (bool)
    {
        return s.priorityRoutingPerkArmed && s.lenderIntentPriority[owner][lendingAsset][collateralAsset]
            && s.perkCredits[owner][PERK_ID] != 0;
    }

    /// @notice Write an intent's opt-in and emit on EVERY write — an explicit
    ///         opt-in, a repeated one, the reset every `setLenderIntent` performs
    ///         and the clear on cancellation (Codex #2563 r1): each is a consent
    ///         action the owner or the protocol took, so the logs record all of
    ///         them, not only the changes.
    /// @notice Arm the effect on the first priced, counted write of perk 1 — the
    ///         ONE place `priorityRoutingPerkArmed` is set (`PerkFacet.setPerkConfig`).
    ///         Refused while units of id 1 sold before the effect existed are
    ///         outstanding: those buyers paid for something else. Idempotent after.
    function armOnPricedWrite(LibVaipakam.Storage storage s, uint256 priceVpfi) internal {
        if (s.priorityRoutingPerkArmed) return;
        uint256 sold = s.perkUnitsSold[PERK_ID];
        if (sold != 0) revert IVaipakamErrors.PerkPriorityLegacyUnitsSold(sold);
        s.priorityRoutingPerkArmed = true;
        emit PriorityRoutingPerkArmed(priceVpfi);
    }

    function writeFlag(
        LibVaipakam.Storage storage s,
        address owner,
        address lendingAsset,
        address collateralAsset,
        bool enabled
    ) internal {
        s.lenderIntentPriority[owner][lendingAsset][collateralAsset] = enabled;
        emit LenderIntentPrioritySet(owner, lendingAsset, collateralAsset, enabled);
    }

    /// @notice The fill's LAST step, in place of `LibServiceCapacity.chargeSolver()`:
    ///         charge the solver when its capacity covers the fill (or the limiter
    ///         is dark); otherwise spend one of `lender`'s priority credits when the
    ///         intent is opted in and a credit is held; otherwise charge anyway, which
    ///         reverts with the ordinary `ServiceCapacityExhausted`. The credit spend
    ///         and the fill are one transaction, so a credit is never spent on a fill
    ///         that reverts.
    /// @dev   The capacity pre-check uses the NON-consuming outer read: the real
    ///         charge consumes the backstop's transient initiator, so peeking first
    ///         must not.
    function chargeFill(
        LibVaipakam.Storage storage s,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint256 loanId
    ) internal {
        if (
            !covers(s, lender, lendingAsset, collateralAsset)
                || LibServiceCapacity.fillCovered(s, msg.sender, LibServiceCapacity.peekChargedOuter(s, msg.sender))
        ) {
            LibServiceCapacity.chargeSolver();
            return;
        }
        LibFacet.crossFacetCall(
            abi.encodeWithSignature("consumePerkCredit(address,uint256)", lender, PERK_ID),
            IVaipakamErrors.PerkCreditConsumeFailed.selector
        );
        emit IntentPriorityFill(
            lender, lendingAsset, collateralAsset, loanId, msg.sender, s.perkCredits[lender][PERK_ID]
        );
    }
}
