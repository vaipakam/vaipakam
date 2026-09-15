## Thread — A correction could close a position on a block the chain never called settled (issue #2201)

Before the platform corrects a loan's recorded state against the chain, it
has to pick a moment to look at. It asks the chain for the point the chain
itself treats as beyond revision. Some providers cannot answer that question,
and some that can will occasionally fail to — a timeout is a failure like any
other — so there is a fallback: step back a fixed distance from the newest
block and treat that as good enough.

That fallback is a guess about finality rather than the chain's statement of
it. For the correction it is the wrong kind of answer, and the platform's own
specification says so in as many words: the state a correction relies on must
be read at a point the chain treats as settled, never at a point derived from
what the source last saw.

The cost of being wrong is not symmetric with the rest of the platform's
reading. The correction looks only at positions still recorded as open, so a
position it records as ended leaves the set it draws from and is never looked
at again. A reorganisation deeper than the guessed margin could therefore show
an ending that later vanishes, and the correction — which exists to stop
positions being published as open after they have ended — would publish an
open position as ended, permanently, with no later pass able to find it.

### What changed

The answer to "which block" now travels with where it came from. One piece of
work resolves it, and it reports whether the chain named the block or the
platform guessed it. A reader of that answer cannot take the number without
also being handed that fact.

The correction refuses a guessed one, and **says so**. A chain whose provider
could not supply a settled point has no correction running at all, and the
operator learns that from the log rather than from a divergence months later.
A check that quietly declines to run reports perfect health while records stay
wrong — the same failure a companion change fixed on the same path this week.

The message quotes the provider's own reason rather than asserting one. The
fallback is taken whenever the settled read does not answer, so a momentary
timeout on a capable provider looks identical to a provider that cannot answer
at all; telling that operator their setup lacks a feature it has would send
them to fix something that works.

The same resolution also backs the recycling backing snapshot, which had its
own copy of it — the same constant, the same fallback, commented as mirroring
the other. A mirror is a copy that has not drifted yet.

### Two things review found that were worse than the defect being fixed

**A reminder could have been sent about a loan that had already ended.** The
check that compares the platform's records against the chain is followed, on
the same turn, by the one that derives due-date and grace-period reminders
from those records. Those reminders fire once and are never taken back. When
the check refused to run, it reported the same "nothing to correct" as a check
that had run and found everything in order — so the reminders were derived
anyway, from exactly the records nobody had verified. A record left wrongly
open is what this whole area exists to catch, and it is precisely the record
that would have been reminded about.

The two turns now share one answer, which distinguishes *checked, and nothing
was wrong* from *could not check*. Reminders wait for a turn that checked.
This closes a case that predates the change: a turn whose cursor had run ahead
of the chain's settled point already skipped the check and swept anyway.
Waiting costs nothing — a reminder's own window is hours to days — and the
same surface already waits, for the same reason, when the grace schedule it
depends on has not been read.

**The operator log would have carried the provider's API key.** The message
explaining why no settled point could be read quoted what the provider said,
and providers put the whole request address — key included — inside that text.
On a provider whose settled read keeps failing, that is the credential printed
on every turn. What is reported now is built from bounded fields that cannot
contain a secret, and still tells apart the two cases an operator has to act
on differently.

### What this does not change, and one thing it does not fix

Nothing about which positions are corrected, or when, on any deployment whose
provider answers the question — which is all of them in the current
configuration. The correction behaves exactly as before there.

**The ordinary scan is exposed to the same guess and is not fixed here.** It
is tempting to say the scan repairs itself — that it can re-read and converge
— and it cannot: its cursor only ever moves forward, so a block removed by a
reorganisation is never read again and what it contained stays missing. The
difference between the two is how bad the wrong record is, not whether it can
be recovered. Deciding what the scan should do when no settled point is
available is a genuine trade against keeping the index moving at all, and it
is left open rather than settled quietly here.

Refs #2201. The published recycling snapshot still does not tell its readers
which kind of block it was pinned to; that is #2210.
