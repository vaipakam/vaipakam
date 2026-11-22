# A borrow larger than one transaction: fill what fits, request the rest

**Status:** design, agreed in outline by the owner on 2026-11-20 (one loan per lender stays; a larger borrow is filled in parts). Nothing is built from it yet. Card #3871.

**Related:** `InstantMarketDesign.md` (section 4, the instant borrow and its fill bound), `BorrowingDesign.md` (sections 4 and 8, the record and adding to it), `RateAuctionDesign.md` (the all-at-once route), `PayoutDestinationRuleDesign.md` (where an offer's leftovers go), `TermAverageAndLinkGuardsDesign.md` (the rate acknowledgement).

## 1. Why

An instant borrow opens one loan per lender, and one transaction holds only so many loans: 2 on the networks with the smaller transaction limit and 5 on the others, as measured on 2026-11-20 (`InstantMarketDesign.md`, section 4). A borrower who wants more than those lenders can give in one transaction has, today, to borrow again by hand.

The owner decided on 2026-11-20 to keep one loan per lender. Every loan keeps its own collateral amount under its own hold, its own health factor and its own liquidation. A loan shared by several lenders was designed and not adopted. This document is the route for a larger borrow under that rule.

## 2. What exists today

Scouted on `main` on 2026-11-20.

- **`borrowInstant`** fills from the sources the borrower lists, in order, each fill its own loan at that source's own price, until the amount is received or the fill bound is reached. It reverts only when what was received is below the least the borrower states. The borrower's collateral is split across the loans in proportion to principal. The collateral for what was not filled is not taken.
- **A borrower's request on the book** (a borrower offer) can already be filled in parts when the matching switch is on. It states a smallest amount per fill and a total. Each match opens its own loan and adds to the amount filled, and the request closes when what is left is below the smallest fill. What is left of its collateral is then released.
- **A slot fills a request** through `matchIntent`, which any solver may call and the platform's keeper already calls each tick. The keeper sizes the fill, confirms it with the preview and submits it. A slot that requires an authorised solver is filled only by one.
- **The price when a third party pairs two standing parties** is the midpoint of the range both accept. A request that states one rate, not a range, is therefore filled at exactly that rate, by any lender whose own floor is at or under it.
- **Collateral per fill of a request** is what the lender requires for that amount (and at least what the opening risk rule requires). It is not the borrower's own proportion. A borrower who posted more collateral than lenders require gets loans nearer the limit than they chose, and the surplus back when the request closes.
- **A request's fill can open a borrowing** when the request carries renewal limits and a slot fills it (`BorrowingDesign.md`, section 4). No request can name an existing borrowing.
- **Every fill pays its fee as any loan does.** A third party that pairs the two is paid the matcher's part of that fee. The borrower's fee is the same on every route.

## 3. The design

**An instant borrow may leave what it could not fill as the borrower's own request on the book, in the same transaction. Each later fill of that request is its own loan with one lender, in the same borrowing.**

Three changes make that work. The first two are useful for any request and are built first.

### 3.1 A request may name the borrower's borrowing

A borrower's request may name a borrowing its creator owns on the same pair. Every loan the request opens then joins that borrowing as it opens, under the rules `BorrowingDesign.md` section 8 already sets for adding a loan:

- The request carries interest by time, as every loan in a borrowing does.
- The request records the borrowing's settings version when it is posted. A fill is refused while the borrowing's version differs, so no loan enters under settings the borrower did not see. The borrower confirms the request against the new settings in one call, or cancels it.
- A request whose stated rate is above the borrowing's highest rate is refused at posting, and a fill is refused if the limit has since moved below it. A loan never enters a borrowing outside the limit that borrowing renews under.
- The bound on the borrowing's list is checked at posting against the most loans the request can open (its total over its smallest fill, rounded down, since no fill is smaller than that), and again at each fill after a prune. A fill that would pass the bound is refused.
- The request carries no settings of its own. The borrowing's renewal limits and due-date plan are its settings. Where a slot with the renewal consent fills it under the conditions of `InstantMarketDesign.md` 6.1, the loan is an instant-market loan in this borrowing, not in a borrowing of its own.
- If the borrowing's owner is no longer the request's holder, every fill is refused.

A refused fill moves nothing and leaves the request open. The refusal names its reason, and the preview a solver reads reports it, so the keeper does not retry it each tick.

### 3.2 A request may state its collateral in proportion

A request may state that every fill takes collateral in the request's own proportion: the collateral posted over the total requested, times the fill's amount, with the fill that completes the request taking what is left. A lender who requires more than that for the amount cannot fill it, and the opening risk rule still applies to every loan. This is the rule an instant borrow already uses for its own fills. It lets the borrower, and not the lender's limit, decide how far each loan opens from its liquidation level.

### 3.3 `borrowInstant` may post the rest

The request gains three optional inputs: the rate offered for the rest, the time the request stays open, and the smallest fill.

- **When it applies.** After the fills, if the amount wanted is not yet received and the rest inputs are present, the call posts a request for the rest. It is an ordinary request in every respect, made by the same creation rule every offer is made by: it is on the book, it has its own position token, it can be cancelled, and anyone reading the book sees it.
- **Rate.** One stated rate, not a range, at or under the highest rate the borrower gave for the instant fills. Every fill of the rest is at exactly that rate (section 2). It is a maker's rate, checked against the warning band once, when the request is posted, as any request's is (`TermAverageAndLinkGuardsDesign.md` 6.4). The call's one acknowledgement is needed if that rate, or any fill's, is outside the band. A later fill by a third party asks for none.
- **Collateral.** The collateral not yet used is locked for the request in the borrower's vault, from free balance first and then from the wallet, as for the fills. The request states collateral in proportion (3.2), with the proportion of the whole borrow.
- **Term and shape.** The same base term, interest by time and the same repayment shape as the fills. Fixed rate only, as the instant borrow is today. A floating request arrives with the floating loan.
- **Borrowing.** The request names the borrowing the call opened or added to (3.1).
- **How long.** The time is required and bounded: at least 10 minutes, at most 30 days, a governed range. At that time the request can no longer be filled. Its collateral is released by a cancel: the borrower's own, or anyone's once the time has passed, which the book already allows for an expired offer. The keeper does not sweep expired ordinary offers today (its teardown pass covers sale listings and offers whose route is dead), so that pass gains one case: an expired request that names a borrowing. The borrower's collateral is then released without the borrower returning.
- **Smallest fill.** At least the book's value floor, and large enough that the most loans the request can open fit the room left on the borrowing's list.
- **When no request is posted.** If what is left is below the smallest fill or the book's value floor, if the wallet is at its limit of open offers, or if a rule of 3.1 refuses it, the borrow completes without a request. The collateral for that part is not taken, and the summary event and the preview state the reason. The least total the borrower stated still applies to what this transaction received, unchanged, and a call that receives nothing still reverts.
- **Gas.** Posting the request is part of the call's measured cost. The fill bound for a call that posts the rest is the largest number of fills for which the whole call, with the posting, stays inside 80% of the network's limit, so it may be one lower than for a call that posts nothing. The gas tests cover a borrow at that bound with a request posted.
- **One event states the whole borrow**: the loans opened now, the request posted (its id, amount, rate, time and smallest fill) or the reason none was posted.

### 3.4 Who fills the rest, and at what price

- Any lender, by the routes the book has today: a slot through a solver's fill, a lender offer through a match, or a lender directly where the request is not yet part filled. The platform's keeper fills requests from Auto-lend slots already, one loan per transaction. No new keeper pass is needed for the fills.
- Nobody chooses a price for the borrower. The rate is the one the borrower stated. Whoever pairs the request chooses which lender fills it, and that choice changes nothing for the borrower: the rate, the proportion of collateral, the term and the shape are the request's.
- A loan filled from the rest is an ordinary loan of the book. It is an instant-market loan only under the conditions of `InstantMarketDesign.md` 6.1.

## 4. What the borrower is told

No guiding. The review shows facts and the borrower chooses.

- What this transaction borrows: the amount, from how many lenders, each at its own rate.
- What can be borrowed now beyond that, in further transactions, and at which rates: the sources that did not fit. Borrowing more now is another instant borrow into the same borrowing, at those lenders' own rates.
- What a request for the rest would be: the amount, the rate the borrower enters (the field starts at the highest rate the borrower already gave), until when, and the smallest fill.
- That the rest **fills at the stated rate, not at a lender's lower price**, that it may fill in part or not at all, and that each loan's term runs from the moment that loan opens, so the loans will not share one due date.
- That the whole amount at one moment and one rate is the rate auction (`RateAuctionDesign.md`).

Afterwards the borrowing shows "borrowed X of Y" (an app figure, as today), the request with what it has filled, and one notice per loan as it opens.

## 5. Limits, stated

- **The rest may fill short, or not at all.** Nothing is promised but the rate if it fills. What is left below the smallest fill is never filled: the request closes and that part's collateral is released.
- **The rest costs the stated rate.** A lender whose own price is lower still lends at the borrower's stated rate. A borrower who wants lenders' own prices borrows again now, in further transactions.
- **Different start times.** Loans opened from the rest start later than the first ones and fall due later. The borrowing's actions and its due-date plan already work across loans with different dates.
- **Collateral stays locked for the request** until it fills or is cancelled: by the borrower, or by anyone once its time has passed.
- **A request can be cancelled only after the book's short wait** from posting, as any offer.
- **A fill can be refused** by the borrowing's rules (3.1). The request then waits for the borrower.

## 6. What it needs

- **Contracts.** The borrowing on a request, with its checks at posting and at each fill, and the confirm step (3.1). Collateral in proportion on a request (3.2). The rest inputs on `borrowInstant`, the posting inside the call, the preview and the event (3.3). The fill-bound rule and its gas tests with a request posted. Every new external step gets its row in the permissionless-steps ledger where one is owed.
- **Keeper.** No new pass. The matcher's preview reading gains the new refusals so a refused fill is not retried each tick. The teardown pass gains the discovery and cancel of an expired request that names a borrowing, and the ledger row for cancelling an offer says so.
- **Indexer.** The request's link to the borrowing and to the instant borrow that posted it, and each later loan's link to both.
- **Apps.** The review of section 4, the borrowing's view of an open request, cancel, and the confirm step after a settings change.
- **Spec.** The owner's list gains the lines this changes.

**Order of work.** Part 1: the borrowing on a request and collateral in proportion (3.1, 3.2), with the app posting the rest as a second transaction. Part 2: the one-call form (3.3). Part 1 is usable alone. Both come after Borrowing A, which builds the record they name. #3851, which makes every loan cheaper to open, is separate and raises how many fills fit in one transaction.

## 7. Alternatives considered

- **Nothing new.** Repeated borrows by hand, or the rate auction. It leaves the borrower to come back, and a request posted by hand takes collateral at the lender's limit and joins no borrowing.
- **Hold the lenders' slots in one transaction, then open each loan after.** It needs a third state for lenders' money on every slot path, and it lets a borrower hold other people's money. The rate auction has that shape fairly, because there bidders lock their own money.
- **A list of sources committed by the borrower and continued by anyone, at each source's own price.** It keeps the lenders' own prices for the part that only failed to fit. It needs a stored plan, a new step anyone may call and a second kind of hold on collateral, and it serves only lenders who were there at the first transaction. Further instant borrows give the same prices with nothing new.
- **Fill the request at each lender's own price.** Whoever pairs the request would then choose the borrower's price by choosing the lender. A stated rate removes that.
- **One loan from several lenders.** Designed and not adopted (owner's decision, 2026-11-20).

## 8. Recommendation

Fill what fits, request the rest, as above: one stated rate for the rest, collateral in proportion, every loan in the one borrowing, filled by the book's existing routes. Part 1 first.

## 9. Tests

1. A request that names a borrowing: each fill's loan is in that borrowing. A fill is refused, with its reason and nothing moved, when the settings version differs, when the stated rate is above the borrowing's limit, when the list is full, and when the borrowing's owner is not the request's holder. After the confirm step the next fill succeeds.
2. Collateral in proportion: fills of unequal size each lock their proportion, the last takes what is left, the amounts sum to the collateral posted, and a lender requiring more is refused.
3. `borrowInstant` with the rest inputs: the loans open, the request is posted for exactly what is left with exactly the collateral left, and the event states both. Without the inputs the call behaves as today.
4. No request is posted, the borrow completes and the reason is stated: below the smallest fill, below the value floor, at the open-offer limit, refused by a rule of 3.1. The collateral for that part is not taken.
5. Every fill of the rest is at the stated rate, whatever the lender's floor, and no fill is possible from a lender whose floor is above it.
6. The least total applies to what the transaction received; a call that receives nothing reverts, with or without the rest inputs.
7. After its time the request cannot be filled. A cancel by anyone releases its collateral to the borrower's vault as free balance, and the keeper's teardown pass finds an expired request that names a borrowing and cancels it without the borrower acting.
8. A borrow at the fill bound that also posts the rest is inside 80% of each network's limit, measured on the CI toolchain.
9. A flagged borrower's request is not filled, and its cancel after expiry still runs.
10. The preview of `borrowInstant` reports the request it would post, or the reason for none, exactly as the call then does.

## 10. Open items for the builder to raise, not decide silently

1. Which facet hosts the posting inside `borrowInstant`, given the two instant facets' room under the size limit.
2. Whether the confirm step of 3.1 is its own entry or an edit of the request through the existing edit route.
3. The exact governed range for the request's time, if 10 minutes to 30 days does not suit the book's expiry rules.
4. Whether collateral in proportion is offered on the ordinary request form in the apps at the same time, or only used by the rest.
