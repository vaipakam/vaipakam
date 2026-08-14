# apps/defi: cleared the unused lint-suppression backlog, and found a live error hiding in it

The lending app carried sixteen lint suppressions that no longer suppressed
anything. Clearing them was meant to be routine tidying — the smallest slice of
the wider effort to get the app's full lint run to zero — but one of them turned
out to be covering a genuine error.

Fifteen were simply inert. Fourteen suppressed a console-output rule the app has
never actually switched on, and one suppressed a type-strictness rule at a place
where the code it applied to had since been rewritten. None of them was doing
anything, and the sibling app that has already reached a clean lint run had
removed exactly this class of leftover, so these follow it.

The sixteenth was different. It documented a deliberate, correct exception: a
pricing hook reads chain data for a chain the caller names explicitly, rather
than whichever chain the wallet happens to be on, so it is allowed to bypass a
rule that otherwise steers every read through a shared wrapper. That reasoning
still holds. What had gone wrong is that a suppression of this kind applies only
to the single line immediately after it, and the explanation written above the
import had grown to five lines — so the suppression came to rest on a line of
prose and stopped covering the import entirely. The rule then fired for real,
and the app's lint run had been carrying that error, unnoticed among the
warnings about the suppressions themselves.

The explanation now sits above the suppression rather than between it and the
import, so the exception covers what it is meant to cover, and the note records
why the ordering matters. No behaviour changes: the same code runs, against the
same chain, as before.

Worth noting for whoever picks up the rest of this cleanup: because the app has
never enabled the console-output rule, the fourteen deliberate console calls
those directives described are now unremarked. Turning that rule on is a
separate decision, not part of this change.
