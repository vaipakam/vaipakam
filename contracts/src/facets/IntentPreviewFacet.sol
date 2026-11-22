// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRiskAccess} from "../libraries/LibRiskAccess.sol";
import {LibOfferMatch} from "../libraries/LibOfferMatch.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {LibPriorityRouting} from "../libraries/LibPriorityRouting.sol";
import {LibCompliance} from "../libraries/LibCompliance.sol";
import {LibOfferRefund} from "../libraries/LibOfferRefund.sol";
import {OfferAcceptFacet} from "./OfferAcceptFacet.sol";
import {OfferPriceGuardFacet} from "./OfferPriceGuardFacet.sol";

/**
 * @title IntentPreviewFacet
 * @author Vaipakam Developer Team
 * @notice The standing-intent fill preview, `previewIntent`: whether a
 *         `matchIntent` fill would succeed now and, if not, the first reason
 *         it would revert.
 *
 * @dev    Split off `RiskPreviewFacet` in #3843, a pure move: the selector,
 *         arguments, return shape and behaviour are unchanged, and only the
 *         runtime bytecode is separate. `RiskPreviewFacet` had reached the
 *         EIP-170 ceiling, and `previewIntent` inlines the whole shared match
 *         core (`LibOfferMatch`), so moving it frees far more room than its
 *         own wrapper. **`previewIntent` is NOT on RiskPreviewFacet any
 *         more.**
 *
 *         Every function here is `external view`: it makes no state write,
 *         emits no event and declares no local error. The match-actor
 *         resolution is `LibRiskAccess.resolveMatchActors`, the one rule
 *         `RiskPreviewFacet`'s match gate (`assertMatchAllowed`) and match
 *         preview (`previewMatchRiskBlock`) also compile. Like the other
 *         match-core hosts, this facet reaches the loan-initiation risk
 *         bounds by self-call to `RiskPreviewFacet.initRiskBounds` (inside
 *         `LibOfferMatch`), so it is refreshed together with RiskPreviewFacet
 *         and the match-core hosts.
 */
contract IntentPreviewFacet {
    /// @notice #625 WI-2b — non-mutating preview of a `matchIntent` fill. A
    ///         keeper calls this BEFORE submitting `matchIntent` to learn,
    ///         off-chain and gas-free, whether the fill would succeed and — if
    ///         not — the exact first reason it would revert. On success it also
    ///         returns the principal / midpoint rate / required collateral the
    ///         fill would lock, so a solver can size the call from one read.
    /// @dev    The intent-level guards + the shared match-admission core run in
    ///         {LibOfferMatch.previewIntent}; this wrapper layers the #671
    ///         risk-access gate on top (through `LibRiskAccess.resolveMatchActors`),
    ///         exactly as `LibOfferMatchExecute.executeMatch` calls
    ///         `RiskPreviewFacet.assertMatchAllowed` after
    ///         `previewMatch`. The binding guarantee that this preview agrees
    ///         with the live fill is the `previewIntent` Ok ⟺ `matchIntent`
    ///         succeeds agreement test (`LenderIntentPreview.t.sol`).
    /// @param  solver  Prospective filler — `requiresKeeperAuth` is checked
    ///         against THIS address, not this view's `msg.sender`, so a keeper
    ///         can preview on behalf of the account that would submit.
    /// @param  initiator  The route's OUTER initiator (#2459 r4) — the account the
    ///         fill's capacity charge falls to when `solver` cannot be charged
    ///         itself: the caller of `backstopFill` when `solver` is the backstop
    ///         vault, else the transaction's originator (an aggregator adapter with
    ///         no bound operator). Named, never read from the view's transaction —
    ///         the real fill charges the initiator `backstopFill` records, which an
    ///         `eth_call`'s originator need not be. For a solver that sends its own
    ///         transaction, the solver.
    /// @param  lender  Intent owner (slice creator).
    /// @param  lendingAsset / collateralAsset / slot  Intent key (#3626: the slot
    ///         the fill would draw from).
    /// @param  counterpartyOfferId  The stored borrower offer to fill against.
    /// @param  fillAmount  Principal the solver intends to lend this fill.
    function previewIntent(
        address solver,
        address initiator,
        address lender,
        address lendingAsset,
        address collateralAsset,
        uint8 slot,
        uint256 counterpartyOfferId,
        uint256 fillAmount
    ) external view returns (LibOfferMatch.IntentPreviewResult memory res) {
        res = LibOfferMatch.previewIntent(
            solver,
            lender,
            lendingAsset,
            collateralAsset,
            slot,
            counterpartyOfferId,
            fillAmount
        );
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // Live order in `executeMatch` (Codex #1115 r2): the intent-level guards
        // and the slice's duration-cap + per-asset pause run BEFORE
        // `_createOfferSetup`'s SLICE-CREATOR (lender) risk gate
        // (`assertActorMayTransact`, gate-on only); the collateral floor, the
        // >365d cadence bound, the sale-vehicle rejection, and the match core all
        // run AFTER it; and the BORROWER-side `assertMatchAllowed` runs only once
        // the slice has fully materialized. So the reported first reason must be:
        //   • a PRE-gate failure (intent-level, slice duration-cap, slice pause)
        //     as-is — the risk gate is never reached live;
        //   • otherwise the SLICE-CREATOR (lender) risk block if it trips, since
        //     it precedes every post-gate failure (floor / multi-year /
        //     sale-vehicle / match-core) live;
        //   • else the surviving post-gate failure, or (on a clean result) the
        //     BORROWER risk block, then the accept gates.
        // The post-gate `intentError` set is exactly {SliceCollateralBelowFloor,
        // SliceMultiYearTerm, SaleVehicleTagged}; any `matchError` is post-gate
        // too (the match core runs after materialization).
        bool precedesLenderRisk = !res.ok
            && res.matchError == LibOfferMatch.MatchError.Ok
            && res.intentError != LibOfferMatch.IntentError.SliceCollateralBelowFloor
            && res.intentError != LibOfferMatch.IntentError.SliceMultiYearTerm
            && res.intentError != LibOfferMatch.IntentError.SaleVehicleTagged;
        if (precedesLenderRisk) return res;

        // #671 risk-access gate. Resolve the gated parties via the slice's
        // CREATOR (= `lender`; the slice has no offer id) and the borrower offer;
        // handles the lender-sale-vehicle branch identically to the enforcing
        // path.
        if (LibVaipakam.cfgRiskAccessGateEnabled()) {
            (
                address actorA,
                address actorB,
                LibRiskAccess.PairId memory pair
            ) = LibRiskAccess.resolveMatchActors(s, lender, counterpartyOfferId);
            // The slice-creator (lender) gate `_createOfferSetup` runs at 883 is
            // ALWAYS against the materialized SLICE's own assets — the intent's
            // lend / collateral legs (ERC-20, single-value; tokenIds 0 and prepay
            // immaterial to the ERC-20 pair key) — for BOTH a normal match and a
            // lender-sale vehicle. It is NOT the borrower offer's pair: for a
            // well-formed counterparty the two coincide, but a malformed / stale
            // one (asset-type mismatch => a post-gate `matchError`) has a
            // different, possibly riskier borrower pair (Codex #1115 r3); and for
            // a sale vehicle `executeMatch` reverts `SaleVehicleNotMatchable`
            // before `assertMatchAllowed` ever gates the sold-loan pair, so the
            // sold-loan pair must not gate the pre-match lender either (Codex
            // #1115 r4). Hence: always the slice pair here.
            LibRiskAccess.PairId memory slicePair = LibRiskAccess.PairId({
                lendAsset: lendingAsset,
                lendType: LibVaipakam.AssetType.ERC20,
                lendTokenId: 0,
                collAsset: collateralAsset,
                collType: LibVaipakam.AssetType.ERC20,
                collTokenId: 0,
                prepayAsset: address(0)
            });
            uint8 rb = LibRiskAccess.previewActorBlock(s, actorA, slicePair);
            // The borrower gate (`assertMatchAllowed`) is reached live only after
            // the slice fully materializes (assets matched, not a sale vehicle),
            // so consult it — against the borrower/loan `pair` — only on a clean
            // result, never letting a borrower block override an earlier post-gate
            // failure.
            if (rb == 0 && res.ok && actorB != address(0)) {
                rb = LibRiskAccess.previewActorBlock(s, actorB, pair);
            }
            res.riskBlock = rb;
            if (rb != 0) {
                // The risk gate is the live first-revert reason here; clear any
                // stale post-gate failure code so consumers keying on
                // intentError / matchError don't report the later reason.
                res.ok = false;
                res.intentError = LibOfferMatch.IntentError.Ok;
                res.matchError = LibOfferMatch.MatchError.Ok;
                return res;
            }
        }

        // Risk gate cleared (or off): a surviving post-gate failure is now the
        // correct first reason (its live check comes after the passed risk gate).
        if (!res.ok) return res;

        // #747 Codex r1/r2/r3 — accept-time gates. After the match + risk gate
        // the live fill enters `acceptOfferInternal(counterpartyOfferId)` with
        // the lender slice as acceptor, which can still reject on gates a
        // borrower newly trips AFTER posting. Reproduce the gates that can fail
        // on this deploy:
        //   - sanctions on the borrower (offer creator and token holder);
        //   - `offerConsumedBySale` — the terminal bit a Scenario-A parallel
        //     sale sets, which `_acceptOffer` rejects with `OfferConsumedBySale`
        //     even while the row still looks matchable (Codex r2);
        //   - KYC, when governance has enabled enforcement (Codex r3). Reuse the
        //     SAME value + predicate the accept path applies: the #627 public
        //     `calculateTransactionValueNumeraire` (effectivePrincipal for a
        //     match == the matched amount) and `LibCompliance.offerPartiesMeetKYC`
        //     for BOTH the borrower (offer creator) and the lender (acceptor).
        //     Gated on the flag so retail (enforcement off) pays no oracle read;
        //     `meetsKYCRequirement` itself also short-circuits true when off.
        // (Per-asset pause is mirrored EARLIER at the slice-materialization
        // stage, matching the live order. Country-pair is compile-time pure-true
        // on the retail deploy — the gated variant is a separate industrial-fork
        // function — so it can never block here. Already-accepted / expired are
        // covered by the match core.)
        // #3744 — the holder of the borrower offer's token owns the borrower
        // side, so the accept screens it and applies its KYC tier beside the
        // creator's and the lender's; the preview asks the same.
        address boHolder = LibOfferRefund.holder(s.offers[counterpartyOfferId]);
        bool kycBlocked;
        if (s.kycEnforcementEnabled) {
            uint256 valueNumeraire = OfferAcceptFacet(address(this))
                .calculateTransactionValueNumeraire(
                    counterpartyOfferId, res.matchAmount
                );
            kycBlocked = !LibCompliance.offerPartiesMeetKYC(
                s.offers[counterpartyOfferId].creator, boHolder, lender, valueNumeraire
            );
        }
        if (
            LibVaipakam.isSanctionedAddress(s.offers[counterpartyOfferId].creator)
            || LibVaipakam.isSanctionedAddress(boHolder)
            || s.offerConsumedBySale[counterpartyOfferId]
            || kycBlocked
        ) {
            res.intentError = LibOfferMatch.IntentError.AcceptGateBlocked;
            res.ok = false;
            return res;
        }
        // #3358 — loan creation then asks the borrower offer's origination
        // rules: the cadence admission and the maker's price-move guard. The
        // slice is the other side and is minted in the fill, so it carries no
        // guard a view could read. Same entry the accept and match previews
        // use, so the three cannot disagree about a refusal.
        {
            OfferPriceGuardFacet.OriginationRefusal refusal = OfferPriceGuardFacet(address(this))
                .previewOriginationRefusal(counterpartyOfferId, res.matchAmount, 0, lender, s.offers[counterpartyOfferId].creator);
            if (refusal != OfferPriceGuardFacet.OriginationRefusal.None) {
                res.matchError = refusal == OfferPriceGuardFacet.OriginationRefusal.CadenceNotAdmitted
                    ? LibOfferMatch.MatchError.CadenceNotAdmitted
                    : refusal == OfferPriceGuardFacet.OriginationRefusal.TermsNotAccepted
                        ? LibOfferMatch.MatchError.TermsNotAccepted
                        : refusal == OfferPriceGuardFacet.OriginationRefusal.OfferHolderFlagged
                            ? LibOfferMatch.MatchError.OfferHolderFlagged
                            : LibOfferMatch.MatchError.PriceGuardRefused;
                res.ok = false;
                return res;
            }
        }
        // #1219 review — the fill's capacity charge is its LAST step (after the
        // match), so it is this preview's last check, for the actor the fill's route
        // names for `solver` and `initiator` (`LibServiceCapacity.routeActor`).
        // #2559 (Codex #2563 r1) — the SAME capacity-or-credit rule the fill applies
        // (`LibPriorityRouting.chargeFill`): a capacity refusal on an opted-in intent
        // whose owner holds a priority credit is lifted, so the preview stays Ok
        // exactly when the fill would succeed, and a keeper reading it does not
        // stop at a fill a credit would carry. Codex #2563 r4 — and it says WHICH
        // clear case applies (`spendsPriorityCredit`), so the one pre-check tells a
        // solver whether the fill charges its capacity or spends the owner's credit.
        if (res.ok && !LibServiceCapacity.fillCovered(s, solver, initiator)) {
            if (LibPriorityRouting.covers(s, lender, lendingAsset, collateralAsset, slot)) {
                res.spendsPriorityCredit = true;
            } else {
                res.intentError = LibOfferMatch.IntentError.CapacityExhausted;
                res.ok = false;
            }
        }
    }
}
