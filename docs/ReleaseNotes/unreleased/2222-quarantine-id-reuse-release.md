### A held record now says what its loan number points at, instead of silently withholding

When the platform cannot confirm what happened to a loan, it remembers that and
holds that loan's reminders back rather than sending ones it cannot stand
behind. The memory is released when the loan is settled, or found to have
ended.

One case releases neither: a loan the network denies exists, which may have no
stored record either. That is deliberate — nothing proves such a position
ended, and keeping it held and visible in the report a person reads is the most
useful thing this memory does. But the documented way for an operator to
resolve one is to delete the fabricated record, and once they do, the held
entry matches nothing and stays.

That is worse than untidy, and the reason is the part worth stating. A held
entry withholds reminders from **whatever loan currently bears that number** —
so if the number ever comes round again, after a network redeployment or a
reset, a real loan goes without reminders and nothing says so.

The obvious remedy is for the platform to notice that the loan bearing the
number now is a different one and release the entry by itself. That was built,
and then removed, because every way of establishing "this is a different loan"
from what the platform has stored turned out to be unsound:

- the recorded start time can be the platform's own clock, substituted when the
  network could not be read at the moment the loan was recorded;
- a recorded place in the network's sequence goes stale as soon as an entry is
  rewritten by a path that cannot rewrite it too;
- that sequence restarts on a test-network reset, so a newer loan can appear
  older;
- and the sequence value itself can be left behind by a reorganisation the
  platform is documented as never revisiting.

Each of those was found by review after the previous one was fixed. Acting on
any of them would have released a hold — and resumed reminders — on the
strength of a read that failed, which is precisely what the memory exists to
prevent.

So the platform does not guess. The report a person reads now names, for every
long-held entry, what its number points at today: no stored loan at all, or a
stored loan in a given state that began at a given point. That description is
explicitly labelled as **stored and unverified** — the same record that proved
unsound to act on is not then presented as settled fact — and every held
number is listed even when there are more than the report describes in full,
because an entry left out entirely would be withholding reminders with nothing
anywhere naming it.

Someone reading it can see whether the entry is still about the loan it was
made for, and clear it if not. That is a deliberate act, spelled out in the
report, and it names the exact entry that was read: a check that ran between
the reading and the clearing can have recorded a fresh finding under the same
number, and an unguarded removal would discard it.

Where more entries are held than the report describes in full, it also says
what it is not doing: those numbers are named but not described, the
descriptions are of the longest-held entries and do not take turns, and
resolving one of those is what brings the next into view. It would be easy to
write "described next time" there, and it would be untrue — nothing would ever
supply that detail.

One release does still happen on its own — when a stored loan bearing the
number is no longer running — and that carries the same identity assumption in
smaller form: where a number has been reused, it establishes that the
replacement ended rather than that the original position did. It is recorded as
a known limit rather than presented as settled, **and it is the release itself
that says so**, naming the entries it removed. Leaving that to the held-entry
report would have disclosed nothing in the one case that matters: a release can
clear the last held entry, and the report says nothing when nothing is held.

There is a second way a held entry clears by itself, and it is the sound one:
a run examines the number, the network answers, and the entry goes. That is
deliberately left alone — the network's own answer about a number is the only
solid evidence in any of this, and every basis the platform declines to act on
is a stored value standing in for exactly that answer. Blocking it would leave
a live, settled loan without reminders indefinitely on the strength of a
finding about a loan that no longer exists. But where the entry had been held
long enough to be appearing in the report a person reads, its release is now
announced, together with what that release cannot establish: if the number had
come round, the answer concerns the loan bearing it now, and the earlier
unresolved finding has gone with it. An entry cleared before it was ever
reported stays unannounced — that is the everyday case of a reading that failed
once and succeeded next time, and a line for each would bury the ones that
need a person.

Reporting costs the same fixed amount of work however many entries are held,
and this took two goes to get right. The first fix made the number of database
enquiries constant and left the amount READ and PRINTED growing with the
number of entries — so the report would still have failed on exactly the
network that most needed it, inside the run that must also record how far the
chain has been read. It now names at most a set number of entries, says
**exactly** how many more are held, and hands over the enquiry that lists them.
A listing that simply stopped would be the silent truncation this whole change
exists to avoid.

A suppression a person can see and undo is worth more than an automatic release
built on evidence that has been wrong four different ways.
