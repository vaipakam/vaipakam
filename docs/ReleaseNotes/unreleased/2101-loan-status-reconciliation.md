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

On each scheduled tick the index asks the chain how many loans it considers
running and compares that to its own count. If the two differ it examines a
handful of its records; if they agree it still examines one. Where the chain
says a loan has ended and the record says otherwise, the record is
corrected.

How many chains that covers per tick depends on how the service takes in
data. As currently configured every chain is serviced on every tick, so the
check reaches all of them. On the fallback arrangement one chain is taken
per tick in turn, and the wait before a given chain comes round grows with
the number of chains. The distinction is stated because it decides how long
a wrong record can survive, which is the figure an operator would actually
want.

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
costs two of them: one to ask the chain its total, one to read the single
record it examines anyway.

How many it may spend when the totals DO disagree depends on how the
deployment ingests, and that is worth stating rather than leaving to be
inferred. Where the reading of the chain runs in its own slot — which is how
the service is currently configured — the correction may examine up to three
records per turn. That figure came down from five when establishing the real
holder of a corrected position was added: fewer records per turn, and the
message reaching the right person, is the better of the two. Where it shares a slot with the other scheduled work, it
examines one.

That second case — the shared slot — deserves a plain statement rather than
a reassuring one. It is not merely tight: counted properly, the work already
scheduled into it can exceed what the platform allows, before this
correction is added at all. That is a separate fault, raised on its own, not
something this change introduced or repairs; taking the smallest possible
share is what this change can honestly do about it, and it does not pretend
that makes the slot safe. Either way every record is eventually reached; the
difference is how many turns it takes.

The check also runs on a **quiet** chain — one producing no new blocks
between ticks — and that is not a detail. An earlier version ran it only
where new blocks had just been read, which meant it never ran at all on a
chain that had gone quiet. The three records this was written for sit on
exactly such a chain, so the check might never have examined the very
entries that prompted it.

Where it sits in the tick matters too. It now runs **before** the two
surfaces that tell people things: the reminder sweep and the inbox. Both
read the records as they stand and neither withdraws what it has already
said, so running afterwards meant a loan that had ended months ago could
still be sent a "payment due" or "overdue" reminder that nothing would ever
retract. And a correction now announces itself to anyone watching the
position, the same way any other change does — without that, the record was
put right while every open screen kept showing the old one until it happened
to refresh. The announcement names the corrected loan, which sounds like a
detail and is not: the announcement is filtered down to the people it
concerns, and a corrected loan is by definition an OLD one that appears
nowhere else in that tick's work. Left unnamed, the one announcement that
mattered would have been filtered away from exactly the two people it was
for. Naming it is still not quite enough where the position has changed
hands in the meantime — the new holder's own view cannot know about a loan
they have only just been found to own — so a correction also marks its
announcement as incomplete, which makes it reach everyone rather than only
those already known to be involved.

Both holders of a corrected position also get the ending in their inbox.
They had received nothing: the announcement was missed, so the surface that
turns announcements into messages never saw one, and a position could be put
right while the two people with money in it were told nothing at all. What
those messages carefully do not do is pretend to be news of the moment. They
say the platform found this out now, which is true; they do not carry a date
for the ending, because the check genuinely cannot work out when it happened;
and they are marked as coming from a correction rather than from an
announcement nobody saw.

Where the chain records that a loan is finished but not how it finished —
the same state is reached by a repayment, by a default and by a forced sale
— the message says only that it ended. An earlier version said nothing at
all in that case, on the grounds that anything else would be inventing a
claim. That was the wrong half of the trade: knowing your position ended,
from a platform declining to say how, is better than hearing nothing because
it could not say everything.

That message carries a limit worth stating plainly, because the case it
misses is the ordinary one. The platform works out who to tell by asking the
chain who holds the position — and a loan reaches that undifferentiated
finished state precisely BY both sides taking what was theirs, which destroys
the very thing ownership is asked about. So for a loan that finished the
normal way there is nobody the platform can establish, and nobody is told.
The record is still corrected. Falling back to the last name on a stale list
is exactly what asking the chain exists to prevent, so the answer is not to
relax that; it is a record of who HELD a position that no longer exists,
which the platform does not keep yet and which is raised separately.

Who receives them is asked of the chain, not of the platform's own record of
who holds what. The same gap that swallowed the ending could equally have
swallowed a transfer of the position, so that record is untrustworthy for
exactly the same reason — and the one message a holder gets about their loan
ending is the worst possible one to send to somebody who has already sold
out of it. Where a holder cannot be established at all, no message is sent
for that side rather than one sent to a guess, and the holder it does
establish is written back so every other screen stops naming the wrong one.

Which half of that gets acted on took two goes to get right, and the rule
it settled on is worth stating. An earlier version also recorded an
ABSENCE — nobody holds this side, because that party already took what was
theirs — and worked out which case it was by inspecting how the reading had
failed. That test had to be narrowed once, and the narrowing was the
signal: the same failure also covers an ordinary hiccup, so a version meant
to stop offering something already claimed would, on a bad minute, erase a
holder who still owned it. This project has met that shape before and its
answer is to remove such a test rather than keep sharpening it.

Removing it took the whole write with it, which went too far. The unsafe
part was concluding a position had been given up from a question that went
unanswered; an answer that names an actual holder concludes nothing. So the
correction records a side it got an answer for and leaves a side it did not
exactly as it was.

The cost of that is stated rather than implied: a side whose holder could
not be read gets **no message at all, and no later attempt at one.** The
record is still corrected — the loan stops being published as running,
which is the harm this whole check exists to end — but that one person is
not told. Retrying instead is not available, because an unanswered question
and a position legitimately given up are the same answer here: waiting for
one would leave the other's record wrong forever, which is the worse of the
two.

They also arrive as NEW rather than as something already read. The inbox
decides what is unread by position in the chain's order, and a message
carrying no position of its own has to be placed deliberately — placed
wrongly, it lands behind things the holder has already opened and is never
shown at all. The reminder messages had already learned this; the correction
messages repeated the mistake, and the placement rule is now one shared rule
rather than one each writer has to rediscover.

## What it will not do

It only ever moves a record from "running" to an ending, and only when the
chain says so. A machine that is behind reports the loan as still running,
which matches the record, so nothing is written: being out of date can cause
a correction to be missed, never invented.

That one-way direction is necessary and it is NOT on its own sufficient, and
an earlier draft of this note said otherwise. A correction cannot be undone
by the same check — a record it has ended is no longer one the check looks
at — so a reading that is wrong rather than merely old is permanent. What
actually makes it safe is that the chain is always read at a point the chain
itself treats as settled, never at whatever a machine last saw. Without
that, a momentary reorganisation could report an ending that then
disappears, leaving a genuinely open loan recorded as closed with nothing
that would ever come back to it.

It also refuses to touch a record that has already ended, leaving
corrections between one ending and another to the event path, which knows
more. The chain does not distinguish a forced sale from an ordinary
default, so a record repaired this way may read as the latter where the
event would have said the former — less precise, never wrong, and much
better than "still running". That is stated here rather than left to be
discovered.

And it cannot say WHEN the loan ended, so it does not record a time. An
earlier version stored the moment it happened to look and called that an
honest substitute. It is not one: that figure is published, and the list of
positions with something to claim is ordered and capped by it, so a loan
that ended in July would have presented as freshly ended and pushed genuinely
recent ones out of a limited list. The time is now left empty, which is what
is true.

Leaving it empty turned out to be only half the job. The list of positions
with something to claim, finding no ending time, fell back to when the
record was last written — and a correction writes the record at the moment
it makes it, so the July loan arrived at the top of that list anyway. Fixing
the field being written and not the claim being made is how the same defect
survived its own fix. So the ordering now treats an unknown ending as
unknown: positions with no known ending time come after every position that
has one. They are not hidden — where nothing else is competing they are the
whole list — but an ending nobody can date may not push a genuinely recent
one out of a limited one.

The correction also stands down entirely when the chain briefly reports a
settled point BEHIND where the service has already read. That sounds like an
edge and is not: the same point decides which holder the platform believes
owns the position, so acting on the older one could correct a record
perfectly and send its one message to whoever held it at that earlier moment
— the precise mistake the chain-sourced recipients exist to prevent,
arriving by the clock instead of by the record. There is no single point that
is safe for both questions when they disagree, so the turn is skipped and
the next one does the work.

Two answers it treats as neither running nor ended. A record for a loan the
chain has never heard of — one indexed once from something later undone —
reads, through the chain's own interface, exactly like a running loan; those
are now named in the operator's log as unresolvable rather than counted as
running forever. And a state this build does not recognise, which a newer
deployment could introduce, is named rather than passed over in silence: if
such a state turns out to be an ending, quietly skipping it would leave the
record published as open while every check reported perfect health.

And it cannot say why an ending was missed in the first place.

The correction, the tidying and the messages to the two holders are a single
write, which either happens completely or not at all. That is not a refinement: a
correction that landed on its own would take the record out of the set the
rotation looks at, so nothing would ever come back to finish the job, and a
service killed mid-way leaves no failure to report either. Committing them
together is the only version with no window. The messages were the last
thing still written afterwards, and they had the same flaw: a failure there
left the position corrected and the two people with money in it told nothing,
permanently.

The messages are written only where the correction was actually made by
this check. If another part of the service recorded the ending first — which
is the very race the check is built to lose gracefully — it stops, rather
than telling the two holders it discovered something it did not. And a
failure to work out who the holders are is treated as a failure, not as
"nobody to tell": the whole correction is left for the next turn instead of
going through with the part that is silent.

One failure it survives rather than prevents: if the write for one record
fails while others in the same turn succeed, the successful ones stand and
are reported, and the failed one is left exactly as it was for the next turn.
An earlier version threw the whole turn away, which quietly discarded
corrections that had already been made — and because a corrected record
leaves the set being checked, nothing would ever have gone back to account
for them.

## Not included

The other half of the original report — that the published list and the
published count apply different filters, and so answer the same question
differently — is deliberately not fixed here. Applying that filter first
would take the list from nine entries to seven while the chain says six:
the surfaces would still contradict each other, and the remaining ghost
would be harder to notice because the obvious disagreement had gone. The
repair is the part that has to land first.

Refs #2101.
