# One verdict for "can this lender exit, and if not, why"

**Status: proposal, not a decision — REVISED REPEATEDLY under review.** It has
been rewritten several times: two plain factual errors in the first draft, one
finding that weakens the recommendation itself, and several defects introduced
by the very revisions that fixed the earlier ones — including two that made
the proposal undeployable as written.

**§9 carries the running tally and is the only place that does.** Every
duplicate of it in this file went stale within a round or two, which is a
small instance of the problem the document is about. For the same reason §9
refers to verdicts by **name** rather than by numeric value: it cited stale
numbers for two of them after the enum split, and these codes are a
client-facing ABI schema, so an implementer following the summary rather than
§4.3.1 could have generated incompatible Solidity and TypeScript encodings.

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
reproduce judgements the **contracts** own. **Seventeen** review rounds on
#1839 have found, one at a time, that it was reproducing them wrongly or not
at all. Every fix was correct in isolation. The count has never converged:
12 → 5 → 1 → 5 → 3 → 2 → 2 → 7 → 3 → 4 → 3 → 3 → 2 → 2 → 1 → 2.

**Four of those rounds were caused by the fixes for the rounds before them**
(12→13, 13→14, 14→16, and the r17 cadence gap), and the shape was identical
every time: a distinction drawn in one consumer of a question and not in its
sibling. Not carelessness — each fix moved the boundary instead of removing
it, and the new boundary is where the next round landed.

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

## 2. The ten (plus two the review added), and what each actually needs

| # | Refusal | Contract source | What the client lacks |
| --- | --- | --- | --- |
| 0 | **Loan not Active** (live) | both entrypoints require `status == Active` | a live status read the indexer can lag — the stale-row window |
| 1 | Relist cooldown | `saleRelistCooldownUntil[loanId]`, `EarlyWithdrawalFacet:327` | the timestamp (the revert carries it; nothing reads it ahead of time) |
| 2 | Final-hour window | `MIN_SALE_LISTING_SECONDS` vs remaining term | a governance-tunable constant the app does not read |
| 3 | Sale admission | `LibSaleSolvency.assertSaleSolvent` | already exposed — see §3 |
| 4 | Borrower offset pending | `loanToOffsetOfferId[loanId] != 0` | a chain read; the existing hook is a browser-local marker |
| 5 | Held VPFI unresolved | `SalePositionNotConsolidatable` | no cheap read for the held-for-lender balance |
| 6 | Asset paused (principal) | `isAssetPaused(asset)` | a live read per leg |
| 7 | Asset paused (collateral) | `isAssetPaused(asset)` | a live read per leg |
| 8 | Listing fillability after expiry | the listing offer's `expiresAt` | `LoanSalePendingState` carries no expiry |
| 8b | Listing refuses NFT collateral | `EarlyWithdrawalFacet:275-281` (`SaleOfferCollateralMustBeERC20`) | nothing — already client-answerable; listed because the BITMAP must carry it |
| 8c | Both routes refuse a rental (non-ERC20 principal) | `EarlyWithdrawalDirectFacet:178-179`, `EarlyWithdrawalFacet:272-274` (`InvalidSaleOffer`) | nothing — client-answerable; missing from BOTH maps until review caught it |
| 8d | **Diamond globally paused** | both entrypoints are `whenNotPaused` | a live `paused()` read |
| 8e | **Offer-duration cap** | `OfferCreateFacet._createOfferSetup` (`OfferDurationExceedsCap`) vs live `cfgMaxOfferDurationDays` | the governance-tunable cap |
| 8f | **Sanctioned party** | `_createLoanSaleOfferImpl` screens caller + holder; `sellLoanViaBuyOffer` screens caller | a screening read per party |
| 8g | **Caller is not the holder** | `sellLoanViaBuyOffer` requires `caller == holder` | the authoritative holder |
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

**8c is the same class as 8b and a sharper warning.** An ERC-721/1155 *principal*
(a rental loan) makes BOTH entry points revert `InvalidSaleOffer`, independently
of 8b's collateral check — and it was absent from every version of this table
until review found it. A preview claiming completeness while omitting a blocker
that closes both routes is worse than one that admits a gap, because
`checkedMask` would report those bits checked and clear.

**Item 0 was missing from every earlier version of this table, and it is the
one that matters most.** Both entrypoints require `loan.status == Active`, yet
the set had no status blocker and the temporal encoding carried only
`PastMaturity`. So while the indexer still reported an active row after the
chain moved the loan to `FallbackPending`, `Repaid`, `Settled` or `Defaulted`,
the preview would have returned otherwise-clear verdicts for two routes that
revert `LoanNotActive`.

That is precisely the stale-state window #1839 spent rounds 12–14 closing on
the client — and a preview built to be the authority would have reopened it at
the source, with `checkedMask` reporting those bits checked and clear. A
chain-side view has no excuse for it: the live status is right there.

**8d through 8g came last, and share a property the earlier entries do not:
none of them is raised by a sale facet.** The global pause sits on the modifier,
the duration cap is raised by generic offer creation, and the two authorization
checks screen a *party* rather than the loan. The method that built this table —
walk both sale entry points and enumerate what they refuse — is exactly why they
were missed, and it had already produced a table this document twice described
as complete. Worth stating as a limit of the method rather than as four
oversights: the next omission, if there is one, is likely to be another refusal
that reaches these routes from somewhere else.

8g is also the only entry that is not about the loan at all. It is here because
the ABI takes a `lender` argument and must say what happens when that address is
not the holder — see §4.1.

**So the tractable set is item 0, items 1–8, plus 8b through 8g: fifteen
refusals, answerable without consulting any third party.** That is the
observation this proposal rests on — and note the criterion is *self-contained*,
not *needs a new read*, since neither 8b nor 8c needs one.

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

> **This section has been rewritten repeatedly under review.** The first draft
> contained a factual error about the pause rules and under-specified most of
> the ABI; the revisions that fixed those introduced further defects of their
> own, corrected in turn. The recommendation in §8 is weakened as a result.
> Superseded versions are not preserved inline — a design doc carrying its own
> retracted claims invites someone to read the wrong half — and live in this
> file's history. **The running tally is kept in ONE place, §9**, because
> repeating it here went stale three revisions running.

A **sibling** view on `RiskPreviewFacet`:

```
saleExitPreview(uint256 loanId, address lender)
  → (uint256 directBlockers,     // bit meanings fixed below
     uint256 listBlockers,
     uint256 checkedMask,        // which bits this build actually classified
     uint8  admissionCode,       // 0 = clear; type(uint8).max = unmeasurable
     uint256 admissionA,         // saleAdmission's diagnostic payload,
     uint256 admissionB,         //   carried through, not discarded
     uint64  cooldownUntil,      // 0 = none
     uint64  listingExpiresAt,   // 0 = no listing OR legacy GTC — see below
     uint256 linkedSaleOfferId,  // 0 = none; the view resolves it anyway
     uint8   windowVerdict,      // may a NEW sale start? — 4.3.1
     uint8   listingVerdict)     // state of the EXISTING listing — 4.3.1
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

**The positions, since "fixed as part of the ABI" is worthless without
them.** The previous revision asserted the schema was pinned and then never
assigned a single index — item labels like `8b` are not bit positions, so two
implementations could follow this document faithfully and still disagree.
Append-only; a retired blocker's bit is burned, never reused.

| Bit | Blocker | `directBlockers` | `listBlockers` |
| --- | --- | --- | --- |
| 0 | Loan not Active (item 0) | ✅ | ✅ |
| 1 | Sale admission refused (item 3) | ✅ | ✅ |
| 2 | Borrower offset pending (item 4) | ✅ | ✅ |
| 3 | Held VPFI unresolved (item 5) | — | ✅ |
| 4 | Principal asset paused (item 6) | ✅ | ✅ |
| 5 | Collateral asset paused (item 7) | ✅ | ✅ |
| 6 | Rental principal, non-ERC20 (item 8c) | ✅ | ✅ |
| 7 | NFT collateral (item 8b) | — | ✅ |
| 8 | Relist cooldown active (item 1) | — | ✅ |
| 9 | Final-hour window (item 2) | — | ✅ |
| 10 | Listing already present (item 8) | ✅ | ✅ |
| 11 | Diamond globally paused | ✅ | ✅ |
| 12 | Remaining term exceeds the live offer-duration cap | — | ✅ |
| 13 | Party screened by the sanctions oracle | ✅ | ✅ |

The route masks are the columns: a bit marked `—` is never set in that map,
and a caller must ignore it there rather than treating an unset bit as a
verdict.

**Bits 11–13 were added by review after the table already claimed to be
complete**, which is worth recording as a pattern rather than three separate
corrections: each is a refusal that lives *outside* the sale facets, so
enumerating the sale entry points' own guards — the method that produced bits
0–10 and produced them correctly — could not have found any of them.

- **Bit 11 — the global pause.** Both entry points are `whenNotPaused`, so a
  protocol-wide pause closes both routes. §4.2 corrected the *per-asset* pause
  mapping and, in doing so, made this omission harder to see: the document now
  discussed pausing at length and still classified only the asset legs, so a
  fully-checked preview would report both routes eligible during exactly the
  incident an operator paused for. The per-asset bits are not a superset of
  this one; a Diamond can be paused with every asset unpaused.
- **Bit 12 — the offer-duration cap.** The listing route passes the loan's
  remaining duration into `OfferCreateFacet._createOfferSetup`, which reverts
  `OfferDurationExceedsCap` against the live `cfgMaxOfferDurationDays`. This is
  a Diamond-local, loan-level, governance-tunable comparison — squarely in the
  tractable class — and it was missed because the listing route reaches it
  *through the generic offer-creation path* rather than raising it in
  `EarlyWithdrawalFacet` itself. A lender on a long-dated loan meets it after
  governance lowers the cap, having done nothing.
- **Bit 13 — sanctions screening.** `_createLoanSaleOfferImpl` screens both the
  caller and the resolved holder; `sellLoanViaBuyOffer` screens the caller and
  requires the caller to *be* the holder. This is the one bit whose meaning
  depends on the ABI question below, which is why it came last.

**What `lender` means, since the ABI never said.** It is the **prospective
caller** — the address the client would submit from — and the view resolves
the current holder itself from the position NFT. Both are needed and they are
not always the same address: the listing route accepts a caller who is not the
holder and screens both, while the direct route additionally requires
`caller == holder`. So:

- Bit 13 is set in a route's map if **either** the passed `lender` or the
  resolved holder is screened, per that route's rules.
- A `lender` who is not the current holder sets bit 13's neighbour — see the
  authorization note below — in `directBlockers` only.

**Bit 14 — caller is not the current holder**, `directBlockers` only. Split
out from 13 rather than folded into it because the two have different remedies
and only one of them is the lender's to act on: a screened address has no
remedy on this surface, while a non-holder is usually simply the wrong
connected wallet. Collapsing them would produce a card that tells someone who
switched accounts that they are sanctioned.

The `lender` parameter also means the preview is **holder-relative, not
loan-relative**, and callers must not cache a verdict across a wallet change.
Stated because the loan-level framing in §8 invites exactly that assumption.

**Two of these columns were wrong on their first pass, in opposite
directions**, which is why the masks are stated per-bit rather than described:

- **Bit 10 belongs to BOTH routes.** `EarlyWithdrawalDirectFacet:175-176`
  reverts `SaleOfferAlreadyExists` when `loanToSaleOfferId[loanId] != 0`, so a
  live listing closes the direct sale too. Marking it listing-only would have
  reported a known blocker as irrelevant — and #1839's chooser has blocked
  *both* rows on a live listing since round 1, so the table contradicted
  behaviour already shipped on the strength of the same contract.
- **Bit 3 is listing-only.** The direct route does not refuse an unresolved
  held balance; `EarlyWithdrawalDirectFacet:547` **migrates** the pre-existing
  `heldForLender` to the buyer. Marking it both-routes would have made the
  preview refuse an exit the contract supports — the costlier direction, since
  a false blocker removes a lender's option silently.

The pause bits sit in both maps, which is the visible record of §4.2's
correction.

**`uint256`, not `uint16`.** The narrower type was a false economy: ABI
encoding pads every one of these to a full 32-byte word regardless, so
`uint16` bought no return-data bandwidth while capping the schema at sixteen
positions. Eleven are already spoken for, and review has added three of those
eleven — so the remaining headroom would have been consumed by the same
process that filled it, and exhaustion means either another field or a
coordinated ABI migration. Append-only bits and a tight width are a poor pair.

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

This applies to **both** enums of §4.3.1 — `windowVerdict` and
`listingVerdict` — as well as to the two bitmaps. The previous revision named
`temporalVerdict`, the single enum that revision replaced; following the
requirement literally would have generated a schema for a field that no longer
exists while leaving both real encodings hand-maintained in TypeScript. A
generation requirement that names the wrong artifact is worse than none,
because it reads as satisfied.

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

#### 4.3.1 Two axes, not one — `windowVerdict` and `listingVerdict`

The previous revision put both in a single `temporalVerdict` with a
precedence order, and that was a design error rather than an underspecified
field: **they are orthogonal questions and a precedence between them destroys
information.**

A listing that already exists naturally enters the final-hour window before
its maturity-clamped expiry, and an accepted-but-uncompleted listing can cross
maturity while `completeLoanSale` stays available for as long as the loan is
Active. Ranking maturity and the window above the lifecycle values meant the
card would report "past maturity" to a lender whose actual next action was
*complete the sale that already sold* — discarding the recoverable state at
exactly the moment it is the only thing worth showing.

So: two enums, each answering one question.

**`windowVerdict` — may a NEW sale be started?**

| Value | Meaning | Governs |
| --- | --- | --- |
| 0 | `Open` | both routes |
| 1 | `PastMaturity` — term fully elapsed | both routes |
| 2 | `RelistCooldown` — `cooldownUntil` not reached | listing only |
| 3 | `FinalHourWindow` — remaining term < `MIN_SALE_LISTING_SECONDS` | listing only |
| 255 | `Indeterminate` | both, fail-closed |

Precedence 1 > 2 > 3 > 0. Maturity closes both routes and no narrower reason
helps; cooldown is the longer bar of the two listing-only ones.

**`listingVerdict` — what is the EXISTING listing's state?**

| Value | Meaning |
| --- | --- |
| 0 | `None` — no listing linked |
| 1 | `Fillable` — stands, unexpired, bounds hold right now |
| 2 | `EndedUnfilled` — **expired or terminal**: the listing's own window has closed |
| 3 | `AcceptedPendingCompletion` — accepted, awaiting `completeLoanSale`, loan still Active |
| 5 | `AcceptedButUncompletable` — accepted, loan TERMINAL (`Repaid`/`Settled`/`Defaulted`/`InternalMatched`): stuck |
| 6 | `AcceptedAwaitingCure` — accepted, loan `FallbackPending`: recoverable |
| 4 | `BoundsViolated` — unexpired, but a fill would revert today |
| 255 | `Indeterminate` |

| 7 | `FillableAndTeardownable` — legacy GTC: a buyer can fill it AND a third party can tear it down |

Precedence 5 > 6 > 3 > 7 > 2 > 4 > 1 > 0, and **independent of
`windowVerdict`** — a lender past maturity with value 3 still sees "complete
this sale", because that is what the protocol still permits.

**Value 2's definition was circular, and the precedence made value 4
unreachable.** Defining `EndedUnfilled` as "stands but no buyer can complete"
described value 4 as well — a bounds violation is precisely a state where no
buyer can complete — so under `2 > 4` every bounds failure resolved to 2 and
the diagnostic value could never be returned. That is the worse of the two
outcomes it could have had: value 4 exists to offer *cancel and relist*, a
remedy the lender can act on, while value 2 offers only cleanup. The
definition is now anchored to the listing's **own window** — expired, or its
loan terminal — which is a fact about time rather than about fillability, and
therefore disjoint from a bounds check on live values.

**Value 7 is not a precedence problem; it is two capabilities held at once.**
For a legacy GTC listing (`expiresAt == 0`) the protocol genuinely disagrees
with itself: `OfferAcceptFacet`'s `isOfferExpired` treats the sentinel as
never expiring, so a buyer can fill it, while `teardownStaleSaleListing`
treats the same sentinel as immediately clearable, so a third party can remove
it. Both are live at the same instant and the outcome is decided by whichever
transaction lands first.

The previous revision asserted that precedence made the lifecycle states
mutually exclusive. It does not — no ordering of 1 and 2 describes a listing
that is simultaneously fillable and tearable, because the exclusivity claim was
about the *encoding* and this is a property of the *chain*. Ranking it below
the accepted states and above 2 says the honest thing: this listing may still
sell and may vanish, and a lender who wants either outcome specifically should
act rather than wait. The alternative — returning independent `fillable` and
`teardownable` booleans — was considered and rejected only because it would
make every ordinary listing carry two fields to express one state; the race is
confined to legacy rows and shrinks as they clear.

**Value 5 is a genuine protocol dead end; value 6 is emphatically not**, and
collapsing them was a real error in the previous revision — every non-Active
status mapped to "stuck", but `FallbackPending` has an explicit borrower cure
back to `Active`, after which `completeLoanSale` proceeds normally. Labelling
that a dead end would tell a lender their sale is unrecoverable while the
borrower is in the middle of recovering it. Value 5 is therefore restricted to
the three genuinely terminal statuses.

`InternalMatched` belongs in that terminal set too, and was missed:
`RiskMatchLiquidationFacet.triggerInternalMatchLiquidation` can move an Active
or `FallbackPending` loan there **without consulting its sale link**, which
reaches the same stuck state by a fourth route.

If a legacy accepted-but-uncompleted listing's loan reaches `Repaid`,
`Settled`, `Defaulted` or `InternalMatched`, `_completeLoanSaleImpl` rejects every non-Active loan **and**
`teardownStaleSaleListing` deliberately skips accepted offers — so the link is
stuck with no on-chain path out. Value 3 without the Active condition would
have sent the lender to a completion that cannot succeed, repeatedly.

The preview cannot fix that; it can refuse to misdescribe it. Naming the state
is the minimum, and whether the protocol should gain a recovery path for it is
a separate question this document raises rather than answers — it is a
contract gap that predates the proposal and would outlive a decision not to
build it. Filed as **#1851**, explicitly unreproduced: it rests on reading two
guards against each other, and the state may prove unreachable.

Values 3 and 4 exist because the single-enum version was wrong twice over.
**3**: a legacy or recovery-state sale can have `accepted == true` while
`loanToSaleOfferId` is still set — not fillable, not ended, and
`teardownStaleSaleListing` explicitly excludes that state (`:567-570`), so
folding it into "ended" also points at the one wrong recovery. **4**: expiry
does not decide fillability, since `_completeLoanSaleImpl` reverts
`SaleBelowSellerFloor` / `SaleAboveHeldCeiling` when the live seller net or
held balance has drifted outside the bounds stamped at listing
(`EarlyWithdrawalFacet:793-805`).

Both enums are chain-evaluated, so no caller compares a timestamp to a device
clock. `cooldownUntil` and `listingExpiresAt` remain as display values only.

**`linkedSaleOfferId` comes back too.** The view resolves
`loanToSaleOfferId[loanId]` to answer `listingVerdict` at all, so discarding it
is pure waste — and it is the id `useLoanSalePending` currently hunts for with
a bounded indexer walk that can come up empty, which is what leaves a lender
with no cancel button (#1848).

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
anything unchecked renders as unknown, not as permission.

**`admissionCode` is a separate gate, not a bit.** §4.4 makes an unmeasurable
admission return `type(uint8).max`, but the availability rule above speaks only
of bits — so an implementation could legitimately mark bit 1 checked and clear
while returning 255, and a conforming client would report both routes
available during exactly the oracle failure the fail-closed code exists for.
The rule is therefore: a route is available only when its relevant bits are
checked and clear **and** `admissionCode == 0`. Any other admission value,
including 255, blocks both routes.

**The same rule binds the two enums, and `checkedMask` does not cover them.**
It records bit coverage only — so an unimplemented `windowVerdict` or
`listingVerdict` would default to `Open` / `None`, which are *valid definitive
answers*, not absences. A partial build would then erase a live cooldown or a
recoverable listing state while the blocker bits beside them correctly
rendered unknown: the false-green failure again, arriving through the field
added to prevent it.

So an unimplemented enum classifier MUST return `Indeterminate` (255), never
its zero value. Stated as a hard rule because the zero value is the natural
default of an unwritten function, which makes this the easiest of all these
mistakes to make by simply not doing something.

#### 4.5.1 The complete availability rule

The rule has been stated three times in this section, each time about the
field under discussion, and the result was that **the enums never entered the
gate at all** — every version said "bits, plus `admissionCode`". A conforming
client could therefore read `windowVerdict == PastMaturity` and still advertise
both exits, because nothing told it not to. Past maturity is not a corner: an
`Active` loan stays `Active` through its whole grace period, with every bit
legitimately clear, while listing reverts at `EarlyWithdrawalFacet:353-356` and
every valid direct-sale offer fails the zero-remaining-days check at
`EarlyWithdrawalDirectFacet:288-292`. So the gap covered the single most
predictable refusal in the set — the one that arrives on schedule, for every
loan, at a time known in advance.

Stated once, completely, so there is nothing left to omit. **A route is
available only when all of the following hold:**

1. Every bit in that route's mask is **checked** in `checkedMask` and **clear**
   in that route's blocker map.
2. `admissionCode == 0`. Any other value, 255 included, blocks both routes.
3. `windowVerdict` is route-compatible: `Open` for either route;
   `RelistCooldown` and `FinalHourWindow` block **listing only**;
   `PastMaturity` and `Indeterminate` block **both**.
4. `listingVerdict` is route-compatible: `None` for either route. Every other
   value blocks **both** routes, including the direct one — see below.

Anything else is unknown, and unknown renders as unknown, never as permission.

**Point 4 is the one that looks wrong and is not.** A listing's state appears
to be the listing route's business, and the earlier draft of this rule said so
— it told the direct row to accept `None`, `Fillable` and `Indeterminate`, and
called any listing-only value in a direct verdict a contract bug. That is
backwards: `EarlyWithdrawalDirectFacet` reverts `SaleOfferAlreadyExists`
whenever `loanToSaleOfferId[loanId]` is nonzero, and it does not care what
state that listing is in. Live, expired, accepted, bounds-violated — the link
alone closes the direct route. Under the old rule a lender with a *live*
listing would have been shown the instant sale as available, which is both the
commonest listing state and the one the #1839 chooser has blocked on both rows
since its first round. The document would have specified a regression against
behaviour already shipped.

Bit 10 encodes the same fact and is marked for both routes, so a conforming
client that checked only the bits would have been saved by it. That is not a
reason to leave the enum rule wrong: two fields describing one condition must
agree, or the next reader has to work out which one is authoritative.

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

**A sibling, not an extension of `saleAdmission` — and the reason given for
that was wrong.** The earlier text said widening `saleAdmission`'s return would
*break* `LibSaleSolvency`, and therefore a fund-moving path. It would not.
Appending return words does not change the selector; deployed callers decode
only the first three words and tolerate trailing returndata, and
`LibSaleSolvency.saleSolvency`'s low-level path explicitly checks for **at
least** 96 bytes before decoding those three. A fresh source build would need
its typed destructuring adjusted — a compile error, loud and local — but there
is no runtime break and no behavioural change to any guard.

So the sibling is not forced by a safety constraint. It has to stand on
weaker, real grounds, and it is worth being clear that these are preferences
rather than requirements:

- **The two answer different questions.** `saleAdmission` classifies solvency
  admission; this view aggregates eleven unrelated refusals plus two lifecycle
  enums. Merging them gives one selector two jobs and a return tuple whose
  first three words mean something different from the rest.
- **The guards would pay for the aggregate.** `LibSaleSolvency` is on the
  *mutating* path. Extending the selector it calls means every guarded write
  executes the listing lookups, pause reads and cooldown comparisons it has no
  use for — turning a read-only convenience into gas on the fund-moving path.
  This is the substantive argument, and it is about **cost**, not safety.
- **Append-only returns are a one-way door.** The bitmaps are already
  append-only by design (§4.1); making the admission selector's tuple
  append-only as well couples two schemas that will not evolve together.

Recording the correction rather than quietly substituting the better argument:
a design justified by a danger that does not exist is a design nobody has
actually weighed. The conclusion survives; the reasoning that carried it did
not.

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

**One extra read per position page — but not one cheap one, and the earlier
accounting was flattering.** It is a single RPC round trip, which is the number
that matters to the client. What that trip does on the node is not eight cheap
Diamond-local storage loads:

- **Item 2 is not a read at all.** `MIN_SALE_LISTING_SECONDS` is a
  compile-time constant, so counting it as an RPC saving inflated the
  denominator. It never cost a call.
- **Item 3 is the expensive one, by a wide margin.** `saleAdmission` runs live
  liquidity, health-factor and LTV logic that reaches external Chainlink
  feeds, secondary oracles, token metadata and pool state. Describing it
  alongside a storage read as "eight cheap local reads" understated it by
  whatever the oracle path costs, which is most of the call.

The honest form: **one round trip replacing up to seven, of which one does
real work and the rest are storage loads.** That is still the right trade for
a client — round trips are what a position page is short of, and the oracle
work happens on the node either way — but it changes the *availability*
argument materially, and that is the half the earlier text got wrong by
omission. A call whose dominant cost is oracle-reaching is a call that can
fail, be slow, or return `Indeterminate` under exactly the conditions §4.4
exists for. The preview is not merely cheaper than the alternative; it
inherits the alternative's fragility, concentrated into one place.

Concentrating it is arguably the point — one failure the card can name beats
seven it must reason about — but it must be argued rather than hidden behind
an averaged cost.

If the diet cannot afford this call, it cannot afford the feature, and the
honest response is to keep the rows silent rather than to guess — which is what
they do today.

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

The connected app (`apps/app`) talks to several heterogeneous Diamonds, and `LoanSaleFlow` already
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
(Counting note: fifteen loan-level entries — item 0, items 1–8, plus 8b
through 8g. The count has grown three times under review; §2 says why the
method that built it kept missing entries.)

My first attempt justified the split on *durability*: loan-level blockers are
permanent, candidate matching is momentary. That is **false**, and worth
striking rather than softening. Governance unpauses assets. Cooldowns expire
by construction. Oracle and liquidity conditions recover. A held-for-lender
balance gets resolved. Most of the fifteen are as transient as the order book.

The distinction that actually holds is **self-contained vs relational**. Every
one of the fifteen is a property of *this loan and this holder* — answerable by
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

**Given a yes:** the first batch is **items 6 and 7 only** — the two per-asset
pause legs, which really are bare `isAssetPaused` reads with no predicate
behind them — behind `checkedMask`, with the per-chain gate from §7 in place.

**8b and 8c are not in it either, correcting the revision that put them
there.** They look like free wins — the client can already answer both — but
the *contracts* enforce them inline (`loan.collateralAssetType != ERC20` and
`loan.assetType != ERC20`) in the mutating facets, so classifying them in the
preview first duplicates those guards and breaks §4.6 in exactly the way the
cooldown/window batch did. I removed that violation and reintroduced it one
revision later with different items, which says something about how easily
this precondition is lost.

Items 1 and 2 are **not** in it, correcting an earlier revision. Calling
them "pure storage reads" confused reading a value with classifying it: the
cooldown needs the inline `block.timestamp` comparison and the final-hour
window needs the `_boundListingExpiry` maturity predicate, so producing their
`windowVerdict` means reproducing exactly the logic §4.6 makes a
precondition for adopting any of this. A first pass that shipped them would
ship the duplicated predicates this design exists to eliminate — with the
proposal's own adoption rule written three sections above it.

So items 1, 2, 4, 5, 8, **8b and 8c** all land **with** the classifier
extraction, not before it. Naming 8b and 8c explicitly matters: the previous
revision removed them from the first batch and assigned them to nothing, which
under the `checkedMask` rule means the listing route could never graduate from
unknown for 8b and neither route for 8c. Removing a check from a batch is not
the same as scheduling it, and the difference is invisible until a permanently
unknown row shows up in production. Item 3 is already exposed.

**Every bit must appear in exactly one batch, and three did not.** The
paragraphs above assign items by discussing them, which is how the following
went unscheduled — each was *added* to the tractable set in a later revision
and the rollout, written earlier, never grew to match:

- **Item 0 (bit 0, loan not Active)** — added as the "most important" check in
  the revision that introduced it, and then assigned to no batch at all. Under
  §4.5's rule an unchecked bit forces **both** routes to unknown for **every**
  loan, so following this rollout literally would have shipped a preview that
  could never report either route available. The single most consequential
  scheduling omission possible, produced by adding a field and not revisiting a
  list.
- **Bits 11 and 13/14 (global pause, sanctions, holder)** — the global pause is
  a bare `paused()` read with no predicate, so it joins **the first batch**
  with items 6 and 7. Sanctions and holder resolution are also predicate-free
  lookups, but they are the only bits that depend on the `lender` argument's
  semantics, so they land with the classifier extraction where that contract is
  settled rather than assumed.
- **Bit 12 (offer-duration cap)** — with the classifier extraction. The
  comparison itself is trivial, but it lives inside
  `OfferCreateFacet._createOfferSetup`, so classifying it in the preview first
  duplicates a guard, which is the §4.6 violation again.

Item 0 lands with the classifier extraction: `LoanStatus` is read directly, but
which statuses block a sale is a predicate the guards enforce inline.

**The full assignment, so nothing is scheduled by prose:** first batch — bits
4, 5, 11. Classifier-extraction batch — bits 0, 2, 3, 6, 7, 8, 9, 10, 12, 13,
14, plus both enums. Already exposed — bit 1 (item 3).

That makes the first batch smaller and less useful than the version it
replaces, which is the honest consequence of taking §4.6 seriously rather than
a reason to relax it. It also means the first pass reports **unknown for both
routes on every loan**, since bit 0 is unchecked — it is a plumbing milestone,
not a user-visible one, and §7's per-chain gate should keep the card on
map-only behaviour throughout it.

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

**A sixth round found three more, all one category: claiming a
classification was complete when it was not.**

- A **rental principal** (non-ERC20) makes both entry points revert, entirely
  separately from the NFT-*collateral* check — and it was missing from every
  version of the table (now 8c). With `checkedMask` reporting those bits
  checked and clear, an omission like this is worse than an admitted gap.
- An **accepted-but-uncompleted** listing is neither fillable nor ended
  unfilled, and teardown is explicitly wrong for it (`AcceptedPendingCompletion`).
- An unexpired listing is **not necessarily fillable**: the seller floor and
  held ceiling stamped at listing can be violated by the time a buyer arrives,
  so every acceptance reverts (`BoundsViolated`).

The third is the one to sit with. It attacks `ListingLive` — a value added by
the *previous* round's fix — for exactly the flaw that round was fixing: a
verdict named for what was recorded rather than for what would happen. Six
rounds in, the document is still finding the same error in its own
corrections, which is either the strongest possible support for §1's thesis or
the clearest possible sign that this design should not be built. Both readings
are available and §8 does not resolve them.

**A seventh round found three more, and one of them is the most serious
omission in the document:**

- **No live loan-status blocker at all** (now item 0). Both entrypoints
  require `status == Active`, and the set had none — so on a stale indexer row
  the preview would report two routes clear that revert `LoanNotActive`. That
  is the exact window #1839 spent three rounds closing on the client, which a
  preview claiming to be the authority would have reopened at the source.
- **The single `temporalVerdict` conflated two orthogonal axes.** A listing
  past maturity or inside the final-hour window lost its fill/cancel/complete
  state to precedence, exactly when that state is the only actionable thing
  left. Split into `windowVerdict` (may a new sale start) and `listingVerdict`
  (what is the existing listing doing), ranked independently.
- **8b and 8c were put in the first batch** — and they are inline predicates
  in the mutating facets too, so that batch broke §4.6 the same way the
  cooldown/window batch did. I removed that violation one round earlier and
  reintroduced it with different items.

The last of those is worth stating plainly: **the same precondition has now
been violated twice, by me, one round apart, in a document that states it as a
condition of adoption three sections above.** If a rule is that easy to lose
while actively holding it in mind, expecting it to survive an implementation
under deadline is not a reasonable bet — and that is an argument about §8's
recommendation, not a note about §8's rollout table.

**Rounds six through thirteen — and then a decision to stop.** These found
eleven more, and the character of the findings changed partway through, which
is the most useful thing in this section.

The first several were still substantive gaps in the *contract surface* the
document claimed to enumerate:

- **The global pause** (bit 11) was never classified, in a document that had
  already corrected itself once about pausing and discussed it at length.
- **The offer-duration cap** (bit 12) reaches the listing route through generic
  offer creation, so enumerating the sale facets' own guards could not find it.
- **Sanctions screening and holder authorization** (bits 13, 14) were absent,
  and surfacing them exposed that the ABI had never said what its `lender`
  argument meant — caller, holder, or either.

Then three findings about the document's *internal consistency*, each of which
would have produced a wrong implementation from a faithful reading:

- The availability rule was stated three times, about whichever field was under
  discussion, and consequently **never included the two enums** — so a
  conforming client could advertise both exits past maturity.
- The direct row was told to accept listing-only verdicts, which
  **specified a regression** against behaviour #1839 shipped: any linked
  listing closes the direct route.
- `listingVerdict`'s value 2 was defined circularly, making value 4
  unreachable and silently deleting the one remedy a lender can act on.

And two corrections to arguments rather than facts:

- The cost accounting called `saleAdmission` one of "eight cheap local reads"
  and counted a **compile-time constant** as an RPC saving. The oracle-reaching
  call is most of the cost, and its fragility is inherited, not avoided.
- The stated reason for a sibling over extending `saleAdmission` — that it
  would break a fund-moving path — is **false**. Appending return words breaks
  no deployed caller. The conclusion survives on cost and separation-of-concerns
  grounds; the safety argument that carried it did not exist.

**Stopping here, and saying why.** This is a docs-only PR under a two-round
review cap, and it is being merged at thirteen. Every finding in those extra
eleven rounds was real and roughly half were consequential, so the rounds were
not wasted — but that is the trap rather than a justification. A proposal
document can absorb review indefinitely, because there is always another
contract path to enumerate and always another sentence that is not quite
precise enough, and none of it is load-bearing until someone decides whether to
build the thing.

**The document's purpose is to support the §6 fork, and it now does.** Both
options are stated, the preview-backed one is costed honestly including the
parts that weaken it, and the classifier-extraction precondition is explicit.
Continuing to refine an ABI that may never be cut is work performed against a
decision nobody has made yet.

Two things follow, and they point in opposite directions:

- If the answer is **yes**, this document is a starting point and not a
  specification. Twelve rounds found defects in it at a roughly constant rate,
  including several introduced by the corrections themselves. There is no
  reason to think the next twelve would find fewer, and an implementation will
  surface more than any amount of reading.
- If the answer is **no**, §6's map-only option needs none of this, and the
  right reading of thirteen rounds is that it is the cheaper answer as well as
  a defensible one — which is now stated in §8 and was not obvious when this
  was written.
