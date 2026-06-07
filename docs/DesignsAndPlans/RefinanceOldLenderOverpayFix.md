# Refinance — Old-Lender Shortfall: redundant over-compensation (spec + code)

**Status:** Design — **Option 1 selected (2026-06-07)**: drop the refinance shortfall + update spec §2127/§2138 · **Date:** 2026-06-07 (corrected)
**Card:** [#411]
**Independent of:** the interest floor-model change (`InterestSettlementFloorModel.md`)

> **Correction (2026-06-07):** an earlier draft of this doc called this a code-vs-spec *bug* ("code exceeds spec"). That was wrong — the spec **explicitly documents** the shortfall (see §3). This is therefore a deliberate **economic-policy decision** (change spec + code together), not a silent bug fix.

---

## 1. Current behaviour

In `RefinanceFacet.refinanceLoan` the original lender **exits** the loan fully repaid and receives `principal + full-term interest + shortfall`:

```solidity
oldInterest         = fullTermInterest(oldLoan.principal, oldLoan.interestRateBps, oldLoan.durationDays); // :172
newExpectedInterest = fullTermInterest(offer.amount, offer.interestRateBps, offer.durationDays);          // :179
shortfall           = newExpectedInterest < oldInterest ? oldInterest - newExpectedInterest : 0;          // :184-187
interestPortion     = oldInterest + shortfall;                                                            // :196
```

The old lender exits — `s.lenderClaims[oldLoanId]` is set and the old loan closes (`:246`). Their capital is returned early to redeploy.

## 2. The economic question

**Full-term interest is the maximum the old lender could ever have earned** on that loan (the run-to-maturity, no-early-payoff case). An exiting lender paid full-term is therefore **strictly whole** — there is no scenario where they are worse off, so there is nothing for a shortfall to compensate. `oldInterest + shortfall = P + 2·oldFullTerm − newFullTerm` pays them **beyond their maximum**, funded by the borrower.

**Contrast the transfer path** (`PrecloseFacet.transferObligationViaOffer:480-486`): there the lender **stays on the loan** and earns the *new* (possibly lower) rate going forward, so `accrued + shortfall` is genuinely required to bridge back up to full term. **The shortfall is necessary in transfer, redundant in refinance** — so any change here is **refinance-path only**; the transfer/offset shortfall must stay.

## 3. What the spec says (the reason this is NOT a bug)

`docs/FunctionalSpecs/ProjectDetailsREADME.md`:
- **§2127** (frontend warning): *"the old lender is repaid with principal plus full-term interest, not merely accrued-to-date interest, **plus any rate shortfall required to keep the original lender whole.**"*
- **§2138/§2142** (Original Lender Protection Rule): the borrower must cover the shortfall when the new offer implies lower lender-side economics.

So the **code faithfully implements the documented spec.** The redundancy is in the *spec's* economics (likely the transfer-path protection concept carried into refinance, where the lender exits rather than continues).

## 4. Options — **Option 1 selected (2026-06-07)**

- **✅ Option 1 — Drop the shortfall on refinance (SELECTED).** `interestPortion = oldInterest`. Fair economics: old lender made whole at their ceiling; borrower not over-charged. **Requires editing the spec** (§2127 to drop the "plus any rate shortfall" clause for refinance; §2138/§2142 to clarify that full-term already satisfies the protection rule for an *exiting* lender) **and** `RefinanceFacet` (remove the `newExpectedInterest`/`shortfall` block). Refinance-path only.
- **Option 2 — Keep as-is.** Matches current spec, but intentionally over-rewards the original lender at borrower expense — only justifiable as a deliberate anti-disruption/loyalty subsidy.

## 5. Implementation (if Option 1)

```solidity
uint256 interestPortion = oldInterest;   // drop `+ shortfall`
```
Remove the now-dead `newExpectedInterest` / `shortfall` locals from the refinance path (they have no other consumer there). Treasury split + VPFI-discount handling below are unchanged. **Edit `ProjectDetailsREADME.md` §2127 + §2138/§2142** in the same PR so spec and code stay aligned. No ABI change (internal economics only).

## 6. Test plan

- Refinance to a **lower-yield** new offer → old lender receives exactly `principal + fullTermInterest(old) − treasuryFee`, **no** shortfall addend; borrower pays exactly that (+ treasury).
- Refinance to an **equal/higher-yield** offer → unchanged (shortfall was already 0).
- Confirm the **transfer/offset** path shortfall is untouched (regression).

## 7. Acceptance criteria

Decision recorded; if Option 1: `RefinanceFacet` `interestPortion = oldInterest`, dead locals removed, **spec §2127/§2138 updated**, test asserting exact old-lender receipt, transfer-path regression, `_CodeVsDocsAudit.md` entry, release-note fragment.

[#411]: https://github.com/vaipakam/vaipakam/issues/411
