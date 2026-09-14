# The index checks its own loan statuses against the chain

The indexer learns that a loan has ended by seeing the event announcing
it. That works until it doesn't see one — because the service was down,
was being rate-limited, or because the gap grew past the window it is
willing to scan backwards over. A missed ending is missed permanently.
Letting the service catch up restores its place in the chain, not the
records it skipped past while it was behind.

Nothing checked afterwards. The result, measured on the test network on
14 September: the chain said six loans were running, one published figure
said seven, and the list of running loans had nine entries. Three of those
entries were loans that had already ended — one of them two months
earlier, in early July, and untouched since.

That is not a cosmetic miscount. Each of those entries is a position the
platform is telling the world is still open, in the offer book and in
anything else reading the published list, for a loan that has already
defaulted or been repaid.

## What now happens

Once per scheduled tick, for one chain in rotation, the index asks the
chain how many loans it considers running and compares that to its own
count. If they differ it examines a handful of its records; if they agree
it still examines one. Where the chain says a loan has ended and the
record says otherwise, the record is corrected.

A correction is the whole record, not just the word "ended". The same
question that returns the loan's state also returns the money still
attached to it, so both are written together. That matters because the
things that move those figures — a part repayment, a forced sale, a
collateral top-up, a debt written off — announce themselves the same way an
ending does, and can be missed the same way. A record stale enough to have
missed an ending has no claim to be current about the amounts, and nothing
is given up by preferring the chain's: an ending never erases what was
owed, so where the chain holds a smaller figure, that smaller figure is
what actually happened. A closed loan also loses everything the
platform was still offering to act on for it: a collateral sale listing, and
a committed swap the borrower could still be shown a cancel button for.
Neither would work against an ended loan, which is no comfort to whoever
tried.

These two came from consecutive review rounds — first the listing, then the
swap — so the fix was not to add the second one beside the first. There is
now a single named clean-up that runs whenever a loan CLOSES, wherever the
closing was learned; the correction calls that rather than keeping its own
list of things to tidy, so anything added to it in future is covered without
the correction changing at all. Ending a listing or a commitment on a loan
that is still running stays deliberately separate: withdrawing a collateral
sale is not withdrawing a swap commitment, and the platform must not dispose
of a position the borrower still holds.

Both halves of the deciding are deliberate. It keeps looking when the totals
agree because two mistakes cancel — one ending missed and one beginning
missed leaves the totals equal while both records are wrong — so a check
that only wakes on a mismatch is one that can be quietly satisfied. And it
examines only a few records per turn because the scheduled work has a hard
ceiling on how many outside requests it may make, most of which the
existing scan has already spoken for. In the ordinary case the whole thing
costs three requests.

## What it will not do

It only ever moves a record from "running" to an ending, and only when the
chain says so. That direction is what makes it safe to run at all against
records about money: a machine that is behind reports the loan as still
running, which matches the record, so nothing is written. Being out of
date can only cause a repair to be missed, never invented — there is no
sequence of events here that closes a loan which is genuinely open,
because "it has ended" is never the out-of-date answer.

It also refuses to touch a record that has already ended, leaving
corrections between one ending and another to the event path, which knows
more. The chain does not distinguish a forced sale from an ordinary
default, so a record repaired this way may read as the latter where the
event would have said the former — less precise, never wrong, and much
better than "still running". That is stated here rather than left to be
discovered.

And it cannot say why an ending was missed in the first place.

One failure is reported rather than retried: if the correction lands but the
tidying afterwards does not, the record has already ended and nothing will
look at it again. The affected loans are named in the service's log so an
operator can clear them by hand, rather than the platform quietly continuing
to advertise something nobody can act on.

## Not included

The other half of the original report — that the published list and the
published count apply different filters, and so answer the same question
differently — is deliberately not fixed here. Applying that filter first
would take the list from nine entries to seven while the chain says six:
the surfaces would still contradict each other, and the remaining ghost
would be harder to notice because the obvious disagreement had gone. The
repair is the part that has to land first.

Refs #2101.
