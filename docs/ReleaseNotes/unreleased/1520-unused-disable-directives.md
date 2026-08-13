## Stale lint suppressions in the connected app now fail the build (#1520)

The connected app's lint config has spent several changes promoting
correctness rules from advisory to blocking, each one promoted at the moment
its violation count reached zero. That work is finished.

It left something behind that is easy to miss. Driving those rules to zero
did not mean deleting every place they fired — a number of them were
deliberate, correct code that the rule cannot recognise as such, and each of
those carries a suppression comment with the reasoning written next to it.
That is the intended end state rather than debt. But it does mean the app now
carries a meaningful number of suppressions, and until now nothing checked
whether any of them still had a reason to exist.

The problem is not a suppression that is wrong today. It is one that stops
being needed and stays anyway: the code around it gets rewritten, the rule
would no longer fire, and the comment sits there inert. Nothing is broken and
nothing is reported. It becomes a problem only later, when that same file
regresses — and the leftover comment silently suppresses the new violation, so
the rule that was promoted specifically to catch it never fires. The
suppression has quietly pre-authorised the bug.

The linter can already detect this, and was already detecting it — but only as
a warning, which does not fail anything, so the count was free to drift. It is
now an error, on the same principle every other rule here was promoted under:
the count is at zero, so lock it there. A suppression that outlives its cause
now fails the build rather than accumulating unnoticed.

To be precise about what this does not do: it is not what catches a
suppression attached to the wrong line. That case leaves the real violation
unsuppressed, so the rule itself already fails. This is strictly about
suppressions that have outlived the thing they were written for.

No product behaviour changes — this affects only what the build refuses to
accept.
