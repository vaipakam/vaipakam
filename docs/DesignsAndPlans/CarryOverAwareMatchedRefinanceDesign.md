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

### 3.1 Admission — `previewMatch` must MIRROR the full atomic preconditions

**Principle (PR #682 round 2): `previewMatch` admission must be a faithful
predictor of the atomic accept/refinance path**, not just a carry-over-shape
check. The atomic path (`acceptOfferInternal` → `refinanceLoanFromAccept`)
re-runs `LibAutoRefinanceCheck.validate` + the auto-refinance caps / kill-switch
/ period-settlement gates *before* creating the loan; if preview admits a pair
those gates would reject, bots get repeated **false-positive** matches against a
stale/ungated offer. So a tagged borrower offer is matchable **iff** ALL hold:

1. `offer.refinanceCarryOver == true` (the #576 create-time predicate), **and**
2. `offer.fillMode == FillMode.Aon` and `offer.amountMax == offer.amount`
   (re-checked at match time — §3.5), **and**
3. **Live freshness** (re-evaluated at preview/match, NOT trusted from the
   create-time snapshot): the target loan is still active, the offer creator is
   still the current borrower-position-NFT holder, the old-loan lien is still
   live, and `offer.amount == target loan outstanding principal`. (Round-2
   Findings 1+2.) **and**
4. **Current refinance gates** the atomic path enforces: the auto-refinance
   caps (rate/expiry) are satisfied and not stale, `cfgAutoRefinanceEnabled`
   permits the completion path, and the target loan needs no pending period
   settlement. (Round-2 Finding 4.) **and**
5. **Strict same-key retag is possible** (Round-3 Finding 1):
   `LibEncumbrance.rekeyCollateralLienOnRefinance` succeeds only when the old
   lien's full key (`user / asset / tokenId / amount / assetType`) equals the
   replacement loan's. A carry-over offer that survived a borrower-position
   transfer + consolidation to an interim holder (then back to the creator) can
   pass §3.1.3 freshness yet have a diverged lien key — preview/admission must
   run the same strict-key test or it recreates the false-positive bot loop. **and**
6. **No live swap-to-repay intent on the target** (Round-3 Finding 2):
   `_refinanceLoanLogic` calls `LibVaipakam.assertNoLiveIntentCommit(oldLoanId)`
   (reverts `IntentPending` while `intentCommits[loanId].orderHash != 0`).
   Admission must include the same intent-pending fence.

**Closure principle: admission must be the EXHAUSTIVE mirror of
`RefinanceFacet._refinanceLoanLogic`'s preconditions, derived from the SAME
code** — not a hand-maintained re-listing that drifts as gates are added. The
shared predicate (below) is the single source of truth; preview, the on-chain
guard, and the atomic path all consult it, so a precondition can never hold in
one and not the others. The enumerated items 1-6 are the *current* contents of
that predicate, not a parallel list to keep in sync.

`previewMatch` replaces its blanket `RefinanceTagged` rejection with this full
test; any miss returns a dedicated non-OK `MatchError` (e.g.
`RefinanceTagStale` / `RefinanceTagGated`) so bots can distinguish "not yet"
from "never," and the on-chain guard mirrors it. The lender offer is never
refinance-tagged. Fail closed on every miss. (Implementation note: factor the
freshness + cap + strict-key + intent-fence predicate the atomic path uses —
`LibAutoRefinanceCheck` + the `_refinanceLoanLogic` pre-checks
— into a shared view so preview and accept cannot drift.)

### 3.2 Force the AON amount to the borrower's full `amount` (lender may stay open)

`previewMatch` currently sets `matchAmount = midpoint(...)` and *then* applies the
AON gate `matchAmount == amount`. For an open lender range with
`lenderRemaining > borrower.amount` the midpoint exceeds `borrower.amount`, so an
AON borrower match would revert `AonRequiresFullFill` — the lender could never be
left partially open. The fix: bypass only the midpoint **selection** — set
`matchAmount = borrower.amount` — while **keeping every lender-side fill gate**
(Finding 3). After fixing `matchAmount = borrower.amount`, preview must still
require: the amount lies within the lender's `[lo, hi]` overlap window, the
lender has enough remaining (`lenderRemaining >= borrower.amount`), it clears the
lender's minimum-slice, and — if the **lender** side is itself AON — it equals
the lender's full amount (a lender AON cannot be left partially filled). If any
lender-side gate fails, no match. So "force AON amount" changes only which
amount is *chosen*, never which amounts are *legal*.

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

- **Mutation guard — freeze the amount to the target principal, not just
  `amountMax == amount`** (Finding round-2 #2): forbidding only widening still
  lets a borrower move a carry-over offer from `amount == amountMax ==
  oldPrincipal` to some *other* single value; that passes `amountMax == amount`
  and previews as matchable, but the atomic path rejects (the old loan principal
  is no longer the offer amount) — a false-positive stale offer. So while an
  offer is carry-over-tagged, the amount mutators must **freeze `amount` (and
  `amountMax`) to the target loan's outstanding principal** — i.e. forbid any
  amount change while tagged (or re-validate `amount == target outstanding` on
  every mutation). Preferred: freeze while tagged.
- **Match-time assertion (belt-and-braces):** §3.1.3 re-checks `amount == target
  outstanding && amountMax == amount` live, so even a mutated offer that slipped
  through is rejected at preview/match.

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

- **`previewMatch` admission is a faithful mirror of the atomic accept/refinance
  preconditions** — carry-over shape + live freshness (target active, current
  borrower-NFT owner, live lien, `amount == target outstanding`) + the current
  auto-refinance caps / kill-switch / period-settlement gates — so a preview-OK
  pair never reverts inside the atomic path (no bot false positives) (§3.1).
- **Forcing the AON amount changes only the chosen amount, never the legal
  bounds** — the lender `[lo,hi]` overlap, remaining, min-slice, and lender-AON
  gates all still apply (§3.2).
- **A carry-over offer's `amount` is frozen to the target loan's outstanding
  principal while tagged** (§3.5).
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

1. **`LibAutoRefinanceCheck` (shared predicate)** — factor the freshness + cap /
   kill-switch / period-settlement checks the atomic accept path already runs
   into a view callable from BOTH `previewMatch` and `acceptOfferInternal`, so
   the two can't drift (§3.1.3-4).
2. **`LibOfferMatch.previewMatch`** (the heart of the change):
   - replace the blanket `RefinanceTagged` rejection with the §3.1 admission
     (carry-over shape + AON + `amountMax == amount` + the shared
     freshness/cap predicate from step 1); non-qualifying tagged → a dedicated
     `MatchError` (`RefinanceTagStale` / `RefinanceTagGated`);
   - §3.2 — for an admitted carry-over borrower side, fix
     `matchAmount = borrower.amount` (bypass only the midpoint) but KEEP every
     lender-side gate (lo/hi overlap, remaining, min-slice, lender-AON);
   - §3.3 — set `reqCollateral = offer.collateralAmount` (carried), run the
     synthetic HF/LTV gate on that pinned value, and return a shortfall error
     when the lender's full-`amount` requirement exceeds it.
3. `OfferMatchFacet` guard (~L719) — mirror the §3.1 admission so the on-chain
   path agrees with the preview.
4. `OfferMatchFacet._executeMatch` dust-close (~L1056-1126) — §3.4: skip the
   collateral refund + offer-lock release for carry-over; retag hook (L1117)
   unchanged. The `mo.collateralAmount = mr.reqCollateral` install (~L824) needs
   no special case (preview already pinned it).
5. Amount mutators (`setOfferAmount` / `modifyOffer`) — §3.5 guard: **freeze the
   amount to the target outstanding principal** while carry-over-tagged.
6. New error(s): `RefinanceCarryOverCollateralShortfall` + `MatchError` variants
   (`RefinanceTagStale`, `RefinanceTagGated`). No new external functions → no
   diamond-cut / selector change; inlined errors → one ABI re-export.

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
- **Stale target (preview/match parity):** target loan repaid / defaulted, or
  borrower NFT transferred after offer create → preview returns
  `RefinanceTagStale` and the on-chain match rejects (no false positive).
- **Cap / kill-switch gated:** auto-refinance cap tightened/disabled or
  `cfgAutoRefinanceEnabled` off, or target needs period settlement → preview
  returns `RefinanceTagGated`; the atomic path would have reverted.
- **Amount mutated to another single value** (`amount != target outstanding`,
  still `amountMax == amount`) → mutation frozen (reverts); if forced, preview +
  match reject.
- **Lender-bound violations** with forced AON amount: `lenderRemaining <
  borrower.amount`, below lender min-slice, or lender-itself-AON with
  `lender.amount != borrower.amount` → no match (lender gates preserved).
- **Diverged retag key (Round-3 #1):** carry-over offer survives a
  borrower-position transfer + consolidation to an interim holder, then back to
  the creator → §3.1.3 freshness passes but the strict same-key retag would
  fail; preview/match reject (no false positive).
- **Live swap-to-repay intent on target (Round-3 #2):** target has a live
  `intentCommits[loanId].orderHash` → preview returns the intent-pending miss
  and the on-chain match rejects (would have reverted `IntentPending`).
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
