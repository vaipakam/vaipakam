# A confirmation that could not be obtained is not a failed write

When one of the live drives sends a transaction, it reads the state
afterwards to check the transaction did what it was for. The reading is
the part that went wrong.

The chain is reached through a public endpoint that is really several
machines behind one address. The receipt saying the transaction was
included can come from one of them while the reading a moment later is
served by another that has not caught up. What comes back is then the
state as it was BEFORE the transaction — which is exactly what a
transaction that achieved nothing would leave behind. The two are
indistinguishable to a check that just looks once and believes what it
is told.

That is not hypothetical. A batch run against the live site on
10 September ended by announcing that a signed lending offer might still
be fillable by anyone holding the signature, and telling the operator to
go and revoke it by hand. The revocation had already happened. Reading
the chain afterwards showed it exactly where it should be.

This is the worst alarm to get wrong in this direction. Acting on it
costs a second fee for a revocation that already took place. Not acting
on it — which is what people start doing once an alarm has been wrong a
few times — is how a signature that genuinely is still live eventually
gets waved past. It also turned a whole run red for something that was
never a product fault.

## What changed

The check now asks its question of a machine that is demonstrably far
enough along. Each attempt asks the machine how far it has got, ignores
it if it is behind the transaction, and otherwise reads the state as of
exactly the point it reported. A machine too far behind removes itself
before it can give a misleading answer, and one that falls behind
between the two questions produces an error rather than a quiet wrong
answer.

The more important half is that there are now three possible outcomes
where there used to be two. The state is right. The state is wrong. Or
no attempt could get an answer it could use — which is neither, and is
what actually happened in September. That third outcome no longer borrows
the second one's words. (An earlier draft called it "nobody would
answer"; a later round showed that was itself a claim the run cannot
make, since a rejected call is an answer. See the final section.)
Where it comes up, the report says what IS known — the transaction was
included and succeeded, so the thing it was for did happen — and
separately that the confirmation of its effect could not be obtained,
along with how to check by hand. It does not say the order may still be
fillable, because that is not something the run found out.

A wrong answer, by contrast, is decided on a single reading and not
retried. At or after the transaction's own point in the chain there is
nothing left to wait for, and a check that kept asking until it heard
what it wanted would be a way of sitting out real faults rather than a
way of avoiding false ones.

## Where it applies

Three places, all of them cleanup paths that revoke something the run
created: two in the signed-offer drive (the cancellation the run drives
through the screen, and the direct one its cleanup falls back to) and
one in the rate-desk drive, which cancels the offers it posted. All
three previously read the state once, immediately, and treated a stale
answer as a failed revocation.

The rate-desk cleanup gained one more distinction along the way. Its
closing summary used to say every offer it swept was verified cancelled.
An offer whose cancellation was sent and could not be confirmed is not
that — and it is not an offer left live with funds held either, since
the cancellation was included successfully. It is now counted
separately, and the summary declines to claim it in either direction
rather than rounding it to whichever is nearer.

One drive in this family already did the right thing, for the same
reason, after an earlier review round. What was missing was that it was
one drive's private solution rather than something the others could use.
It is now shared, and the three places above are the first users.

## Two more, found in review

Both were invisible — neither would have shown up as an error, only as
the wrong verdict.

The first: the question "how far has this machine got?" was being
answered from a cache. The library keeps that answer for four seconds by
default, and the check was asking again every three, so what looked like
a series of fresh attempts was partly one answer repeated. Worse, an
answer cached while the machine was behind could still be handed back at
the very end, after the chain had caught up — failing the confirmation
because the last question was never actually asked. Every attempt now
insists on a fresh answer.

The second: not every failure to read is a failure to reach. If the
thing being read has itself broken — a function that now rejects the
call, a reply that will not decode — every machine gives the same answer,
and waiting out the deadline to announce that nobody would answer blames
the network for a fault in the code. Those two specific failures were
recognised and reported as what they are. Everything else still retries,
deliberately: the list of ways a network call can fail has no end, so the
short, knowable list is the one worth naming, and anything unfamiliar
behaves exactly as it did before.

*(Neither half of this survived. The part about replies that will not
decode was replaced twice over the next two rounds and finally stopped
being a matter of recognition at all; the part about a call being
rejected was deleted in the round after that, along with the whole idea
of recognising anything. The last two sections are what replaced them,
and this is left standing because four failed attempts are the argument
for the answer that worked.)*

A third suggestion was to prove the reading came from the same chain the
transaction is on, rather than merely from the same height — two machines
can disagree at one height while the chain reorganises. That is true, and
it is not fixed here, for a reason written into the code rather than left
implied: for the two questions actually being asked, every way it can go
wrong goes wrong in the safe direction. A reorganisation that dropped the
transaction leaves the state looking untouched, which reports as a
problem — correctly, because the transaction really is no longer there.
A momentary reading from a competing branch reports the same, which is a
false alarm that sends someone to look rather than one that tells them
not to. And a false all-clear would need a branch on which the answer is
already the one being hoped for — which, for "this offer can no longer be
taken", is a branch where it cannot be taken anyway. Guarding against it
would mean adding a defence against something no run has ever seen, and
this codebase has a costly recent lesson about exactly that. The limit is
written down instead.

## And three more, from the round after

The recognition of "broken in a way every machine agrees on" was named
one case too narrowly. It covered a reply that was empty; review
produced a reply that was present but the wrong size, which fails
identically everywhere and was still being waited out. The library
offers seventeen such errors and gives them no shared parent, so naming
them one at a time would have added one per review round — so they were
recognised as a family, by the pattern the library names them under,
with a check insisting every member of that family was covered.

*(That is not how this ends. The very next round found failures that
decode a reply wrongly and do not carry the pattern's name at all, and
the section below replaces this fix rather than extending it. It is
described here as it happened because the two failed attempts are the
argument for what finally worked.)*

The deadline was a promise the check did not quite keep. It waited a
fixed interval between attempts regardless of how much time was left,
so a run could sleep past its own deadline and then begin a fresh
attempt — and an attempt is not quick, since each network call has its
own timeout and retries. A ninety-second bound could overshoot by tens
of seconds, or return an answer the caller had been told could not
arrive that late. Attempts are now gated on the deadline and the wait is
trimmed to what remains.

The third is the most worth recording, because the previous round caused
it. Making broken-everywhere failures stop being retried meant they were
raised instead — and raising them handed them to the surrounding cleanup
code, whose message says the position may still be live, funds may be
held, and someone should go and cancel it by hand. That is the exact
false alarm this whole change exists to remove, reached by a longer
route. The transaction's own receipt said it succeeded; a checker that
breaks afterwards does not withdraw that. Such a failure is now reported
as what it is — the verification did not complete, and here is precisely
why — with the error named rather than swallowed, and without the claim
about funds that nobody established.

## The round after that, where two of these stopped being lists

Recognising "broken in a way every machine agrees on" had now been
attempted twice — first as a handful of named cases, then as a family
named by a pattern — and review broke it a third time, with failures
that decode a reply wrongly but do not carry the pattern's name at all.
Three attempts at one boundary is the point at which the boundary is
wrong, not the list.

So the list was not extended again. The reading was split in two
instead: fetching the reply, which is worth trying again because a
machine may be unreachable or behind, and making sense of the reply,
which never is — a reply that arrived arrived everywhere. Only the
fetching is retried now. Nothing has to be recognised for that to hold,
because a reply that will not make sense is no longer inside the part
that retries. What remains to be recognised is a single question: did
the machine answer by rejecting the call? That one has been stable
throughout and has produced no surprises.

The split was checked against the live chain before being trusted:
reading the two values the two drives actually read, the old way and
the new way, returns identical results — including for the one that
comes back as a whole record rather than a single number.

The time limit needed the same treatment. Checking the clock before
starting an attempt still allowed the first half of that attempt to run
long and the second half to begin after the limit had passed. Checking
between each step would have meant a new check for every step anyone
adds later. The attempt as a whole is now run against the remaining
time, so the limit covers steps nobody has written yet — and the timer
is cleaned up when the attempt wins, which matters because a live run
would otherwise sit at the end refusing to finish.

## Round four, where the recognising stopped entirely

Recognising which failures are pointless to retry was attempted in four
consecutive rounds, and review broke it in all four — each time by
naming the case the previous attempt had missed, ending with the form
that a plain call actually produces, which the round before had just
added a different class for.

A rule wrong four times running is not one case short. It is the wrong
idea, so it is gone. Every failure to get an answer is now retried, and
nothing tries to judge which ones are futile.

Two things make that safe rather than a step backwards. The part that
genuinely must never be retried — making sense of a reply that did
arrive — is no longer a matter of recognition at all; it sits outside
the retrying, as of the previous round, and that is untouched. And what
the recognising was really protecting was a sentence: the report used to
end by saying no machine would answer. That was the false part. A
rejected call *is* an answer, from every machine. The report now states
the cause it actually saw and declines to say why, noting that a cause
of that shape points at the code rather than at the network. What is
lost is promptness in a situation no run has ever produced.

The other half of the round: losing a race is not the same as stopping.
Marking the abandoned attempt as ignorable only silences it; the attempt
itself carried on, and once its first request came back it started a
second one, after the answer had already been given up on. It now checks
whether it has been abandoned before going further. The limit of that is
stated plainly rather than implied — no new request is made once time is
up, but one already in flight cannot be called back, and runs to its own
timeout.

## Round seven, which corrected round three

The round that moved making-sense-of-a-reply out of the retrying rested
on an argument: a reply that arrived arrived everywhere, so trying again
could not help. Review showed the argument is wrong. The endpoint is
several machines, and one of them can hand back an empty or truncated
reply while the next hands back a good one — which is the very thing
this whole change exists to cope with. Round three was right that these
failures must not be *recognised* by name, and wrong about where to put
them.

They are simply retried now, like every other failure to get a usable
answer. That needs no recognition either, so nothing is given back. What
is left is one rule where there were three: try again until the time is
up, and report what was seen without saying why.

The same round caught the last piece of unearned certainty, and it was
in a sentence written two rounds earlier to *remove* unearned certainty.
When the checking itself broke, the report said the failure happens on
every machine or else the drive is at fault. Neither follows from one
bad reply. It now says only that this confirmation did not finish, and
why it stopped. A companion sentence that declared a rejected call to be
a fault in the code rather than in the network went the same way: the
cause is printed, the reader draws the conclusion, and the report says
plainly that this is what it is doing.
