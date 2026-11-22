// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPriceRead} from "../libraries/LibPriceRead.sol";
import {LibSaleListing} from "../libraries/LibSaleListing.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";

/**
 * @title SaleAdmissionFacet
 * @author Vaipakam Developer Team
 * @notice The sale side of the risk reads: whether a loan may admit a new
 *         lender by sale (`saleAdmission`), the seller bounds a listing would
 *         record (`quoteSellerBounds`) and the bounds a standing listing did
 *         record (`getSaleListingBounds`).
 *
 * @dev    Split off `RiskPreviewFacet` in #3843, a pure move: the selectors,
 *         return shapes and behaviour are unchanged, and only the runtime
 *         bytecode is separate. `RiskPreviewFacet` had reached the EIP-170
 *         ceiling, and these three reads are the one cluster it carried that
 *         concerns an existing loan's SALE rather than a new loan's
 *         origination. **These functions are NOT on RiskPreviewFacet any
 *         more.**
 *
 *         Every function here is `external view`: it makes no state write,
 *         emits no event and declares no local error. `LibSaleSolvency`
 *         reaches `saleAdmission` by self-call from every facet that inlines
 *         it (today `SaleExitVerdictFacet`, which both early-withdrawal
 *         facets self-call, `OfferAcceptFacet` and `OfferPreviewFacet`), so
 *         this facet is refreshed together with `RiskPreviewFacet` and those
 *         sale hosts, `EarlyWithdrawalFacet` and `EarlyWithdrawalDirectFacet`
 *         among them: a caller refreshed onto a Diamond that does not route
 *         `saleAdmission` reverts `FunctionDoesNotExist` on every sale (a
 *         hard revert, never an unchecked sale). Find the callers again with
 *         a grep for `LibSaleSolvency.`, not from this list.
 */
contract SaleAdmissionFacet {
    /**
     * @notice #1503 item 4 — the two bounds a listing made right now WOULD
     *         record, so the seller can be shown what they are agreeing to
     *         before they agree to it.
     *
     * @dev    Literally the same call the listing makes:
     *         {LibSaleListing.projectSellerBounds} is what
     *         {LibSaleListing.recordSellerBounds} stores, so the quote cannot
     *         disagree with the bound — not "agrees today", but one computation
     *         with two callers. That is the #1801 lesson applied ahead of time
     *         rather than after: a client that mirrors the rule drifts from it
     *         the moment the rule changes, and this rule has changed under
     *         review more than once. There is nothing on-chain to read at
     *         listing time — the listing does not exist yet — so the projection
     *         has to be offered as a view or the client is forced to re-derive
     *         it, which is the drift by a longer road.
     *
     *         `expiresAt` is passed rather than derived because the seller is
     *         still choosing it: the whole point of the quote is to answer
     *         "what would I be agreeing to if I listed for THIS long".
     *
     * @param loanId      The loan the seller is considering listing.
     * @param saleRateBps The rate they would list at.
     * @param expiresAt   The expiry the listing would carry.
     * @return minSellerNet The floor that listing would record — the least the
     *                      seller receives if it fills at any point before it
     *                      expires.
     * @return maxHeld      The ceiling it would record: money already set aside
     *                      for the lender, which transfers with the position.
     */
    function quoteSellerBounds(
        uint256 loanId,
        uint256 saleRateBps,
        uint256 expiresAt
    ) external view returns (uint256 minSellerNet, uint256 maxHeld) {
        return LibSaleListing.projectSellerBounds(
            LibVaipakam.storageSlot(), loanId, saleRateBps, expiresAt
        );
    }

    /**
     * @notice #2672 — the figures a standing sale listing on `loanId`
     *         recorded for the seller, so the app can state them (and the
     *         buyer side can see a listing that has stopped being buyable)
     *         instead of leaving the seller to find out from a refused fill.
     * @dev    A read of what {LibSaleListing.recordSellerBounds} stored, plus
     *         the live held balance the ceiling is compared with. Settlement
     *         (`EarlyWithdrawalFacet.completeLoanSaleInternal`) refuses a fill
     *         while `recorded` and the time is at or before `expiry` if the
     *         seller would net less than `minSellerNet` (`SaleBelowSellerFloor`)
     *         or `heldNow` exceeds `maxHeld` (`SaleAboveHeldCeiling`). The
     *         ceiling half can be judged from these outputs alone; the floor
     *         half depends on the fill's own proceeds and accrual, so it is not
     *         predicted here.
     * @return recorded     Whether the listing recorded bounds (false: none,
     *                      or the listing is gone).
     * @return minSellerNet The least the seller agreed to come out with.
     * @return maxHeld      The most of the lender's held funds that may move
     *                      with the position.
     * @return expiry       The listing expiry the floor was computed for; past
     *                      it the bounds are not enforced.
     * @return heldNow      Funds held for the lender on this loan right now.
     */
    function getSaleListingBounds(uint256 loanId)
        external
        view
        returns (bool recorded, uint256 minSellerNet, uint256 maxHeld, uint256 expiry, uint256 heldNow)
    {
        LibVaipakam.Storage storage st = LibVaipakam.storageSlot();
        return (
            st.saleListingBoundsRecorded[loanId],
            st.saleListingMinSellerNet[loanId],
            st.saleListingMaxHeldTransfer[loanId],
            st.saleListingBoundsExpiry[loanId],
            st.heldForLender[loanId]
        );
    }

    /**
     * @notice #1503 PR-E (design item 11) — whether `loanId` may admit a NEW
     *         lender by sale, as a single classification.
     *
     * @dev    Lives HERE rather than inlined into the sale facets: both
     *         `EarlyWithdrawalFacet` and `OfferAcceptFacet` were already at
     *         the EIP-170 ceiling and the guard pushed each ~650 bytes over
     *         it, and `RiskFacet` had too little headroom to take it. This
     *         facet already hosts the risk-domain assert/classify surface the
     *         mutating paths consult (`assertMatchAllowed`,
     *         `assertObligationTransferAllowed`), so it is the consistent
     *         home rather than merely the one with room.
     *
     *         Classifies rather than reverts so ONE selector serves both the
     *         reverting guard and the read-only preview; `LibSaleSolvency`
     *         maps the code onto the caller-side errors. An oracle that
     *         cannot price a position REVERTS out of here, which the guard
     *         treats as fail-closed and the preview as not-admissible.
     *
     * @return code 0 admissible;
     *         1 live health factor below the loan's own admission floor;
     *         2/3/4 inherited risk terms weaker than current — admission
     *         health floor, liquidation LTV, init-LTV cap respectively;
     *         5 live LTV above the cap a fresh admission would allow;
     *         6 a leg is not priceable today, so nothing below can be measured
     *         (#1655) — note this REFUSES, where the superseded
     *         snapshot-based carve-out returned 0 for the same shape, and that
     *         it refuses UNCONDITIONALLY: the progressive-risk-access consent
     *         ladder classifies assets by identity and depth, never by live
     *         priceability, so it cannot be deferred to here (Codex r8);
     *         7 the inherited TREASURY-FEE snapshot is higher than the rate a
     *         loan originated today would carry, so the incoming lender would
     *         net less than their own offer's terms imply (#1918). Same
     *         one-directional inherited-terms rule as 2/3/4 — a LOWER
     *         inherited fee stays sellable — but reported separately because
     *         it is an economic term rather than a risk bound, and telling a
     *         buyer their collateral bounds are weak when the objection is the
     *         fee would describe the wrong position.
     * @return a The position's figure for the failing check (0 when code 0),
     *         except code 6, where it names the unpriceable leg — 0 collateral,
     *         1 principal — because a refusal for want of a measurement has no
     *         figure to report.
     * @return b The figure it is required to meet (0 when code 0, and 0 for
     *         code 6 for the same reason).
     */
    function saleAdmission(uint256 loanId)
        external
        view
        returns (uint8 code, uint256 a, uint256 b)
    {
        LibVaipakam.Storage storage st = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = st.loans[loanId];

        // Liquidity is judged RIGHT NOW, the same way origination judges it —
        // `OracleFacet.checkLiquidity`, the live fail-closed classifier
        // `LoanFacet` calls before stamping a loan, and the one
        // `AddCollateralFacet` already consults rather than the snapshot when
        // admitting new value into a live loan.
        //
        // Deliberately NOT `loan.collateralLiquidity` / `loan.principalLiquidity`:
        // those are written once at origination and never refreshed, so they
        // describe the market as it was, not as it is. A snapshot saying
        // `Liquid` on a market that has since degraded would pass every check
        // below against prices the protocol no longer considers usable, and
        // never reach the illiquid branch at all (#1655). The same reasoning
        // `FeeEntitlementFacet` records for the offer-creation snapshot, one
        // level further out: the snapshot is right for the question it was
        // taken to answer, and this is a different question.
        //
        // The snapshots remain right for what they are FOR: the existing loan's
        // own lifecycle (`RiskFacet`, `RepayFacet`, the default and liquidation
        // routing) is governed by the bargain struck at origination, and a
        // market moving underneath it must not rewrite that. Sale admission is
        // the one question asked about today rather than about origination.
        // A leg is measurable only if BOTH sources say so, and that is not a
        // redundant belt: they answer different questions and each can block on
        // its own.
        //
        //   * The LIVE reading is whether the market can be priced today. Only
        //     it can catch a snapshot that has gone stale in the dangerous
        //     direction — still `Liquid` for a market that has degraded.
        //   * The SNAPSHOT is whether risk math is available for this loan AT
        //     ALL: `RiskFacet.calculateHealthFactor` gates on
        //     `loan.collateralLiquidity` / `loan.principalLiquidity` and reverts
        //     `IlliquidLoanNoRiskMath` when either is not `Liquid`. So a loan
        //     carrying an illiquid snapshot has no health factor to compare,
        //     whatever the market has since done.
        //
        // Requiring both is therefore the accurate statement of "the protocol
        // can produce a figure for this position", not an arbitrary ratchet.
        // Reading only the live value would send a stale-`Illiquid` loan into
        // the health read and surface an opaque `IlliquidLoanNoRiskMath` where
        // the honest answer is that the position is unpriceable.
        LibVaipakam.LiquidityStatus collLiq = _measurable(
            loan.collateralAsset,
            loan.collateralLiquidity
        );
        LibVaipakam.LiquidityStatus prinLiq = _measurable(
            loan.principalAsset,
            loan.principalLiquidity
        );
        if (
            collLiq != LibVaipakam.LiquidityStatus.Liquid ||
            prinLiq != LibVaipakam.LiquidityStatus.Liquid
        ) {
            // An unpriceable leg cannot be measured: health factor is a ratio
            // of oracle-priced values and REVERTS here rather than returning a
            // conservative number, so none of the checks below can run. This is
            // the design doc's Phase-1 exclusion for these positions
            // (`LenderEarlyWithdrawalUXDesign.md` 717-736), and the refusal is
            // UNCONDITIONAL — it does not consult the progressive-risk-access
            // switch.
            //
            // An earlier revision of this branch DID consult it, admitting
            // unpriceable positions when the gate was on so the buyer-consent
            // gate could decide. That was wrong, and the reason generalises
            // (Codex #1635 r8): **the consent ladder classifies assets, not
            // measurements.** `LibRiskAccess._isBlueChip` returns true for WETH
            // and every configured PAA asset by IDENTITY, with no liquidity
            // read, so `_assetRequiredLevel` yields `BlueChipOnly` — the level
            // every vault holds by default. A WETH leg whose ETH/numeraire feed
            // has gone stale, or whose sequencer check fails, is therefore
            // unpriceable AND still blue-chip: the gate requires no opt-up and
            // no pair consent, and would wave the position through to a
            // default-tier buyer on both sale paths.
            //
            // So the ladder cannot stand in for this check. It answers "how
            // risky is this class of asset", which is a property of the asset;
            // measurability is a property of the oracle's state right now, and
            // there is nothing for a buyer to consent to when the protocol
            // cannot say what the position is worth. Deferring to a gate on the
            // assumption that it recognises a condition it never reads is the
            // failure mode, not the switch itself.
            //
            // Refusing is not the "silent blocking" the design doc rules out:
            // that objection is to a guard that reverts without saying why.
            // This names the condition and the leg.
            return (
                6,
                collLiq != LibVaipakam.LiquidityStatus.Liquid ? 0 : 1,
                0
            );
        }

        uint256 hf = RiskFacet(address(this)).calculateHealthFactor(loanId);
        uint256 floor = LibVaipakam.effectiveLoanMinHealthFactor(
            loan.minHealthFactorAtInit
        );
        if (hf < floor) return (1, hf, floor);

        // Inherited snapshots must be no WEAKER than a fresh loan's today.
        // Migrating the position changes the lender, not the loan's terms, so
        // without this the buyer can inherit a looser collateral-withdrawal
        // floor and a later liquidation point than they could be sold today.
        // One-directional on purpose: STRICTER than current is fine to sell.
        // BRANCH-AWARE, mirroring `LoanFacet._snapshotRiskCaps` exactly: the
        // depth-tiered regime admits at HF_LIQUIDATION_THRESHOLD (1e18) and
        // only the non-tiered regime uses the tunable knob. Comparing a
        // tiered-originated loan's 1e18 snapshot against the knob (>=1.2e18,
        // 1.5e18 by default) would classify EVERY such loan as weaker and
        // block it from both sale paths, which is a false positive rather
        // than a tightening.
        uint256 currentHf = LibVaipakam.admissionHealthFactorFloor();
        if (floor < currentHf) return (2, floor, currentHf);

        uint8 effTier = _effectiveTierOrZero(loan.collateralAsset);

        uint256 curLiqLtv = LibVaipakam.cfgTierLiquidationLtvBps(effTier);
        if (uint256(loan.liquidationLtvBpsAtInit) > curLiqLtv) {
            return (3, uint256(loan.liquidationLtvBpsAtInit), curLiqLtv);
        }

        uint256 curCap = LibVaipakam.assetInitLtvCeilingBps(loan.collateralAsset);
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            uint256 tierCap = uint256(LibVaipakam.effectiveTierMaxInitLtvBps(effTier));
            if (tierCap < curCap) curCap = tierCap;
        }
        uint256 inheritedCap = LibVaipakam.effectiveLoanInitLtvCapBps(
            loan.initLtvCapBpsAtInit,
            curCap
        );
        if (inheritedCap > curCap) return (4, inheritedCap, curCap);

        // #1918 (#1503 design item 18) — the inherited-terms rule applied to
        // the loan's ECONOMIC snapshot, not just its risk ones. A running loan
        // keeps `treasuryFeeBpsAtInit` when the lender migrates, and settlement
        // keeps reading it, so a buyer whose standing offer assumed today's
        // schedule can be swapped into an older loan that pays a higher cut to
        // treasury and therefore yields them less. Nothing above sees it: the
        // fee is not a risk bound, not a term the buyer authored, and not
        // visible in a health or LTV reading.
        //
        // ONE-DIRECTIONAL, exactly as the risk snapshots above, and that is the
        // spec's answer rather than a judgement call here. `ProjectDetailsREADME`
        // draws the line explicitly: an inherited term must be "no weaker than a
        // loan originated today would carry", and "a position on STRICTER terms
        // than today's stays sellable, since its buyer inherits a better
        // position than a fresh loan would give them". A lower inherited fee is
        // that better position, so refusing it would block a sale that harms
        // nobody.
        //
        // It is deliberately NOT the exact-match rule the direct route applies
        // to behavioural terms. That rule governs "terms the buyer authored"
        // and is exact because the listed route could never deliver a mismatch;
        // this fee is authored by GOVERNANCE, appears in no offer, and is
        // mirrored by neither route — so it belongs to the inherited family,
        // whose test is directional.
        //
        // The snapshot itself is untouched, which is the other half of the same
        // spec rule: "Snapshot semantics continue to govern the EXISTING loan's
        // ongoing operation... Admission of a NEW lender is judged against
        // current standards instead." A retune still never re-prices an open
        // loan (§"Fee rates are fixed at loan origination") — it can only make
        // the position temporarily unsellable while remaining perfectly valid
        // to hold, repay or liquidate, which the spec names as the accepted
        // consequence.
        //
        // Compared through `effectiveTreasuryFeeBps`, not the raw field, so the
        // frozen `LEGACY_TREASURY_FEE_BPS` fallback for pre-#957 loans is the
        // figure tested. Reading the raw `0` those loans carry would compare a
        // sentinel against a rate and call every one of them cheaper than
        // today's — right by accident at 1% vs 2%, wrong the moment governance
        // moves the knob below the legacy value.
        uint256 inheritedFee = LibVaipakam.effectiveTreasuryFeeBps(loan);
        uint256 curFee = LibVaipakam.cfgTreasuryFeeBps();
        if (inheritedFee > curFee) return (7, inheritedFee, curFee);

        // The LIVE LTV, not just the cap snapshots. Equal caps say nothing
        // about where the position actually sits: accrued interest or
        // principal appreciation can carry a loan above its init cap while
        // the health factor stays above the floor. The tiered regime makes
        // that stark — floor 1e18, Tier-3 init cap 73%, liquidation
        // threshold 90% — so a position near 90% LTV would otherwise be
        // assignable even though `LibNewLoanRisk.requireAdmissible` would
        // reject the same collateralisation as a fresh admission, which is
        // the standard a sale is meant to meet.
        //
        // Bound by `inheritedCap`, which the gate above has already proven
        // is the stricter of the two, so this satisfies both the loan's own
        // terms and today's.
        uint256 liveLtv = RiskFacet(address(this)).calculateLTV(loanId);
        if (liveLtv > inheritedCap) return (5, liveLtv, inheritedCap);

        return (0, 0, 0);
    }

    /// @dev Whether one leg is measurable for sale admission: `Liquid` only
    ///      when the live classification AND the loan's own snapshot both say
    ///      so. See the note in `saleAdmission` for why both are load-bearing.
    ///      Collapses to `Illiquid` — the refusing value — rather than
    ///      reporting which source objected, since the caller's answer is the
    ///      same either way and the leg index is what a consumer needs.
    function _measurable(
        address asset,
        LibVaipakam.LiquidityStatus snapshot
    ) private view returns (LibVaipakam.LiquidityStatus) {
        if (snapshot != LibVaipakam.LiquidityStatus.Liquid) {
            return LibVaipakam.LiquidityStatus.Illiquid;
        }
        return _liveLiquidity(asset);
    }

    /// @dev The live liquidity classification for one leg, read through the
    ///      same entry point `LoanFacet` uses at origination so the two agree
    ///      by construction rather than by inspection.
    ///
    ///      Degrades to `Illiquid` — the REFUSING value — when the call fails,
    ///      rather than bubbling. `checkLiquidity` reverts `InvalidAsset` only
    ///      for `address(0)`, which a live loan cannot carry (origination calls
    ///      this on both legs and would itself have reverted), so this is a
    ///      belt-and-braces path; if it is ever reached, an unanswerable
    ///      liquidity question must refuse the sale, never pass it. Note the
    ///      asymmetry with the health and LTV reads below, which are left to
    ///      revert: those are measurements of a position we have already
    ///      established is priceable, and a guard that cannot obtain one must
    ///      stop the sale loudly rather than convert it into a classification.
    function _liveLiquidity(address asset)
        private
        view
        returns (LibVaipakam.LiquidityStatus)
    {
        (bool ok, bytes memory ret) = LibPriceRead.trySelfRead(
            abi.encodeWithSelector(OracleFacet.checkLiquidity.selector, asset)
        );
        if (!ok || ret.length < 32) return LibVaipakam.LiquidityStatus.Illiquid;
        return abi.decode(ret, (LibVaipakam.LiquidityStatus));
    }

    /// @dev Mirrors `LoanFacet._snapshotRiskCaps`'s tier lookup, fallback and
    ///      all, so the comparison above is like-for-like with what would be
    ///      stamped on a loan originated right now.
    function _effectiveTierOrZero(address asset) private view returns (uint8) {
        (bool ok, bytes memory ret) = LibPriceRead.trySelfRead(
            abi.encodeWithSelector(
                OracleFacet.getEffectiveLiquidityTier.selector,
                asset
            )
        );
        return ok && ret.length >= 32 ? abi.decode(ret, (uint8)) : 0;
    }
}
