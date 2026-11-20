# The repayment record (design)

**Status:** owner approved the feature for design and build on 2026-11-19 (second review of the platform survey). Card #3778. Indexer and app work, with one small addition to a contract event (4.4): the full repayment's event states the loan's due date as the chain measured it.
**Base:** the events and views named below were read on the batch branch of #3743 (`claude/project-thread-ijafuu`), and the design was checked against that code again after it was written. Two things it names are designed and not yet built there: the exit instruction (#3752) and the payer on a part repayment and a wallet interest payment (#3779). The record counts them once they exist.
**Related:** `FeaturesOverExistingPartsDesign.md` (the public data feed, section 8), `PayoutDestinationRuleDesign.md`, `ExitBeforeLiquidationDesign.md`, `RateReferenceSeriesDesign.md`.

## 1. Why

A person who has borrowed and repaid here many times looks, to the next lender, exactly like a wallet created this morning. For a loan against liquid, priced collateral that matters little, because the collateral covers the lender. It matters where the lender carries more of the outcome themselves: a loan against collateral that has no price, a rental of an item the renter could fail to return in good time, and any offer where the lender wants to choose who they deal with.

Everything needed to state a wallet's history is already public in the platform's events. Nobody has put it in one place, and where people do that for themselves they tend to turn it into a score.

## 2. What the user gets

A **repayment record** for any address: a short page of counted facts about the loans and rentals that address held as the borrower or renter, each with the block it is true as of.

- Shown on a borrower's request, beside an offer when someone accepts it, on a rental, and on the address's own page.
- It is a list of facts. It is not a score, a grade, a rating or a rank, it has no colour, and it never says whether anyone should lend.

## 3. The rule

1. **Facts from the chain only.** Every figure is derived from the platform's own events. Nothing is self-declared and nothing comes from outside the platform.
2. **No single number.** The record never combines its figures into one.
3. **Each figure says what it leaves out.** In particular the record states that one person can hold many addresses, and that two addresses can lend to each other.
4. **Anyone can recompute it.** The derivation is published with the public data feed, with a version, and every figure carries its block.
5. **It gives nobody a right.** No contract reads it. A lender may look at it; the contracts treat every wallet the same.

## 4. Design

### 4.1 What it states

For an address, on each network, and as a total with the per-network lines beneath it:

| Figure | Counted how |
| --- | --- |
| Loans held to the end as borrower | loans whose borrower position this address held when the loan closed |
| Of those: repaid on or before the due date | closed as repaid, at a time not after the loan's due date as the chain measured it (4.4) |
| Repaid after the due date, inside the grace period | closed as repaid, at a time after that due date |
| Repaid by a sale of collateral on the holder's own route or instruction | repay-with-collateral, and the exit instruction once it is built |
| Refinanced | the old loan closed by a refinance; counted once, here, and not also as repaid |
| Closed by liquidation | a health-factor liquidation |
| Closed by default | the grace period ended unpaid |
| Open now | loans this address holds as borrower today |
| Interest periods | closed with no sale of collateral; collected by a sale after the grace |
| Interest paid | the total per token, from the per-loan interest-paid event |
| Fees paid to the platform | the initiation fees and the treasury's share of interest on those loans, per token |
| Rentals | completed and returned in time; ended by default |
| First loan | the date of the first loan this address held |
| Held from the start | how many of the closed loans this address also opened, and how many it took over later |

- **No amounts in money terms are ranked or compared.** Totals are per token, in the token's own units, with a numeraire value beside them only where the indexer already holds the price at the event. (Settled with the builder on 2026-11-19: it holds no price at each event, so no money value is shown. A total is never valued at today's price.)
- **Internal records are left out:** the vehicle loans a lender's sale creates, which the platform's own view already marks.
- **A loan is counted for the address that held the borrower position when it closed.** Someone who takes over a nearly finished loan and repays it has repaid a loan, and the "held from the start" line shows it was taken over.
- **A payment by someone else** (a guarantor's borrower, `FeaturesOverExistingPartsDesign.md` section 2) is the holder's loan repaid. The record does not name payers.

### 4.2 What it says about itself

Shown on every view of a record, in these words or close to them:

- "This is a count of what this address did on this platform. It is not a score and not advice."
- "One person can use many addresses, and a new address has no record. An empty record says nothing bad."
- "Two addresses can lend to each other to build a record. The fees paid line shows what that would have cost."
- "Past repayment does not secure a loan. The collateral does."

The words credit, score, rating, trust, reputation, grade and worthiness are not used for it anywhere.

### 4.3 Where it is shown

- **A borrower's request and a renter's request:** a one-line summary (loans repaid, loans closed by liquidation or default, first loan date) that opens the full record.
- **A lender reviewing a fill, and a lender whose slot or offer was filled:** the same line for the counterparty.
- **The address's own page,** with a link the owner can share.
- **A filter in the app's request list:** "has repaid at least N loans". It is a filter on what the lender sees. It is not a condition on any offer and the chain does not enforce it.
- **The public data feed:** one read per address, with the block and the derivation's version. It is the only read in the feed that takes an address. The feed has no route that lists, ranks, searches or filters addresses by their record, and every answer carries the statements of 4.2 and the number of loans it could not classify.

### 4.4 The derivation

- The indexer builds the record from events it already handles: the loan's opening, the terminal events (repaid, defaulted, liquidated, the refinance and preclose closings, the exit run), the periodic settlement events, the per-loan interest-paid and interest-undelivered events, the fee events and the position transfers.
- **Timing is read from time, never from the late fee.** A late fee is a share of the principal still open, so on a loan paid down to a very small remainder it rounds to zero, and a late repayment would then count as on time. The loan's due date also moves with a platform pause and with a sequencer outage, by the chain's own clock, so the indexer does not rebuild it from the loan's start and length. The full repayment's event therefore states the due date the chain measured the late fee from, and the record compares the repayment's time with it. Settled with the builder on 2026-11-19: the `LoanRepaid` event gains `lateFeeFrom`, the moment the chain's loan clock starts the late fee, read at the repayment. That event has one emit site for every full repayment. A repayment is on time when its block time is not after `lateFeeFrom`. It is built with #3779, which already changes the repayment events. On a deployment whose event does not state it, a repayment with a late fee is counted as late, one made no later than the loan's original due date is counted as on time, and any other is left unclassified and counted as such.
- A figure that cannot be derived for a loan is left out of the count and the record says how many loans it could not classify. It never guesses a class.
- **Fees paid are read from one statement.** The events of 2026-11-19 do not state a loan's fees: no event names the initiation fee, and the treasury's share of interest is stated on some routes only. Settled with the builder that day: the fee is stated once, where every fee passes. The platform's fee step names the loan a fee belongs to in the event that already states the treasury's part and the reserve's part, on every route, so the record sums those parts per loan and no route can be missed. An event at the initiation charge with a field on the interest event was considered and not chosen: it would state the treasury's share in two places, one of which does not measure what arrived. Until that is built, the record says that fees paid are not stated; it never shows a zero for them.
- A fresh Diamond on a network starts a new record on that network, as every indexed figure does. The record states the date its history begins.
- The derivation's document lists each figure, the events it reads, and the cases it leaves out. A change to the derivation raises its version.

## 5. What it cannot do

- It cannot tell whether two addresses belong to one person.
- It says nothing about a person's means, identity or conduct anywhere else.
- It does not follow a person to a new address. A user who moves wallets starts an empty record.
- It cannot be hidden by its owner, because every fact in it is already public. The app shows it only where it bears on a decision (4.3) and does not list addresses by record.

## 6. Tests

1. Each figure of 4.1 equals a recount from the raw events for a set of addresses that covers every closing route.
2. A refinanced loan is counted once, as refinanced. A loan paid down to a remainder too small to carry a late fee and then repaid after its due date is counted as repaid after the due date; one repaid after its original due date but inside a due date moved by a pause is counted as on time.
3. A sale's vehicle loan is not counted.
4. A loan taken over and then repaid is counted for the address that closed it, under "took over later".
5. A loan paid by another address counts for the holder.
6. An address with no history returns an empty record with the statement of 4.2, never an error and never a zero score.
7. The feed's read carries the block and the version, and returns nothing the app keeps privately for a wallet.
8. No view of the record shows a combined number, a rank or a colour.

## 7. Alternatives considered

1. **Counters on chain, written at each closing.** A contract could then read the record, for example an offer open only to wallets that have repaid a number of loans. Not recommended now. Every loan is secured by its collateral, so no contract needs the record to decide anything, and the counters would add a write to every closing route and code to facets that are already near their size limit. The events already carry every fact. If a product arrives where a contract must read the record, the counters are added then, from this same list of figures.
2. **A token or badge that cannot be transferred.** It turns a count into an object people collect and display, and it invites the reading that the platform vouches for its holder. Rejected.
3. **One score.** Easy to read and easy to misread. A score decides how the facts are weighed, on the reader's behalf, and it reads as an assessment of a person. Rejected.
4. **Bring in a history from outside the platform.** The platform cannot check it, and it ties an address to an identity. Rejected.
5. **Let the owner switch their record off.** The facts stay public and anyone can count them, so the switch would promise a privacy it cannot give. Rejected in favour of showing the record only where it bears on a decision.
6. **Do nothing.** Lenders who care will count for themselves, each in their own way, and some will publish scores. A plain, stated count from the platform is the better starting point.

## 8. Recommendation

Build the record in the indexer and the app, as a count of facts with its limits stated, served through the public data feed. The one contract addition is the due date on the full repayment's event (4.4), built with #3779.

## 9. Open items for the builder to raise, not decide silently

1. Any figure of 4.1 that the current events cannot classify without a guess, with the event that would settle it.
2. Whether the one-line summary on a request is read with the request or fetched after it.
3. How far back the numeraire value beside a total can be stated from prices the indexer already holds.

Settled on 2026-11-19: item 1, fees paid (4.4) and the repayment's timing (`lateFeeFrom`, 4.4); item 2, the one-line summary is its own cached read made after the request, a request never waits on it or is hidden for it, and a line that could not be read says so; item 3, no money value (4.1).
