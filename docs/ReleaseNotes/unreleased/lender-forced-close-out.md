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
that as normal rather than as loss. And it never implies the money
arrives by itself — what is owed becomes claimable afterwards rather
than landing in a wallet. It does not promise the loan is finished
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
