## Thread — Position sales now require a solvent position (PR-E, item 11)

Selling a lender position used to check almost nothing about the position's
health. Both exit routes — the direct swap-in against a standing buy offer,
and the resting sale listing — gated on the loan still being `Active` and
nothing more. That left a real trade open: a lender watching collateral fall
could hand an already-underwater position, in the worst case one liquidatable
in the very next block, to a counterparty who had authored ordinary lending
terms on the assumption that a new position starts comfortably
over-collateralised. The sale price is computed from principal and accrued
interest, neither of which says anything about a collateral shortfall, so
nothing in the trade signalled the problem.

A sale is an admission rather than a hand-off of already-accepted risk — the
incoming lender never underwrote this loan — so both paths now require the
position to clear the same health-factor floor its own origination required.
The floor comes from the loan's origination snapshot rather than the live
protocol setting, which is the rule every other post-origination health check
follows.

A sale must clear a second bar as well, and the two pull in different
directions on purpose. Transferring a position changes the lender, not the
loan's recorded admission floor, liquidation threshold or initial-LTV cap — so
where governance has tightened since origination, a buyer would silently
inherit looser collateral bounds and a later liquidation point than they could
be sold today, which no health reading reveals because the position is entirely
solvent against its own older terms. Sale admission therefore also requires
those inherited terms, and the position's live loan-to-value, to be compatible
with current parameters.

So the honest statement about a governance retune is narrower than "it changes
nothing for open positions". Snapshot semantics still govern the existing
loan's ongoing operation, so the current lender's bargain is never rewritten.
But a tightening can leave an otherwise valid open position temporarily
unsellable while it remains perfectly valid to hold, repay or liquidate. That
is a deliberate consequence of treating a sale as the admission of a new
lender rather than a hand-off of accepted risk. For a resting listing the
binding check is at the moment the buyer's value commits: a listing sits
still while the position keeps moving, and only the fill-time reading
describes what the buyer actually inherits. Listing creation runs the same
test so a seller is told at once instead of after some buyer's transaction
fails, and the read-only accept preview classifies a sub-floor position so an
interface can explain the block before anyone signs. It is deliberately not
re-checked at sale completion, where a refusal would strand a buyer whose
principal has already settled — the same reasoning the maturity gate follows.

Positions whose legs are not price-discoverable are out of scope rather than
silently admitted: a health factor is a ratio of priced values, so there is
no floor to measure, and those positions stay governed by the explicit
both-parties-consent regime for illiquid assets. The guard fails closed in
the other direction — if a position claims to be priceable but the oracle
cannot price it, the sale is refused rather than admitted against an
unverifiable figure.

Verified beyond unit tests: each new test was confirmed to fail when the
guard is removed, and the behaviour was driven end-to-end against a real
Diamond deployed on a local chain — full facet routing, real oracle wiring,
no mocking — where a position was pushed under its floor by a collateral
price move, the sale refused with the specific error, and the very same sale
then settled once the price recovered.

This is the first half of PR-E. Item 21 (sale paths rejecting or binding
active borrower close-out state) is not included: rejecting an active
refinance offer needs a loan-to-refinance-offer reverse index that does not
exist today, which is a cross-facet change worth keeping separate.

Two pre-existing problems were found while verifying and are recorded rather
than fixed here: the local-chain flow script cannot reach its broadcast pass
at all (an earlier scenario's keeper revocation re-simulates as
already-revoked and aborts the run, reproducible with every later scenario
disabled), and one test fixture builds a Diamond without the risk facet, so
sale-path tests in it now need the health read stubbed.
