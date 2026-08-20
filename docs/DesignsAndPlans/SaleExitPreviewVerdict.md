# One verdict for "can this lender exit, and if not, why"

**Status: proposal, not a decision — REVISED THREE TIMES after review.** Five
Codex rounds on #1847 have returned sixteen findings. Two were plain factual
errors in the first draft, one weakens the recommendation itself, and **four
were defects introduced by the revisions that fixed the earlier ones** —
including two that made the proposal undeployable as written. §9 lists what
changed and when.

It exists because #1841 has
accumulated **ten** deferred items that all wait on the same choice, and
answering them one at a time has been demonstrably worse than answering
them together. Nothing here is implemented. The recommendation is at the
end, and the alternative of *not* doing it is argued rather than
dismissed.

Related: #1841 (the ten items), #1839 (the chooser that surfaced them),
#1503 (the lender early-withdrawal programme), #1835 (blocked separately
on facet size, but affected by the sizing argument in §5), #1849 (item 9's
Advanced-mode half).

---

## 1. What went wrong, stated plainly

The lender exit chooser is an *awareness* surface: it tells a lender
what their options are and what each costs, and jumps to the tool that
performs the action. It does not submit anything.

To say "this option is not available, and here is why", it has to
reproduce judgements the **contracts** own. **Fifteen** review rounds on
#1839 have found, one at a time, that it was reproducing them wrongly or not
at all. Every fix was correct in isolation. The count has never converged:
12 → 5 → 1 → 5 → 3 → 2 → 2 → 7 → 3 → 4 → 3 → 3 → 2 → 2.

Rounds 13 and 14 were caused by the fixes for rounds 12 and 13 — not by
carelessness in them, but because each fix moved the boundary rather than
removing it.

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

## 2. The ten (plus one the review added), and what each actually needs

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
| 8b | Listing refuses NFT collateral | `EarlyWithdrawalFacet:275-281` (`SaleOfferCollateralMustBeERC20`) | nothing — already client-answerable; listed because the BITMAP must carry it |
| 9 | Instant-sell candidates | the open-offer book | a full page walk in Basic; in Advanced, already walked and discarded |
| 10 | Maturity tick resolution | — | not a read at all; a shared-clock change |

Item 10 is not a read at all — a client timer concern, listed only so the
count is honest. Item 9 is a book walk, which a per-loan view cannot answer in
either mode.

**8b is new in this revision and is a different kind of entry.** NFT
collateral deterministically reverts the LISTING route
(`SaleOfferCollateralMustBeERC20`) while the direct route may stay eligible,
and the client can already answer it from loan data it holds — so it is not a
missing *read*. It is here because `listBlockers` must still carry the bit:
a bitmap that omits a live route-specific refusal reports `listBlockers`
clear for a listing that cannot be created, and a caller cannot tell the
difference between "not blocked" and "not represented". It also shows the
route asymmetry is real rather than assumed, which §4.2 needed after the
pause claim turned out to be wrong.

**So the tractable set is items 1–8 plus 8b: nine refusals, answerable
without consulting any third party.** That is the observation this proposal
rests on — and note the criterion is *self-contained*, not *needs a new read*,
since 8b needs none.

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

> **Revised twice after review (#1847, four rounds, fourteen findings).** The
> first draft contained a factual error about the pause rules and
> under-specified most of the ABI. The revision that fixed those introduced
> two defects of its own, corrected in turn. The recommendation in §8 is
> weakened as a result. Neither superseded version is preserved inline — a
> design doc carrying its own retracted claims invites someone to read the
> wrong half; both are in this file's history.

A **sibling** view on `RiskPreviewFacet`:

```
saleExitPreview(uint256 loanId, address lender)
  → (uint16 directBlockers,      // bit meanings fixed below
     uint16 listBlockers,
     uint16 checkedMask,         // which bits this build actually classified
     uint8  admissionCode,       // 0 = clear; type(uint8).max = unmeasurable
     uint256 admissionA,         // saleAdmission's diagnostic payload,
     uint256 admissionB,         //   carried through, not discarded
     uint64  cooldownUntil,      // 0 = none
     uint64  listingExpiresAt,   // 0 = no listing OR legacy GTC — see below
     uint256 linkedSaleOfferId,  // 0 = none; the view resolves it anyway
     uint8   temporalVerdict)    // chain-evaluated enum, encoded in 4.3.1
```

Wider than the first draft, and every added field answers a specific way the
narrow version would have failed.

### 4.1 Bit assignments are part of the ABI

Every bit position and meaning is fixed as part of the ABI, not chosen
independently by the contract and the client. Two sides picking their own
assignments compile and decode the same `uint16` perfectly while disagreeing
about what it says — the shadow-copy failure this selector exists to end,
reproduced inside the fix. Bits are append-only; a retired blocker leaves its
bit permanently burned.

**A Solidity constant does not achieve this, and saying so was the error.**
The generated ABI describes the `uint16` return types and carries **no
constant values**, so a client reading the ABI learns nothing about bit
meanings and would hand-transcribe them — which is the drift, restored, in the
section claiming to prevent it. Making the constant `public` only adds a
getter, i.e. another call to learn something static.

The schema must therefore reach TypeScript as a **generated artifact**: the
bit assignments emitted from the Solidity source into
`packages/contracts/src/`, alongside the existing per-facet ABI export, so the
compiler stays the single source of truth exactly as it already is for event
and function shapes. A hand-maintained TS mirror is not an acceptable
substitute here for the same reason the Worker ABIs are generated rather than
typed by hand: the failure is silent and positional.

This applies to `temporalVerdict`'s enum (§4.3.1) as well as the two bitmaps.

### 4.2 Both routes pause — the earlier claim was wrong

The first draft justified two bitmaps partly on "the direct sale has no kill
switch". **That is false.** `EarlyWithdrawalDirectFacet:196-197` calls
`LibFacet.requireAssetNotPaused` on both the principal and collateral legs,
and both routes are `whenNotPaused`. A pause blocks both, so the pause bits
belong in **both** bitmaps; assigning them only to the listing map would
report the direct route available during exactly the outage the operator
paused for.

Two bitmaps still earn their place — the listing route carries a window bound
and a relist cooldown the direct route does not — but the split is now drawn
from the entry points rather than from memory. The lesson generalises: this
document argued that shadow copies of protocol rules drift, while containing
one.

### 4.3 No device clocks, and the GTC sentinel is genuinely ambiguous

Returning raw timestamps forces the caller to compare them against something.
An `eth_call` result carries no block timestamp, so the client would either
make the extra latest-block read this design claims to avoid, or use the
device clock — re-creating precisely the drift excluded as item 10.

So the view returns a **chain-evaluated** `temporalVerdict` alongside the
display timestamps: the contract compares against `block.timestamp`, and the
timestamps remain only so the tools can render *when* a cooldown lifts.

`listingExpiresAt == 0` cannot be interpreted client-side at all, and this is
not a nicety. For a legacy GTC listing the protocol itself holds two
contradictory readings: `isOfferExpired` short-circuits **false** forever,
while `OfferCancelFacet.teardownStaleSaleListing` (`:587-595`) admits that same
sentinel to teardown **immediately**. A client choosing either reading is
wrong half the time. `temporalVerdict` carries the classification the sale
paths actually use, and the sentinel stays a display value.

#### 4.3.1 `temporalVerdict` encoding — an ENUM, and precedence is fixed

The first revision added this field and then left it undefined, which is
§4.1's own finding one field over: two sides can implement incompatible
readings of the same `uint8` and both decode cleanly. Pinning the bitmaps
while leaving this open was not a smaller version of that mistake, it was the
same one.

An **enum, not a bitmap** — the conditions are mutually exclusive once
precedence is applied, and a bitmap would invite callers to invent their own
precedence:

| Value | Meaning | Governs |
| --- | --- | --- |
| 0 | `Clear` — no temporal bar | both routes |
| 1 | `PastMaturity` — term fully elapsed | both routes |
| 2 | `RelistCooldown` — `cooldownUntil` not yet reached | listing only |
| 3 | `FinalHourWindow` — remaining term < `MIN_SALE_LISTING_SECONDS` | listing only |
| 4 | `ListingLive` — a listing stands and can still be filled | listing only |
| 5 | `ListingEndedUnfilled` — stands but no buyer can complete | listing only |
| 255 | `Indeterminate` — could not be evaluated | both, fail-closed |

**Precedence, highest first: 1 > 2 > 3 > 5 > 4 > 0.** Maturity outranks
everything because it closes both routes and no narrower reason can help.
Cooldown outranks the window because it is the longer bar. `ListingEnded`
outranks `ListingLive` so a caller never treats a dead listing as fillable.

Callers get one value and no arithmetic. The direct route reads only 0, 1 and
255; a listing-only value on the direct row is a contract bug, not a caller
decision.

**`linkedSaleOfferId` comes back too.** The view must resolve
`loanToSaleOfferId[loanId]` to read the expiry at all, so discarding it is
pure waste — and it is the id `useLoanSalePending` currently hunts for with a
bounded indexer walk that can come up empty, which is exactly what leaves a
lender with no cancel button (#1848). Returning what we already looked up
turns a fallible recovery into a field.

### 4.4 An unmeasurable admission is a distinct answer

`saleAdmission` can revert when the health-factor or LTV measurement fails.
`LibSaleSolvency.saleSolvency` already converts that to `type(uint8).max`
rather than propagating, and this view adopts the same convention: an oracle
failure must neither revert the whole aggregate call nor read as "no blocker".

This matters most where it is easiest to skip. The card's entire claim is to
be right about availability; if it silently reports "clear" during an oracle
outage, it is wrong in the one operational mode where a lender most needs a
straight answer.

`admissionA` / `admissionB` are carried through rather than dropped: codes 1–5
use them for observed-vs-required values and code 6 distinguishes an
unpriceable collateral leg from an unpriceable principal leg. Discarding them
would force a second `saleAdmission` call — defeating the one-call claim — or
collapse distinct causes into generic copy, defeating the point of explaining
why.

### 4.5 `checkedMask` — unclassified must not read as clear

A staged rollout is the obvious way to land this, and it is a trap: with a
plain bitmap, "this build has not classified blocker 5 yet" and "blocker 5 is
clear" are the same zero bits. That re-creates false availability, which is
the defect the proposal exists to remove.

`checkedMask` makes the distinction explicit. A caller may treat a route as
available only when the relevant bits are both **checked** and **clear**;
anything unchecked renders as unknown, not as permission. This also makes a
partial first pass safe to ship, which the original plan quietly was not.

### 4.6 Shared classifiers, or this is just a second copy

A sibling view alone does **not** remove the shadow copy. Several
classifications live in inline or private guard logic today —
`LibConsolidation._isExcludedLive` is `private`, and the listing-expiry bound
is inline — so `saleExitPreview` would have to reproduce those predicates and
could drift from them exactly as the client did.

The design is therefore only sound if the mutating guards **consume the same
classifier the preview does**. If that is out of scope, so is this proposal:
without it we would be building a second source of truth and calling it a
single one.

**And the mechanism matters more than the intent.** The previous revision said
"shared **internal** classifiers", which is wrong in a way that would have
shown up only at deploy: an `internal` library function is compiled **into
every consuming facet**. Since `EarlyWithdrawalFacet` and `OfferAcceptFacet`
are the consumers and both sit at or near the EIP-170 ceiling (#1842 —
`OfferAcceptFacet` has **164 bytes**), inlining a classifier into them is not
a size risk, it is a straightforward overflow. §5's headroom figure for
`RiskPreviewFacet` says nothing about that, so as written the document never
established the complete proposal was deployable at all.

**The precedent already solves this, and it is not inlining.**
`LibSaleSolvency` reaches the admission classifier by a **cross-facet call** —
`RiskPreviewFacet(address(this)).saleAdmission(loanId)` at `:129` — so the
logic exists once, on the facet with room for it, and each consumer pays only
for the call plus its own error mapping. That is the hosting model this
proposal must adopt, stated explicitly rather than left to the reader:

- Classifier bodies live on `RiskPreviewFacet`.
- Guards call them through the Diamond and map codes to their own errors,
  exactly as `LibSaleSolvency` does today.
- Only the thin call-and-map is `internal`.

**Cost, since this is not free.** Every guarded write pays an extra
delegatecall. That is already true of the admission check on the sale paths,
so it is a known and accepted shape rather than a new one — but it must be
budgeted per consuming facet, not assumed.

**Required before adoption:** a measured size delta for **every** consuming
facet, not just the host, run through the existing `FacetSizeLimitTest`. With
`OfferAcceptFacet` at 164 bytes and `RewardAggregatorFacet` at 32, "it fits on
the host" is not evidence of anything. #1842's ranked headroom report exists
precisely so this is checkable rather than argued.

**Deliberately NOT in scope:**

- **Item 9** (candidate matching) — a book walk, not a per-loan read, so a
  per-loan view cannot answer it in either mode. Only the Basic half is a real
  gap: in Advanced the sale tool has already walked the book and the chooser
  discards the result, which needs the tool's derivation shared rather than
  copied and is tracked separately (#1849).
- **Item 10** (tick resolution) — a client clock change, fixed at the shared
  anchor.
- **Pricing.** The preview says *whether*, never *how much*.

**A sibling, not an extension of `saleAdmission`.** Widening that selector's
return would break `LibSaleSolvency`, which the *mutating* guards call — a
fund-moving path changed to improve a read-only one.

## 5. Costs, stated honestly

**Facet size — the host is the easy half.** `RiskPreviewFacet` has **7,643
bytes** of EIP-170 headroom at `0501225c9`, the most of any facet in the sale
family, and the view itself fits there comfortably. `OfferAcceptFacet` has 164
bytes and `RewardAggregatorFacet` 32 (see #1842), so "put it where it is used"
was never available.

**That figure does not establish the proposal is deployable**, and the earlier
revision treated it as though it did. §4.6 makes the guards consume the same
classifier, so the binding constraint is the size delta on **every consuming
facet** — and those are the facets with no room. It is only affordable because
the hosting model is a cross-facet call rather than an inlined `internal`
library (§4.6): consumers pay for a call and an error map, not for the logic.
Even so, that delta is measured before adoption, not assumed.

**One extra read per position page.** Against the read-diet this is the
real cost. It is one call that replaces **eight** that would otherwise
be needed, and it is a `view` on storage the page's other reads already
touch. If the diet cannot afford one call, it cannot afford the feature,
and the honest response is to keep the rows silent rather than to guess
— which is what they do today.

**A new selector to register.** `DeployDiamond`, `HelperTest`,
`FacetSelectors` (RiskPreviewFacet already has a getter, so its parity case
must be updated), `rehearse-partial-refresh.sh`'s hard-coded
`RISK_PREVIEW_SELECTORS` array — and, the one that actually decides whether
the client can call it, **regenerating `packages/contracts/src/abis/
RiskPreviewFacet.json`** via `exportFrontendAbis.sh`.

The first draft listed `SetupTest` here and omitted the ABI export. Both were
wrong: `SetupTest.t.sol:495` consumes `helperTest.getRiskPreviewFacetSelectors()`
and needs no edit of its own, so naming it was padding — while a selector
routed on-chain but missing from the client ABI is unavailable to the very
caller that motivated the work. Padding a list with a site that needs nothing,
while omitting the one that gates the feature, is worse than a short list.

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

## 7. Rollout is per-chain, not per-selector

alpha02 talks to several heterogeneous Diamonds, and `LoanSaleFlow` already
gates listing to Base Sepolia and Arbitrum Sepolia because BNB Testnet lacks
an earlier cut. Registering a selector in the deploy scripts therefore says
nothing about whether a given chain has it: call `saleExitPreview` on a chain
that has not been re-cut and the Diamond raises `FunctionDoesNotExist`, making
the proposed authority unavailable for **every** position there.

So the card must treat "this Diamond does not serve the preview" as a
first-class state — the same shape as `checkedMask`, one level up — and fall
back to the map-only behaviour rather than to a spinner or a wrong verdict.
Per-chain cut verification is a release gate, not an afterthought.

## 8. Recommendation — weakened by review, and honest about it

**Preview-backed for LOAN-LEVEL eligibility only, and the decision still
belongs to a human.**

The first draft recommended this as the way to make the card an authority on
availability. Review showed that claim is too strong, and the argument that
depended on it does not survive intact.

**What the preview cannot do.** For a Basic-mode lender with no compatible buy
offer, `saleExitPreview` returns zero `directBlockers` while the direct exit is
in fact unavailable: item 9 is out of scope and the function takes no offer id
with which to judge a counterparty's expiry, shape or fillability. So the
preview answers *"is this loan eligible to be sold"*, never *"can this lender
sell it right now"*. Those are different questions, and the card asks the
second.

**What that costs the argument.** §6's case for the preview-backed option
leaned on the switch CTA needing to predict whether tools would appear. It
still does — but a loan-level verdict does not fully supply that prediction,
so the preview narrows the map-only gap rather than closing it. I am not going
to pretend otherwise to keep the recommendation tidy.

**Why I still lean this way — on a different invariant than I first gave.**
(Counting note: nine loan-level entries, items 1–8 plus 8b.)

My first attempt justified the split on *durability*: loan-level blockers are
permanent, candidate matching is momentary. That is **false**, and worth
striking rather than softening. Governance unpauses assets. Cooldowns expire
by construction. Oracle and liquidity conditions recover. A held-for-lender
balance gets resolved. Most of the nine are as transient as the order book.

The distinction that actually holds is **self-contained vs relational**. Every
one of the nine is a property of *this loan and this holder* — answerable by
reading the position and the protocol's own configuration, with no third party
involved. Candidate matching is irreducibly relational: it asks what OTHER
participants are currently offering, so it cannot be answered by a per-loan
view at any price, and its answer is invalidated by strangers rather than by
anything about this position.

That is why one belongs in an aggregate per-loan read and the other belongs
with the tool that walks the book — and unlike durability, it is a property of
the *question*, not a guess about how long an answer stays true.

**Adopting it means adopting §4.6.** Without extracting the shared classifiers
the mutating guards consume, this is a second source of truth wearing the
costume of a single one — and it would drift, exactly as the client did. That
is now a precondition, not a refinement.

**Given a yes:** the first batch is **items 6, 7 and 8b** — the two per-asset
pause legs, which really are bare `isAssetPaused` reads with no predicate
behind them, plus the NFT-collateral bit, which needs no read at all — behind `checkedMask`, with the per-chain gate from §7 in place.

Items 1 and 2 are **not** in it, correcting the previous revision. Calling
them "pure storage reads" confused reading a value with classifying it: the
cooldown needs the inline `block.timestamp` comparison and the final-hour
window needs the `_boundListingExpiry` maturity predicate, so producing their
`temporalVerdict` means reproducing exactly the logic §4.6 makes a
precondition for adopting any of this. A first pass that shipped them would
ship the duplicated predicates this design exists to eliminate — with the
proposal's own adoption rule written three sections above it.

So items 1, 2, 4, 5 and 8 all land **with** the classifier extraction, not
before it. Item 3 is already exposed. That makes the first batch smaller and
less useful than the version it replaces, which is the honest consequence of
taking §4.6 seriously rather than a reason to relax it.

**Given a no:** strip the card's availability claims to what it can answer from
data the page already holds, and say in the copy that the tool performs the
real check. Fourteen review rounds on #1839 have now made that the *cheaper*
option as well as a defensible one, which was not obvious when this document
was written.

## 9. What the review changed

Recorded because the corrections are more useful than the proposal:

- The direct route **does** enforce per-asset pauses (§4.2). Stated
  confidently and wrongly, from memory rather than from the entry point.
- Registration list padded with a site needing no change, missing the ABI
  export that gates the whole feature (§5).
- Timestamps without a chain-evaluated verdict push the caller onto a device
  clock, re-creating an excluded item (§4.3).
- The GTC sentinel is ambiguous **in the protocol itself**, not merely to the
  client (§4.3).
- A staged rollout would have shipped unclassified-reads-as-clear (§4.5).
- A sibling view does not remove a shadow copy unless the guards share the
  classifiers (§4.6).
- The authority claim was too strong, which weakens §8's own argument.

Seven of these would have survived into an implementation.

**A fourth round found five more, on the revision itself:**

- `temporalVerdict` was added with **no encoding** — §4.1's own finding, one
  field over, in the same edit that fixed it. Now a pinned enum with stated
  precedence (§4.3.1).
- The durability premise behind §8's split was **false** — pauses lift,
  cooldowns expire, oracles recover. Replaced with self-contained vs
  relational, which is a property of the question rather than a guess about
  its answer's lifetime.
- The first rollout batch **contradicted §4.6**, shipping the duplicated
  predicates the adoption precondition forbids. The batch is now smaller.
- NFT collateral was counted in the recommendation but **absent from §2** and
  from every batch (now 8b).
- The view resolves the linked sale offer id and **discarded it**, leaving a
  fallible recovery walk in place of a field.

Two of those five were defects introduced BY the revision. That is the
clearest evidence in this document for its own thesis: a corrected shadow copy
is still a shadow copy, and the correction is where the next divergence
enters.

**A fifth round found two more, and both attack deployability rather than
detail:**

- §4.6 said "shared **internal** classifiers". An `internal` library function
  compiles into every consuming facet, and the consumers here are the facets
  with 164 and 32 bytes left — so the design as written was not deployable,
  and §5's host-headroom figure was answering the wrong question. Corrected to
  the cross-facet hosting the admission classifier already uses
  (`LibSaleSolvency:129`), with a per-consumer size budget required before
  adoption.
- §4.1 pinned the bit schema "in one shared Solidity constant". The generated
  ABI carries types, **not constant values**, so the client would have
  hand-transcribed the assignments — the drift that section exists to prevent,
  reintroduced by the mechanism chosen to prevent it. Now a generated TS
  artifact, alongside the existing ABI export.

Both were mine, and both were the *same mistake in different clothing*:
naming a sharing mechanism without checking that it actually shares anything
across the boundary it has to cross — Solidity-to-Solidity in one case,
Solidity-to-TypeScript in the other.
