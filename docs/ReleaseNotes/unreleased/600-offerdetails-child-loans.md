## OfferDetails lists every loan from a multi-fill offer (#600)

A range / partial-fill offer can be filled many times, producing several loans
from one offer. The offer detail page previously linked only a single loan (the
most recent fill), so to see the rest a user had to go back to the Dashboard's
"Loans by offer" section.

The offer detail page now shows a **"Loans from this offer"** section listing
every child loan, with the same per-offer aggregates the Dashboard already
computes — total principal, amount-weighted average rate, status counts, and
collateral by asset — and each child links to its own loan page. (Health factor
isn't computed for this offer-side view, so the min-HF cell shows "—".) A
single-fill offer keeps the existing "View loan" link; the section also appears
for a lone child of a still-open partial-fill offer that has no header link yet,
so that loan is always reachable.

The complete child list is read from the indexer's activity history of the offer,
covering both direct fills and matcher-driven fills (the latter previously
attributed a lender offer's loans to the counterparty offer; the indexer now also
records the lender side so those children surface here too). It reflects all loans
the offer ever produced regardless of who currently holds them. No on-chain or
contract changes.

Operational note: the matcher-fill coverage relies on a new indexer field written
only for activity recorded after this deploys. On an environment that already has
historical matcher-filled lender offers, those existing rows need a one-time
re-index to appear in this section (the platform is pre-live, so there is no
production history to backfill).

This also corrects a status-label mapping so terminal loans (liquidated /
fully-settled) show the right status and counts here and on the public dashboard.
