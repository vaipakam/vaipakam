# Release Notes — 2026-08-19

Seven entries, most of them about transfers of ownership and the bookkeeping that
has to travel with them. Selling or handing over a position now carries its
records along instead of leaving them with the previous holder; the instant sale
route refuses a loan that has a live offset rather than settling into an
inconsistent state; a seller's listing can be held to the quote they actually
reviewed; and selling a VPFI-settled position now refreshes the fee-tier clock
for both parties, where previously neither of them was touched.

The rest continue a thread that has run through this week: making automated
consumers and live drives tell the truth about their own state. A check now
catches an event that names a loan or offer but files that reference blank,
unless the omission is recorded as deliberate — sixty such gaps already existed
and stay open on their own tracking issue rather than being waved through;
automated readers are pointed at where the current rates genuinely live instead
of documents pretending to carry them; and the marketing-site live drive now
runs from the agent environment with its previous blocker's real cause recorded
rather than worked around.

## Lender sale — the instant route now refuses a loan with a live offset (PR #1813)

A borrower who has started a Preclose Option-3 offset has a close-out in
flight that pays whoever holds the lender position when it completes. The
listing route has long refused to put that position up for sale while such an
offset is outstanding, because a sale is a *second settlement* of a loan that
already has one running, and the two would race. The instant route — selling
straight into a standing lender offer — never had that refusal, so the same
loan could be sold out from under a live offset in a single transaction.

Worth being precise about what is and is not restricted, because it is easy to
state too broadly. A lender who simply transfers their position NFT to another
wallet is unaffected: the offset holds only the borrower's position, and
completion pays whoever holds the lender side at that moment. Ownership moving
is safe. What is refused is starting a second settlement while one is pending.

It now refuses, with the same error the listing route uses, so a caller sees
identical revert data whichever route turned them away.

The remedy is specifically to **cancel** the offset, not to wait for it. If the
offset instead completes, it settles the loan outright — the position the lender
wanted to sell no longer exists, and the sale is moot rather than merely
deferred. A lender who wants to exit by selling therefore needs the offset
withdrawn; a lender who is content to be paid out simply lets it complete. Those
are two different outcomes and only the first ends with a sale.

**One consequence is worth stating plainly rather than leaving for someone to
discover.** Only the borrower who created an offset can cancel it: offsets are
deliberately created without a deadline, and the permissionless cleanup path
applies only to offers that have expired. Until now that let a borrower stall
the *listed* lender exit indefinitely by posting an offset nobody accepts;
closing the instant route means both protocol-mediated exits can now be stalled
the same way. That is a deliberate trade — an unguarded instant sale during a
live offset risks two settlements racing over real money, where the stall costs
the lender time and optionality — but it is a real widening of a borrower-side
veto, and giving linked offsets a bounded lifetime or a permissionless teardown
is tracked in #1814.

The instant route is the sharper case, which is why this is worth calling out
rather than filing as a consistency tidy-up. A listing sits in public for a
window during which the borrower, the seller, or a keeper can notice the
conflict and act; the instant route migrates the lender inside one transaction,
so there is no interval in which anyone could intervene.

Worth recording why the gap survived review for as long as it did. The instant
route already carried a check one line away that reads almost identically and
uses the same family of storage — but it asks whether the *offer being consumed*
is itself an offset vehicle, not whether the *loan being sold* has an offset on
it. Opposite subject, near-identical shape. Every other operation of this class
— starting a second offset, listing a prepay, listing the position for sale —
already guarded the loan side; this was the one that did not.

The other half of the tracked item is not addressed here: an active *refinance*
offer should arguably block a sale on the same reasoning, but refinance offers
are not indexed by loan, so there is nothing to consult. That needs an index
before it can be a guard, and is left as follow-up rather than half-built.

Part of #1503 (item 21).

## Selling or handing over a position now carries its bookkeeping with it (PR #1818)

Two things that should have moved when a loan position changed owner did not.

**A bought position was not findable by its own token.** The platform keeps a
lookup from position NFT to loan, so a holder can go from the token in their
wallet to the loan behind it. That lookup was written once, when the loan was
created, and never revisited. Every sale mints the buyer a fresh position token
and retires the seller's — so after any lender sale the buyer's token led
nowhere, while the seller's superseded token still pointed at a loan they no
longer held. Anything reading the loan by token — position lists, the loan
lookup a holder's own client uses — answered for the wrong party or not at all.

The same was true when a borrower handed their obligation to someone else. The
audit item was written about lender sales, because that is where it surfaced,
but the lookup is keyed by position token rather than by side, so the borrower
half had the identical gap. Both are fixed together, in the one place every
position migration passes through, rather than at each route that happens to
move a position — the point being that a future route inherits the correct
behaviour instead of having to remember it.

**A bought position was also absent from the buyer's own loan lists.** Finding
the position by its token is half of discovery; the dashboard and history views
enumerate a per-user loan list instead, and a sale never added the acquired
loan to the buyer's. A listing buyer saw only the temporary sale vehicle there,
and an instant-sale buyer saw nothing at all. The migration now appends the
real loan to the buyer's list, with constant-cost de-duplication so a frequent
buyer's growing history can never make a fill run out of gas, and a first-time
buyer is counted as a protocol user the way an ordinary borrower or lender is.
One policy question this surfaced is decided rather than left implicit: the
paid-notification flag does not travel with a sold position, so a buyer cannot
consume notification service the seller had funded — each holder pays for
their own.

**A seller's lending capacity stayed reserved after they exited.** A lender who
sets a standing intent has a cap on how much principal they can have live at
once. When they exit a loan through the listed sale route, that cap is freed
immediately, because waiting for the buyer to claim would hold the seller's
capacity hostage to an action the buyer may never take. The instant sale route
never did this, so a seller who exited that way kept the exited loan counting
against their own limit — quietly reducing how much they could lend, with no
error and nothing to indicate why.

One exception to that release, on both routes, closed during review: selling
the position to *yourself* through your own standing offer is a trade that
changes nothing real — you remain the lender of a live intent-funded loan —
and freeing the cap for it would have been a way to mint lending headroom out
of a self-trade. A self-purchase now leaves the cap, and the loan's
intent-origin marker, exactly as they were.

A second review round closed an upgrade-day corner of the list-view fix: on a
deployment that already has loans, a holder who acquired a position before
this change shipped was never added to their own list — that is the bug being
fixed — so the bookkeeping must not assume anything about who is already
listed. Positions on loans created from now on carry exact bookkeeping and
stay constant-cost; a sale touching an older loan instead verifies each
party's membership once, records the true answer, and reuses it from then on.
The alternative — assuming a departing holder was always listed — would have
quietly guaranteed the opposite of the fix: a pre-upgrade buyer who later
repurchased the same position would never appear in their own lists at all.

Neither of these is a loss of funds. Both are the same shape as several recent
fixes on the lender-exit paths: a mechanism that exists, is correct, and was
applied to one route and not its sibling.

Part of #1503 (items 17 and 25).

## Automated readers are now told where the current rates live, instead of the documents pretending to carry them

The plain-text copies of the documentation that the site publishes for automated
readers carry the protocol's original settings — the ones it was built with —
and they do not change when governance later retunes a rate. That was made
explicit a while ago, replacing wording that implied the files were current as
of the day they were produced. What it left open was what to do about it.

The open option was to have the publication step read the live settings and
write those into the files instead. That has been decided against, and the
reasoning is worth recording because the option sounds strictly better than it
is. It would not make the files current; it would move the moment they go out
of date from the release to the publication, while making publication depend on
a service that can be unavailable, and making two publications of the same
source produce different files. It would also pull protocol data into the
documentation surface, which is deliberately the one public surface that holds
no chain credentials and no chain dependencies.

What a reader who needs current figures actually needs is somewhere to read
them. That already existed — the same public, keyless data service the site
itself consults — but the index that tells automated readers what this site
offers never mentioned it, listing only the offer and loan feeds. It does now,
pointing at the deployment the documents describe, and saying plainly that the
documents carry starting rates while that address carries current ones. Static
documents beside a named live source is the same division the site already
publishes for its other data.

### The live figures now arrive with names on them

Advertising that address exposed a second problem. It was returning its numbers
as a bare list, in the order the contract happens to return them — fine for our
own pages, which know the order, and useless to anyone else, who cannot tell
which number is the treasury fee. A public address that automated readers are
pointed at cannot serve numbers only its author can interpret.

Each figure now also arrives under its own name, alongside the original list so
nothing that reads the list today is disturbed. The names are taken from the
compiled contract rather than written by hand, for the same reason the project
already forbids hand-written positional lists in the services that read from
chain: a field added or renamed in the contract silently shifts every position
after it. And if the stored snapshot and the contract ever disagree about how
many figures there are, the named view is withheld entirely rather than guessed
at — a number carrying the wrong name is worse than a number carrying none,
because nothing about it looks wrong.

## The marketing-site live drive now runs from the agent environment, and the blocker's real cause is on record

The committed post-deploy drive for the marketing site could not previously be
run from the automated agent environment: the browser there failed every
navigation with a connection error, while ordinary command-line requests to the
same address succeeded, so live reviews waited on an operator machine.

The cause turned out not to be the connection at all. That environment's
outbound traffic passes through an inspecting proxy, and the proxy rejects a
security extension this browser includes in its handshake by default — one the
command-line tools never send, which is why they worked. The visible error
pointed at the connection rather than the handshake, which is what made the
gap expensive to diagnose. A second, quieter requirement — teaching the
browser to trust that proxy's certificates — was uncovered and addressed in
the same investigation.

The drive now honours two optional environment settings so the same committed
script runs in both worlds: an operator machine sets nothing and runs exactly
as before, while the agent environment points the drive at its own browser and
proxy. The setup steps the agent environment needs are documented beside the
drive, including the reason each exists and the instruction that certificate
verification must never be bypassed as a shortcut — the drive watches a
production surface and must not be taught to accept an unverified one.

With that in place the drive was run for real against the production site and
passed every check: the worked example's money figures render from the
published configuration with the contract's exact arithmetic, their provenance
is honest, and the help search finds the page by a figure printed on it. This
closes the outstanding live review that had been waiting on the blocker, and
ends the era of that review being impossible from the environment that
performs the rest of the process.

## Thread — events can no longer be filed without the loan or offer they name (PR #1797)

The activity ledger stores, next to each recorded event, which loan and which offer
it concerns; those two references are what the per-loan and per-offer history views
filter on, and they are filled in by a lookup keyed on the event's name. An event
missing from that lookup is filed with both references blank, and nothing looks
broken — the row is written, the general feed shows it, no check complains. What
silently stops working is the per-loan view, which cannot find the row at all. A
review caught one such event last week: the announcement added specifically so that
a status change could be observed, filed with no loan attached, and therefore
invisible in exactly the place it was introduced to be visible.

A new check now derives the expectation from the compiled contract interfaces
rather than from a maintained list, and fails when an event carrying a loan or
offer reference neither files it nor is listed as deliberately unfiled with a
stated reason. It recognises a reference by the shape of its name, including inside
nested structures, so an event that calls one `oldLoanId` or `fields.refinanceTargetLoanId`
is covered without anyone remembering to extend a list; and it checks each
reference separately, since an event can attach one and drop the other. Whether
each filing actually works is then verified by **running the real code**: for
every covered event, the actual lookup is executed against a synthetic decoded
event planted with known ids, and the check passes only when the planted id
comes back out — so a filing that reads the wrong argument, returns a constant,
or only works on some path fails the same way a missing one does. The recording
step is exercised the same way: a synthetic batch must produce exactly one
stored row per event with its references attached. It also flags entries in the
exemption list that have gone stale, because a list that outlives its subject
re-opens the hole it documented. (An earlier iteration of this change tried to
establish the same guarantees by analysing the source code's syntax instead of
running it; review kept finding code shapes the analysis missed, so it was
replaced with the executed form, which has no shapes to miss.)

Measuring the platform this way found **sixty** event-and-reference pairs already
in the blank state, several of them things a user would plainly expect on a loan's
history: a lender selling their position, a borrower closing early, collateral
added or released, a health-factor liquidation, an obligation handed to a
replacement borrower. Those are recorded as tagged gaps rather than as decisions,
so the whole backlog is listable with one search and each closes with its own
behaviour change and review — writing "this is deliberate" beside sixty real
omissions would satisfy the check forever. Only six entries are genuine decisions.
Four of the sixty pairs, one on each of four events, are left deliberately
unresolved because they raise product questions rather than needing a mechanical
fix: a refinance and both halves of the offset route each involve two loans against
a single column, so which one the row belongs to is a choice; and an offer's
refinance-target loan may or may not belong on that loan's timeline at all. Each of
those four says so in its own entry, so the reason travels with the gap. The
tracking issue **#1794** stays open for the sixty mappings; this change is the
guardrail that stops the list growing silently.

## A seller's listing can now be held to the quote they reviewed (PR #1823)

When a lender lists their position for sale, the platform records two figures
that protect them for the life of the listing: the least they can receive if
it fills (the floor), and the most already-set-aside money that can transfer
with the position (the held ceiling). Those figures are computed when the
listing lands on chain — which is moments *after* the seller decided, looking
at a quote. If the loan moves in between (a borrower partial repayment is
enough), the listing records worse figures than the seller reviewed, and the
protections then faithfully protect the worse numbers.

There is now a second way to submit a listing that closes that seam: the
seller's interface passes along the floor and ceiling it showed them, and the
listing is refused if what it would actually record is worse — a lower floor,
or a higher held ceiling. Better-than-reviewed always passes; only adverse
drift is refused, and the refusal names both figures so the interface can
re-quote and explain what moved. The original submission path is unchanged
and remains available, so nothing already built against it is affected.

This is the platform half of the seller-quote work: the interface half — the
listing form showing the guaranteed floor for the chosen duration, and the
live-listing card explaining an unfillable listing — follows once this is
deployed where the interface can reach it.

Part of #1503 (item 4 follow-through); tracked as #1810.

## Selling a VPFI-settled position now refreshes both parties' fee-tier clock (PR #1819)

The VPFI fee-discount tier is time-weighted: every time VPFI moves through a
user's vault, the platform is supposed to re-record their balance at that
moment, so the average that prices their discount reflects what they actually
held, for as long as they actually held it. The flows the tier system already
wires up — the VPFI vault page's own deposits and withdrawals, fee payments,
claim consolidation — do this. A lender position sale did not, on either
route. (A handful of other vault paths, such as the funds an offer escrows at
creation and returns at cancellation, also lack the refresh today; those are
recorded and tracked separately rather than silently widened into this
change.)

A sale settled in VPFI moves vaulted VPFI on both sides at once: the held-back
VPFI attached to the loan leaves the seller's vault and lands in the buyer's,
and the purchase debits the buyer's vaulted escrow. (The sale price itself is
paid to the seller's wallet, outside the vault.) Until now that settlement
happened without either party's tier clock being touched. The seller's
departed held balance kept earning discount history as if it had never left;
the buyer's new balance went uncounted. Both errors silently corrected
themselves only at each user's next unrelated vault movement, which could be
much later or never — and until then one side was quietly over-priced and the
other under-priced on every fee the tier touches.

Both sale routes now refresh each party's tier record at the vault movements
the sale itself performs. On the instant sale that is every movement: the
buyer's principal debit (and any refund of an oversized offer), and the held
VPFI leaving the seller and landing with the buyer. On the completion of a
listed sale it is the movements completion actually makes — the held
migration and any rate-difference deposit; a completion that moves nothing
(the legacy recovery path) touches no one's record, and the buyer's
purchase-price debit, which happened earlier when they accepted the listing,
remains among the untracked paths recorded in the audit and deferred to
#1820.

Part of #1503 (item 27); tracked as #1817.
