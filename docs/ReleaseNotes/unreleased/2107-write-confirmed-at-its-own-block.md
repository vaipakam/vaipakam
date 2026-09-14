# A confirmation nobody would answer is not a failed write

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
nobody would answer — which is neither, and is what actually happened in
September. That third outcome no longer borrows the second one's words.
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
the network for a fault in the code. Those two specific failures are now
recognised and reported as what they are. Everything else still retries,
deliberately: the list of ways a network call can fail has no end, so the
short, knowable list is the one worth naming, and anything unfamiliar
behaves exactly as it did before.

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
them one at a time would have added one per review round. They are now
recognised as the family they are, with a check that walks the library's
own list and insists every member is covered — so if one is renamed or
a new one appears outside the pattern, that fails loudly rather than
quietly going back to being waited out.

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
