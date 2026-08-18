## Thread — a lender listing their position now says what they will accept (PR TBD)

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
