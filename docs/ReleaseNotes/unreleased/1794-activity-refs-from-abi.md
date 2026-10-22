## Indexer — every activity row is filed under the loan or offer it names (PR #TBD)

**Loan and offer references now come from each event's own definition, by one rule (#1794).** The activity ledger can be filtered by loan and by offer, but those references used to be written out by hand, one event at a time. An event nobody had written out was stored with no loan and no offer. The row existed, but nobody looking at a loan could find it. Sixty event fields were in that state, among them a lender selling a loan, a borrower's early close-out, collateral being added or withdrawn, health-factor liquidations and fallback episodes. Now the indexer reads the reference straight from the event's definition, using the same rule the coverage check uses to decide that an event carries one. All of those events are filed under their loan or offer, and a new event that names a loan is filed correctly without anyone remembering to add it. Only the "who did it" field is still decided per event.

**What is deliberately not filed, and why, is written down in one policy file.** Each exception is stated with its reason, and the indexer and the coverage check read the same file.
- Companion records whose main event in the same transaction is already filed are not filed again, so one action is not listed twice.
- `SanctionedProceedsLocked` is not filed under a loan, because its loan field carries an offer number when the refund comes from a cancelled offer.
- The value zero, which events use to mean "no loan" (a treasury conversion's swap attempts carry it), is never filed as a loan.

Where an event names two candidates, the choice is recorded with its reason:
- A refinance is filed under the old loan it closes.
- A standing-intent or signed-order match is filed under the counterparty's standing offer, not the slice offer the protocol creates inside the same transaction.

Each exception also records which event fields it was granted for, and the coverage check flags the exception if those fields change (#1807). The check now states what it guards: accidental drift, not deliberately constructed workarounds (#1811).

**What this means for existing data.** Rows already in the ledger keep their earlier filing. Every testnet is indexed again from scratch at its next fresh deployment, so no rewrite of existing rows was added. In the app, a wallet's Activity page now also lists these events for the loans it holds. Some of them have no translated label yet and show an English name generated from the event, which the app's label work will cover.

Closes #1794, #1807, #1811.
