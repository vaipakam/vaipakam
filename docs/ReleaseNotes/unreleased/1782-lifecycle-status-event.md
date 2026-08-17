## Every loan status change now announces itself, from the one place they all go through

A loan's status can only be changed in one place. That has been true for a long
time and is deliberate — the intent is that there is exactly one spot to read
when reasoning about the lifecycle, and a status change that isn't in the
permitted table is rejected outright. What that one place did was update the
platform's own internal tallies. What it did not do was say anything out loud.

Anything watching from outside therefore could not watch the status change
itself. It could only watch whatever announcement the surrounding operation
happened to make. Most operations make a good one. Some make none, and at least
one announces a different loan than the one whose status actually moved — the
temporary holding record used to carry a lender position from one lender to the
next ends its life silently, while the announcement names the original loan.

The consequence is a loan that has genuinely finished still showing as running,
indefinitely, on every surface that reads from an external index rather than
from the platform directly. On-chain everything is correct; the reader is simply
never told. This is the same symptom as a past incident where an index went
blind to loans ending, and it is reachable through the one blind spot in the
automated check built to prevent that incident recurring: that check works from
the list of announcements that exist, and an operation which announces nothing
is not a mis-tagged or unhandled announcement, so it never enters the list at
all.

The fix is to announce from the single place all status changes already go
through. This is not a new mechanism — the choke point exists, is mandatory, and
is enforced. It had one observer wired to it and now has two. What changes is
that a status change nobody can see is no longer possible to write: there is no
longer any individual operation that could forget, because none of them is doing
the announcing.

That distinction is why this was done at the choke point rather than by fixing
the one case that was found. The same class had already been patched by hand
twice, each time after somebody noticed a specific loan looking wrong. Both of
those remain handled explicitly, for the extra work they do that a general
announcement cannot know about; the point is that a third occurrence is now a
non-event. It also removes the need for a second, larger piece of tooling that
had been sketched to hunt for exactly this — with the announcement built in,
there is nothing left for it to hunt.

The cost was the reason this had been deferred rather than done. The platform's
components each face a hard size ceiling, and two of them had thirty bytes of
room, which is less than a single announcement costs. Splitting the larger of
those two, done separately, is what made this affordable. Measured afterwards,
the additions run between thirty and roughly a hundred and sixty bytes per
component — and the components with the least room to spare pay nothing at all,
because they reach the status change through a shared internal caller rather
than doing it themselves. The worst case is a hundred and sixty bytes into
seventeen hundred free.

On the reading side the new announcement is treated as a safety net rather than
a replacement. The existing handlers keep doing the work only they can do, such
as clearing a related listing or looking up a loan under a different name. The
net does one thing: it makes sure no loan is left showing as running when the
platform says otherwise. It deliberately does not promote an already-finished
loan further along, because whether a finished loan is fully wound up depends on
both parties having claimed, and the handlers that know about claims are the
right ones to decide that.

The automated check demanded a handler the moment the new announcement appeared,
which is the whole point: the announcement enrolled itself in the guardrail, so
the gap closes for every future status change and not just for the one that was
found.

Two corrections landed after review, and the first changes when the net acts
rather than what it does. The net's update and one of the existing handlers'
updates both apply only to a loan still showing as running — that condition is
what makes each of them safe to repeat. Because the platform announces the
status change from inside the very operation the specific handler is watching
for, the announcement is seen first, and the net was therefore claiming that
condition before the specific handler could use it. The specific handler's
update then matched nothing, which mattered because that is the update which
also refreshes the loan's outstanding amount and collateral from a reading taken
against the exact moment of the change. The figures stayed stale, and a counter
reported a write that had not happened.

The net now waits until every specific handler has run, and only then fills a
gap none of them filled. That is what a safety net should be, and stating it as
ordering rather than as a special case means it holds for every handler, not
just the one that was found. It also repairs a second, sharper case for free:
where a loan is matched and then fully wound up within the same block, the net
now takes the last of those steps rather than the first, which is what the
platform's own end-of-block reading reports. Taking the first left such a loan
showing as matched forever, since nothing later corrects it — behaviour two
earlier fixes had specifically established, and which this change had been
quietly undoing.

The second correction is smaller and about reach rather than correctness. The
new announcement was being filed without the loan it belongs to attached, so the
per-loan history view could not find it. That is worst exactly where the
announcement is most needed: the temporary bookkeeping loan a lender sale
creates is named by no other announcement, so its history had no record of the
change at all. It is now filed under its loan.
