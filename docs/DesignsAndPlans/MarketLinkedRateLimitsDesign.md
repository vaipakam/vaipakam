# Market-linked rate limits, and Auto-lend that fills fixed or floating — design

**Status:** owner approved, 2026-11-15. Card #3635. Depends on the reference rate of #3337 (floating-rate loans), which is not built yet; this document also states what #3337's reference must provide so it is built once.
**Scope:** how the market reference rate may be used to fill fixed-term offers and standing intents fairly. Floating-rate loans themselves are specified on #3337 and are not re-specified here.
**Related:** `IdleLiquidityMatchingDesign.md` (the goal: nothing sits idle while a compatible counterparty exists), `AutoLendLendUntilDesign.md` (intent end date, pro-rata opt-in), #3626 (several intents per pair), the quote-time rate model (`RateModelFacet`, #400 / #2748).

## 1. The question

Owner, 2026-11-15: floating-rate offers behave like one-day offers at the market rate. Can they also fill fixed-term offers and intents, in a fair way?

## 2. What is not done, and why

**A floating offer is never matched against a fixed offer with each side keeping its own rate rule.** A loan has one rate rule, signed by both parties. If a lender were paid the floating rate while the borrower paid a fixed one, the difference would have to come from, or go to, someone else on every day the market moved. That someone would be the protocol, which would then be a middleman carrying rate risk. The floating-rate decision (#3337) rules that out: no platform spread, the borrower pays exactly what the lender earns.

**A matched loan is never re-priced** outside a formula both parties signed. The existing rule for the quote-time rate model (it never re-prices a live loan and never overwrites a typed rate) stays whole.

## 3. What is done instead

Two opt-in uses of the reference rate. In both, each loan still has one rate rule that both parties signed.

- **A. Market-linked limit.** A maker of a fixed-rate offer or intent may express their rate limit as "the market rate plus a margin" instead of only a typed number. The limit moves with the market while the offer waits. When it fills, the loan is an ordinary fixed-rate loan at the rate agreed in that transaction, and it never changes afterwards.
- **B. Fixed or floating on Auto-lend.** A standing lender intent may opt in to fill floating requests as well as fixed ones, each under its own limit. The same capital serves whichever borrower arrives.

A is what makes the reference act like a "one-day offer": a waiting offer re-prices itself as the market moves, without a transaction, until it fills.

Two further uses fall out of A at no extra contract cost, and are part of this design:

- **C. A market-tracking position built from fixed loans** (section 5a): a market-linked Auto-lend slot with a short longest term re-prices at every new fill, so a lender follows the market in steps before floating loans exist at all.
- **D. The averaged reference as guidance** (section 5b): every maker, linked or not, sees "the market today" beside the rate field.

## 4. A — market-linked limit

### 4.1 Rule

An offer, or an intent slot, may carry a link: a signed margin in basis points (`linkMarginBps`, may be negative) and a flag that the link is on. The link produces a **linked rate** = averaged reference for the lending asset (4.3) + margin, floored at zero.

The link only ever **tightens** the maker's own typed bounds. The typed bounds stay, and stay binding:

| Maker | Typed bound that stays | Effective bound while linked |
| --- | --- | --- |
| Lender offer or intent | lowest rate (the floor) | the higher of the typed floor and the linked rate |
| Borrower offer | highest rate (the ceiling) | the lower of the typed ceiling and the linked rate |

Everything after that is today's rule, unchanged: the match needs the two ranges to overlap, and the loan's rate is the midpoint of the overlap, computed from the effective bounds. The result is stored on the loan as its fixed rate.

Consequences worth stating:

- No reference value, however wrong, can produce a rate outside what a maker typed and signed. A lender is never filled below their typed floor; a borrower never above their typed ceiling.
- A lender who wants "always at market" types a low floor and a link margin. A lender who wants "never below 4%, and at least market when market is higher" types 4% and a link.
- A linked maker's upper bound (lender) or lower bound (borrower) is not linked. Linking both ends would let the reference set the whole range, which removes the typed safety bound.

### 4.2 When the reference cannot be used

If the averaged reference is unavailable (4.3), a linked offer or intent **fills nothing** until it is available again, and the preview says so with its own reason. It does not fall back to the typed bound: the maker asked for a market-relative limit, and filling at a typed floor that may be far below market is the outcome the link exists to prevent. Unlinked offers and intents are not affected by the reference at all.

### 4.3 The averaged reference

> **Amended 2026-11-17 (#3713, `RateGuideAndLinkGuardsDesign.md`).** The window is no longer 24 hours for every term: a fill reads 24 hours for a loan of up to 30 days, 7 days up to 365 days, and 30 days beyond. Linked fills over 30 days pause while the reference is "unusual". A link may name the guide for the loan's term instead of the averaged reference, so `rateLinked` becomes `linkKind`. Where this section and that design differ, that design holds.

The linked rate must not be the latest reading. A fill is permissionless and its sender picks the moment; a single reading can be momentarily low or high even inside the per-update clamp.

#3337 defines one cumulative rate index per lending asset and chain: each update adds `reference × elapsed time`. An average over any window is then exact and cheap: `(index now − index at window start) ÷ elapsed time`.

What this design needs from #3337's index, to be built with it:

- **Checkpoints.** The updater records the index value and time once per hour in a small ring (the same shape as the hourly price checkpoints the forced-sale floor reads), so a window start can be found without a search.
- **Window.** The average is taken from the newest checkpoint that is at least 24 hours old. A governance-bounded setting (12 to 72 hours, default 24).
- **Available means:** the index was updated within its staleness limit (the limit #3337 sets for itself; proposed three update intervals), a checkpoint exists inside the window's tolerance (at least the window, at most twice the window old), and the quorum was not in its "previous reference holds" state for more than half of the window. Otherwise unavailable.
- **One read.** `LibRateReference.averaged(asset)` returns the average and whether it is available. The match core, both previews, the intent fill and the views all call it, so they cannot disagree.

### 4.4 Feedback guard

#3337 lets the platform's own matched-loan rate join the quorum as one member on high-volume pairs. A loan whose rate came from a linked bound is partly a copy of the reference. Loans filled with a linked bound on either side are therefore excluded from that own-rate member, so the reference cannot feed on itself.

### 4.5 Where it applies

- **Matches of two offers** and **intent fills:** as in 4.1.
- **Direct accept:** the acceptor signs exact terms, including the rate. For a linked offer the signed rate must sit inside the effective bounds at that moment; a rate that was valid when the screen loaded and is not when the transaction lands is refused, and the app re-quotes. The builder scouts how a direct accept picks the rate inside a ranged offer today and keeps that rule.
- **Signed (off-chain) offers:** the link fields join the signed offer type.
- **Changing the link** (margin or on/off) is a change of terms: the terms-age wait (#3443) restarts. The reference moving is not a change of terms.
- **Not offered** on NFT rentals, loan-sale offers or refinance requests in this build. They can follow once the lending case has run.

### 4.6 Contract changes

| Where | Change |
| --- | --- |
| `LibVaipakam.Offer` | Append `bool rateLinked`, `int16 linkMarginBps` at the tail (mapping value struct). |
| `LibVaipakam.LenderIntent` | Append the same two fields (per slot, after #3626). |
| `LibRateReference` (new, beside #3337's index) | `averaged(asset)`; `effectiveLenderFloor`, `effectiveBorrowerCeiling`. One copy, hosted behind a self-call if the match hosts have no room. |
| `LibOfferMatch` (match core and both previews) | Compute the overlap from effective bounds. New `MatchError.ReferenceUnavailable` and `IntentError.ReferenceUnavailable`, appended at the tail of each enum. |
| `OfferCreateFacet`, `OfferMutateFacet`, `LenderIntentFacet.setLenderIntent`, the signed-offer type | Accept and validate the fields (margin within ± the protocol maximum rate; link refused for an asset with no reference configured). Creation events and `LenderIntentSet` state them. |
| Loan record | One appended flag, `rateFromLink`, for 4.4 and for the loan page. |
| Views | Offer and intent views return the effective bound now and whether the reference is available. |
| Storage-layout guard | `write`, commit the golden file. |

The match hosts sit close to the size limit (`OfferMatchIntentFacet`, `SignedOfferMatchFacet`, `RiskPreviewFacet`). Check with the deploy-sanity size test; if the bound computation does not fit inline, host it once and self-call it, as the risk bounds are (`OfferPreviewFacet.initRiskBounds`). Do not trim.

Reaches a chain by fresh deploy.

## 5. B — Auto-lend that fills fixed or floating

An intent slot gains `bool acceptsFloating` and a lowest margin (`minMarginBps`, signed), set through `setLenderIntent`.

- **Off (default):** the intent fills fixed-rate requests only, as today.
- **On:** it also fills floating requests whose offered margin is at least `minMarginBps`. Floating loans are pro-rata only (#3337), so the flag requires `acceptsProRata`; setting it without is refused.
- Each fill is one kind of loan. A fixed request is checked against the intent's rate floor (typed, or market-linked per section 4); a floating request against its margin floor. The materialized lender slice takes the request's rate kind, so the match core's lifecycle-terms check passes and both parties' signed terms describe the loan that is opened.
- Everything else about the intent is shared: capital, exposure cap, LTV ceiling, longest term, lend-until date, roll. A rolled loan's proceeds return to the slot whatever kind the loan was.
- The backstop vault and the aggregator adapters pass `false`.

A one-time offer cannot be "either": it is one concrete set of terms that a counterparty reviews and signs. A lender who wants both posts two offers, or uses an intent.

This part needs floating loans to exist, so it is built with or after #3337's loan part.

## 5a. C — a market-tracking position from fixed loans

Nothing new is built for this; it is what sections 4 and the existing roll give together, and the app should offer it by name.

- A lender sets a market-linked Auto-lend slot with a short longest term (for example 7 or 30 days) and "keep lending when repaid".
- Each loan is fixed for its own short term. When it is repaid, the roll returns principal and interest to the slot (`rollIntentLoan`, and from #3629 the held amounts too), and the next fill is a new fill, priced from the effective bound at that moment.
- The position therefore follows the market in steps of one loan term. The borrower of each loan has a rate that cannot move during their term, which a floating loan cannot offer.

A roll is not a re-pricing of an open loan: the old loan is repaid and closed first. A new fill while the reference is unavailable is refused like any other linked fill (4.2); the capital waits in the slot, still claimable by its owner.

This ships with step 2 of section 10, before floating loans, and covers most of what a lender wants from "lend at the market rate". Floating loans (#3337 part 2) remain the answer for a borrower who wants one long loan that tracks the market without re-borrowing.

## 5b. D — the averaged reference as guidance

The same `LibRateReference.averaged(asset)` read is shown, never applied, on every rate field:

- The post-offer and Auto-lend forms show "market today" for the lending asset, and how far the typed rate is from it. An offer typed far from the market is the commonest reason an offer sits idle, and today the maker has nothing to compare against on pairs the quote-time model does not cover.
- The quote-time rate model keeps its own rule and its own band. Where both exist for a pair the form shows both, labelled; neither overwrites a typed rate. Whether the model should take the averaged reference as one of its inputs is a separate decision and is not made here.
- The "why isn't my offer matching" diagnostics (#3623) state the distance from the market when the reference is available.
- Where the reference is unavailable or not configured, the field says so. It never shows a stale number as current.

No contract change beyond the view in 4.6.

## 6. Fairness, stated

- **Consent.** Nothing here binds a party to a rule they did not choose. A link is opt-in per offer or intent; fixed-or-floating is opt-in per intent.
- **Hard bounds.** A link can only tighten the maker's typed bound (4.1).
- **No timing edge.** The linked rate is a 24-hour average; the per-update clamp of #3337 bounds how far one hour can move it.
- **Fail closed for the linked maker only** (4.2).
- **No middleman.** The protocol takes no spread and carries no rate risk; the treasury's usual share of interest is unchanged.
- **Pricing rule unchanged.** The loan's rate is still the midpoint of the overlap; the protocol still does not rank counterparties.
- **Disclosure.** The review screen shows the formula, the reference's current average, the resulting effective bound and the typed bound; says the bound will move while the offer waits; and says that once a loan opens its rate is fixed and will not follow the market. An unavailable reference is shown as unavailable, never as a number.

## 7. Off-chain

- **Keeper:** the match and intent passes compute effective bounds from the reference view before spending a preview, and skip linked makers while the reference is unavailable. A change in the average can make waiting pairs compatible, so the pass re-examines linked pairs after each index checkpoint. New passes ship disarmed.
- **App:** a "Follow the market" choice beside the rate field (margin, the typed bound kept as "never below" / "never above"), today's effective rate, and the copy in section 6. Auto-lend setup gains "also lend at a floating rate" once floating loans ship.
- **Indexer:** stores the link fields and `rateFromLink`; the "why isn't my offer matching" diagnostics (#3623) add the two reasons "reference unavailable" and "market-linked limit is currently above/below the counterparty's range".
- ABI exports for the frontend and the keeper bot in the same PR as the contract change.

## 8. Tests

1. Unlinked offers and intents behave exactly as today, with and without a reference configured.
2. Lender link: the effective floor is the higher of typed and linked; a borrower whose ceiling is between them is refused; the loan's rate is the midpoint from effective bounds; the loan's rate does not change when the reference later moves.
3. Borrower link: the mirror case.
4. Both sides linked: overlap and midpoint from both effective bounds.
5. A negative margin, and a linked rate that would go below zero, floor at zero.
6. Reference unavailable (stale index, no checkpoint in tolerance, quorum holding too long): linked makers are refused with the new reason by the match and by both previews alike; unlinked makers still fill.
7. Averaging: a one-hour spike moves the linked rate by at most its share of the window; a fill inside the spike does not get the spike rate.
8. Changing the link restarts the terms-age wait; the reference moving does not.
9. Direct accept of a linked offer at a rate outside the effective bounds is refused.
10. `previewMatch` and `previewIntent` report Ok if and only if the match and the intent fill succeed, with links on.
11. A loan filled through a link is excluded from the own-rate quorum member.
12. Section 5a: a linked slot's loan is repaid and rolled; the next fill is priced from the effective bound at that time, not the old loan's rate; with the reference unavailable the capital waits and the owner can still withdraw it.
13. Part B: flag off refuses a floating request; on fills it as a floating loan and still fills a fixed request as fixed; `acceptsFloating` without `acceptsProRata` is refused at set; margin floor enforced; roll returns either kind to the slot.

## 9. Alternatives considered

1. **Cross-fill floating against fixed, the protocol settling the difference.** Rejected: the protocol becomes a rate-swap counterparty (section 2).
2. **A keeper or the owner re-prices waiting offers as the market moves.** Rejected: a transaction per change, each one restarts the terms-age wait, it stops silently when nobody sends it, and a keeper setting a user's price is what the keeper rules forbid.
3. **A pure link with no typed bound.** Rejected: a wrong or manipulated reference would set the rate without limit.
4. **Link to the latest reading.** Rejected: the sender of a fill picks the moment.
5. **Fall back to the typed bound when the reference is unavailable.** Rejected: fills at a rate the maker tried to avoid, at the moment the market data is least trustworthy.
6. **Price a linked fill at the linked rate itself instead of the midpoint.** Rejected: it would give the whole overlap to the unlinked party every time, and the platform would have two pricing rules. A maker who wants to trade close to the market types a bound close to it, or meets another linked maker, where the midpoint is the reference plus the average of the two margins.
7. **One borrower request that accepts either a fixed or a floating loan.** Rejected for now: a loan copies one concrete borrower offer, so "either" would need two offers over the same collateral where filling one cancels the other. That is a general feature (one-cancels-the-other offers) with its own lien questions, not part of rate linking. A borrower who wants the market rate posts a market-linked fixed request today.
8. **Build floating loans first and wait for them.** Rejected: sections 4, 5a and 5b need only the reference, not floating loans, and deliver the market-following behaviour sooner with a smaller change.
9. **Convert an open floating loan to fixed, or the reverse.** Out of scope: that is a new agreement between the two parties; the lender-takeover and refinance routes already exist for changing terms.

## 10. Order of work

1. #3337 part 1: the reference quorum and the per-asset index, **with the hourly checkpoints and `LibRateReference.averaged`** from 4.3.
2. Section 4 (market-linked limits), with 5a and 5b in the app. It needs only step 1, not floating loans, so it ships before them.
3. #3337 part 2: floating loans.
4. Section 5 (fixed or floating on Auto-lend).

Each is its own contract PR; all reach a chain by fresh deploy.

## 11. Open items for the builder to raise, not decide silently

- How a direct accept chooses the rate inside a ranged offer today (4.5).
- Whether the window and tolerance in 4.3 suit the update cadence #3337 settles on.
- How the next fill after a roll is priced today, to confirm 5a needs no contract change.
- Chains or assets with fewer than three reference sources: #3337 decides whether a reference exists there; where none does, links are refused for that asset.
