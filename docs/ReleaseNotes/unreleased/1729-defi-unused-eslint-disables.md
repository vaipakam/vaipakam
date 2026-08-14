# apps/defi: cleared the unused lint-suppression backlog, and found a live error hiding in it

The lending app carried sixteen lint suppressions that no longer suppressed
anything. Clearing them was meant to be routine tidying — the smallest slice of
the wider effort to get the app's full lint run to zero — but one of them turned
out to be covering a genuine error.

Fourteen were simply inert: they suppressed a console-output rule the app has
never actually switched on, so they could not have been suppressing anything.
The sibling app that has already reached a clean lint run had removed exactly
this class of leftover, so these follow it.

The other two were the interesting ones, and they failed the same way. A
suppression of this kind applies only to the single line immediately after it.
Both had been written above a statement that spans several lines, so each came
to rest on the opening line while the thing it was meant to excuse sat further
down — outside its reach. In both cases the rule had been firing for real, and
the app's lint run had been carrying those errors unnoticed, camouflaged among
the warnings about the suppressions themselves.

The first documented a deliberate, correct exception: a
pricing hook reads chain data for a chain the caller names explicitly, rather
than whichever chain the wallet happens to be on, so it is allowed to bypass a
rule that otherwise steers every read through a shared wrapper. That reasoning
still holds. Here the explanation written above the import had grown to five
lines, so the suppression came to rest on a line of prose and stopped covering
the import entirely. The explanation now sits above the suppression rather than
between it and the import.

The second sits at a marketplace-publishing call, where a value is deliberately
cast loosely at the boundary to an external contract's typed interface because
only the encoded content matters to the hash being recomputed. That reasoning
also still holds, but the suppression had been written above the opening line of
a multi-line call while the cast itself is four lines further in. It now sits
directly above the cast.

Both notes record why the placement matters, so the next person to expand either
explanation doesn't silently push the suppression off its target again. No
behaviour changes: the same code runs, against the same chain, as before.

Worth noting for whoever picks up the rest of this cleanup: because the app has
never enabled the console-output rule, the fourteen deliberate console calls
those directives described are now unremarked. Turning that rule on is a
separate decision, not part of this change.
