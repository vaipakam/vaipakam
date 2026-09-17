### Payment reminders again go out nearest-deadline-first after a busy run

The service that reminds people about an upcoming interest payment works
through a list of loans ordered by how soon the payment is due, nearest first,
and stops when it has used its allowance for that run. It then records where it
stopped, so the next run picks up rather than starting over.

What it recorded was a **position in the list** — "I stopped at the sixth". The
list is rebuilt from scratch each run, and a loan reminded on the previous run
is no longer in it. So the sixth place in the new list is not the sixth loan
from before: it is the eleventh. The five loans in between — the nearest
remaining deadlines, the very ones that should have been next — were stepped
over.

Under sustained load this ran the service's own rule backwards: reminders about
payments further away went out while nearer ones waited.

Whether any reminder was actually missed is **not known, and is not claimed
here**. The reasoning that made this look harmless was that the position wraps
to the front when it runs off the end, so a stepped-over loan is reached on a
later pass — but that argument holds only if the list is worked through. If
loans enter the list about as fast as they are handled, its end keeps moving,
the wrap may not come, and a loan stepped over near the front can pass its
deadline and leave the window before anything reaches it. That is the same
sustained load the fault needs to appear in the first place. Establishing
which of those actually happened would take production evidence nobody has
gathered, so this is recorded as an ordering fault of unknown consequence
rather than as one known to be harmless.

It now records **the deadline** it stopped at, and resumes at the first loan due
at or after that moment. A deadline does not move when other loans are reminded,
settled, or pass out of the window, so the resumption is exact rather than
approximate — and the note in the code claiming an exact resumption was
impossible here has been corrected, because it was wrong about why.

Two consequences worth stating. Where the recorded place cannot be read at all —
a database problem, or a deployment that arrives before the schema change it
needs — the run starts at the nearest deadline instead. For any one run that
repeats work already done rather than stepping over anything, which is the only
acceptable direction for that failure. It is not harmless if it persists: a
service that always restarts at the same place never works its way down the
list, so loans further along stop being reached. That is why the run says so
every time rather than falling back quietly. And the old recorded positions are deleted rather than left
behind: a stale number in a table that other things still read is how a later
reader comes to trust a position that means nothing.
