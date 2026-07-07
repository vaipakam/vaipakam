// src/libraries/LibEntitlement.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibEntitlement
 * @notice Centralizes the accrued-interest and fee-split arithmetic reused
 *         across Repay, Preclose, Refinance, PartialWithdrawal, Risk, and
 *         Defaulted facets.
 * @dev Pure / view helpers only — callers are responsible for state writes
 *      (transfers, vault routing, claim bookkeeping). Keeping the math in
 *      one place means one rounding model, one off-by-one surface, and one
 *      place to audit when the interest / fee policy changes.
 */
library LibEntitlement {
    /// @notice Full-term interest: `principal * rateBps * durationDays / (DAYS_PER_YEAR * BASIS_POINTS)`.
    /// @dev Used when the loan is repaid-early-but-owes-full-term (README: lender
    ///      is made whole on duration) or at refinance when alice owes the old
    ///      lender the full promised coupon.
    function fullTermInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * durationDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice Pro-rata interest over `elapsedDays` (integer days).
    function proRataInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 elapsedDays
    ) internal pure returns (uint256) {
        return
            (principal * rateBps * elapsedDays) /
            (LibVaipakam.DAYS_PER_YEAR * LibVaipakam.BASIS_POINTS);
    }

    /// @notice #641 — a loan's interest-accrual origin: the dedicated
    ///         `interestAccrualStart` clock (re-stamped by partials WITHOUT
    ///         moving the term/maturity), falling back to `startTime` for loans
    ///         that predate the field. `interestAccrualStart` is set to a real
    ///         timestamp at origination, so `!= 0` cleanly distinguishes a
    ///         post-#641 loan (use the clock, even if `interestRemainingDays`
    ///         legitimately reached 0) from a legacy one.
    function _accrualStart(LibVaipakam.Loan storage loan) private view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestAccrualStart)
            : uint256(loan.startTime);
    }

    /// @notice #641 — a loan's remaining interest term in days: the dedicated
    ///         `interestRemainingDays` (re-stamped by partials), falling back to
    ///         the live `durationDays` for pre-field loans. Gated on
    ///         `interestAccrualStart` (NOT `interestRemainingDays != 0`) so a
    ///         post-#641 loan whose remaining term has reached 0 isn't mistaken
    ///         for a legacy loan.
    function _remainingTermDays(LibVaipakam.Loan storage loan) private view returns (uint256) {
        return loan.interestAccrualStart != 0
            ? uint256(loan.interestRemainingDays)
            : loan.durationDays;
    }

    /// @notice Pro-rata interest accrued on an ERC-20 loan from its interest-
    ///         accrual clock to `nowTime`, rounded down to whole days.
    function accruedInterestToTime(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 accrualStart = _accrualStart(loan);
        if (nowTime <= accrualStart) return 0;
        uint256 elapsedDays = (nowTime - accrualStart) / LibVaipakam.ONE_DAY;
        return proRataInterest(loan.principal, loan.interestRateBps, elapsedDays);
    }

    /// @notice Seconds-precise current borrow balance — `principal +
    ///         continuously-accrued interest` from `loan.startTime` to now.
    /// @dev    DISTINCT from {accruedInterestToTime}: the HF / liquidation
    ///         paths accrue interest by the *second* (`elapsed /
    ///         SECONDS_PER_YEAR`) so a loan's debt — and therefore its
    ///         liquidation proceeds split — is exact at the block of
    ///         liquidation, whereas settlement-time math rounds down to
    ///         whole days (borrower-favourable). Do not substitute one for
    ///         the other: it would shift the liquidation debt by up to a
    ///         day's interest. Rounds DOWN (borrower-favourable by <=1 wei),
    ///         multiplying first to preserve numerator precision. Shared by
    ///         {RiskFacet} (HF / single-route + partial liquidation) and
    ///         {RiskMatchLiquidationFacet} (split-route liquidation) since
    ///         the #66 facet split — one accrual model, one audit surface.
    function currentBorrowBalance(
        LibVaipakam.Loan memory loan
    ) internal view returns (uint256) {
        // #641 — accrue from the interest clock (see `_accrualStart`); inlined
        // here because this overload takes `Loan memory`, not storage.
        uint256 accrualStart = loan.interestAccrualStart != 0
            ? uint256(loan.interestAccrualStart)
            : uint256(loan.startTime);
        uint256 elapsed = block.timestamp > accrualStart
            ? block.timestamp - accrualStart
            : 0;
        uint256 accruedInterest = (loan.principal *
            loan.interestRateBps *
            elapsed) / (LibVaipakam.SECONDS_PER_YEAR * LibVaipakam.BASIS_POINTS);
        // #915 (M7) — credit interest already forwarded to the lender via
        // periodic auto-liquidation (`loan.interestSettled`, saturating at 0)
        // so the HF / forced-close debt does not double-count it. The accrual
        // clock is NOT reset by periodic settlement, so the raw `accruedInterest`
        // still spans the settled periods; subtracting the settled portion here
        // gives every HF read + single/split liquidation the same net-of-settled
        // debt the proper-close paths already use via `settlementInterestNet`.
        uint256 settled = uint256(loan.interestSettled);
        uint256 netInterest = accruedInterest > settled ? accruedInterest - settled : 0;
        return loan.principal + netInterest;
    }

    /// @notice #408/#410/#413 (2026-06-12) — Gross interest owed on an
    ///         ERC-20 loan at settlement time, per the full-term FLOOR
    ///         model:
    ///
    ///         ```
    ///         floorDays     = useFullTermInterest ? durationDays : 0
    ///         effectiveDays = max(elapsedDays, floorDays)
    ///         gross         = proRataInterest(P, rate, effectiveDays)
    ///         ```
    ///
    ///         Callers (`LibSettlement.computePreclose` /
    ///         `computeRepayment`) subtract `loan.interestSettled`
    ///         (saturating at 0) before splitting treasury/lender so
    ///         interest already paid via partial-repay or periodic
    ///         settlement is credited exactly once.
    ///
    ///         Branches:
    ///         - Early repay (elapsed < duration, flag on) → effective
    ///           = duration → full-term floor. Lender made whole at
    ///           the original commitment ceiling.
    ///         - At maturity → identical to full-term.
    ///         - In grace (elapsed > duration) → effective = elapsed →
    ///           interest keeps accruing past full-term. (Late fee +
    ///           treasury split stay additive on top, unchanged.)
    ///         - Lender opt-out (`useFullTermInterest = false`) →
    ///           floorDays = 0 → pure pro-rata-elapsed. Both branches
    ///           still accrue through grace.
    ///
    ///         Pre-#408 the `true` branch returned `fullTermInterest`
    ///         directly, capping interest at the duration — blocked
    ///         grace accrual + over-charged on preclose after partial
    ///         (ignored `interestSettled`). The floor + accumulator-
    ///         credit pair fixes both.
    ///
    ///         Partial-repay accounting (Option A): #641 moved the
    ///         remaining-term counter off `durationDays` onto the dedicated
    ///         `interestRemainingDays` (decremented in `RepayFacet.repayPartial`
    ///         / partial liquidation / swap-to-repay by elapsed-since-last-
    ///         segment) so `floorDays` here reflects the borrower's REMAINING
    ///         commitment WITHOUT shrinking the term tuple that defines
    ///         maturity + grace. Read via `_remainingTermDays`.
    function settlementInterest(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        uint256 accrualStart = _accrualStart(loan);
        uint256 elapsedDays = nowTime > accrualStart
            ? (nowTime - accrualStart) / LibVaipakam.ONE_DAY
            : 0;
        uint256 floorDays = loan.useFullTermInterest ? _remainingTermDays(loan) : 0;
        uint256 effectiveDays = elapsedDays > floorDays ? elapsedDays : floorDays;
        return proRataInterest(loan.principal, loan.interestRateBps, effectiveDays);
    }

    /// @notice #408/#410/#413 — convenience wrapper that subtracts
    ///         `loan.interestSettled` (saturating at 0) from the gross
    ///         floor returned by `settlementInterest`. Use this from
    ///         `LibSettlement.compute*` + `RepayFacet.calculateRepaymentAmount`
    ///         so the split-treasury math operates on the NET amount.
    function settlementInterestNet(
        LibVaipakam.Loan storage loan,
        uint256 nowTime
    ) internal view returns (uint256) {
        return creditSettledInterest(loan, settlementInterest(loan, nowTime));
    }

    /// @notice #915 (M7) — credit `loan.interestSettled` against an
    ///         already-computed gross interest figure (saturating at 0).
    /// @dev    Periodic auto-liquidation forwards interest to the lender
    ///         (`loan.interestSettled += ...`) WITHOUT resetting the accrual
    ///         clock, so any raw pro-rata / full-term interest figure still
    ///         spans the settled periods. Every non-proper-close ERC-20
    ///         settlement (obligation-transfer Option 2, offset Option 3,
    ///         time-default, HF liquidation) routes its gross interest through
    ///         here so the already-paid portion is credited exactly once —
    ///         the same credit the proper-close paths get via
    ///         {settlementInterestNet}. Kept as a one-expression helper so
    ///         stack-tight callers (e.g. `PrecloseFacet.transferObligationViaOffer`
    ///         under viaIR) don't add a local for `settled`.
    function creditSettledInterest(
        LibVaipakam.Loan storage loan,
        uint256 grossInterest
    ) internal view returns (uint256) {
        uint256 settled = uint256(loan.interestSettled);
        return grossInterest > settled ? grossInterest - settled : 0;
    }

    /// @notice Applies the treasury cut to an interest-like amount, using the
    ///         fee BPS the loan was ORIGINATED under.
    /// @param loan           The loan whose treasury cut is being settled — its
    ///                       `treasuryFeeBpsAtInit` snapshot (via
    ///                       {LibVaipakam.effectiveTreasuryFeeBps}) sets the rate.
    /// @param interestAmount The interest-like amount to split.
    /// @return treasuryShare treasury's cut.
    /// @return lenderShare   the remainder the lender keeps.
    /// @dev #957 (#921 item 6): reads the per-loan snapshot, NOT the live
    ///      `cfgTreasuryFeeBps()`, so a mid-loan governance retune never
    ///      changes an open loan's settlement economics vs. the signed
    ///      receipt. `view`, not `pure`: the snapshot resolver touches
    ///      storage. A `0` snapshot (pre-#957 loan) falls back to the live
    ///      knob — see {LibVaipakam.effectiveTreasuryFeeBps}.
    function splitTreasury(
        LibVaipakam.Loan storage loan,
        uint256 interestAmount
    ) internal view returns (uint256 treasuryShare, uint256 lenderShare) {
        treasuryShare =
            (interestAmount * LibVaipakam.effectiveTreasuryFeeBps(loan)) /
            LibVaipakam.BASIS_POINTS;
        lenderShare = interestAmount - treasuryShare;
    }

    /// @notice Dynamic liquidator incentive in bps — `cfgMaxLiquidationSlippageBps`
    ///         (6%) minus realized slippage, capped at `cfgMaxLiquidatorIncentiveBps`
    ///         (3%) and any per-asset `liqBonusBps` ceiling.
    /// @dev    #1010 (L-h): shared by the single-route / split-route HF
    ///         liquidation paths AND the time-based-default swap path so all
    ///         three pay the SAME keeper incentive. Returns bps only; the caller
    ///         multiplies by `proceeds`. Kept as an `internal view` helper (one
    ///         audit surface for the incentive curve) — the surrounding
    ///         waterfall stays inline in each facet to respect the EIP-170
    ///         ceiling (a memory-struct-returning distributor inflates each
    ///         god-facet past 24,576 B).
    /// @param collateralAsset  Loan collateral asset (for the per-asset cap).
    /// @param proceeds         Actual swap proceeds.
    /// @param expectedProceeds Oracle-derived expected proceeds.
    function liquidatorIncentiveBps(
        address collateralAsset,
        uint256 proceeds,
        uint256 expectedProceeds
    ) internal view returns (uint256 incentiveBps) {
        uint256 maxSlippageBps = LibVaipakam.cfgMaxLiquidationSlippageBps();
        uint256 realizedSlippageBps;
        if (proceeds < expectedProceeds && expectedProceeds != 0) {
            realizedSlippageBps =
                ((expectedProceeds - proceeds) * LibVaipakam.BASIS_POINTS) / expectedProceeds;
            if (realizedSlippageBps > maxSlippageBps) realizedSlippageBps = maxSlippageBps;
        }
        incentiveBps = maxSlippageBps - realizedSlippageBps;
        uint256 maxIncentiveBps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        if (incentiveBps > maxIncentiveBps) incentiveBps = maxIncentiveBps;
        uint256 assetCapBps =
            LibVaipakam.storageSlot().assetRiskParams[collateralAsset].liqBonusBps;
        if (assetCapBps != 0 && incentiveBps > assetCapBps) incentiveBps = assetCapBps;
    }
}
