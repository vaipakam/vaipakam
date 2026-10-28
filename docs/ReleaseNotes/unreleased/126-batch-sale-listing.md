## Thread — List all for sale on lender positions from one offer (PR #3066)

When one of a lender's offers filled into two or more loans whose lender
positions the wallet still holds, the Positions page now shows a card for
that offer, in Advanced mode, with "List all for sale". On a network
where listing is not available yet, the card says so instead of
disappearing. The lender picks one rate and one
listing window, reviews every loan, and signs one transaction for up to
30 listings instead of one per loan. Listing draws nothing from the
wallet and asks for no approval.

The checks the loan page's listing form runs before a listing is signed
(sanctions, the position still held, both assets unpaused, the loan
active and far enough from its due date, and a simulation of the exact
listing) now live in one per-loan plan that the form and the batch both
use, so the two cannot drift.

The review shows, for each loan, the minimum the lender is guaranteed if
a buyer takes the listing, anything already set aside for the lender
that goes to the buyer, today's settlement, and what that loan's own
page says before a listing (a Full fee mode travels to the buyer; a rate
above the loan's own costs the difference). It discloses the lock on
each listed position, and one consent covers exactly what the review
shows. Each listing is bound to the figures reviewed, and is skipped
rather than made if it would record worse ones. A loan the platform
would refuse is left out and named with the reason; every loan is
checked again in full right before its transaction is sent.

Which loans were listed is taken from the transaction's own record, not
assumed: listed (with its sale offer, which its loan page then shows and
can cancel), not listed with the reason, no longer active, not confirmed
yet, or unreadable.

Advances #126 (slice 2 of 3; the borrower's "Refinance all" follows).
Design: `docs/DesignsAndPlans/OfferGroupBatchActionsDesign.md`.

> Caveat: no Anvil end-to-end spec yet; it needs a seed that fills one lender offer into two loans.
