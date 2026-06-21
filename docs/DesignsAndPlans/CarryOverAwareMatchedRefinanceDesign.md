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

**Adversarial review (PR #682) established the load-bearing correction:**
carry-over awareness must be threaded into **`LibOfferMatch.previewMatch`** —
the single source of truth for `matchAmount`, `reqCollateral`, and the synthetic
HF/LTV gate — not bolted onto `_executeMatch` after the preview. `previewMatch`
today returns `MatchError.RefinanceTagged` for *any* tagged offer **before**
computing the match, so an `_executeMatch`-only change would leave the feature
unmatchable (and bot previews would still skip it). The design below is
preview-centric.

### 3.1 Admission — `previewMatch` + the facet guard (mirror each other)

A tagged borrower offer is matchable **iff**

1. `offer.refinanceCarryOver == true` (passed the full #576 create-time
   predicate: tagged + non-transferred + single-value collateral + exact
   collateral identity + live old-loan lien), **and**
2. `offer.fillMode == FillMode.Aon`, **and**
3. `offer.amountMax == offer.amount` re-checked **at match time** (see §3.5 —
   defends against post-create mutation).

`previewMatch` replaces its blanket `RefinanceTagged` rejection with this same
admission test (so previews and the on-chain guard agree); any tagged offer that
fails it still maps to `RefinanceTagged` / `RefinanceTaggedOfferNotMatchable`.
The lender offer is never refinance-tagged. Fail closed on every miss.

### 3.2 Force the AON amount to the borrower's full `amount` (lender may stay open)

`previewMatch` currently sets `matchAmount = midpoint(...)` and *then* applies the
AON gate `matchAmount == amount`. For an open lender range with
`lenderRemaining > borrower.amount` the midpoint exceeds `borrower.amount`, so an
AON borrower match would revert `AonRequiresFullFill` — the lender could never be
left partially open. The fix: when the **borrower** side is an admitted AON
carry-over offer, **select `matchAmount = borrower.amount` directly** (its full
single-fill size), bypassing the midpoint, and fill that amount from the lender
(the lender offer is partially filled and stays open for its remainder). The
borrower-side AON invariant (`matchAmount == amount && amountFilled == 0`) holds
by construction.

### 3.3 Pin collateral to the carried amount + risk-check the pinned value

For a carry-over match the collateral is **fixed** at the old loan's amount
(== `offer.collateralAmount`, guaranteed by the #576 predicate). Inside
`previewMatch`, for an admitted carry-over offer:

- set `reqCollateral = offer.collateralAmount` (the carried amount), NOT the
  lender-derived pro-rata — so the value that flows into `matchOverride`, the
  `RefinanceFacet` identity gate, and the lien math is the carried amount (P2
  fixed); and
- evaluate the **synthetic HF/LTV init gate on the pinned carried collateral**,
  not on the lender-derived `reqCollateral`. Otherwise a lender asking for *less*
  collateral than the old loan carries could trip `MatchHFTooLow` / `LtvAboveTier`
  in preview even though the carried amount comfortably satisfies the init gate
  (Finding #4).
- **Reject** (`RefinanceCarryOverCollateralShortfall`) when the lender's
  full-`amount` collateral requirement exceeds the carried amount: carry-over
  pledges no fresh collateral to top up, so the lender's terms cannot be met.
  When the requirement is `<=` carried, the lender is at-least-fully-secured and
  the borrower keeps their full carried collateral — safe.

`_executeMatch` then consumes the already-carry-over-aware `mr` unchanged
(`mo.collateralAmount = mr.reqCollateral`, which now equals the carried amount).

### 3.4 Dust-close: skip the collateral refund for carry-over

The borrower dust-close path increments `collateralAmountFilled` by
`mr.reqCollateral` and withdraws `collateralAmountMax − collateralAmountFilled`
as excess. A carry-over offer pledged **no fresh collateral** (the deposit was
skipped at create), and the old lien encumbers the full carried amount until the
retag — so this refund would either revert at the vault-withdraw guard (no free
balance) or withdraw *unrelated* free collateral (Finding #3). For a carry-over
offer the dust-close branch MUST **skip the collateral refund entirely** (there
is nothing to refund; the carried lien is untouched and about to be retagged).
The offer-collateral-lock release is likewise a no-op for carry-over (no offer
lock was taken). Only the `accepted = true` flip, the metrics hook, and the
retag hook run.

### 3.5 Preserve the AON single-value invariant across offer mutation

The §2 proof relies on `amountMax == amount` at match time, but
`setOfferAmount` / `modifyOffer` only enforce `amountMax >= amount`. A borrower
could create an AON carry-over offer, then widen `amountMax` (keeping the old
principal inside the range so accept-time refinance validation still passes); an
AON match of `amount` would then leave `borrowerRemaining = amountMax − amount`
nonzero, the dust-close branch would NOT run, and the P1 uncollateralized-loan
window returns (Finding #5). Defense, both layers:

- **Mutation guard:** when an offer is carry-over-tagged
  (`refinanceTargetLoanId != 0`), the amount mutators must either forbid
  `amountMax != amount` or strip the carry-over/tag on widening (re-validating
  the predicate). Preferred: forbid breaking `amountMax == amount` while tagged.
- **Match-time assertion (belt-and-braces):** the §3.1 admission re-checks
  `amountMax == amount`, so even a mutated offer that slipped through is rejected
  at match.

### 3.6 Atomic retag — reuse the existing hook (unchanged)

The dust-close hook at `OfferMatchFacet` L1117 already calls
`RefinanceFacet.refinanceLoanFromAccept(bm.refinanceTargetLoanId,
borrowerOfferId)` when `bm.refinanceTargetLoanId != 0`. §2 + §3.2 + §3.5
guarantee an admitted AON carry-over fill always reaches dust-close in the same
tx with `borrowerRemaining == 0`. The retag's own strict checks (#576 round-7:
same-key retag, live-lien requirement, full collateral-identity re-assertion)
remain the last line of defense, unchanged.

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

- **No uncollateralized loan ever persists across a tx boundary** (§2 + §3.5).
- **`newLoan.collateralAmount == oldLoan.collateralAmount`** at the retag
  (guaranteed by the §3.3 preview pin + the #576 create-time predicate).
- **Risk gates evaluate on the carried (pinned) collateral**, never the
  lender-derived pro-rata, for a carry-over match (§3.3).
- **No fresh collateral is pulled or refunded** for a carry-over match — the
  carried lien is the only collateral and is retagged, not re-pledged; the
  dust-close refund + offer-lock release are skipped (§3.4).
- The old lien is **retagged, never release+create** for carry-over (the #576
  round-7 strict-key rule).
- **`matchAmount == borrower.amount` exactly** for an admitted carry-over match
  (§3.2) and `amountMax == amount` holds at match time (§3.5) — so the single
  full fill always reaches dust-close in the same tx.
- A tagged offer that fails any admission condition reverts in BOTH `previewMatch`
  and the on-chain guard (no silent fall-through to the fresh-pledge path).
- The lender offer may still be **partially** filled by this AON borrower match
  (only the borrower/refinance side is constrained to AON).
- Sanctions / exclusion gates on the match path are unchanged.

---

## 6. Implementation sketch (edit sites)

1. **`LibOfferMatch.previewMatch`** (the heart of the change):
   - replace the blanket `RefinanceTagged` rejection with the §3.1 admission
     (AON + carry-over + `amountMax == amount`); non-qualifying tagged → error;
   - §3.2 — for an admitted carry-over borrower side, select
     `matchAmount = borrower.amount` (bypass the midpoint) so the lender side can
     be partially filled;
   - §3.3 — set `reqCollateral = offer.collateralAmount` (carried), run the
     synthetic HF/LTV gate on that pinned value, and return a shortfall error
     code when the lender's full-`amount` requirement exceeds it.
2. `OfferMatchFacet` guard (~L719) — mirror the §3.1 admission so the on-chain
   path agrees with the preview.
3. `OfferMatchFacet._executeMatch` dust-close (~L1056-1126) — §3.4: skip the
   collateral refund + offer-lock release for carry-over; retag hook (L1117)
   unchanged. The `mo.collateralAmount = mr.reqCollateral` install (~L824) needs
   no special case (preview already pinned it).
4. Amount mutators (`setOfferAmount` / `modifyOffer`) — §3.5 guard: forbid
   breaking `amountMax == amount` while carry-over-tagged.
5. New error(s): `RefinanceCarryOverCollateralShortfall` (+ a `MatchError`
   variant for the preview side). No new external functions → no diamond-cut /
   selector change; inlined errors → one ABI re-export.

## 7. Test matrix

- AON carry-over offer matched → single full fill, replacement loan created,
  old lien **retagged** onto it (assert the new loan's lien is present + keyed to
  the borrower immediately after the match — no uncollateralized window), old
  loan terminal.
- **previewMatch** returns a matchable result for an admitted AON carry-over
  offer (bot-preview parity), with `matchAmount == borrower.amount` and
  `reqCollateral == carried`.
- Carry-over offer with `fillMode != Aon` → rejected (preview + on-chain).
- Carry-over offer mutated to `amountMax > amount` → mutation reverts (§3.5
  guard); and if forced into storage, the match-time admission rejects it.
- Non-carry-over tagged offer (transferred / ranged) → still rejected.
- Lender requires MORE collateral than carried → `RefinanceCarryOverCollateralShortfall`.
- Lender requires LESS than carried → match succeeds; HF/LTV evaluated on the
  carried amount (not the smaller lender value); `newLoan.collateralAmount ==`
  carried (identity gate passes); lender over-secured; **no spurious collateral
  refund / withdraw at dust-close** (assert borrower free balance untouched).
- Lender offer partially filled by the AON borrower match → lender offer stays
  open with reduced remaining; borrower offer terminal.
- Regression: untagged matched offers + direct-accept refinance unchanged.

---

## 8. Open questions for review

1. **Create-time vs match-time AON enforcement** (reinforced by Finding #5):
   forbid `fillMode != Aon` / `amountMax != amount` at **create** whenever
   `refinanceCarryOver` would be set, vs. enforce only at match + in the mutators
   (this design). Create-time is the earliest, clearest failure and removes the
   mutation-window class entirely, at the cost of coupling the #576 carry-over
   predicate to fill-mode. **Recommendation: enforce at create-time too** (make
   carry-over imply AON single-value from birth) AND keep the match-time
   assertion as defense-in-depth. Seeking ratification.
2. On mutation of a carry-over offer, **strip** the carry-over flag (fall back to
   the fresh-pledge legacy path) vs. **freeze** the amount (this design)?
   Stripping is more permissive but re-introduces fresh-pledge accounting;
   freezing is simpler + safer. Open.
