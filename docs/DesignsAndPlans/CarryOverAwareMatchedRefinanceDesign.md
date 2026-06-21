# Carry-Over-Aware Matched Refinance (#595)

**Status:** Design proposal — awaiting adversarial review + ratification.
**Builds on:** #576 (collateral carry-over), #549 / [`T092AtomicAcceptAndRefinance.md`](T092AtomicAcceptAndRefinance.md)
(the atomic accept-and-refinance hook), [`SignedOfferMatcherV06Design.md`](SignedOfferMatcherV06Design.md)
(`_executeMatch` shared path).
**Supersedes the stop-gap in:** PR #593 (refinance-tagged offers made
direct-accept-only).

---

## 1. Context — why matched refinance is currently disabled

#576 introduced **collateral carry-over**: a refinance-tagged borrower offer
(`refinanceCarryOver == true`) reuses the *old* loan's collateral lien in place
instead of pledging a fresh batch. At loan-init, `LoanFacet` therefore **skips
both the collateral deposit and the fresh lien** for a carry-over offer, relying
on `RefinanceFacet.refinanceLoanFromAccept` to atomically **retag** the old
lien onto the replacement loan.

Codex review of PR #593 found two ways this breaks on the `matchOffers`
(range-orders / partial-fill) path, so #593 shipped a stop-gap: `matchOffers`
reverts `RefinanceTaggedOfferNotMatchable` for **any** tagged offer (guard at
`OfferMatchFacet` ~L719). The atomic-retag hook in the dust-close branch
(~L1117) was retained as dormant wiring for this card.

### Bug P1 — uncollateralized-loan window (partial fill before dust-close)

The retag fires only inside the **dust-close** branch
(`borrowerRemaining < bm.amount`). On a *partial* fill where the borrower offer
still has capacity (`borrowerRemaining >= bm.amount`), the fill **creates the
replacement loan** (deposit + lien skipped) but the dust-close branch does
**not** run, so the retag never fires and the transaction ends with an
**uncollateralized loan** exposed to the new lender.

### Bug P2 — unfillable identity gate (collateral divergence)

For a matched fill, `LoanFacet` copies `matchOverride.collateralAmount`
(= `previewMatch`'s lender-derived `reqCollateral` midpoint), which can differ
from the borrower's fixed carried collateral. `RefinanceFacet`'s carry-over
identity check requires `newLoan.collateralAmount == oldLoan.collateralAmount`,
so the match reverts unless the lender's required collateral happens to equal
the old loan's exactly.

---

## 2. Key insight — a refinance is intrinsically All-Or-Nothing

A refinance **replaces one old loan with one new loan**. There is exactly **one**
old collateral lien to retag. Partial fills would create **N** replacement loans
from N slices, but there is only **one** old lien — N−1 of them could never be
collateralized by carry-over (they pledged no fresh collateral). So partial
matched-refinance is not merely risky, it is **incoherent**.

Forcing the carry-over offer to be **AON (all-or-nothing, single full fill)**
therefore both:

- **Structurally eliminates P1.** For an AON full fill the borrower offer is
  consumed in a single slice: `amountFilled` becomes `amount`, so
  `borrowerRemaining = amountMax − amountFilled = 0 < amount` and the dust-close
  branch **runs in the same transaction as the fill** — the retag fires before
  the tx ends. There is no cross-transaction window in which an uncollateralized
  loan exists. (Verified against the current `_executeMatch` dust-close gate at
  `OfferMatchFacet` L1056.)
- **Matches the one-loan-one-retag invariant.** Exactly one replacement loan is
  created and exactly one retag fires.

The existing dust-close retag hook (L1117) already does the right thing once an
AON carry-over offer is *admitted* — so requirement "atomic retag on every
matched fill" needs **no new wiring**; it needs only the AON constraint that
makes "every fill" mean "the one full fill."

---

## 3. Proposed design

### 3.1 Admit only AON carry-over offers (relax the guard)

Replace the blanket `refinanceTargetLoanId != 0` rejection with: a tagged
borrower offer is matchable **iff**

1. `offer.refinanceCarryOver == true` — it passed the full #576 carry-over
   predicate at create-time (tagged + non-transferred + single-value collateral
   + exact collateral identity + live old-loan lien), **and**
2. `offer.fillMode == FillMode.Aon` — single full fill.

Any tagged offer that is **not** carry-over (transferred / ranged /
collateral-mismatched / no-lien) or **not** AON stays rejected with
`RefinanceTaggedOfferNotMatchable`. The lender offer is never refinance-tagged,
so the guard only inspects the borrower side. (A tagged carry-over offer that is
not AON is a borrower/frontend misconfiguration — fail closed.)

### 3.2 Pin the matched collateral to the carried amount

For a carry-over match, the loan's collateral is **fixed** at the old loan's
amount (== `offer.collateralAmount`, guaranteed equal by the #576 carry-over
predicate). In `_executeMatch`, when the borrower offer is carry-over:

- **Pin** `matchOverride.collateralAmount = offer.collateralAmount` (the carried
  amount) instead of the lender-derived `mr.reqCollateral`. This makes
  `RefinanceFacet`'s identity check pass (P2 fixed).
- **Reject** if the lender's full-fill collateral requirement exceeds the carried
  amount (`mr.reqCollateral > offer.collateralAmount`): the carried collateral
  cannot satisfy the lender's terms and carry-over pledges no fresh collateral to
  top it up. Revert with a dedicated error
  (e.g. `RefinanceCarryOverCollateralShortfall`). When `reqCollateral <=` carried,
  the lender is at-least-fully-secured and the borrower keeps their full
  collateral — safe.

Because the offer is AON full-size, `mr.reqCollateral` is the lender's
requirement at the full `amount`, so this is a single clean comparison.

### 3.3 Atomic retag — reuse the existing hook

No change. The dust-close hook at `OfferMatchFacet` L1117 already calls
`RefinanceFacet.refinanceLoanFromAccept(bm.refinanceTargetLoanId,
borrowerOfferId)` when `bm.refinanceTargetLoanId != 0`, and §2 establishes that
an AON full fill always reaches dust-close in the same tx. The retag's own
strict checks (#576 round-7: same-key lien retag, live-lien requirement, full
collateral-identity re-assertion) remain the last line of defense and are
unchanged.

---

## 4. Alternatives considered

- **(A — chosen) AON-only matched refinance.** Coherent, structurally
  P1-free, minimal new surface, reuses the dust-close hook.
- **(B — rejected) Partial-fill matched refinance.** Would require splitting the
  single old lien across N replacement loans + per-fill retag accounting. There
  is only one old lien; N−1 slices would be uncollateralized. Incoherent with the
  carry-over model. Rejected.
- **(C — rejected) Auto-coerce any tagged offer to AON at match time.** Mutating
  the caller's `fillMode` implicitly is surprising and could mis-price a
  borrower who set a range deliberately. Prefer explicit `fillMode == Aon`
  required + fail-closed. Rejected in favor of 3.1.

---

## 5. Invariants to preserve

- **No uncollateralized loan ever persists across a tx boundary** (§2).
- **`newLoan.collateralAmount == oldLoan.collateralAmount`** at the retag
  (guaranteed by 3.2 pin + the #576 create-time predicate).
- The old lien is **retagged, never release+create** for carry-over (the #576
  round-7 strict-key rule; carry-over pledged no fresh collateral).
- A tagged offer that fails any admission condition reverts (no silent
  fall-through to the fresh-pledge path).
- The lender offer may still be **partially** filled by this AON borrower match
  (only the borrower/refinance side is constrained to AON).
- Sanctions / exclusion gates on the match path are unchanged.

---

## 6. Implementation sketch (edit sites)

1. `OfferMatchFacet` (~L719) — replace the blanket tagged-offer reject with the
   §3.1 admit-AON-carry-over / reject-rest logic.
2. `OfferMatchFacet._executeMatch` (~L824) — when the borrower offer is
   carry-over, pin `mo.collateralAmount` to `offer.collateralAmount` and add the
   §3.2 shortfall reject (new error).
3. No change to the dust-close retag hook (L1117) or `RefinanceFacet`.
4. Selector set unchanged (no new external functions) → no diamond-cut /
   ABI-export change; the new error inlines into `OfferMatchFacet`'s ABI (one
   re-export).

## 7. Test matrix

- AON carry-over offer matched → single full fill, replacement loan created,
  old lien retagged to it, old loan terminal, **no uncollateralized window**
  (assert lien present on the new loan immediately after the match).
- Carry-over offer with `fillMode != Aon` → `RefinanceTaggedOfferNotMatchable`.
- Non-carry-over tagged offer (transferred / ranged) → still rejected.
- Lender requires more collateral than carried → `RefinanceCarryOverCollateralShortfall`.
- Lender requires less/equal → match succeeds, `newLoan.collateralAmount ==`
  carried (identity gate passes), lender over-secured.
- Lender offer partially filled by the AON borrower match → lender offer stays
  open with reduced remaining; borrower offer terminal.
- Regression: untagged matched offers + direct-accept refinance unchanged.

---

## 8. Open questions for review

1. Should a tagged carry-over offer that is **not** AON revert at **match** time
   (this design) or be rejected earlier at **create** time (force
   `fillMode == Aon` whenever `refinanceCarryOver` is set)? Create-time rejection
   gives an earlier, clearer failure but couples the carry-over predicate to
   fill-mode. Leaning match-time (keeps #576's predicate orthogonal), but open.
2. Confirm there is no path where an AON borrower offer can be left
   `amountFilled > 0` without reaching dust-close (the AON pre-gate
   `amountFilled == 0 && matchAmount == amount` should preclude it — to be
   re-verified adversarially).
