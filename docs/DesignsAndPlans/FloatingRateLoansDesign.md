# Floating-rate loans — design

**Status:** design note for #3337 part 2, which the card requires before any code. The product was decided by the owner on 2026-11-08 (#3337) and amended on 2026-11-15 (standard cap and floor levels). This note settles the loan side: the shape of an offer and a loan, the accrual, the ceiling, which routes open and act on a floating loan, and what previews read. Design for review before build.
**Related:** `RateReferenceDesign.md` (part 1: the reference, series, index), `FloatingRateCapFloorLevelsDesign.md` (cap and floor levels), `MarketLinkedRateLimitsDesign.md` (#3635; part B is Auto-lend that fills floating), `RepaymentByOthersDesign.md` (#3779: the one interest ledger a period is judged from, and the one writer of the accrual segment's start), `LenderSaleSellerInterestClaimDesign.md`, #3637 (rate-rise illustration, "fix my rate", alerts).
**Base:** read on the branch of the part 1 build (`RateReference`, `RateLinkFacet`, the offer and loan records, `LibInterestLedger`, `LibEntitlement`, `LibPeriodicInterest`, the sale and close-out facets) and the batch branch. The design was checked against that code again after it was written.

## 1. What the scouting found

- **The reference side is ready.** A series keeps a running sum of `reference × seconds`, 1e18-scaled, readable at the present second. It counts its open loans through two entries only the Diamond may call. Its ceiling is fixed when the series opens.
- **A loan's rate is read in about twenty places**, not one. `LibInterestLedger` is the one *writer* of a loan's principal and rate, but the borrower's debt, the close-out sizing, the fallback, the period library, four sale and close-out facets, the metrics and the rewards each multiply `principal × rate × time` from the stored rate themselves. A floating loan has no stored rate to multiply.
- **Two books price interest.** The borrower's book counts from the start of the current accrual segment and credits the interest settled. The lender side's ledger counts from its last checkpoint. Both are right for a floating loan if each remembers the running sum at its own starting moment.
- **Several routes price interest that has not happened yet**: the lender sale (listed, direct, parallel), the offset, the full-term minimum and the handover all compute interest for the remaining term at the loan's rate. That figure does not exist for a floating loan.
- **An offer already carries a signed margin** for a market link (`linkKind`, `linkMarginBps`). That is a bound on a fixed rate, set once at the fill. It is a different thing from a rate that moves for the loan's life, and the two are kept apart (section 3).

## 2. The rule

A floating loan's annual rate at any moment is `clamp(reference, floor, cap) + margin`, where the reference is its series' reference, the cap and floor are the levels it signed (or none), and the margin is the agreed margin.

**One running sum per loan.** For a loan's series and its two levels, the rate reference serves the **clamped sum** as of the present second:

`F = index − excess above its cap + shortfall below its floor`

A loan's levels never change, so `F` is one number for the loan's whole life and a snapshot of it is one value, not three. Interest on a principal `P` from a moment with snapshot `F₀` to now, `t` seconds later, is

`P × ( (F − F₀) + margin × 1e14 × t ) / (365 days × 1e18)`

worked in one division, rounded as fixed interest is. With a constant reference and no margin this equals a fixed loan at that rate to the last unit, which is the first test.

A floating loan is exact at the present second and at any moment it stored a snapshot. It has no exact figure for a future moment or for a past moment nobody stored. Every rule below follows from that.

## 3. The offer

An ERC-20 lending offer gains, appended:

| Field | Meaning |
| --- | --- |
| `rateKind` | 0 fixed, 1 floating. |
| `floatMarginBps` | Signed basis points. A lender's offer states the least margin it takes, a borrower's the most it pays. |
| `capLevelId`, `floorLevelId` | Level ids of the lending asset, 0 for none. |

The same four go on the creation parameters, the signed-offer type and the acceptor's signed terms. On a fixed offer all four are zero. On a floating offer:

- the fixed rate fields are zero and it carries no market link (a link bounds a fixed rate);
- interest is by time only. The full-term minimum is refused, as the card decided;
- it is an ERC-20 loan whose lending asset has a reference that is not stale (`RateReferenceDesign.md` 6). An NFT rental, a sale vehicle and a collection offer are never floating;
- **the ceiling rule:** the effective cap plus the margin must not exceed the protocol maximum interest rate. The effective cap is the cap level, or with none **the series' own ceiling**, which the reference can never pass (section 6);
- **the floor rule:** the effective floor plus the margin must not be below zero. The effective floor is the floor level, or zero with none. So a negative margin needs a floor at least as large;
- levels must be open, and the floor below the cap, as the levels design states.

These are checked when the offer is posted, for an early refusal by name, and again in the one shared origination step with the margin actually agreed and the series the loan opens on, which is the check that binds.

An offer names no series. The loan opens on the asset's newest series at that moment. A taker's signed terms name the series they saw, so a taker is never moved to another. A maker with a standing floating offer is covered by the delay on opening a series (seven days or more), its event, and a notice from the app that the reference for the asset changes on a date and the offer may be cancelled.

## 4. Matching and accepting

- `rateKind` and the two level ids join the lifecycle terms the match core compares, and must be equal. A floating offer never meets a fixed one (`MarketLinkedRateLimitsDesign.md` section 2).
- **Two offers:** the lender's least margin must not exceed the borrower's most. The loan's margin is their midpoint, by the same rounding the fixed midpoint uses.
- **Direct accept:** the loan opens at the offer's margin exactly.
- The warning band and the term average are for fixed rates. A floating loan's protection is its cap, and nothing checks a margin against the market.
- Previews report a kind mismatch, a level mismatch, a margin gap, a stale reference and each refusal of section 3 with its own reason, appended at the tail of the error lists.

## 5. The loan

The loan record gains, appended, all written once at origination except the anchor:

| Field | Meaning |
| --- | --- |
| `rateKind`, `floatMarginBps`, `capLevelId`, `floorLevelId` | The agreed terms. |
| The rate reference's address and the series id | Stamped beside the loan's other settings (#3437). The loan reads that contract and that series for its whole life, whatever the registry points to later. |
| The segment anchor | The clamped sum at the start of the current accrual segment. |

The lender side's ledger gains its own anchor, the clamped sum at its last checkpoint.

The fixed rate field of a floating loan is zero and nothing may read it (section 7). At origination the Diamond tells the rate reference a loan opened on the series and its two levels, and when the loan leaves its accruing states (the one status writer) that it closed. The close is idempotent by a mark on the loan, and a failure of that call never stands in the way of a close-out: it is caught and stated in an event, and its only cost is a series written longer than needed.

## 6. The protocol maximum

**An uncapped loan's cap is its series' ceiling.** The reference is already cut to the series' ceiling before it enters the running sum, at no cost per loan and with nothing extra tracked. So one rule covers every floating loan: effective cap plus margin within the protocol maximum, checked at origination. No loan can accrue above the protocol maximum as it stood when the loan opened, and the running sum stays exact.

Two consequences, both stated to users:

- Every floating loan has a worst case the borrower can read as one rate: cap plus margin, or series ceiling plus margin. The review says "your rate can never pass X%" in both cases, and for an uncapped loan adds that X comes from the reference's own ceiling, not from a cap chosen by the parties. This replaces the levels design's wording that an uncapped loan has only the protocol maximum.
- A series is opened with its ceiling below the protocol maximum by the room meant for margins. A series whose ceiling equals the protocol maximum admits uncapped loans only at a margin of zero or less. Choosing the ceiling is an owner configuration step when the series is proposed.

## 7. Accrual: one reader of a loan's rate

**One library answers every question about what a loan's rate has cost or costs now**, for both kinds:

- the interest on a principal from a stored starting point to now;
- the loan's rate now, its highest possible rate and its least, as annual figures;
- a **ceiling** on interest between now and a future moment, at the highest possible rate, and the matching least.

Every place that multiplies principal, rate and time today calls it. A fixed loan gives the same figures as now. A pre-deploy check, placed after the existing loan-terms checks, refuses any read of a loan's stored rate outside that library, as the writer check does for writes. Without it a missed reader would compute zero interest on a floating loan and nothing would fail.

**The two books.**

- *The borrower's book.* The one writer of the accrual segment's start (#3779) also writes the segment anchor, in the same step. Interest on the segment is the formula of section 2 from that anchor. The interest settled stays a credit against the segment.
- *The lender side's ledger.* A checkpoint folds in interest from its own anchor and moves the anchor. Sales, seller claims, the treasury share, the lender's fee discount and the payout order are unchanged: they work on amounts.
- Each touch costs one read of the rate reference. There is no per-loan upkeep and no other writer of accrued interest.
- The rate setter refuses a floating loan: its terms never change.

**What does not change:** the late fee (a share of principal, read from the loan clock), the grace period, accrual through a pause, and accrual at the held figure while the reference holds or a source is muted.

**Interest periods.** A floating loan may carry a cadence under the same admission rule as a fixed loan. A period is judged from the one ledger, as #3779 decides, with one stated difference: the shortfall of a boundary that has passed is the interest accrued **to the present moment** less the interest settled, because a floating loan has no exact figure at a past boundary nobody stored. So a period is covered when, at any payment at or after its boundary, everything accrued to that moment has been settled; a sale for a period sells for what has accrued and is unpaid at the moment of the sale; and nothing is ever taken before it accrues. The review and the loan page say that a floating loan's period is settled to the moment of payment, not to the period's end date. Figures shown ahead of a boundary are an estimate at today's rate with the ceiling beside it.

**Figures sized for a future moment** (the refinance payoff permit, which is already a ceiling to a stated time; a reserve's sufficiency; any "by" view) use the ceiling of this section from now to that moment and say they are a ceiling. Settlement always takes the exact figure at its own moment.

## 8. Routes

**Open a floating loan in part 2:** posting an offer on either side, a direct accept, a match of two offers, a signed offer's fill and its keeper match, and a refinance in either direction (a floating request that replaces a fixed loan, and a fixed request that replaces a floating one, which is "fix my rate" of #3637). Amount ranges and part fills work as for fixed.

**Act on a floating loan in part 2:** full and part repayment by anyone allowed, interest payment at any time (#3779), the three standing instructions, the exit instruction (#3752), the health-factor liquidation on every route, the time-based default, the fallback and its claims, the periodic settlement, swap-to-repay, the direct early close, a plain transfer of either position token, and every claim.

**Refused on a floating loan or offer in part 2, each by name:**

| Route | Why | Where it comes back |
| --- | --- | --- |
| Auto-lend slots, the instant market, the takeover at face value | A slot states a fixed rate floor; it needs the margin floor and cap bounds of #3635 part B | #3635 part B |
| Lender sale (listed, direct, parallel), offset, lender cash-out routes that sell or price the position | They price interest for the remaining term, which a floating loan does not have | With #3635 part B, as the takeover at face value: a floating position stays close to its face value because its rate follows the market, so the natural exit pays the principal outstanding and leaves the earned interest as a seller claim |
| Obligation handover, in-place extension, the automatic extension and refinance limits, renewal | Each re-agrees a rate inside limits stated as fixed rates | The renewal build (#3763) and the due-date plan (#3785) each state their floating rule |
| Rate auction, collection offers | Fixed by their own designs | Not planned |

A lender therefore holds a floating loan to its end date in part 2, short of transferring the position token, and the lender's review says so in one plain sentence. That limit ends with part B.

## 9. Health, previews and views

- **Every on-chain check reads what is owed now**, which is exact: the health factor, liquidation, partial withdrawal, every close-out. Nothing on-chain admits or refuses a loan on a projected rate. Origination tests are on principal, as today.
- **Views** return, for a loan and for a floating offer's terms: the rate now, the highest possible rate and the least, the reference, the margin, the levels as all-in rates, the series, and whether the reference is holding or stale. The rate-rise illustration of #3637 is computed in the app from these; a figure the app cannot substantiate is shown as unknown.
- **Figures that read "the loan's rate" as one number** (the platform's average rate, the rewards basis) read the one library. Floating loans stay out of the fixed-rate average and are counted beside it with their margins. The builder lists each such reader with what it means for a floating loan and reports the rewards basis before choosing (open items).
- **Events:** the origination event states the kind, margin, levels, rate reference and series. Interest events state amounts, as today. The indexer derives a loan's rate history from the series' update events.

## 10. Contract changes

| Where | Change |
| --- | --- |
| Rate reference | Level table, per-series level totals accrued in the update, the clamped-sum read (returning the series ceiling with it), level counts in the two Diamond-only entries, add and retire behind the delay. Stated to the builder on 2026-11-19; measured for size in the same change. |
| Offer, creation parameters, signed-offer type, acceptor's terms | The four fields of section 3, appended. |
| Loan record and the interest ledger | Section 5, appended. |
| The one rate library | Section 7, with every current reader moved onto it and the pre-deploy read check. |
| Offer creation and the one shared origination step | The rules of section 3; the open call to the rate reference. |
| Match core and previews | Kind and level equality, the margin midpoint, new refusal reasons appended. |
| The segment-start writer (#3779), the ledger checkpoint | Write and move the anchors. |
| The period library's one shortfall | The floating reading of section 7. |
| The status writer | The close call, once. |
| Routes of section 8's third list | Refuse a floating loan or offer by name. |
| Views and events | Section 9. |

Built on the #3779 change, which gives the one segment-start writer and the one period shortfall. Reaches a chain by fresh deploy. Storage golden file rewritten; facet sizes checked by the deploy-sanity suite, split along a seam where one does not fit.

## 11. Tests

1. Constant reference, no margin: equal to a fixed loan at that rate to the last unit, on both books, through repayment, part repayment, liquidation and the fallback.
2. A moving reference across many updates: total interest equals the sum over update intervals, whatever touches happened in between, and both books agree.
3. Cap, floor and both, on paths that cross each (with the levels design's tests).
4. Margin: positive, zero, and negative with a floor; interest is never negative.
5. The ceiling rule and the floor rule at posting and at origination, with the agreed margin; an uncapped loan on a series whose ceiling leaves no room is refused; a loan never accrues above the protocol maximum.
6. Match: kinds and levels must be equal; margin midpoint; a margin gap refuses; a direct accept opens at the offer's margin.
7. A taker's signed terms naming an older series refuse after a new series opens; a maker's standing offer opens on the newest.
8. A loan opened on a series keeps reading it after a newer series opens and after the registry points to another contract.
9. Open and close counts: once each per loan on every terminal route; a failing close call does not block a close-out.
10. Periods: a payment at or after a boundary that settles everything accrued covers it; a sale sells what is accrued and unpaid at its moment; totals over the loan's life equal total interest.
11. Each refused route refuses by name; each acting route of section 8 settles the exact interest.
12. A future-moment figure is never below what is later owed at that moment.
13. The read check refuses a read of a loan's stored rate outside the library.
14. A stale reference refuses new floating loans and leaves open ones accruing at the held figure.

## 12. Alternatives considered

1. **Put the margin in the fixed rate field, with a kind flag.** Fewer fields. Rejected: every reader that was missed would read a margin as a rate, and a margin may be negative.
2. **Reuse the market link's kind and margin for floating.** No new fields in the signed type. Rejected: a link is a bound on a fixed rate set once; one field would carry two rules.
3. **Three snapshots per book** (index, excess, shortfall), as the levels design first listed. Rejected for one clamped sum: a loan's levels never change, so one number carries the same information.
4. **Cut an uncapped loan's interest to the protocol maximum at each settlement.** Rejected: the result would depend on when settlements happen, the levels design's alternative 3.
5. **Require a cap on every floating loan.** It also gives one rule. Rejected: the series ceiling already is that cap, and requiring a level would refuse loans on an asset with no level list.
6. **Refuse interest periods on floating loans at first.** Simplest. Rejected: every floating loan would then be limited to a year, and the one ledger of #3779 already gives a sound reading at the present moment.
7. **Judge a floating period at its boundary from stored checkpoints.** Exact at the boundary, at the cost of checkpointing every level total. Rejected: more state in a contract near its size limit, to move a threshold by a few days of interest that is owed either way.
8. **Open every route in part 2.** Rejected: the sale and re-pricing routes need rules of their own for a rate that moves, and the reader change is already the larger part of this build.
9. **Leave the readers as they are and special-case floating in each.** Rejected: twenty copies of one rule, the fault the writer check was made for.

## 13. Recommendation

Build floating loans with explicit offer and loan fields, one clamped sum per loan, one library that reads a loan's rate with a pre-deploy check behind it, the series ceiling as the ceiling of an uncapped loan, interest periods read at the present moment, and the route lists of section 8.

## 14. Open items for the builder to raise, not decide silently

- The rewards basis for a floating loan (9), with the choices found.
- Whether the periodic sale's sizing and the shared period loop take a need that grows by the second without change. If not, report before choosing between a change there and refusing a cadence.
- The measured size of the rate reference with the levels, and the seam if it does not fit (read side out, never the levels).
- Any reader of a loan's rate, or any route that prices future interest, that this note does not list.
- For the owner: the uncapped wording of section 6, the ceiling of each series, and that a floating position has no sale route until part B.
