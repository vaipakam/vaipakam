# Release Notes — 2026-08-18

Seven entries. Most of the day went to a single question asked in two places:
what has a party actually agreed to, and does the system hold itself to that?

On the lending side, two distinct defects in a lender leaving a position early.
One was arithmetic: the departing lender was charged for interest the borrower
had already paid them, which a paid-through checkpoint now excludes — nothing to
do with agreement, simply a figure that was wrong. The other was consent: a
lender had no way to say what price they would accept, so a listing could be
filled on terms they never saw, and a listing is now bounded by what the seller
actually agreed to.

The rest is the documentation and configuration surfaces making the same kind of
correction: stating which network a figure came from, stating a loan's own fee
rather than today's rate, no longer implying a currency that isn't there, and
no longer letting one failed read pin a whole session to stale values. The last
entry is a deploy record that had been missing thirteen of its components.

## Thread — a lender selling out is no longer billed for interest already paid to them (PR #1801)

Both lender-exit sale routes charged the seller their forfeited accrued interest
straight off the accrual clock. On a loan with periodic interest servicing that
figure is wrong: each servicing run forwards interest to the lender without
resetting the clock, so the raw accrual still spans periods the borrower has
already paid for. A lender selling mid-term was therefore charged a second time
for interest they had already received, and the two sale routes were the only
settlement paths in the protocol that did not account for this — repayment,
preclose, swap-to-repay, default and the fallback route all already did.

The fix narrows the *window* the forfeiture is measured over rather than
subtracting an amount from it. The platform now records, per position, the point
in time through which the lender has actually been paid, and the forfeiture runs
from there. A seller is charged for the stretch nobody has paid them for, and for
nothing else.

That mark is the authority, not the loan's own interest clock. The two are easy
to conflate and answer different questions: the loan's clock restarts whenever
the borrower's obligation is re-based, which is not the same event as the lender
being paid. They diverge in a case that matters — when a payment is due to a
lender whose wallet the sanctions registry flags, the money is held rather than
delivered while the obligation still re-bases — so reading the obligation clock
as evidence of payment would close the seller's window over money that never
reached them. Where no payment has ever been made to a lender, the loan's clock
is the starting point; after that, only actual payment moves the mark. A payment
path the platform failed to account for therefore over-charges the seller
slightly rather than quietly paying them twice, which is the safer way to be
wrong.

Measuring a window rather than netting an amount is the load-bearing choice, and
it took two attempts to see why. The forfeiture figure belongs to the loan's
*current* accrual stretch, and several ordinary events — a partial repayment, a
swap-to-repay — restart that stretch. A running total of interest delivered over
the loan's whole life is therefore not comparable with it: immediately after a
restart the total describes a window the forfeiture no longer covers, and once
the same amount accrues again it gets deducted a second time. A point in time
composes with a restart, because a mark that records actual payment is unaffected
by a restart that paid nobody. It also removes a refusal the amount-based version needed: a
window cannot over-subtract, so there is no leftover credit to strand, and a
lender who is fully paid up simply forfeits nothing and completes the sale
normally. An earlier revision of this change blocked that sale outright.

There is a second, subtler version of the same mistake, and it is closed here
too. Interest recorded as settled to the lender side is not always interest the
lender received: when a periodic payment is due to a wallet the sanctions
registry flags, the money is held rather than delivered, while the record still
counts it — correctly, since the borrower paid it and their obligation must
reduce either way. A sale then hands that held balance to the buyer. So it is
money the exiting lender never received and does not keep, and treating it as
paid would credit them for it a second time at the platform's expense. The mark
only advances where interest genuinely reaches the lender.

For the same reason it advances only when a period is settled in FULL. A partial
settlement leaves the remainder in the borrower's obligation, so treating the
period as paid would let the seller collect that remainder through their sale
price while the buyer can still collect it later through repayment — the same
interest, paid twice. The effect would be largest exactly where collateral is
nearly exhausted and the payment smallest.

A completed sale also moves the mark forward, because a sale settles the
outstanding forfeiture — to the platform, or into the buyer's rate compensation.
The position the buyer receives is clean, and their own window opens at the sale.
Without that, the same stretch would be forfeited again on every resale, at the
seller's expense once per hop.

A plain transfer of the position is deliberately different: it moves nothing.
Nothing is settled by a transfer, so the outstanding forfeiture travels with the
position exactly as the unpaid interest it represents does. Treating a transfer
like a sale would let any lender zero their own forfeiture by sending the
position to a second wallet — or to themselves — and selling from there, which
is a larger hole than the one this change closes.

The mark is honoured only while it still describes the position, and this is the
limit worth understanding. A point in time carries no amount. It can stand in for
"interest already received" only when nothing since has changed what that stretch
is worth or broken it into pieces — and two ordinary things do.

The first is a change of principal. The unpaid stretch is priced at the balance
it accrued on, so a partial repayment inside the stretch leaves part of it having
accrued on a larger balance than the loan now carries; one figure would bill it
at the wrong size. The second is a payment held rather than delivered. After
that, the lender's delivery is no longer one continuous run — an earlier period
is unpaid while a later one is settled — and a single point cannot express which,
so reading it as "paid through the later one" would credit the held period too.
That second disqualification lasts the rest of the lender's tenure, because no
later payment restores the missing one.

Interest can be held back for reasons that have nothing to do with sanctions,
and those count identically. Handing the borrower's obligation to a replacement
borrower settles the outgoing lender's accrued share into the same holding
account, on a loan that carries on running — the lender has not been paid, and
the balance goes to whoever buys the position next. Any later payment would
otherwise close the seller's window over that stretch. The platform therefore
looks at whether anything is being held for this lender that was not being held
when the mark was last recorded, rather than relying on each of the seven places
that can hold money to remember the rule. One of them did; that is the argument
for reading the state rather than trusting the caller, not against it.

A loan also needs a starting point for any of this to mean anything. Each new
loan records the balance it opens at, so the first delivery has something to
compare against; without that, a balance change between origination and the
first settlement would be invisible, and that settlement would install a record
that looks trustworthy while excluding interest charged at the larger balance.
Loans already open when this ships have no such starting point, and no later
event supplies one: the interval between origination and the first delivery is
never reconciled, so a mark installed after it excludes whatever happened in
there just the same. Such a position therefore grants no credit for the rest of
the lender's tenure — it keeps the full charge it already had — and only a sale,
which opens a fresh window for the incoming lender, clears the condition.

Neither disqualification lifts. A later clean settlement cannot repair a record
that is already discontinuous, so once either has happened nothing on that
position is trusted again until a sale opens a fresh window for the incoming
lender. That matters most in a sequence that looks harmless: a principal change
followed by a successful settlement would otherwise re-validate the mark and
silently exclude the stretch that accrued on the larger balance.

Where any of these applies — a principal change, a held payment, or a missing
starting point — the platform discards the credit. The exiting lender may be
charged for interest they genuinely received; the platform never pays the same
interest twice. A sale clears all of them, since the buyer's period opens at the
purchase and carries nothing from the seller's tenure.

Discarding the credit is not the same as forgetting the record, and the
difference is the whole point. The obvious reading — fall back to the loan's own
interest clock — is wrong for a reason that only shows up in combination: the
clock moves. A partial repayment whose interest is held back does both things at
once, holding the money and re-basing the clock to that moment, so falling back
to the clock would open the seller's window at the reset and skip exactly the
stretch the disqualification exists to keep charging for. That is the same
mistake described earlier in this note, arriving by the opposite door: reading
the obligation clock as evidence of payment. So the recorded point is kept and
used as the earliest of the two, which is the honest answer — neither the last
recorded payment nor the obligation restart can be later than the moment this
lender was genuinely paid through.

There is a floor under all of it: the moment this lender's own involvement
began, which is either the loan opening or the sale that handed them the
position. Without it the window can escape the tenure it belongs to, in both
directions. A loan whose very first payment is the one held back has no earlier
payment to fall back to, so only the floor keeps that unpaid stretch inside the
charge. And a buyer who is later disqualified would otherwise fall back to the
loan's original clock, which predates them entirely — charging them for the
seller's whole stretch, which the sale they bought through had already settled.
The platform records when each lender's tenure starts and never opens a window
before it. Positions that predate this change record nothing, so nothing is
assumed about them.

Both conditions are read from the loan's own recorded state rather than reported
by whatever caused them. That distinction is the point: principal is reduced at
eight places across five parts of the protocol, and a rule those places have to
remember to honour has eight places to be forgotten — including in code written
later by someone who has never seen this change. A rule that reads the state
instead cannot be forgotten.

One consequence is worth stating plainly, because it is a step back for some
sellers rather than only a correction. A larger forfeiture is a larger cost, and
the sale routes refuse a sale that would leave the position short of its solvency
floor. A lender on a loan that has taken a partial repayment, or that has ever
held a payment to them, may therefore find a sale priced higher than before —
and, near the floor, refused where it would previously have completed. That is
the platform declining to fund a credit it cannot size correctly, not a fee
increase, and it resolves as the accumulator work lands.

The narrower cases this leaves open — crediting interest delivered beyond a
period boundary, and pricing a stretch that spans a principal change — are
tracked separately. Closing them properly needs the platform to accumulate the
forfeitable amount segment by segment as the loan changes, rather than infer it
from a single point in time, and that is a larger change than this one.

One more thing changed on the app side, and it is a correction rather than an
addition. When the seller's window cannot be read — a transient RPC failure —
the app used to fall back to the loan's own interest clock on the reasoning that
this is the cautious direction. It is not always: the point a lender was paid
through can sit EARLIER than that clock, because closing a loan early re-bases
the clock without clearing the older record. The platform would then charge from
the earlier point while the app quoted from the later one, understating the cost
and letting a seller commit to a sale the platform then refuses. The app now
says the quote is unavailable instead of estimating one. Every other surface is
unaffected — only the figure that cannot be computed declines to be computed,
and a listing that exists on chain keeps its card and its cancel button even
while its funding figure is unknown.

Relatedly, the app can no longer price a sale against a different moment than it
read the loan at. The timestamp is part of the snapshot and the pricing helpers
take no clock argument, so pairing a loan with someone else's clock is not
something a caller can express any more, rather than something each caller has
to remember.

Loans that predate this change carry no mark, which resolves to the accrual
origin — exactly the behaviour they already had. Nothing needs to be
reconstructed or backfilled for them.

One upgrade note for operators. The internal entry point that pays a lender
their periodic interest now also records when it did, so it takes one more
piece of information and its old form is retired. Both upgrade paths — the
curated partial refresh and the all-facets in-place refresh — now retire the
old form explicitly. Without that, the old entry point stays reachable on the
previous code while the refresh reports every part of the platform updated, and
it pays lenders without recording anything — which is precisely the case that
makes the next sale over-charge the seller.

Seller-facing surfaces read the same figure the contract charges, through a new
read-only view that reports both the window's start and what it comes to right
now. The offer picker, the confirmation receipt, the funding watch and the
submit re-check all quote the corrected cost rather than the raw accrual.

Also of note for anyone reading test coverage: the listed route's net-settlement
fan-out was previously unreachable in the unit suite, because the scaffolded
completions never escrow the buyer's principal; a test-only escrow setter now
makes what the seller is charged observable on that route too.

Part of #1503 (item 28).

## Thread — a lender listing their position now says what they will accept (PR #1812)

Listing a lender position for sale recorded no economic bound of any kind. The
seller reviewed a set of figures, posted the listing, and then the platform
recomputed everything at the moment a buyer filled it — so what they actually
received was whatever the arithmetic came to then, not what they agreed to. A
listing can stand for up to thirty days, and several ordinary events inside that
window change the answer.

A listing now carries two bounds, and the seller's own figures are what set
them. Their shapes are deliberately different, which is the part worth
understanding, because it follows from what each cost actually does over time.

The first is a floor on what the seller receives. It cannot be the number on
their screen at the instant they look: the interest they forfeit grows for as
long as the listing stands, so a floor set at the displayed figure would make
their own listing unfillable within minutes of posting it. The enforceable floor
is the worst case they are accepting across the whole window — the same
settlement arithmetic evaluated at both ends of it, taking whichever is worse for
them. "If this fills at any time before it runs out, you receive at least this
much" is both a true sentence to show them and a promise the platform can keep.
It is only computable because a listing must now carry a finite expiry, which is
the second time that rule has turned out to carry weight it was not introduced
for.

Both ends, not just the last one, and the reason is the second thing about this
worth understanding. Two costs make up the figure and they move in opposite
directions: the interest the seller forfeits grows as the listing stands, while
the compensation owed to the buyer for taking a rate above the loan's own is
calculated over the remaining term and therefore shrinks. So the costliest moment
to fill is one end of the window or the other, and which end depends on the
terms. A listing priced well above the loan's rate is most expensive for the
seller to exit immediately.

The second is a ceiling on money already set aside for the lender, which
transfers to the buyer along with the position. That quantity does not grow with
time at all. It grows only when a settlement puts more into it between listing
and sale — which is exactly the drift the bound exists to refuse — so the
recorded figure is simply the balance when they listed, and anything parked
afterwards fails the sale rather than quietly enlarging what they give up.

Neither bound is redundant, and it is worth saying why, because they look like
two views of one thing. Money being set aside trips both: it enlarges the
transferring balance AND it disqualifies the record of what the lender has been
paid, which widens the forfeiture. But a repayment that reduces the loan's
balance disqualifies that record while setting nothing aside — so the floor
catches a case the ceiling cannot see at all.

What trips the floor is therefore never the drift the seller accepted. Ordinary
growth across the whole window sits inside it by construction. What trips it is
a step they never reviewed, and the remedy is to cancel and list again at the
new economics rather than to relax the bound: the larger cost is real, and they
simply have not agreed to it. Both refusals name the figure the seller recorded
and the figure the sale would produce, so the app can say which bound moved and
by how much.

One consequence follows and should be expected rather than treated as a fault: a
live listing can become unfillable through ordinary borrower activity, since a
partial repayment is enough to disqualify the paid-through record.

What this release ships is the rule and the figures behind it: the platform now
records the bounds when a listing is made, refuses a sale that breaks them, and
can answer the question "what is the least I would receive if I listed at this
rate until this date?"

Two things follow from that scope and are worth stating plainly rather than
leaving to be discovered. The app's own copy — showing that floor on the listing
form, and telling a seller whose live listing has become unfillable that
relisting is the way forward — follows separately, because the platform has to be
able to answer the question before an app can ask it. And what is bound here is
the stretch from listing to sale: the figures recorded when the listing was
posted are what the fill is held to. Binding the figures a seller *reviewed*
to the listing they then submit is a second, narrower promise — the two can
differ if the borrower repays in the moments between — and it lands with the
surface that actually shows them a quote, since there is nothing to bind against
until something does.

One consequence of the floor's two-ended shape is worth repeating because sellers
will see it: an above-rate listing is quoted against its instant cost rather than
its expiry cost, so its floor sits lower than a same-rate listing's would. That
is the bound being honest about the worst case, not a penalty.

The bounds apply only while the seller's projection still describes the sale.
Completing a listing is deliberately still possible after its window has run
out, because that path is lender-gated — the seller doing it themselves is fresh
authorisation, not a race — and holding them to a projection made for a window
that has since passed would refuse their own deliberate act. Listings made
before this shipped record no bounds and complete exactly as they did; the
platform can tell that apart from a listing whose ceiling is legitimately zero,
which is why "nothing was set aside" is recorded rather than inferred.

Part of #1503 (item 4). The app surface is #1810.

## The machine-readable documentation stops claiming a currency it does not have

The site publishes machine-readable copies of its documentation for automated
consumers. Those copies have no runtime, so the tunable figures in them are
resolved when the files are produced — and what they resolve to is the value
set shipped with the site, which is pinned to the protocol's compiled starting
rates. A governance retune moves the live configuration, not those starting
rates, so these files do not follow a retune even when the site is rebuilt.
The rendered pages do, when their own read of the published configuration
succeeds — a page whose read fails shows the same shipped values these files
carry, which is its designed fallback.

The specification said these copies were "current as of their build" and
carried "the same resolved values as the human-facing pages". Both claims are
now false in exactly the situation that matters — after the first retune —
and the first is false in a subtle way: rebuilding does not refresh the
figures, so even "as of the build" promised more than the files deliver.

Both passages now say what the files actually carry, that they match the
rendered pages only while the published configuration equals the shipped
values, and that the divergence after a retune is specified and stated rather
than a defect. A code comment repeating the same wrong claim is corrected with
them.

What is deliberately not decided here: whether these files should instead
fetch the published configuration when they are produced. That would make
publication depend on a network read, with everything that implies for a build
the configuration service cannot answer, and it needs a considered yes or no
rather than a side effect of a wording fix. The specification now names that
as an open decision, so the honest description holds either way.

## A documented figure now says which network's configuration it came from

The documentation's tunable figures — the fee rates, the tier thresholds, the
amounts computed from them — follow the published configuration of one
nominated network, because every supported network runs its own independently
tunable copy of the protocol and a wallet-free page cannot ask the reader
which one they mean. The marker on each figure, though, said only that the
value came from "the published protocol configuration", as if there were one.

That reads as universal, and it stops being true the moment two networks are
retuned apart: a reader on any other deployment would see a figure that is not
theirs, under a label asserting it is current. The marker now names the
network — "Live value from the published Base Sepolia configuration" — and the
fallback wording names it too, so a reader always knows which deployment was
consulted, whether the read succeeded or not.

The name is derived from the same setting that selects the deployment, not
written beside it as a second fact. If the nomination is ever pointed at
another network, the label follows automatically; a deployment the site does
not know a name for is labelled by its numeric identifier — ugly and honest,
rather than a prettier guess. Two records of one fact drift, and a provenance
label naming the wrong network would be worse than none.

Nothing about the figures themselves changes, and the machine-readable marker
that distinguishes published from bundled values is untouched — this names the
source more precisely; it does not change what the source is.

## Copy about an existing loan's fee no longer presents the current rate as that loan's rate

The protocol stamps its fee percentages on a loan when the loan is created, so
a later change to the protocol fee never re-prices a loan that is already
open. Four passages across the two user guides — each explaining what a
lender's claim on a settling loan pays out — quoted the treasury cut using the
same live figure the rest of the documentation uses for current rates. After a retune,
a reader holding an older position would have seen the new rate presented as
their loan's cut, while the contract kept using the one stamped when their
loan was created.

All four passages, in all ten languages, now say the percentage was fixed at the
loan's creation and that a later protocol change does not touch it, and
present the live figure only as what loans created at the current rate carry.
The figure stays on the page and stays live — it is useful context — but it
no longer claims to describe the reader's existing position.

The guides' other uses of the same figure were examined and deliberately left
alone: the offer-acceptance passages describe what a lender accepting now
will earn — and a loan created by that acceptance stamps the current rate —
while the fee-overview and risk-disclosure passages describe the protocol's
current terms to a reader deciding whether to participate. The distinction the specification now records is
whether the reader is being told about a position that exists or one they are
about to create.

## A failed or aged-out configuration read no longer pins the whole session

The marketing pages read the published protocol configuration once and then
held whatever that first attempt produced for as long as the tab lived. Both
ways that could go wrong went wrong silently. A transient failure on the
first read pinned the bundled fallback for the entire session, even after the
configuration service recovered — every later page the reader visited kept
the shipped values, honestly labelled but needlessly stale. And a snapshot
accepted just inside the freshness window kept its published label
indefinitely once held, though the same snapshot arriving an hour later would
have been refused as too old.

The read is now retried when the reader gives the page a natural opportunity:
visiting another page, or returning to a tab that was left in the background.
A healthy, fresh snapshot triggers nothing — browsing must not turn into
request traffic — and a page rendering dozens of figures still causes at most
one request. While a re-check is in flight the page keeps stating its
previous conclusion rather than flickering through an in-between state,
because it still has one.

The freshness rule now also applies for as long as a figure is shown, not
only at the moment it arrives. A snapshot that ages past the window while on
display, and that a re-check cannot replace, reverts to the bundled value
with its label following — the same honest fallback a failed first read gets.
Holding a figure the page would refuse to accept, under a label claiming it
is current, was the one remaining way the provenance marker could overclaim.
Reader-driven moments alone could not deliver that rule: a tab left open and
visible sees neither a navigation nor a return, and review caught that it
would have held its published label indefinitely. So when a snapshot is
accepted, the page also notes the moment it will expire and re-checks then.
Because a device's clock can be corrected while the page waits — most
commonly by the machine sleeping and waking — the page does not trust one
long countdown to land on that moment: it confirms the deadline against the
clock at most hourly, and each confirmation either acts, if the moment has
passed, or simply waits on. These confirmations make no requests — browsing
still produces at most the requests it always did, and the read itself still
happens only at expiry. An expired snapshot that cannot be replaced steps
down at the moment its acceptance always implied.

## Thirteen components were missing from the record of what a deploy installed

A deploy writes a file listing every component it installed and the address each
one landed at. Everything downstream reads that file: the apps, the background
workers, upgrade tooling, and anyone verifying the deployment by hand.

Thirteen components were installed by a fresh deploy and never written to it.

Nothing looked wrong. The components were live and working — they were installed
correctly, and only the *record* of them was missing. The pre-deploy gate
reported success, because the one check it had asks whether every address the
deploy *did* record is of a kind the consumers understand. That question cannot
notice an address never recorded at all. So the gate was structurally incapable
of seeing this, and passed every time.

The thirteen are now written. Building the check that found them is what
surfaced them: the follow-up this came from assumed there was one such
component — the one whose omission was caught in review last week. There were
thirteen, and that one was not among them; it had already been fixed.

Two details worth recording, because they explain why this sat unnoticed.

The consumers already expected all thirteen. A second script, the one that
refreshes every component in place, writes the full set — so any chain that had
ever been refreshed had a complete record, and only a freshly deployed chain was
missing entries. That is why nothing downstream ever complained: the gap was
invisible on exactly the chains people look at.

And the addresses were never actually lost. A deployed system can be asked
directly which component serves any given function, so every missing address was
recoverable on-chain, as well as from the deploy's own logs. This was an
inconvenience, not a lost deployment — worth stating plainly, since an earlier
note about the same gap overstated it, and treating a recoverable record as an
unrecoverable incident is its own kind of error.

**The automated guard against this recurring is deliberately not in this
change.** A version of it was written — it read the two deploy scripts as text
and tried to prove that everything installed was also recorded — and then
withdrawn after review found thirteen distinct ways to slip a registration past
it. A registration hidden in a conditional written on one line, in a loop header
whose own punctuation split the statement, in a helper that is never called or
is called only sometimes, under a variable reassigned before the record is
written, or written by a second, more general writer that reaches the same part
of the file by another route. Every one of those was real, and every fix opened
the next.

That is not a run of bad luck. Proving that a particular line runs, under the
identity it appears to have, on every chain, is a question about scope and
control flow — and reading source text line by line cannot answer it. The check
was reaching a confident verdict it had not earned, which on a gate that stands
between a change and a deployment is worse than having no gate at all: nobody
reads a green one.

What settles the question needs no reading of source at all. Run the deploy,
then compare the record it produced against what the deployed system reports it
actually installed. That does not care how a registration is written, where it
lives, or what guards it. It is tracked as its own follow-up, along with the
label-comparison check described above, which has the same weakness for the same
reason.

So this change fixes the thirteen missing entries and states plainly that the
regression guard is still owed, rather than shipping an approximation of one.
