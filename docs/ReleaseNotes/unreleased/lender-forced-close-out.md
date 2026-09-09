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

Two sentences were left standing by an earlier correction rather than
broken by it, which is worth separating from the rest. Admitting that a
settlement against an opposing position may cover only part of a loan
made two neighbouring statements false, and neither was in the sentence
being corrected.

The first told the lender that if somebody else closes the position out
first, it will simply show as closed. Where only part settles, it shows
as smaller instead and carries on. The second said what is owed becomes
claimable once the close-out settles. For a partial settlement it does
not: the protocol holds that portion and it becomes claimable when the
remainder is closed later, which may be considerably later. A lender
told to go and collect would have found nothing there and no explanation
for it.

Both are the same lesson as the rest of this note, one step removed: a
correction changes what is true around it, not only where it lands.

Rather than wait to be told the same thing a third time, the rest of the
card's wording was read against that one fact — that a settlement may
cover only part of a loan, and that the part it covers is held rather
than paid out until the remainder closes. Two more sentences failed.

The general note about collecting, shown on every route except the one
just corrected, still said what was owed became claimable once the
close-out settled. It has the same exception as its sibling and now says
so. And the description of the settle-against-an-opposing-position route
ended by telling the lender to claim whatever settled — the one case
where the settled portion is specifically not claimable yet. That
sentence is gone rather than qualified: the note directly beneath it
already explains the timing, and saying it twice at two different levels
of precision is how they came to disagree in the first place.

The most serious thing found in this whole review came late, and it was
about the transaction rather than the words around it. The card marked a
close-out as submitted only once the network had confirmed it. That
sounds right and is not: confirming can time out, or lose its connection,
on a transaction that has already been accepted and will mine perfectly
well. When that happened the card concluded nothing had been sent, gave
the button back, and a lender pressing it again could have a second
close-out queued behind the first — which either wastes a network fee
arriving at a loan that has just closed, or, where the first settled only
part, runs for real against what is left. The card now records the
attempt the moment the transaction has an identifier, which is the point
at which it stops being safe to assume nothing happened.

That fix was half a fix, and reviewing it found the other half. Recording
the attempt disables the button on the position — but after a failed
confirmation the page is not showing that button, it is showing the open
confirmation panel, and the confirm inside it was not covered. The retry
the whole change was meant to prevent was still one click away, by a
different route. Both are closed now, and the close-out additionally
refuses to start a second time while a first is unaccounted for,
regardless of what the screen is showing.

It took a third pass to get the underlying idea right. The card was
deciding whether a close-out was still outstanding by looking at how
recently it had re-read the loan — which is a fact about the app, not
about the transaction. That reading fails in both directions. One of the
readings behind the card is deliberately slow to refresh, so on a failed
confirmation nothing would refresh it and the action stayed disabled for
a transaction that may simply have been dropped; and if anything did
refresh those readings while the transaction was still in flight, the
action came back with the transaction unresolved, which is the thing
being prevented. The card now follows the transaction itself, and stops
following it after a few minutes if the network never accepted it —
because a lender whose transaction vanished should be able to try again,
and one whose transaction landed no longer has a position for this card
to offer anything about.

Two smaller items alongside it. A live check on the deployed site treated
the Terms notice appearing over a claims, vault, recovery or desk page as
an inconclusive result and told whoever ran it to accept the Terms and try
again. Those four pages are deliberately exempt from that notice, because
they are how somebody gets their money out and paperwork must not stand
in the way. So the notice appearing there is a fault, and the check was
both failing to report it and recommending the exact step that makes it
disappear from the next run. It now fails, and says not to do that.

Following the transaction brought its own correction, and then a
correction to the correction. Waiting for one fresh reading of the loan
before offering the button again is right when the transaction succeeded
— the position has changed, and a button offered against the figures from
before the close-out would be offering something that no longer exists.
It is wrong when the transaction was rejected, or when the wallet
replaced it with a cancellation: nothing happened on the chain, a retry
is reasonable, and neither of those endings triggers the refresh that
would end the wait, so the button could have stayed away for good.

But "we have been waiting a while" is not one of those endings, and
treating it as one was a mistake worth naming. A transaction that has not
confirmed yet has not failed — it can still go through — so re-offering
the button after a few minutes invited a second close-out to queue up
behind a first that was still live, which is exactly the outcome the wait
exists to prevent and the more expensive one. The app now keeps waiting,
and says so: it tells the lender plainly that it has not been able to
account for the transaction, that this does not mean it failed, why the
button is staying off, and to look in their wallet, which is where the
answer actually is. An honest "we don't know yet" is better product than
a button that implies it is safe to try again.

It also follows the transaction properly now. A wallet that speeds up or
cancels a pending send produces a different transaction for the same
slot, and the app was watching only the original — so a sped-up close-out
that went through perfectly looked identical to one that vanished, and a
confirmed cancellation looked the same again. All three now resolve to
what actually happened.

A separate correction to the live checks: when the address of the site to
review was not supplied, every one of them stopped with an unhandled
error, which the batch runner reads as "this check found a defect in the
product". Nothing had been reviewed at all. They now report that the
review could not be started, which is a different verdict with a
different remedy — supply the address and run it again, rather than go
hunting for a bug that was never found.


Two more from the same review pass. The confirmation for the matched
close-out told every lender that the matcher incentive would arrive in
their wallet immediately. That is not true for a wallet the sanctions
oracle has flagged — the protocol runs the close-out for them but does
not pay them that incentive — and such a lender can reach this button by
design, because close-out paths stay open to flagged wallets so the other
side can still be made whole. The card now checks, and says which of the
three cases applies: paid, not paid, or not yet known. The not-paid
wording is careful about where the money goes instead, because "you do
not get it" would overstate the loss: the part that would have come out
of this position simply stays in what the lender claims later, and only
the part from the opposing position goes elsewhere.

And the heading on a loan blocked by a sequencer outage said "if this
loan is not repaid", conditionally, about a loan the chain has already
confirmed is past its repayment window and its grace period. That
hedging was correct once, when the app checked sequencer health before
the repayment window; it stopped being correct when the order was
changed to match the contract, and the sentence explaining it outlived
the ordering it described.

A later pass tightened three more things about that wait, and one of them
matters more than it sounds. Waiting for the position to refresh before
offering the button again was measured from when the transaction was
sent, and that is the wrong moment: anything can refresh the page's
readings in between — another card, switching back to the window, an
ordinary poll — and those readings still describe the loan as it was
before the close-out. On a slow transaction the wait was therefore
already satisfied when the close-out landed, and the button came back
immediately over figures from before it. It is now measured from when
the app learned the transaction's outcome, which is the earliest moment
anything could have changed.

The second: if a completely unrelated transaction takes the same slot in
the queue, ours can never run — and the app was reading that other
transaction's outcome as though it were ours, so an unrelated success
was reported as a successful close-out. It now uses the same shared piece
of the app that every other transaction goes through, which already knew
the difference between our transaction sped up (still ours, read its
result), cancelled (ours never ran), and displaced by something else
(ours never ran either).

The third: switching networks while a close-out was in flight threw away
the only record of it. Switching back left the app no longer watching a
transaction that could still land, with the button offered again over the
top of it. Submissions are now remembered per network and per position,
so switching away and back finds what was left running.

Separately, a lender whose deployment has internal matching switched off
is told a match might still appear, which on that deployment it cannot.
The app has no way to read that setting today — the protocol does not
publish it — so this is recorded as its own piece of work rather than
guessed at.

Remembering the in-flight close-out turned out to need more than
remembering it per network. The record lived only as long as the page
did, so reloading, or moving away from the position and back, lost it
just as completely — and reloading is the more likely of the two. It is
now kept on the device the same way the app already remembers a sale
listing or a recovery it has just broadcast, and cleared once the
transaction's outcome is known.

Two smaller corrections in the same area. The app stops and restarts its
watch on the transaction; it used to wait three minutes before starting
the next one, and a wallet that sped up or cancelled inside that gap
could leave the app permanently unable to work out what happened —
holding the button off while telling the lender it was still watching. It
restarts immediately now. And if the app lost the connection while the
transaction was still going, it never refreshed the position afterwards
even once it worked out the close-out had succeeded; on a part-settled
loan that left the remaining part locked with the answer already known.
Working out the outcome now refreshes the position by itself.

Keeping the record across a reload closed one hole and opened a smaller
one, which is worth describing because the fix is a choice about honesty
rather than about mechanism. The old wording told a lender whose
transaction could not be accounted for to check their wallet and reload
the page — and that used to work, by accident, because reloading threw
the record away. Now that the record survives, reloading changes nothing,
and somebody whose transaction had genuinely vanished would have found
the app refusing to let them close that position, permanently, over
something it has no way of checking.

The app cannot see anyone's wallet, so it now asks the person who can. It
says plainly that it keeps watching across a reload, and offers the
lender a way to state that their wallet no longer shows the transaction —
which stops the wait and returns the action. It is worded as their
statement rather than as a reset button, and it says what it costs if
they are wrong, because pretending the button performs a check would be
the same false confidence in a new place.

One more way of not knowing about a close-out, found by looking for it
rather than by hitting it: the same position open in two browser tabs.
The tab that sends remembers it; the other tab had nothing to notice, so
it would have gone on offering the button over a transaction already on
its way. Tabs now tell each other, in both directions — one that learns
of a close-out stops offering the action, and one that learns the record
has been cleared stops waiting.

Telling tabs about each other closed most of that gap and not all of it.
A confirmation already open in a second tab passes its check, then waits
on a pending question and a final check with the protocol before the
wallet opens — seconds during which the first tab can send. The app now
re-reads its own record in the last moment before handing anything to the
wallet, and stops there if a close-out has already gone out from this
browser, saying so rather than implying the position is closed. Two tabs
pressing in the same instant remains possible; the browser offers nothing
that would settle that, and the app does not claim otherwise.

The watch on a submitted close-out no longer stops at all. It had a
three-minute limit, and recognising a transaction that was sped up or
cancelled depends on the original still being in flight — so the limit
was quietly the difference between telling a lender their close-out was
cancelled and never being able to say. The limit now governs only what
the card says: after a few minutes it stops describing an ordinary pause
and states that it cannot account for the transaction, while the same
watch carries on. The app's note of a submitted close-out is also kept
until the position on screen has caught up with it, rather than being
dropped the moment a receipt arrives — in that window a reload used to
find nothing and offer the button again.

Where the browser refuses to store that note at all — private mode, or
storage switched off — the card now says so and names the consequence:
this page still holds the action back, a reload will not. And erasing
your data from the "Your data" page now says the thing it could not
previously: a transaction already sent to the blockchain keeps going, so
what the erasure removes is the app's note of it, after which the app
stops following it and may offer the same action again.

One claim has been withdrawn. An overdue NFT rental carried a warning
that someone might settle it against an opposing position first. The
protocol has no path that does that for a rental — its search for a
counterparty requires the rented item to carry a market price, and its
settlement moves fungible assets only — so the card was describing an
outcome that cannot happen, on the one card whose job is being exact
about what the lender receives.

On the two public pages: a counter that arrives but cannot be a count —
negative, fractional, or not a number at all — is no longer printed as
though it were one. It is withheld like an absent figure, but labelled
differently, because "the source sent something impossible" and "the
source sent nothing" are different facts and a reader checking the source
is owed the difference. The protocol console also refreshes while it is
open; it used to keep whatever it loaded with, so a fee or a switch
changed by governance could sit there superseded, with the page's own age
line saying nothing was wrong.

One more way the app could have trapped a lender, found in review rather
than in the wild. When a close-out is sent and then never resolves, the
only way back to the action is the lender telling the app their wallet no
longer shows the transaction — and the app offered that only after a few
minutes had passed, measured against the device's own clock. A clock
corrected backwards after sending, or a record written while the clock
was wrong, made that wait never finish: the position would have stayed
unclosable from the app for as long as the error lasted, with no route
out. The wait is now measured so that no clock change can stall it.

The same lesson applied a second time, in the other direction. After a
close-out succeeds, the card keeps the action back until the position on
screen has caught up — and it decided "caught up" by comparing
timestamps. A device clock corrected backwards in that window makes a
reading that has just been refreshed look older than the event it
followed, so the card would have gone on withholding the action on a
position that was still part-open, until the lender happened to reload.
It now waits for the refresh it asked for to finish, which is the thing
it actually wanted to know and which no clock can misreport.

Two tabs again, and the correction is to something this note claimed
earlier. When one tab finishes with a close-out it forgets its local
note of it, and the other tab was taking that as permission to forget
too — which put the action back in front of a lender whose own page had
not yet caught up. The earlier reasoning was that a last-moment check
with the protocol would catch anything wrong here. It would not: after a
close-out settles only part of a position the rest stays genuinely open,
so that check passes, and what is stale is not the action but the
description of what it will pay out. A tab now waits for its own figures
to refresh before it stops holding, regardless of what another tab has
decided about its own transaction.

On the analytics page: a loan whose lending asset was never recorded is
now left out of the by-type subtotals whichever placeholder the record
carries. One older placeholder was slipping through and being published
as an ERC-20 loan, which is worse than the gap it hid — the subtotals
then added up, so the page's own "we could not classify these" line read
zero and the disagreement it exists to expose was invisible.

The card now says which way a close-out failed. When the blockchain
rejects the call, or the wallet cancels it, or another transaction from
the same wallet takes its place, the position is untouched and the
action becomes available again — and until now that is all a lender saw:
an unchanged screen with the button back. Three short sentences say which
of the three happened, because all three leave the loan alone but only
one of them is likely to repeat.

Behind that, the way the card decides its figures have caught up after a
successful close-out has been rebuilt. It used to wait on a refresh
request and treat that request finishing as proof; a second refresh of
the same data cancels the first, and a cancelled request finishes in a
way indistinguishable from a successful one. The card now watches for
the readings themselves to change, which nothing else can fake, and it
tracks each close-out separately so a late answer about an earlier one
cannot lock the action on a position that is live now.
