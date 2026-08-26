# The lender's paid discount reaches every repayment route — and none of the recovery ones

A lender who paid the optional up-front tariff on a loan earns a further
reduction of the fee taken from their interest. When that arrangement was
specified, several of the ways a loan can be settled did not yet apply it, and
the specification recorded all of them as outstanding — and as something that
must be resolved before the tariff can be switched on at all.

Most of them have since been implemented, and the specification had not caught
up. Closing early by handing the obligation to someone else, closing by
offsetting against a new position, repaying part of the amount, paying interest
periodically, and the automatic lifecycle path where the position has changed
hands all now apply the reduction, and all of them key it on the party actually
being paid rather than on whoever the loan first recorded as lender.

One entry on the old list turns out never to have belonged there. A rental loan
cannot carry the paid arrangement at all — the tariff is only ever charged when a
loan is originated in an ordinary token, and a rental pays no origination fee to
be tariffed alongside. There is no rental lender who paid and could be owed
anything, so that route is dropped rather than fixed.

What the review turned up instead is a set nobody had listed: the ways a loan
ends **without being repaid**. When a loan defaults, or is liquidated, whatever
interest is recovered still has the ordinary cut taken from it — and none of
those routes consults the lender's arrangement, so a lender who paid for the
reduction does not receive it. The original enumeration named only the repayment
and early-close routes, so the recovery routes were absent from that
IMPLEMENTATION list — not from the entitlement itself, which the frozen rule
already extends to every settlement of a lender's interest.

One of those routes does not even end the loan: a partial liquidation leaves it
running and still takes a cut from the interest it recovers on the way.

Two more routes are not recoveries at all. When an NFT collateral position is
sold through the prepayment route — an ordinary, orderly close — the settlement
pays a fee computed the plain way, on both the loan-keyed and the offer-keyed
flow, and neither consults the arrangement. A lender who paid for the reduction
pays the full fee anyway.

One further route honours the arrangement but pays for it out of the wrong
pocket: refinancing resolves it against whoever the records still name as lender.

One route that earlier drafts of this note counted among the recovery
routes turns out not to belong there at all. When a periodic-interest
payment is missed and collateral is sold to cover it, the charge taken is a
handling fee on the sale proceeds, not a share of the interest — so there is
no yield fee on that route for the arrangement to reduce, and asking for one
would either discount an unrelated service charge or introduce a fee the
route does not levy. The count of affected recovery routes is five, not six.
The mistake is recorded rather than quietly amended: it had reached six
separate documents.

A related precision on the sale routes: the charge they pay is really two
charges added together, and only the first is the one this arrangement
reduces. The second reads as nothing today, so an implementation that passed
the combined figure through would look correct and would silently begin
discounting the wrong charge the day the second is switched on.

Two things follow that the documents had not said. The condition for declaring
this settled now spells out that a decision to leave recovered interest out of
scope would settle only the recovery half — the sale routes close a loan
normally, and the refinance defect is that the wrong party is billed, so neither
is touched by that decision. And nothing automatic is checking any of it: the
one deploy-time check on the master switch confirms only that it ships turned
off, and the switch itself asks only which chain it is on. Confirming the
settlement work is live is a manual step, and a clean automated run is not
evidence for it.
Where the position has been sold and the tidy-up step declined to run — it
declines rather than failing, by design — the previous lender funds a reduction
the buyer receives.

The specification now says that plainly, and says what kind of thing it is. The
frozen rule is that the reduction applies at *every* moment a lender's interest
is settled; the four routes named beside it are the ones that were built, not a
definition of where the promise reaches. Recovered interest is lender interest —
the ordinary cut is taken from it — so the recovery routes are inside the rule
and simply do not honour it yet. That is a gap between the code and a decision
already made, not a question still open, and only the owner can narrow the
decision instead of closing the gap.

Two other documents said the opposite and are corrected with it: an internal
audit recorded this work as complete across *every* settlement path, and the
operator's switch reference told whoever throws the switch that this was "a
check, not a blocker". Either would have led someone to enable the arrangement
while a lender who paid for the reduction could still lose it, depending only on
how their loan happened to end.

Separately, tightening the milestone conditions turned up a slice of work
with no tracker: the ability for a maker to opt into the full arrangement on
a pre-signed offer was never delivered, but the card covering it was closed
when its other half shipped. The source still points readers at that closed
card. It now has an open one, so the milestone cannot close over it.
