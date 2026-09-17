### A held record stops suppressing a different loan that reuses its number — where the platform can tell it is different

When the platform cannot confirm what happened to a loan, it remembers that
and holds that loan's reminders back rather than sending ones it cannot stand
behind. The memory is released when the loan is settled, or when it is found
to have ended.

One case released neither: a loan the network denies exists, which may have no
stored record either. That is deliberate — nothing proves such a position
ended, and keeping it held and visible in the report a person reads is the most
useful thing this memory does. But the documented way for an operator to
resolve one of those is to delete the fabricated record, and once they do, the
held entry matches nothing and stays forever.

Left alone, that has a harmless consequence and a harmful one. The harmless
one is clutter: an entry sitting in a report, burying the ones that need
attention. The harmful one is that loan numbers can come round again — a
network redeployment, a partial reset — and a stale entry would then withhold
reminders from a **different, legitimate** loan, without saying so.

The second is closed for replacements the platform can recognise as newer,
which is the ordinary case and not all of them; the exception is stated below
rather than left in the small print. A held entry is released as soon as a loan bearing
the same number appears that began later in the network's own sequence than
the point the platform had reached when it recorded the entry. That can only
be a different loan: a loan cannot begin after it was held. A loan replayed
from history keeps its original place in the sequence and so is still
recognised as the same position, and stays held.

The comparison deliberately uses that sequence rather than a time. When the
platform cannot read a timestamp from the network while recording a loan, it
substitutes its own clock — so a replayed original loan can carry a time later
than the finding about it, and a decision made on times would have released a
hold because a read had failed. A position's place in the sequence comes from
the record itself and is never substituted.

The point it is compared against is the last time the platform confirmed the
entry was still unresolved, not the first time it noticed. An entry nobody
re-examines — the case this fixes — keeps its last point, and the rule fires.
An entry still being found unresolved keeps moving its point forward, so a
replacement that is itself unresolved cannot release the hold about itself.

Two cases are **not** fixed, and they are worth being plain about because the
first version of this note implied otherwise.

Where a test network's block height restarts, a replacement loan can sit below
the recorded point, so the rule does not fire and the entry is kept.
Distinguishing a restarted sequence from an ordinary one needs an identity for
the deployment that the platform does not record today.

And an entry carrying no recorded point at all — one written before this
change, or during the window where the service is running but the schema
change has not been applied — is deliberately never released by this rule,
because treating its absence as the start of the sequence would release every
held entry at once.

In both cases a kept entry withholds reminders from whatever loan now bears
that number. That is not clutter; it is the same silent suppression this change
set out to remove, in the situations the comparison cannot see. What the change
does is remove it from the ordinary case and state where it remains, rather
than leave the whole of it unexamined.

The clutter is deliberately left. Removing it would mean either releasing
entries merely because their record is absent — which drops exactly the cases
this memory exists to surface — or ageing them out on a timer, which trades a
real signal for tidiness. An entry a person has resolved can be cleared by that
person; an entry nobody has resolved should still be in front of them.
