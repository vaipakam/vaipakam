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
