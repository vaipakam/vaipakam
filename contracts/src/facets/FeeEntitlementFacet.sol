// src/facets/FeeEntitlementFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFeeEntitlement} from "../libraries/LibFeeEntitlement.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  FeeEntitlementFacet
 * @notice #1347 (M2 PR-5a/5b) — the Full VPFI tariff surface: prices the
 *         per-loan `C*` (LIF·year), charges each opting-in party's `C*` from
 *         their own vault into the recycle bucket, and stamps the per-loan
 *         fee-entitlement record the settlement sweep (PR-6) and loan-side
 *         reward cap (PR-5c) read.
 *
 * @dev    Lives in its own facet on purpose:
 *          - it gives the tariff charge a FRESH stack frame, off the
 *            at-budget `OfferAcceptFacet._acceptOffer` viaIR path (the charge
 *            is a `msg.sender == address(this)` cross-facet call, the same
 *            trust model as `chargeBorrowerLifAndDeliver`);
 *          - it keeps the Full-tariff bytecode off the already-large accept
 *            facet (EIP-170); and
 *          - it is the single place PR-5c / PR-6 extend for cap reads + lender
 *            Full honoring.
 *
 *         Ships DARK: while `cfgFeeEntitlementEnabled()` is false every Full
 *         opt-in fails closed (revert unless the party permitted a downgrade),
 *         so {chargeFullTariff} only ever stamps `None`/`HoldOnly` and the
 *         notional `cStarOpen`.
 */
contract FeeEntitlementFacet is IVaipakamErrors {
    /// @notice #1347 — emitted once per loan at initiation with the resolved
    ///         per-party modes, each Full party's absorbed tariff, and the
    ///         notional `C*`. Auxiliary fee-accounting log — the recycle credit
    ///         itself is observable via `VpfiRecycled`, and the loan lifecycle
    ///         via `LoanInitiated`.
    /// @custom:event-category informational/fee-entitlement
    event FeeEntitlementStamped(
        uint256 indexed loanId,
        uint8 borrowerMode,
        uint8 lenderMode,
        uint256 borrowerTariffPaid,
        uint256 lenderTariffPaid,
        uint256 cStarOpen
    );

    /**
     * @notice Charge the Full VPFI tariff for a freshly-initiated loan and stamp
     *         its fee-entitlement record.
     * @dev    Internal cross-facet entry — `msg.sender` MUST be the Diamond, so
     *         only `OfferAcceptFacet` (behind the accept flow, post-mint) can
     *         reach it. It self-reads every Full authorization from the durable,
     *         party-signed artifacts — the CREATOR's from `s.offers[offerId]`
     *         (`creatorFull` / `creatorMaxCStar` / `creatorAllowFullDowngrade`),
     *         the ACCEPTOR's from the `_verifyAndBindAccept` transient injection
     *         (`s.acceptAckAcceptor*`, gated on `acceptAckActive` so a matcher
     *         fill can never inherit a stale direct-accept opt-in) — then maps
     *         creator↔acceptor to borrower↔lender by `offerType`. This keeps the
     *         at-EIP-170 / at-viaIR-budget `_acceptOffer` caller down to five
     *         scalar arguments. It prices one shared notional `C*`, resolves and
     *         charges each party independently (double absorption — both Full ⇒
     *         `2 × C*` to the bucket), then writes `feeEntitlementByLoanId`. The
     *         notional `cStarOpen` is stamped for EVERY loan (even None/HoldOnly)
     *         because the loan-side reward cap (PR-5c) is defined from it. Only
     *         ever invoked on the ERC-20 origination path (never a rental / a
     *         sale-vehicle accept, which pay no LIF and so bear no tariff).
     * @param  offerId            The accepted offer (source of the creator side).
     * @param  loanId             The freshly-minted loan.
     * @param  borrower           The loan's borrowing party.
     * @param  lender             The loan's lending party.
     * @param  effectivePrincipal The filled principal in lending-asset wei.
     */
    function chargeFullTariff(
        uint256 offerId,
        uint256 loanId,
        address borrower,
        address lender,
        uint256 effectivePrincipal
    ) external {
        if (msg.sender != address(this)) revert UnauthorizedCrossFacetCall();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Offer storage offer = s.offers[offerId];
        // Accept-time liquidity, NOT the offer-creation snapshot: `LoanFacet`
        // re-checks liquidity at accept and snapshots it onto the loan, and the
        // borrower LIF discount is charged against that same accept-time value.
        // Reading `offer.principalLiquidity` here could stamp HoldOnly/None (or
        // gate Full) against a stale classification if the asset's liquidity
        // flipped between create and accept (Codex #1366 P2).
        bool principalLiquid = s.loans[loanId].principalLiquidity ==
            LibVaipakam.LiquidityStatus.Liquid;

        // Party-scoped authorization → borrower/lender by offer side. The
        // creator signed offer creation (auth on the Offer); the acceptor signed
        // the accept terms (auth in the transient injection). On a Lender offer
        // the acceptor is the borrower; on a Borrower offer the acceptor is the
        // lender. A matcher fill leaves `acceptAckActive == false`, so the
        // acceptor side reads as non-Full — the borrower can never have their
        // vault drained by a keeper they didn't sign for.
        //
        // KNOWN LIMITATION (matched fills): `matchOffers` routes
        // `acceptOfferInternal` with the BORROWER offer id, so `offer` here is
        // the borrower offer and the counterparty lender's `creatorFull` (which
        // lives on the SEPARATE lender offer, not read here) is silently ignored
        // — a matched fill therefore resolves the lender side as non-Full rather
        // than charging or downgrading it. This is SAFE (no wrong charge; the
        // design treats matched-fill lender-Full as a "may", rev-15 §3) and dark;
        // honoring lender Full on the match path (threading the lender offer's
        // auth through `OfferMatchFacet`) is tracked as follow-up #1369. Borrower
        // Full on a matched borrower offer IS honored via `offer.creatorFull`.
        bool acceptorFull = s.acceptAckActive && s.acceptAckAcceptorFull;
        bool isLenderOffer = offer.offerType == LibVaipakam.OfferType.Lender;

        (uint256 cStar, bool numeraireOk) = LibFeeEntitlement.computeCStar(
            offer.lendingAsset,
            effectivePrincipal,
            offer.durationDays
        );

        // Borrower gates on its PRE-MINT free VPFI (snapshotted by
        // chargeBorrowerLifAndDeliver before the lien release), so the `C*`
        // charge matches the pre-mint `+10%` verdict exactly and
        // `resolveAndCharge` keeps its full revert/downgrade semantics (Codex
        // #1366 r5 P2). The auth-side selection + hold-eligibility are pushed
        // into `_resolveParty` so their ternary temporaries leave this
        // at-viaIR-budget frame (#1353 PR-5c added the reward-cap stamp below).
        (LibVaipakam.FeeEntitlementMode bMode, uint256 bPaid) = _resolveParty(
            s,
            offer,
            loanId,
            borrower,
            /*useAcceptorAuth=*/ isLenderOffer,
            acceptorFull,
            /*isBorrowerSide=*/ true,
            principalLiquid,
            s.acceptAckBorrowerPreFreeVpfi,
            cStar,
            numeraireOk
        );
        // Lender gates on its LIVE free VPFI — it has no pre-mint +10% to stay in
        // sync with (its yield-fee discount is a settlement / PR-6 concern), and
        // the loan lien is on the borrower's collateral, not the lender's vault.
        (LibVaipakam.FeeEntitlementMode lMode, uint256 lPaid) = _resolveParty(
            s,
            offer,
            loanId,
            lender,
            /*useAcceptorAuth=*/ !isLenderOffer,
            acceptorFull,
            /*isBorrowerSide=*/ false,
            principalLiquid,
            LibFeeEntitlement.freeVpfiBalance(lender),
            cStar,
            numeraireOk
        );

        // Stamp the fee-entitlement record (incl. the PR-5c reward-cap fields) in
        // a FRESH frame — the accept path is at the viaIR stack budget, so the
        // 8-field struct write + cap compute + emit are extracted here (Codex
        // #1366 pattern) to keep `chargeFullTariff`'s frame in bounds.
        _stampEntitlement(
            s,
            loanId,
            bMode,
            lMode,
            uint32(offer.durationDays == 0 ? 1 : offer.durationDays),
            bPaid,
            lPaid,
            cStar
        );
    }

    /// @dev Resolve + charge ONE party's Full tariff in its own frame. Selects
    ///      the party's signed authorization by side — the ACCEPTOR's from the
    ///      transient `s.acceptAck*` injection when `useAcceptorAuth`, else the
    ///      CREATOR's from the offer — then resolves hold-eligibility and calls
    ///      {LibFeeEntitlement.resolveAndCharge}. `acceptorFull` is the
    ///      already-gated (`acceptAckActive && …`) acceptor opt-in; the raw
    ///      transient `maxCStar` / `allowDowngrade` are safe to read unguarded
    ///      because `resolveAndCharge` ignores them when `full == false`.
    ///      Extracted so the caller's at-viaIR-budget frame doesn't carry the
    ///      per-side ternary temporaries.
    function _resolveParty(
        LibVaipakam.Storage storage s,
        LibVaipakam.Offer storage offer,
        uint256 loanId,
        address party,
        bool useAcceptorAuth,
        bool acceptorFull,
        bool isBorrowerSide,
        bool principalLiquid,
        uint256 partyFreeVpfi,
        uint256 cStar,
        bool numeraireOk
    ) private returns (LibVaipakam.FeeEntitlementMode mode, uint256 paid) {
        return
            LibFeeEntitlement.resolveAndCharge(
                loanId,
                party,
                useAcceptorAuth ? acceptorFull : offer.creatorFull,
                useAcceptorAuth
                    ? s.acceptAckAcceptorMaxCStar
                    : offer.creatorMaxCStar,
                useAcceptorAuth
                    ? s.acceptAckAcceptorAllowFullDowngrade
                    : offer.creatorAllowFullDowngrade,
                _holdEligible(s, party, principalLiquid, isBorrowerSide),
                principalLiquid,
                partyFreeVpfi,
                cStar,
                numeraireOk
            );
    }

    /// @dev #1353 (M2 PR-5c) — write `feeEntitlementByLoanId[loanId]` and emit
    ///      {FeeEntitlementStamped}. Snapshots the reward-cap haircut and caches
    ///      the per-side lifetime reward ceiling AT OPEN, both priced off the
    ///      notional `cStar` (0 ⇒ reward-ineligible loan ⇒ 0 cap). Stamping from
    ///      the snapshot (not the live cfg) freezes an open loan's reward ceiling
    ///      against a later governance retune. Own frame: keeps the at-budget
    ///      `chargeFullTariff` viaIR path in bounds. Ships DARK — the cap is
    ///      enforced only on post-cutover reward days (`_isArmedDay`), unarmed on
    ///      every deploy.
    function _stampEntitlement(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        LibVaipakam.FeeEntitlementMode bMode,
        LibVaipakam.FeeEntitlementMode lMode,
        uint32 openDays,
        uint256 bPaid,
        uint256 lPaid,
        uint256 cStar
    ) private {
        uint16 haircutAtOpen = uint16(LibVaipakam.cfgRewardHaircutBps());
        s.feeEntitlementByLoanId[loanId] = LibVaipakam.FeeEntitlement({
            borrowerMode: bMode,
            lenderMode: lMode,
            openDays: openDays,
            rewardHaircutBpsAtOpen: haircutAtOpen,
            borrowerTariffPaid: bPaid,
            lenderTariffPaid: lPaid,
            cStarOpen: cStar,
            loanSideRewardCapOpen: uint128(
                (cStar * (LibVaipakam.BASIS_POINTS - haircutAtOpen)) /
                    LibVaipakam.BASIS_POINTS /
                    2
            )
        });

        emit FeeEntitlementStamped(
            loanId,
            uint8(bMode),
            uint8(lMode),
            bPaid,
            lPaid,
            cStar
        );
    }

    /// @dev Hold-discount eligibility for the non-Full mode stamp (HoldOnly vs
    ///      None) that the settlement sweep (PR-6) reads. Mirrors what the actual
    ///      fee paths apply so the durable stamp never records an entitlement a
    ///      party never authorized:
    ///       - BOTH sides require the shared `vpfiDiscountConsent` — settlement
    ///         only applies either discount when that consent is on, so a
    ///         tier-holding but non-consenting party is stamped `None` (Codex
    ///         #1366 r2 P2).
    ///       - the borrower's HoldOnly LIF discount is additionally LIQUID-only
    ///         (matching {LibVPFIDiscount.holdOnlyBorrowerLif}); the lender's
    ///         yield-fee discount is tier-based and not liquidity-gated.
    function _holdEligible(
        LibVaipakam.Storage storage s,
        address party,
        bool principalLiquid,
        bool isBorrowerSide
    ) private view returns (bool) {
        if (!s.vpfiDiscountConsent[party]) return false;
        if (isBorrowerSide && !principalLiquid) return false;
        (, uint16 effBps) = LibVPFIDiscount.effectiveTierAndBps(party);
        return effBps > 0;
    }

    /**
     * @notice Quote the notional Full tariff `C*` for a prospective loan.
     * @dev    View surface for the frontend Full-tariff quote (PR-8 #1355) and
     *         off-chain callers. `numeraireOk` is false when the list LIF can't
     *         be priced — a reward-eligible origination requires it.
     * @param  lendingAsset  Prospective loan's ERC-20 principal asset.
     * @param  principal     Prospective filled principal in lending-asset wei.
     * @param  durationDays  Prospective term in days.
     * @return cStar         Notional tariff per Full party in VPFI wei (1e18).
     * @return numeraireOk   True iff the list LIF resolved a numeraire price.
     */
    function quoteCStar(
        address lendingAsset,
        uint256 principal,
        uint256 durationDays
    ) external view returns (uint256 cStar, bool numeraireOk) {
        return
            LibFeeEntitlement.computeCStar(
                lendingAsset,
                principal,
                durationDays
            );
    }

    /**
     * @notice Read a loan's fee-entitlement record (per-party modes, absorbed
     *         tariffs, notional `C*`, open term).
     * @param  loanId The loan to read.
     * @return The stored {LibVaipakam.FeeEntitlement} (zero-default when the
     *         loan never touched the VPFI discount/tariff path).
     */
    function getFeeEntitlement(
        uint256 loanId
    ) external view returns (LibVaipakam.FeeEntitlement memory) {
        return LibVaipakam.storageSlot().feeEntitlementByLoanId[loanId];
    }
}
