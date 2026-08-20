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

**Each sale row states its cost before you open anything**, and states all of
it: selling early costs the larger of the interest built up so far or the
buyer's rate top-up — never both — and on top of that, any balance already being
held for you on the loan transfers to the buyer and your pending reward entry
for the position is given up. The card cannot price those, so it names them and
points you at the tool that shows the figures. A cost line that mentioned only
the interest would read as complete while omitting an amount that can be larger
than it.

Those cost lines stay visible **while a listing of yours is standing**, even
though the rows themselves then read as unavailable. A live listing is not an
option you declined — it is a sale in flight that a buyer can complete at any
moment, so the held balance transferring and the reward entry being given up are
pending consequences rather than hypothetical prices. Nothing else on the page
states them, so the card keeps saying them until the listing clears.

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
a cancel it cannot deliver). Two more reasons are operational rather than
positional: while the fee terms that must be disclosed before any sale are
still being read — or could not be read — both sale rows say so, because the
tools themselves do not appear until that read lands; and if the operator has
paused new listings on a deployment while looking into an issue, the listing
row says that too, and says your position is unaffected. Past the due date both sale rows say plainly that
the loan is now resolved by repayment or the default process — no new sale can
be started — so you are not sent looking for a narrower fix that could not help
anyway.

Two limits worth stating plainly. In the simple view the "sell now" row does not
yet tell you whether a matching buyer exists right now; finding that out
requires a sweep of every open offer, and doing it for every lender who merely
opens a page would be a poor trade. Rather than guess, the row makes no claim
and the tool it points to does the real check. Separately, two further reasons a
listing can be refused — a position carrying an unresolved VPFI balance, and a
borrower whose own offset exit is already pending — are **not** yet shown on the
card: neither has a cheap client-side read today, so both still surface when you
try rather than up front. Wiring them is tracked as follow-up work; the card is
built to take them without restructuring.

The card is available in all nine translated languages.
