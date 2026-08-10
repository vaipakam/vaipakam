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
fails, and the read-only accept preview classifies a blocked position, naming
which bar it failed rather than reporting every refusal as a health-factor
shortfall. Consuming that classification in the acceptance interface is
separate follow-up work, so today a buyer can still sign and learn of the block
from the revert; the contract-side guard holds either way. It is deliberately not
re-checked at sale completion, where a refusal would strand a buyer whose
principal has already settled — the same reasoning the maturity gate follows.

Positions whose legs are not price-discoverable now get an answer of their own
rather than a free pass. Previously they were waved through this check on the
reasoning that a health factor is a ratio of priced values, so there was no
floor to measure, and that the platform's separate consent regime for illiquid
assets would govern them. That regime's enforcement sits behind a switch that is
off by default, so on a default deployment the practical effect was that an
unpriceable — in the worst case worthless — position could be handed to whoever
had authored a standing offer, with no loan-specific or pair-level agreement
anywhere in the flow.

Two things changed together, and neither would have been safe alone. Liquidity
is now judged **as of the sale** instead of being read from the record written
when the loan was opened, which is never refreshed: a market that had degraded
since origination previously let a position be sold on the strength of prices
the platform no longer accepts, without ever being recognised as unpriceable.
Fixing only that would have routed *more* positions into the pass-through, so
the pass-through is gone: where a leg cannot be measured and no consent regime
is in force, the sale is now refused. Where progressive risk access is enabled,
the buyer's own risk-access gate governs instead — the mechanism the platform
already specifies for illiquid-backed pairs, which is the one surface that can
express an informed acknowledgement.

A leg counts as measurable only when the live determination and the loan's own
record agree. That is not belt-and-braces: the record is what decides whether
risk arithmetic runs for a loan at all, so a position recorded as illiquid has
no health factor to compare regardless of what its market has since done, and
consulting only the live value would surface an opaque internal failure from the
health calculation where the honest answer is that the position is unpriceable.

A refusal says which leg is not priceable and carries no figures, because there
is no measurement to report. The buyer-facing preview reports the same case as a
plain block rather than as a health shortfall — the platform should never show a
health figure for a position that has none.

The guard fails closed in the other direction too — if a position claims to be
priceable but the oracle cannot price it, the sale is refused rather than
admitted against an unverifiable figure.

Where that failed price read is concerned, the two surfaces now also agree on
the stated reason, not just on the refusal. Previously the buyer-facing preview
turned a price read it could not complete into "this position is below its
health floor", quoting nought as both the position's figure and the figure it
had to meet — a measured shortfall that had never been measured, and a
different reason from the one the sale itself would give. The preview now says
the position cannot be admitted and that the reason could not be determined,
which is what actually happened.

The admission test is a cross-component read, and that has a consequence for
upgrades rather than for users. Two of the operator scripts that refresh an
already-deployed contract set in place reinstall a sale entry point without
having installed the component the new check reads, so running either against
an existing deployment would have left sales failing outright — the new code
live, and every attempt refused for a reason that has nothing to do with the
position. Both scripts now install that component and register the check
alongside whatever they refresh, choosing per entry point whether it is new or
merely being repointed by reading what the live deployment currently routes,
so one script is correct against an older deployment and a current one alike.

Two related problems on that path were found and fixed in the same pass. One
of the two scripts could not run against a current deployment at all: it
assumed a specific historical shape and tried to register entry points that
were already present, which aborts the whole operation. Its every step now
reads live state instead of assuming a version — which also means the sale
fix is genuinely reachable through it rather than masked by the script failing
first. The second: that script refreshes the acceptance path but had left the
read-only preview beside it untouched, so the preview would have gone on
quoting a sale as fine while the acceptance refused it — the exact
preview-versus-outcome divergence this change exists to remove, reintroduced
by a partial refresh. The preview is now refreshed with the path it previews.

Verified beyond unit tests: each new test was confirmed to fail when the
guard is removed, and the behaviour was driven end-to-end against a real
Diamond deployed on a local chain — full facet routing, real oracle wiring,
no mocking — where a position was pushed under its floor by a collateral
price move, the sale refused with the specific error, and the very same sale
then settled once the price recovered.

The upgrade path was rehearsed the same way rather than argued from a
successful compile, because a compile cannot see this class of mistake at all:
an existing local deployment was reduced to the shape a pre-change one
presents, the sale was confirmed to fail there for exactly the routing reason
described, and each refresh script was then run against it. For the script
covering the direct route, the sale was then driven again and completes. For
the script covering the resting-listing route it does **not** complete — that
is the separately filed pre-existing defect described further down, and the
rehearsal is deliberately left failing on it rather than pointed back at a
route that would pass. An operator should expect that script's rehearsal to
stop at its final step.

What the automated test pins is narrower than the operator rehearsal, and the
difference matters: it drives the real cut assembly of both scripts and proves
every affected function ends up routed to a single live build, including an
assertion that the starting fixture really does reproduce the failure —
without which the test could pass against a fixture that was never broken. It
does not drive a sale to completion, so it cannot stand in for the rehearsal
on the point above. Each script is also run twice in a row, because the first
pass exercises the register-as-new branch and the second the repoint branch,
and the underlying operation rejects either one applied in the wrong
situation.

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

A second, larger flaw in the same script came out of reviewing that fix. It
kept its own hand-written record of which functions each component owns, and
that record had fallen a long way behind: for the configuration component it
listed 34 of the 90 functions actually in service, and two others were
similarly short. A refresh only re-points the functions it names, so the rest
carried on being served by the previous build — one component answering calls
from two different versions of itself, while the script reported success and
nothing appeared to fail. The script now reads those lists from the same place
the full deployment does, so the record cannot fall behind, and a new check
asserts every function of every refreshed component ends up on a single build.
The equivalent staleness in the other refresh script is filed separately and
untouched here; its sale-path fix, which is what this release needed, is
complete and covered.

One more gap in the rehearsal itself came out of that review, and closing it
found something. The rehearsal drove the direct sale route for both refresh
scripts, but one of the two refreshes the *resting-listing* route instead — so
for that script the rehearsal was exercising a path it does not touch, and would
have stayed green with the refreshed listing check broken or absent. Each script
is now rehearsed against the route it actually refreshes. Pointing it at the
right route immediately exposed a real defect, and not one this release
introduced: on a partially-refreshed deployment, completing a sale through a
resting listing fails outright while the direct route completes normally, and it
fails the same way against the previous version of the refresh script. It is
filed with its diagnostic trace and the partial-refresh path should be treated
as unsafe for the listing route until it is understood. Correct routing turned
out to be necessary but not sufficient, which is the sort of thing only a real
rehearsal can tell you.
