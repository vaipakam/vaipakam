## Thread — a census of grandfathered custody, and what it refuses to conclude (#1566)

Part of #1566 exists only to move four kinds of legacy custody out of a shared
balance. Whether that work is large, small, or unnecessary is an empirical
question — it depends entirely on whether any such holdings exist on the chains
already deployed — so this adds a read-only census that answers it, and commits
its output as an artifact rather than a claim. "The set was empty" is something
a later reader must be able to re-run, not take on trust.

The result: on three of the five deployed chains every class is empty. On the
other two a single class could not be established at all, and the interesting
part of this change is that the census says so instead of reporting zero.

Most of the design here is about the ways a census can produce a comfortable
answer it has not earned. An all-zero result is indistinguishable by inspection
from a scan that read nothing, so each read path was first made to produce a
non-empty answer, and each proof of absence was checked for what it actually
proves. Three of those checks changed the outcome rather than merely
documenting it.

The first: the census reads live state where it can, and where the relevant
view is not present on a chain it falls back to proving the *producer* was
never reachable, using the chain's own record of every routing change it has
ever made. An earlier version treated "the view is missing" as proof by itself,
which is wrong — a component can be added, write state, and later be removed,
leaving records nothing can read. The second: that history scan came back
reporting *no routing changes at all* on two chains, which cannot be true of a
contract that exists, since every one records at least one when it is deployed.
That is now a hard refusal, and it is what turned one chain's result from
"empty" into "undetermined": its recorded deployment block yields no records at
that address, and the public endpoint used discards the history needed to find
the real one. The third: the scan is now pinned to a finalized block and
records that block's identity, not merely its height, and re-checks it
afterwards — a height alone does not identify what was read, and this artifact
is used to certify work away.

One follow-up remains: re-running the two affected chains against an endpoint
that retains full history, which is expected to settle the last class either
way. Those two are precisely the chains where the relevant view is absent, so
they are the only ones that depend on history at all — and the public endpoints
proved unreliable there in a specific way worth recording: the same endpoint
answered the identical history query two different ways within an hour, once
with real data and once with nothing. A result that cannot be reproduced is not
a result, which is why neither chain is reported as settled.

Two claims were also corrected in the surrounding design. An empty population
retires the *migration* — there is nothing to move, and the shortfall question
that would have gone to the owner does not arise — but it does not retire the
protective changes that keep future holdings out of the shared balance in the
first place. Those producers are still live and can create a qualifying record
the moment after the census reads zero, so that work ships regardless.

Refs #1566, #1349, #1956
