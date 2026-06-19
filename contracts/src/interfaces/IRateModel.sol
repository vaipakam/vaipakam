// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IRateModel
 * @author Vaipakam Developer Team
 * @notice #400 — pluggable, QUOTE-TIME-ONLY interest-rate model. A model is a
 *         pure quote function evaluated **once, at offer-create / signed-offer
 *         sign time**, whose result is written as the offer's concrete
 *         `interestRateBps`. It is NEVER consulted at match / accept (that
 *         would re-price terms a counterparty — or, for a signed offer, the
 *         signature — never agreed to) and NEVER on a live loan (the rate is
 *         snapshotted immutably at `initiateLoan`, per ethos E2).
 *
 *         The default is the **identity model**: when no model is registered
 *         (`getRateModel() == address(0)`), the user-supplied rate stands
 *         unchanged — i.e. today's behaviour is just "the identity rate-model,"
 *         and nothing changes until governance registers a richer model
 *         (timelocked + guardian-revocable, a risk-increasing change). This is
 *         the E2-safe mechanism the risk-premium work (#394) and the keeper-AMM
 *         quoting (#393) build on.
 *
 * @dev    A model holds no funds (E1) and must be a pure `view`. Implementers
 *         receive only the dimensions available at offer-create time — the
 *         at-init LTV/HF is intentionally absent because the counterparty and
 *         the matched amounts aren't known until a (later) match.
 *
 *         ⚠️ **MARKET-ANCHORING IS MANDATORY for automated callers.** A model
 *         that floats free of the live order-book rate is dangerous on the
 *         AUTOMATED path (#393 auto-lend / auto-roll / keeper-AMM, #394
 *         premiums): price it below market and the auto-offer fills instantly
 *         at a loss; price it above and the capital sits idle, unmatched.
 *         Therefore:
 *           - `referenceRateBps` MUST be the **live Vaipakam market rate** for
 *             the asset-pair / duration bucket (the order-book signal that the
 *             market-rate widget already derives) — NOT a static curve or an
 *             external feed. A well-formed model only ADJUSTS around it (e.g.
 *             `market + risk_premium`), so it tracks the market by construction.
 *           - An automated caller MUST clamp the model's output to a
 *             market-relative band (±δ) and apply a freshness bound, so a
 *             buggy/stale model fails CLOSED (no off-market auto-fill) rather
 *             than posting wildly off the market.
 *         These are binding requirements on the consumer (#393/#394), not on
 *         this interface; #400 itself only exposes the resolver and never
 *         auto-posts, so it carries no divergence risk on its own.
 */
interface IRateModel {
    /// @param creator          Offer creator.
    /// @param offerType        `LibVaipakam.OfferType` cast to uint8 (0 = Lender, 1 = Borrower).
    /// @param lendingAsset     The principal asset.
    /// @param collateralAsset  The collateral asset (as specified on the offer; may be unset).
    /// @param amount           The offer's principal `amount` (range MIN for range offers).
    /// @param collateralAmount The offer's collateral `collateralAmount`.
    /// @param durationDays     Loan duration in days.
    /// @param referenceRateBps The user-supplied rate in BPS — the identity model returns this verbatim.
    struct RateModelInput {
        address creator;
        uint8 offerType;
        address lendingAsset;
        address collateralAsset;
        uint256 amount;
        uint256 collateralAmount;
        uint256 durationDays;
        uint256 referenceRateBps;
    }

    /// @notice Quote the concrete rate (BPS) to write into the offer. MUST be a
    ///         pure `view`. The caller (`OfferCreateFacet`) re-asserts the
    ///         protocol's range-ordering + `MAX_INTEREST_BPS` ceiling on the
    ///         returned value, so a model cannot push a rate past the ceiling.
    /// @return rateBps The quoted rate in basis points.
    function quoteRateBps(RateModelInput calldata input) external view returns (uint256 rateBps);
}
