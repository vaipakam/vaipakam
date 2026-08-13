## Developer tooling — one definition for the hook-order guard (PR #TBD)

Five packages — the DeFi app, the marketing site, two earlier app versions,
and the shared component library — each carry a deliberately narrow lint
check that enforces one thing: React's rule that hooks are called in the same
order every time. Each has that narrow check rather than a full lint setup for
its own reason, and each of those reasons is recorded where it applies.

The check itself was copied into all five. The copies were identical apart
from one line, and the duplication had already started to rot: three of them
carried an explanatory comment written about a different package.

That matters more for a guard than for ordinary duplication. Five copies are
five places to update when the check changes, and five places where the check
can be weakened for one package without it being obvious to a reviewer. A
guard whose definition is scattered is a guard that drifts.

The check now lives in one place and is consumed by all five. What stays local
is the part that genuinely differs: why that package has a narrow guard at all,
and what would let it be deleted. Those explanations were kept intact rather
than condensed, and are also collected into a single table for whoever picks up
the underlying cleanup.

Two things about the check look like oversights and are not: it loads two
plugins without switching any of their rules on, and it does not report
unused suppression comments. Both exist so the check reports hook-order
problems and nothing else — the packages' lint had been going unrun precisely
because it drowned real findings in noise. Both are now documented next to the
code rather than rediscovered.

Every one of the five was verified by breaking it on purpose — a conditional
hook was introduced into each package and the check confirmed to catch it,
then removed. A green run alone would not have shown the difference between
"still guarded" and "silently stopped linting this package", which is the one
failure this change could plausibly have introduced.

One deliberate asymmetry: two of the packages keep their own copies of the
lint plugin dependencies, because they also have a fuller lint setup that
imports them and that nothing currently runs. Removing those would have
broken that setup without failing anything today.

No user-visible behaviour changes.
