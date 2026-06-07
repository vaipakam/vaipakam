# Interest Settlement — Full-Term Floor Model + `interestSettled` Accumulator

**Status:** Design (pending implementation) · **Date:** 2026-06-07
**Resolves cards:** [#408] (interest model), [#410] (parallel-sale pro-rata), [#413] (live preclose double-charge)
**Independent (not covered here):** [#411] refinance over-pay — see `RefinanceOldLenderOverpayFix.md`

> Scope this doc to the ERC-20 + NFT *borrower-initiated settlement* interest. Default / HF-liquidation / fallback interest is intentionally **out of scope** (those compute their own seconds-based accrual and never read the flag — see §6).

---

## 1. Problem

Platform ethos: **once a loan is initiated the lender is entitled to the full committed-term interest**; pro-rata applies only to (a) the consented `allowsPartialRepay` path and (b) obligation-transfer/offset mechanics. Verified current behaviour diverges in three places:

| Path | Today | Should be |
| --- | --- | --- |
| `repayLoan` early full repay | pro-rata on elapsed (`settlementInterest` → `accruedInterestToTime`) | full-term floor |
| Parallel-sale settlement (#410) | pro-rata (floor hedges full duration but settlement under-pays) | full-term floor |
| `precloseDirect` after partial/periodic (#413) | **double-charges** — `computePreclose` charges full-term and credits nothing already paid | full-term minus already-paid |

Root causes:
- `useFullTermInterest` is **unreachable dead code** — `CreateOfferParams` has no field, so `Offer.useFullTermInterest` is never set; the only write is `loan.useFullTermInterest = offer.useFullTermInterest` (`LoanFacet.sol:745`) → always `false`.
- A *flat* full-term value (`fullTermInterest(durationDays)`) would also be wrong: it **caps** interest at the duration, so it loses **grace-period accrual** (owner decision: interest must keep accruing past maturity during grace).
- No "interest already paid toward payoff" accumulator exists, so any full-term settlement re-charges interest already collected via partial-repay or periodic settlement.

---

## 2. Design — full-term **floor**, credited by `interestSettled`

Unify every borrower-initiated ERC-20 settlement to:

```
owed = proRataInterest(principal, rateBps, max(elapsedDays, floorDays)) − interestSettled
       (saturating at 0)
  where floorDays  = useFullTermInterest ? durationDays : 0
        elapsedDays = (now − startTime) / 1 day
```

Behaviour:
- **Early repay** (`elapsed < duration`, flag on) → `max = duration` → full-term floor. Lender made whole.
- **At maturity** → identical to full-term.
- **In grace** (`elapsed > duration`) → `max = elapsed` → keeps accruing past full-term, **plus** late fee + treasury/other charges (added on top, unchanged).
- **Lender opt-out** (`useFullTermInterest = false`) → `floorDays = 0` → pure pro-rata-elapsed (borrower pays only for time used). Both branches still accrue through grace.

This **collapses `computePreclose` and `computeRepayment` into one formula** (preclose is just the pre-maturity case where `max(elapsed,duration) = duration`), which is what removes the #413 divergence by construction. `interestSettled` is the credit term that removes the double-charge.

### Late-in-grace (owner decision: keep accruing)
The floor is a **floor, not a cap** — `max(elapsed, duration)` already lets interest exceed full-term during grace. Late fee (`LibVaipakam.calculateLateFee`, 1%→5%) and treasury split stay additive and unchanged.

### NFT rentals (owner decision: full rental on early return)
Mirror the floor in the NFT branch: `rental = principal × max(elapsedDays, durationDays)` (principal = daily fee). Early return therefore forfeits the unused-days refund (lender gets full rental) — consistent with `precloseDirect`'s existing NFT branch (`PrecloseFacet.sol:296`) which already charges full remaining term. Grace overage drawn per existing buffer/late handling. `calculateRepaymentAmount` NFT branch (`RepayFacet.sol:977-990`) updated to the same floor.

---

## 3. Storage changes (`LibVaipakam.sol`)

- **`Loan.interestSettled`** — NEW `uint128`, **appended at the end** of the `Loan` struct (append-only rule; the 8-byte remnant in slot 9 only fits a `uint64`, and interest amounts need `uint128`, so do NOT pack it there — append a fresh field after the current last field `allowsPrepayListing` ~line 1521). Cumulative interest already paid toward this loan.
- **`CreateOfferParams.useFullTermInterest`** — NEW `bool`, appended to the params struct (`LibVaipakam.sol:1037-1157`); **default true** at the offer-builder layer.
- `Offer.useFullTermInterest` (`:1202`) and the copy `LoanFacet.sol:745` already exist — no change beyond now actually being set.

---

## 4. Code changes by site

| File:func | Change |
| --- | --- |
| `LibEntitlement.settlementInterest` (`:57-65`) | Replace the `if useFullTermInterest → fullTermInterest(duration)` branch with `proRataInterest(principal, rate, max(elapsedDays, useFullTermInterest ? durationDays : 0))`. Subtract `loan.interestSettled` (saturating) at the **single** call boundary (see note). |
| `LibSettlement.computePreclose` (`:70-88`) | Stop calling `fullTermInterest` directly; route through the unified `settlementInterest` so it gets the floor **and** the `interestSettled` credit. (Pre-maturity ⇒ identical full-term result, now credited.) |
| `LibSettlement.computeRepayment` (`:47-63`) | Already routes through `settlementInterest`; gains the floor + credit automatically. |
| `RepayFacet.calculateRepaymentAmount` (`:949-998`) | ERC-20 + NFT branches use the floor (`max(elapsed,duration)`) and subtract `interestSettled`, so the view matches settlement. |
| `RepayFacet.repayLoan` NFT branch (`:370-420`) | Apply NFT floor (`principal × max(elapsed,duration)`), credit `interestSettled`. |
| `RepayFacet.repayPartial` (`:636-769`) | On every partial, **increment `loan.interestSettled`** by the interest portion just paid (ERC-20 `:638-660`, NFT days `:712`). See §5 for the startTime/duration reconciliation. |
| Periodic settle (`RepayFacet.settlePeriodicInterest` auto-liq `:1256-1271`; inline advance `:679-705`) | Increment `interestSettled` by interest actually transferred to the lender each period. |
| `OfferParallelSaleFacet` settlement (#410) | The completion/settlement that pays the lender must route through the unified `settlementInterest` (floor) so the lender gets full-term — the pre-loan floor already hedges full duration (`:417-487`), so it is fully collateralised. |
| `OfferCreateFacet._writeOfferPrincipalFields` (`:1070+`) | Write `offer.useFullTermInterest = params.useFullTermInterest`. |

**Single-credit note:** apply the `− interestSettled` subtraction in exactly one place (inside `settlementInterest`, or once in each `compute*`), never twice, or the credit double-counts. Recommend: keep `settlementInterest` returning the *gross* floor amount and subtract `interestSettled` once inside `LibSettlement.compute*` so the split math (treasury/lender) operates on the net.

---

## 5. The key implementation decision — partial-repay accounting

`repayPartial` mutates state differently by asset type:
- **ERC-20** (`:660-663`): `principal -= partialAmount`; **`startTime = now`** (accrual clock reset); `durationDays` **unchanged**.
- **NFT** (`:746`): `durationDays -= partialAmount` (days); `startTime`/`principal` unchanged.

The ERC-20 `startTime` reset means `elapsedDays` after a partial is measured from the last partial, while `durationDays` still reflects the *original* full term — so a naive `max(elapsed, durationDays)` would re-grant a fresh full term on the reduced principal. Two options:

- **Option A (recommended) — track remaining committed term.** On an ERC-20 partial, also reduce the floor basis: either decrement `durationDays` by the elapsed-since-last-segment, or add an explicit `remainingTermDays` field. Then `floorDays = remainingTermDays` and `interestSettled` credits paid interest. Cleanest, makes the floor mean "remaining committed term."
- **Option B — keep reset semantics, rely on the accumulator.** Leave `repayPartial` as-is; `interestSettled` accumulates every paid amount and the final `owed = grossFloor − interestSettled` saturates. Simpler diff, but the floor basis (`durationDays` vs reset `startTime`) must be reasoned about carefully to avoid over/under-grant; needs a dedicated property test.

**DECISION (2026-06-07): Option A chosen.** On an ERC-20 partial repay, reduce the remaining committed term explicitly (track remaining-term days / decrement `durationDays` by the elapsed-since-last-segment) so `floorDays = remaining committed term` and `interestSettled` credits paid interest. This makes the floor self-evidently correct and matches the NFT branch (which already reduces `durationDays`). Implementation note: choose between (i) decrementing `loan.durationDays` in place on each ERC-20 partial, or (ii) adding an explicit `remainingTermDays` field — (i) reuses the existing field but changes its meaning post-partial; (ii) is more explicit but adds storage. Prefer (i) for storage economy unless a consumer relies on `durationDays` meaning the original term (audit call sites first).

---

## 6. Explicitly out of scope (do NOT change)

- **Default / HF-liquidation / fallback interest** — `DefaultedFacet.sol:351-352`, `RiskFacet._calculateCurrentBorrowBalance:1844-1846`, `LibFallback.computeFallbackEntitlements:121-122` all use seconds-based accrual and never read the flag. Intentionally interest-model-agnostic (no dispute over interest at liquidation). Leave as-is.
- **Refinance / obligation-transfer / offset economics** — spec-compliant (lender made whole by continuation/shortfall). The only refinance issue is the over-pay bug in #411 (separate doc).

---

## 7. Test plan

- New: `useFullTermInterest=true` early full repay → lender receives full-term (floor).
- New: grace-period repay → interest = pro-rata-elapsed (> full-term) + late fee (floor did not cap).
- New (regression for #413): periodic-cadence loan, settle ≥1 period, then `precloseDirect` → no double-charge (credited via `interestSettled`).
- New (regression for #413): `allowsPartialRepay` loan, partial repay, then `precloseDirect` and then `repayLoan` → both credited.
- New (#410): parallel-sale fill → lender receives full-term.
- Lender opt-out (`false`) → pure pro-rata early repay.
- Re-derive `test/invariants/InterestMonotonicity.invariant.t.sol` — `max(elapsed,duration)` is monotonic, so the property should still hold; the `− interestSettled` step is a state mutation excluded from the time-warp probe. **Re-verify, don't assume.**
- Update existing value-asserting tests in `RepayFacetTest.t.sol` (`:493-509, 520-530, 1025-1047`) and `LibCollateralSettlementTest.t.sol`.

---

## 8. Acceptance criteria

`Loan.interestSettled` added (append-only); unified floor settlement across `settlementInterest`/`compute*`/`calculateRepaymentAmount`/NFT branch/parallel-sale; `useFullTermInterest` wired into `CreateOfferParams` (default true) + lender opt-out surfaced in the frontend; partial-accounting Option chosen + tested; invariant re-derived; existing tests updated; `_CodeVsDocsAudit.md` entries for #408/#410/#413 cleared; release-note fragment; ABI re-export (CreateOfferParams shape changed → frontend sync per CLAUDE.md).

[#408]: https://github.com/vaipakam/vaipakam/issues/408
[#410]: https://github.com/vaipakam/vaipakam/issues/410
[#411]: https://github.com/vaipakam/vaipakam/issues/411
[#413]: https://github.com/vaipakam/vaipakam/issues/413
