## Thread — the close-out a lender could never reach

When a borrower simply stops paying, the protocol has always had an
answer: once the repayment window and the grace period after it have
both elapsed, the loan can be forced closed and the collateral moved to
where the lender can claim it. Anyone can trigger that, the lender very
much included.

The app never offered it. A lender could watch the due date pass, watch
the grace period pass, and find nothing on the page to press — the one
moment the product owed them an action was the one moment it had none.
That is now a card on the position, and this note is mostly about the
two things that made it more than a button.

**The app must not work out for itself whether the grace period has
expired.** The obvious implementation reads the loan's start date and
term, adds the published grace ladder, and compares against the clock.
That is right until the first deployment configures its own grace
schedule, which the protocol explicitly allows — and then it is
silently wrong in whichever direction the operator tuned, on a page
whose entire job is telling somebody whether they may act yet. So the
card asks the protocol the question directly and renders the answer.
The grace figure is still read, but only to explain the wait; it never
decides it.

**The action is not one button, because the protocol settles these
positions in several different ways and only some of them can be driven
from a browser.** Where the collateral has no reliable market price, or
has fallen far enough in value that selling it is pointless, closing out
hands it over as-is and the app can do that in a single transaction. An
overdue NFT rental can also be ended in one transaction, but it is a
different thing entirely and the card no longer describes it as a
collateral transfer: ending a rental removes the renter's access, leaves
the lender's own asset exactly where it is, and makes the rent that was
paid up front claimable, less fees. Nothing belonging to the borrower
moves.

Where the collateral is ordinary and liquid, the protocol insists it be
sold on an exchange, and insists further that whoever submits the transaction
supply the route for that sale — deliberately, so that nobody can
shortcut an eligible loan into a worse settlement by simply not trying
to sell. The app cannot build such a route yet. It would have been easy
to show one button everywhere and let the second case fail; the lender
would have paid a network fee to be refused, with nothing explaining
why. Instead that case says plainly that the position IS closable, that
the sale has to be routed, that nothing in the product does that
routing automatically today, and that closing such a position needs an
operator — so it is worth asking about rather than waiting on.

Three things the card is careful never to claim. It never states an
amount, because the settlement path is chosen while the transaction
runs and no figure exists beforehand. It never suggests the lender is
the only one who can act, because they are not, and a lender who
returns to find the position already closed by someone else should read
that as normal rather than as loss. And it is careful about how the money
arrives: what is owed becomes claimable afterwards rather than landing
in a wallet, with one exception it now states — where the position is
settled against an opposing one, whoever submits the transaction is paid
a small incentive directly, out of that same settlement. The correction
further down this note describes it in full. It does not promise the loan is finished
either: closing out usually ends it, but where the protocol settles only
part of the position, or the sale of the collateral cannot go through,
the loan stays open and the borrower can still repay or add to their
collateral.

The card also appears before it is usable, which was a deliberate
choice rather than an oversight. It shows while the checks are still
running, and while the borrower still has time, saying which. Hiding it
until the moment it happened to be actionable is precisely how the
capability stayed invisible for as long as it did: nobody asks for a
route they have never been shown.

Writing the automated test for that behaviour caught a mistake in the
card's own wording, which is worth recording because of where it sat.
The heading read "This loan is overdue" in every state — including the
state whose entire message is that the borrower still has time. The
largest text on the card contradicted the sentence directly beneath it,
and it survived building the card, reviewing the card, and translating
the card into nine languages; it only became obvious when a test had to
assert a heading against the state it was checking. The heading now
depends on the state, and says "if this loan is not repaid" while the
answer is still open.

Review then found four more places where the card knew less than the
protocol does, and they are worth recording together because they share
a shape: each was the app modelling one of the contract's conditions and
stopping one clause short.

The card refused to appear at all for a lender whose wallet is
sanctions-flagged. Every other lender tool on that page does hide, and
copying the surrounding pattern is how this happened — but the close-out
is deliberately not one of those. The protocol keeps this route open to
a flagged caller on purpose, withholding only the incentive paid to
whoever fires it, precisely so a close-out cannot be blocked. Hiding the
card removed a flagged lender's only self-service recovery from a
position that had already gone bad.

A loan whose collateral is an NFT — an ordinary shape, not a rental —
waited forever. The card asked whether the collateral was liquid, a
question that only makes sense for a token with a market price, and
never received an answer because none was ever requested. It now
recognises that case directly and offers the one-click route, which is
what the protocol does with it too.

Two conditions the protocol checks were missing entirely: a
governance-wide pause, and, for collateral with no market price, the
risk acknowledgement both parties record when the loan opens. Without
either, the transaction is refused, so the card now says so instead of
offering a button. And because several of the facts behind that button
can change while a lender is reading the confirmation, the app now asks
the chain one last time immediately before sending — which is a better
guarantee than any of the individual checks, since it is the chain's own
answer to the only question that matters.

Three sentences on the card were also more confident than the contract.
It described a state as handled by automated closers, and there are
none — nothing in the codebase submits this particular call, so a lender
told to wait would have waited indefinitely; it now says an operator is
needed and to ask. It named the collateral as what comes back, when the
protocol may instead settle the position against an opposing one and
return what was lent. And it said the loan ends straight away, which is
usually true and not always. Each of those was a sentence about somebody
else's money, on the card whose whole job is explaining how they get
paid.

One smaller correction came with it. The rule that decides which
actions survive a pending change to the Terms did not list this one,
which would have left a lender who had not re-accepted unable to reach
a defaulted borrower's collateral at all — paperwork standing between
somebody and money they are owed by a counterparty who has already
broken the agreement. It is listed now.

A late correction to the close-out card is worth recording because it
contradicted something else written the same day. The card holds itself
back for a moment after a close-out is submitted, so that a page still
showing stale figures cannot invite a second attempt at a loan that has
just ended. The first version of that hold never let go. But closing out
does not always end the loan — the protocol may settle only part of the
position and leave the rest running, which the card's own receipt had
just started saying — so a position that genuinely still needed closing
lost its button permanently. The hold now lasts exactly as long as it
takes for the app to read the position again, after which whatever the
page shows was worked out from what the transaction actually did.

The same hold also had to learn which loan it belonged to. Switching
networks while sitting on a position keeps the page open, so a
close-out submitted on one network could leave the equivalent position
on another looking as though it had already been dealt with.

One further gap, and the least comfortable of them: the protection that
stops a close-out from stranding a half-finished sale of the lender's
own position was reading a value that was never fetched on the lender's
page. It looked correct everywhere it was used and did nothing at all,
on the single screen it existed to protect. It works now.

The last correction went the other way from all the others: the card was
being too cautious rather than too confident. Where a loan's collateral
is ordinary and priced, the card says the sale has to be routed and
offers no button. But before the protocol ever reaches that sale, it
looks for an opposing position it can settle this one against — and when
it finds one, no sale happens and the close-out the app can already
perform succeeds. So a lender was being told to go and find an operator
for a position they could have closed themselves in one transaction.
That case now has its own message and its own button, and it says
plainly that what comes back is the asset lent rather than the
borrower's collateral, because for this route that is what the protocol
returns.

Two more corrections to the card, and both are the same mistake in
different clothes: a sentence that was true of the commonest outcome and
was being shown for all of them.

The first is about the route that settles against an opposing position.
That message warns, correctly, that somebody else may settle against
that position first — and then told the lender the attempt would simply
fail, costing a network fee, with the loan left open to try again. That
is true only when the collateral is ordinary and liquid. Where it is an
NFT, or has no reliable price and both parties recorded their consent,
or has fallen far enough in value, the close-out does not fail at all:
it carries on and hands over the borrower's collateral instead of the
asset that was lent. A lender was being told the worst case was a wasted
fee, on a transaction that could complete and return something entirely
different from what the card had just described. The card now works out
which route the close-out would actually fall to and says that — the
collateral as it stands, the end of a rental, a refusal costing only the
fee, or, where the app could not read enough to tell, plainly that it
cannot tell.

Worth recording how that is decided, because it is the part most likely
to rot. The fallback is not a second copy of the protocol's ordering
written out by hand; it is the same decision this card already makes,
asked again with the opposing position removed. There is one description
of the order things happen in, so the warning cannot drift away from the
behaviour it describes.

The second is the confirmation screen shown before a lender signs. It
described selling collateral and absorbing a shortfall — for every
close-out, including an overdue rental, where none of that happens.
Ending a rental sells nothing, moves nothing belonging to anybody else,
and leaves no shortfall to absorb; what it does is remove the renter's
access and make the prepaid rent claimable. The rental case now has its
own confirmation that says so line by line.

That is the fourth surface to have carried the wrong description of a
rental close-out — the card body, the specification, the change record,
and now the confirmation. The confirmation outlasted the other three
because it does not vary by route: it reads correctly for the majority
case, so each earlier correction went past it. The lesson is that a
screen which does not change is not thereby a screen that is right.

A further review round found five more places where the card spoke for
one route while showing itself on all of them, and one where failing
safe had quietly turned into failing silent. They are worth recording
together because four of the five are the same shape as everything
above: a true sentence, shown where it is not true.

The card said plainly that closing out never moves anything to the
lender's wallet by itself — that what they are owed becomes claimable
afterwards. That is right for every route but one. Where the protocol
settles the position against an opposing one, it pays whoever submitted
the transaction a small incentive, sent directly to that wallet, and
taken out of the same settlement rather than added on top. So a lender
closing out their own position is paid something immediately, and it
comes out of what they would otherwise claim. Both halves of that were
missing, and the card asserted the opposite of the first.

It also said the amount depends on what the collateral is worth. Two
routes have no collateral valuation at all. An overdue rental makes a
fixed, already-paid sum claimable; a settlement against an opposing
position returns the asset that was lent, priced at the moment the
transaction runs. Both are now described as what they are, rather than
sharing a sentence about a valuation neither performs.

The rental confirmation added earlier in this note claimed the lender
gives up the rest of the rental term. There is no rest of the term. A
rental only becomes closable after its term AND the grace period after
it have both expired, and the whole term was paid for up front — so
nothing further could have accrued. That row invented a loss to fill a
space, which on a screen about somebody's money is worse than leaving
the space empty. It now says there is nothing to lose, and says why,
and adds the thing that is actually true: until the close-out runs, the
renter keeps access they are no longer entitled to.

The message shown immediately after submitting said the loan is ending
and pointed at the claims page. Neither is guaranteed. A settlement that
covers only part of the position leaves the rest of the loan running and
nothing claimable yet, which the card had already learned to say
elsewhere and had not learned to say here. It now describes the
transaction as decided while it runs, and sends the lender to the
refreshed position to see which happened.

The last one is different, and is a correction to a fix made earlier in
this same work. The card is deliberately withheld while a sale of the
lender's own position might be half-finished — otherwise a close-out
could strand it. That guard treated an unanswered question as a reason
to remove the card entirely, so a network problem reading that one fact
took away both the action and any explanation of why, for as long as the
problem lasted. Failing safe should mean the button does not work, not
that the page pretends the position has nothing to offer. The card now
stays where it is and says a check is still running — which is what it
does for every other unresolved check, and what it was built to do.

One more of the same kind, found by checking a claim rather than by
being told. In answering the round above I said the card's two remaining
unconditional notes were true on every route. One is not. The note
warning that closing out cancels a borrower's pending swap-to-repay
order describes a facility that covers ordinary-asset loans only — an
overdue rental can never have such an order. The sentence was never
false, since it is conditional and the condition simply never holds; but
it puts a borrower repaying a loan on a screen whose position has a
renter paying rent, which is the same confusion in a quieter voice. It
is no longer shown there.

A smaller repair, on something introduced two rounds earlier rather than
reported by anyone. The warning about another party settling first was
being assembled at display time by gluing three sentences together with
a space. That is correct in most languages and wrong in Japanese and
Chinese, which end a sentence with their own punctuation and put no
space after it — so two of the ten translations carried a stray gap
mid-paragraph. The product already had a rule for this: elsewhere even
the word "and" and a full stop are themselves translated, rather than
written into the layout. The warning now reads as one sentence per
outcome, written that way in each language, so nothing is joined when it
is shown and there is no join character to get wrong.

A later round found four more, and the first is the most consequential
thing in this whole note. The card was asking the wrong question first.
It checked whether the network's sequencer was healthy before it checked
whether the borrower's time was actually up — so a lender looking at a
loan three days into a ninety-day term, during an outage, was told the
close-out was merely paused until the sequencer recovered. That reads as
"this is available, just not right now" about a position the borrower has
most of the term left to save. The protocol asks in the opposite order:
it refuses an early close-out for being early, whatever the network is
doing. The card now asks in the protocol's order.

The order it had was a deliberate choice, aimed at a real problem — the
heading claiming a loan was overdue during an outage. That problem had
already been fixed properly elsewhere, by only letting states that
follow a confirmed answer claim it. Solving it a second time by asking
the questions in the wrong order bought nothing and cost the truthful
answer.

Second, the description of the route that settles against an opposing
position said the loan can be closed out now and left it there. That
position may be smaller than this loan, in which case only part settles
and the rest stays open — which the card had already learned to say
after the fact and not before it. A lender should know that before they
sign, not from a receipt.

Third, the transparency page's freshness line. It draws counters from two
requests and states one age for all of them; the previous fix made it
quote the older of the two. But a response can arrive with no position
marker at all, and the page was then quoting its sibling's — presenting
one set of counters as current through a point the other had reached. A
missing marker is not a weaker claim to be outvoted; it is the absence
of one, and it now disqualifies the combined statement instead.

Fourth, the warning that closing out cancels a borrower's pending
swap-to-repay order was being suppressed using a live measurement of how
tradeable the collateral is. Whether such an order can exist at all was
fixed when the loan opened, not now — so a loan that could still hold one
was having the warning hidden because the collateral had since become
harder to sell. The prediction now rests only on facts that cannot change
for the life of the position.

The last of these is the mirror of a warning added earlier, and it is
slightly embarrassing that it took a separate round to notice. The card
warns, on the route that settles against an opposing position, that
somebody else may settle against it first and what happens then. The same
race runs the other way and was not mentioned at all: the protocol looks
for an opposing position at the moment the transaction executes, not when
the page was loaded, so a loan that read as handing over collateral can
settle as a match instead and repay what was lent. The confirmation
screen had admitted both outcomes for some time; the card body and its
note about collateral value still promised one. Both routes that describe
a collateral outcome now say what can change it — including the one that
offers no button, because its whole message is that an operator must
arrange a sale, and that advice is wrong too if a match has appeared.

A smaller correction alongside it, in the operator notes rather than the
product. The instruction for pointing a self-hosted deployment at its own
public address told the operator to set the value in the example file.
Nothing reads the example file — it is a template. An operator following
it exactly would have got a sitemap and robots file pointing at the
default hosted address while believing they had changed it. The note now
says to copy it to a file that is actually loaded, and lists them.

Finishing that thought properly took a second pass, and the gap it left
is worth recording because it is the same mistake one step down. The
warning about a settlement appearing at the last moment was added to the
two states that describe handing over collateral. There are four states
that name an outcome, not two.

The one that mattered most was the state that says the close-out is
refused for everyone. That sentence is the strongest claim the card
makes — it tells a lender to stop trying and go and ask for help — and it
is not true if a settlement partner turns up, because the protocol looks
for one before it ever reaches the check that refuses these loans. It now
says "as things stand", and carries the same explanation as the others.
An overdue rental was in the same position for the same reason.

The lesson, written down because the round before it had just written
the rule and then broken it: a disclosure that belongs on a route belongs
on every route where the same thing can happen, and "the ones I was
looking at" is not that list.

One structural change came out of all this, and it is the only reason to
expect the pattern to stop. Almost every correction above has the same
shape: a sentence that is true of one situation, shown in a list of
situations somebody wrote out by hand. The rental described as a
collateral transfer, the warning that promised failure, the warning
given in one direction and then on two of the four cases it applies to —
each was a hand-written list, assembled while looking at the two or
three cases in front of whoever wrote it.

The card now decides all of that from a single table with one row per
situation it can be in. A row cannot be left out: the code will not
build until every situation has one, and every column in it is answered
explicitly. Where the old code ended a chain of choices with a default,
a newly added situation would quietly have inherited whatever that
default was — which for the outcome text meant describing itself as a
collateral transfer. That cannot happen now; a new situation stops the
build until somebody decides what it says.

The table earned its keep immediately: adding a column to it produced
build errors on three rows that had been missed, which under the old
shape would have been three more of the findings above.
