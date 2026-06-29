## OfferDetails lists every loan from a multi-fill offer (#600)

A range / partial-fill offer can be filled many times, producing several loans
from one offer. The offer detail page previously linked only a single loan (the
most recent fill), so to see the rest a user had to go back to the Dashboard's
"Loans by offer" section.

The offer detail page now shows a **"Loans from this offer"** section listing
every child loan, with the same per-offer aggregates the Dashboard already
computes — total principal, amount-weighted average rate, minimum health factor,
status counts, and collateral by asset — and each child links to its own loan
page. A single-fill offer is unchanged: it keeps the existing "View loan" link
and the section doesn't appear.

The complete child list is read from the indexer's activity history of the offer
(every fill emits an accept event tagged with both the offer and the new loan),
so it reflects all loans the offer ever produced regardless of who currently
holds them. No on-chain or contract changes.
