### A documentation fault is now caught by a machine instead of by review

Review kept finding the same two mistakes in the operator documentation, in
a different document each time. Neither is the kind of mistake care
prevents: nothing tells the person renaming a directory which prose mentions
the old name, and nothing flags a command that handles a credential unsafely
when the paragraph above it is scrupulous about credentials. Both are now
re-checked automatically whenever the documentation changes.

A companion check for the other fault — a credential written into a command
line, where anyone else on the machine can read it while the command runs —
was built alongside this and **held back**. It found ten times as many
instances as review had, so the problem is real and larger than anyone
thought; but deciding correctly whether a value reaches a command's arguments
turns out to need a proper understanding of shell syntax, and each round of
review found another case the approximation got wrong — including, at one
point, condemning the very pattern the documentation recommends. A check that
is wrong is worse than none, because people learn to ignore it. It is recorded
with its findings and ships when it is right.

The second is a reference to something that no longer exists. The
application directory was renamed some time ago and one hundred and
forty-seven mentions of the old name survived; a page in the app was moved
and three documents still pointed at the old address, one of them the step an
operator follows to confirm a notification-channel migration worked. Those
addresses turn out to still load — an unrecognised first path segment is
treated as a language code and falls back to English — so they are the wrong
address to publish rather than a broken one. An earlier draft of this note
claimed they showed a blank page; that was asserted without being checked,
and review disproved it. The check
confirms that cited locations and app addresses actually resolve, taking the
list of real app addresses from the application itself rather than from a
copy that could drift in its own right.

The check starts out reporting findings, because it describes a backlog that
already exists and is already tracked. Rather than demanding it be
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

Review also found that the recording of known findings could be raised in the
same change that introduced a new one — which would have let the check be
silenced by exactly the move its own documentation forbids. It now compares
that record against the state of the branch it is merging into, and refuses
any addition. One limit of that guard is stated plainly rather than left
implied: it cannot protect the very change that establishes the record, since
there is nothing earlier to compare against. It says so when it runs, and the
initial set is taken on human review.

Two further limits are stated in the check itself, because treating a clean
run as proof is the habit it exists to counter. It establishes only that a
reference resolves, not that it is the right one. And it currently reports
rather than blocks, so a warning will not by itself stop a new instance being
merged — turning it into a gate is a one-line change once the signal has been
watched for a while.
