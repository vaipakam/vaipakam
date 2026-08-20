# One verdict for "can this lender exit, and if not, why"

**Status: proposal, not a decision.** It exists because #1841 has
accumulated **ten** deferred items that all wait on the same choice, and
answering them one at a time has been demonstrably worse than answering
them together. Nothing here is implemented. The recommendation is at the
end, and the alternative of *not* doing it is argued rather than
dismissed.

Related: #1841 (the ten items), #1839 (the chooser that surfaced them),
#1503 (the lender early-withdrawal programme), #1835 (blocked separately
on facet size, but affected by the sizing argument in §5).

---

## 1. What went wrong, stated plainly

The lender exit chooser is an *awareness* surface: it tells a lender
what their options are and what each costs, and jumps to the tool that
performs the action. It does not submit anything.

To say "this option is not available, and here is why", it has to
reproduce judgements the **contracts** own. Eight review rounds on
#1839 found, one at a time, that it was reproducing them wrongly or not
at all. Every fix was correct in isolation. The count did not come down:
12 → 5 → 1 → 5 → 3 → 2 → 2 → 7.

The reason it did not come down is structural, not a matter of care.
Each round made an unanswerable case *representable* — a new union, a
new failure flag — and the new representation became the next round's
surface. The card now carries six union types and two failure booleans
for what a lender experiences as three rows.

Meanwhile ten refusals stayed unrepresented, deferred to #1841 for the
same recurring reason: answering each needs its own chain read, on a
page under an explicit RPC read-diet.

**The pattern to notice**: the card is being asked to hold a *shadow
copy* of the protocol's admission rules, assembled from whatever the
page happened to already be reading. A shadow copy drifts. Every one of
the ten deferrals, and several of the twenty-odd findings, is a drift
between that copy and the real rule.

## 2. The ten, and what each actually needs

| # | Refusal | Contract source | What the client lacks |
| --- | --- | --- | --- |
| 1 | Relist cooldown | `saleRelistCooldownUntil[loanId]`, `EarlyWithdrawalFacet:327` | the timestamp (the revert carries it; nothing reads it ahead of time) |
| 2 | Final-hour window | `MIN_SALE_LISTING_SECONDS` vs remaining term | a governance-tunable constant the app does not read |
| 3 | Sale admission | `LibSaleSolvency.assertSaleSolvent` | already exposed — see §3 |
| 4 | Borrower offset pending | `loanToOffsetOfferId[loanId] != 0` | a chain read; the existing hook is a browser-local marker |
| 5 | Held VPFI unresolved | `SalePositionNotConsolidatable` | no cheap read for the held-for-lender balance |
| 6 | Asset paused (principal) | `isAssetPaused(asset)` | a live read per leg |
| 7 | Asset paused (collateral) | `isAssetPaused(asset)` | a live read per leg |
| 8 | Listing fillability after expiry | the listing offer's `expiresAt` | `LoanSalePendingState` carries no expiry |
| 9 | Instant-sell candidates (Basic) | the open-offer book | a full page walk |
| 10 | Maturity tick resolution | — | not a read at all; a shared-clock change |

Nine of the ten are **reads of Diamond storage**. Item 10 is not — it is
a client timer concern and does not belong in this design; it is called
out here only so the count is honest. Item 9 is a book walk, which a
per-loan view cannot answer either.

**So the tractable set is items 1–8: eight refusals, all answerable from
Diamond-local storage in a single call.** That is the observation this
proposal rests on.

## 3. What already exists

`RiskPreviewFacet.saleAdmission(uint256 loanId)` returns
`(uint8 code, uint256 a, uint256 b)` and already classifies item 3. Its
own docblock records why it lives there rather than in the sale facets:

> both `EarlyWithdrawalFacet` and `OfferAcceptFacet` were already at the
> EIP-170 ceiling and the guard pushed each ~650 bytes over it

and why it classifies rather than reverts:

> ONE selector serves both the reverting guard and the read-only
> preview; `LibSaleSolvency` maps the code onto the caller-side errors.

That is exactly the shape being proposed here, one level wider. The
precedent is not an analogy — it is the same facet, solving the same
problem, for one of the same ten items.

## 4. The proposal

A **sibling** view on `RiskPreviewFacet`:

```
saleExitPreview(uint256 loanId, address lender)
  → (uint16 directBlockers, uint16 listBlockers, uint64 cooldownUntil,
     uint64 listingExpiresAt, uint8 admissionCode)
```

Two bitmaps rather than one, because **the two exits refuse
differently** — the direct sale has no window bound and no kill switch,
the listing has both — and a single verdict would force callers to
re-derive which blockers apply to which row. That re-derivation is the
shadow copy again, in miniature.

Timestamps returned as values, not folded into flags, for the reason the
cooldown revert already carries `availableAt`: `LoanSaleFlow` renders
the reopening *time*, and a boolean "on cooldown" would be strictly less
useful than what a lender gets today on entry. A design that made the
card worse than the tool would defeat its purpose.

**Deliberately NOT in scope:**

- **Item 9** (candidate matching) — a book walk, not a per-loan read.
  Stays `'unknown'` in Basic mode.
- **Item 10** (tick resolution) — a client clock change, fixed at the
  shared anchor.
- **Pricing.** The preview says *whether*, never *how much*. Quotes stay
  with the tools that own their freshness.

**A sibling, not an extension of `saleAdmission`.** Widening that
selector's return would break `LibSaleSolvency`, which the *mutating*
guards call — a fund-moving path changed to improve a read-only one.

## 5. Costs, stated honestly

**Facet size.** `RiskPreviewFacet` has **7,643 bytes** of EIP-170
headroom at `0501225c9`, the most of any facet in the sale family. This
is the one place the addition comfortably fits — and it matters that
`OfferAcceptFacet` has 164 bytes and `RewardAggregatorFacet` 32 (see
#1842), so "put it where it is used" is not available.

**One extra read per position page.** Against the read-diet this is the
real cost. It is one call that replaces **eight** that would otherwise
be needed, and it is a `view` on storage the page's other reads already
touch. If the diet cannot afford one call, it cannot afford the feature,
and the honest response is to keep the rows silent rather than to guess
— which is what they do today.

**A new selector to register.** `DeployDiamond`, `HelperTest`,
`SetupTest`, `FacetSelectors` (RiskPreviewFacet already has a getter, so
its parity case must be updated), and `rehearse-partial-refresh.sh`'s
hard-coded `RISK_PREVIEW_SELECTORS` array. Five sites; CLAUDE.md names
all of them, and the last one is a shell array whose own comment claims
it mirrors the refresh scripts, which is true only while somebody keeps
it so.

## 6. The case against, taken seriously

**"The tools already refuse and explain better."** True, and it is why
every one of the ten was deferred rather than rushed: the cost of the
gap is a wasted click, not a wrong action. If the answer is that a
wasted click is acceptable, then the right move is not this design — it
is to **stop the card making availability claims it cannot support**,
and let the rows say what an option costs and what it does, with
availability owned entirely by the tools. That is a smaller card and a
defensible one.

This is a genuine fork, and I do not think it should be settled by
whoever writes the next fix. The two options differ in what the card
*is*, not in how well it is implemented:

- **Preview-backed**: the card is an authority. It states availability
  and is right, because it asks the same source the contracts do.
- **Cost-and-consequence only**: the card is a map. It says what each
  route is and what it costs; whether the road is open is the tool's
  answer.

Today's card is neither — it makes availability claims from whatever
data happened to be nearby. That is the actual defect behind eight
rounds, and both options above fix it.

## 7. Recommendation

**Preview-backed, and defer the decision to a human.**

The reason to prefer it over the smaller card: the Basic-mode lender is
the one this whole feature exists for, and "switch to Advanced to find
out whether you can do this" is a poor answer for someone who was shown
the option in the first place. The switch CTA already has to predict
whether tools will appear, so the card cannot fully escape availability
even in the map-only design — it would just be less honest about it.

But this is a product judgement about what an awareness surface owes its
reader, and it carries a per-page RPC cost and a contract change. It
should not be made inside a review loop, which is precisely why the ten
items were deferred rather than patched.

**What I would do next, given a yes:** land items 1, 2, 4, 6, 7 first —
the five that are pure storage reads with no new classification logic —
and leave 3 (already exposed), 5 (needs the held-balance question
answered separately) and 8 (needs the listing offer joined) to a second
pass.

**What I would do given a no:** strip the card's availability claims to
those it can answer from data the page already holds, and say in the
copy that the tool performs the real check. That is a smaller diff than
the eight rounds already spent.
