### Two documentation faults are now caught by a machine instead of by review

Review kept finding the same two mistakes in the operator documentation, in
a different document each time. Neither is the kind of mistake care
prevents: nothing tells the person renaming a directory which prose mentions
the old name, and nothing flags a command that handles a credential unsafely
when the paragraph above it is scrupulous about credentials. Both are now
re-checked automatically whenever the documentation changes.

The first is a credential written into a command line. A value passed as a
command argument is readable, for as long as that command runs, by anyone
else with an account on the same machine — and if it was typed rather than
prompted for, it stays in the shell's history afterwards. That is
particularly bad in the one place it kept appearing: incident procedures,
where the credential being handled is usually a replacement issued moments
earlier to lock an intruder out. Three separate review rounds found three
separate instances. Running the new check against the whole documentation
set immediately found ten, in six documents — so the problem was more than
three times larger than review had established.

The second is a reference to something that no longer exists. The
application directory was renamed some time ago and one hundred and
forty-seven mentions of the old name survived; a page in the app was moved
and three documents still pointed at the old address, one of them the step
an operator follows to confirm a notification-channel migration worked. That
step would have shown a blank page and told them nothing. The check
confirms that cited locations and app addresses actually resolve, taking the
list of real app addresses from the application itself rather than from a
copy that could drift in its own right.

Both checks start out reporting findings, because both describe a backlog
that already exists and is already tracked. Rather than demanding it be
cleared first — which would have made them red on arrival, and a check
that is red on arrival gets ignored — they compare against a recorded
count per document and report only when a document gets **worse**. The
existing backlog is frozen where it is and cannot grow, while clearing any
of it is a visible improvement someone can make deliberately.

Freezing rather than clearing is also the correct answer for a second
reason: part of that backlog must not be cleared at all. Historical
records — shipped release notes, past findings, closed to-do entries —
describe what was true when they were written, and rewriting them to match
today would falsify the record.

Two limits are stated plainly in the checks themselves, because treating a
clean run as proof is the exact habit they exist to counter. Neither check
is exhaustive: the first cannot recognise a credential passed under an
unrecognisable name, and the second establishes only that a reference
resolves, not that it is the right one. And both currently report rather
than block, which means a warning will not by itself stop a new instance
being merged — turning them into a gate is a one-line change once the
signal has been observed for a while.
