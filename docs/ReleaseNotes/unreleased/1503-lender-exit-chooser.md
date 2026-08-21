## Lenders can now see what their options are — including doing nothing

If you have lent on a loan, the position page now opens with a card called
"Your options as the lender", listing every way out of the position along with
what each one costs.

Until now, a lender in the simple view saw **nothing at all** about this. The
sale tools existed, but they lived behind the Advanced view, so unless you had
already switched over you would not learn that selling your position early was
possible, what it would cost, or that waiting is itself a choice. The card is
informational only — it never submits anything, and each row points at the tool
that does the actual work.

**Waiting is listed first, on purpose.** For a borrower, the useful thing to
surface is the ways out of a debt. For a lender the situation is reversed: the
position is already the thing that pays you, so the option that costs nothing in
forfeited interest is to leave it alone. The card says so before it says
anything about selling.

With one exception the card now states: **while a listing of yours is standing,
waiting is not the free default.** Doing nothing does not keep the position —
a buyer can complete your listing at any moment, at the costs the sale rows name
two lines below. So the wait row says that, and says cancelling the listing is
what makes waiting free again. It does not read as unavailable, because waiting
is not refused — cancelling is the way back to it. Before this the card managed
to say "a buyer can still complete this and here is what it takes from you" and
"costs nothing — this is the default" about a single live listing, on one
screen.

That row is careful about two things. It never promises you will be repaid — it
says what happens *if* the borrower repays, and what happens if they do not.
And it describes **when** you get paid based on the loan's own schedule rather
than assuming: on a loan that settles interest periodically you are paid during
the term, not only at the end, so the card says that instead. The same applies
on a loan with no periodic schedule that nonetheless allows the borrower to
repay in parts — each part reaches you when it is paid, so the row says money
can arrive before maturity rather than claiming you are paid only at the close.
While it is still reading the schedule it says so rather than guessing, because
guessing would tell you something about your own money that is not yet known.
And if that read *fails* rather than merely being slow, it says so instead of
leaving a "still checking" line up indefinitely, and points you at the loan's
own terms — an answer that is not coming should not be dressed as one that is.

**Each sale row states its cost before you open anything**, and states all of
it: selling early costs the larger of the interest built up so far or the
buyer's rate top-up — never both — and on top of that, any balance already being
held for you on the loan transfers to the buyer and your pending reward entry
for the position is given up. The card cannot price those, so it names them and
points you at the tool that shows the figures. A cost line that mentioned only
the interest would read as complete while omitting an amount that can be larger
than it.

One position type pays a fourth thing, and the card now says so. If your
position is on the Full fee plan — the one you paid for in VPFI when the loan
opened — that plan is recorded against the loan rather than against you, and
nothing about a sale cancels it. So it goes to the buyer along with the
position, and the part of it covering the rest of the term is value you paid
for and do not get back. The card names it on both sale rows and, like the
other two, does not attempt to price it.

Those cost lines stay visible **while a listing of yours is standing**, even
though the rows themselves then read as unavailable. A live listing is not an
option you declined — it is a sale in flight that a buyer can complete at any
moment, so the held balance transferring and the reward entry being given up are
pending consequences rather than hypothetical prices. Nothing else on the page
states them, so the card keeps saying them while the listing stands.

One limit on that, worth stating because it is the direction the card currently
errs in: a listing that **expired without selling** still holds the position
until you cancel it or someone runs the cleanup, and during that window no
buyer can complete — so the losses are no longer pending, but the card carries
on naming them. It is telling you about a cost you can no longer incur, on a
row that already reads as unavailable. Saying too much rather than too little,
and being fixed with the other listing-state work rather than guessed at here.

The listing row goes further and says something sellers routinely do not expect:
while your listing stands it also freezes two of the *borrower's* options on
that loan — the protocol refuses their collateral withdrawal and their offset
exit, both to protect the terms the buyer signs. Their repayments stay open.
And the freeze does not lift on its own when a listing expires: it lasts until a
buyer completes, you cancel, or someone runs the cleanup that clears an expired
listing.

**Rows that are unavailable explain why, rather than disappearing.** A vanished
row reads as "no such option". So the card names the reason instead: the listing
tools are not deployed on this network, the collateral is an NFT and listing
currently supports ERC-20 collateral only, or the position is already listed
(with a pointer to the card that can cancel it — and where this device cannot
recover the listing's record, the row says the listing stands without promising
a cancel it cannot deliver — and where the reason is that we simply could not
confirm you still hold the position, it says *that*, rather than telling you the
listing was made somewhere it may well not have been). A loan settling through
its fallback path also blocks both sales, since a sale can only start on a loan
running normally; the card stays, because waiting still applies. Two more
reasons are operational rather than
positional: while the details a sale needs before it can start are still being
read, both sale rows say so, because the tools themselves do not appear until
those reads land — and if one of them fails outright, the row says that instead,
so the wait does not run forever. It deliberately does **not** say which detail
was missing. Naming it went wrong three times in review, each time blaming a
read that had actually worked, and a lender can do exactly one thing about any
of them — reload — so the name was detail they could not use attached to a claim
that could be wrong. And if the operator has
paused new listings on a deployment while looking into an issue, the listing
row says that too, and says your position is unaffected. And if the loan's due
date cannot be confirmed at all, both rows say **that**, rather than quietly
treating an unanswered check as "not due yet" — a sale cannot be started past
the due date, so a card that guessed there would be guessing about the one fact
that closes both exits. Past the due date both sale rows say plainly that
the loan is now resolved by repayment or the default process — no new sale can
be started — so you are not sent looking for a narrower fix that could not help
anyway.

Two limits worth stating plainly. The "sell now" row does not yet tell you
whether a matching buyer exists right now; finding that out requires a sweep of
every open offer, and doing it for every lender who merely opens a page would be
a poor trade. Rather than guess, the row makes no claim and the tool it points
to does the real check. In the advanced view that sweep has in fact already run
— the sale tool does it — so there the row is holding back an answer that
exists rather than one nobody has; reusing it is follow-up work, and the cost
meanwhile is a scroll to a tool that immediately tells you the market is empty. Separately, two further reasons a
listing can be refused — a position carrying an unresolved VPFI balance, and a
borrower whose own offset exit is already pending — are **not** yet shown on the
card: neither has a cheap client-side read today, so both still surface when you
try rather than up front. Wiring them is tracked as follow-up work; the card is
built to take them without restructuring.

Two things about **when the card appears at all**, both of which err towards
saying nothing rather than saying something wrong. It is shown to whoever holds
the lender position, which is not always the person the page thinks of as "the
lender" — someone holding both sides of a loan gets it too. And if the check of
who holds the position **fails**, the card and the sale tools go away until the
next successful check, rather than staying up for whoever held it last time we
looked. A position can change hands between two page loads; a card that outlives
the check offers exits to a wallet the protocol will refuse.

Finally, the simple view no longer sends you to the advanced one to discover bad
news. If the figure both sale tools need to price an exit cannot be read on this
deployment, the simple view now says so directly — previously it showed both
rows as available, offered the switch to the advanced view, and only then turned
them to "couldn't be read". The switch was an invitation to find a dead end.

The card is available in all nine translated languages.
