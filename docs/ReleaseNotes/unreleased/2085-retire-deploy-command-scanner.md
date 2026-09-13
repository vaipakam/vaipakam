## Thread — the deploy guard stops guessing what text will run

Cloudflare Workers lose their dashboard-managed environment values on an
ordinary deploy: wrangler treats the checked-in configuration as the source of
truth and deletes anything not in it. For the keeper that is the liquidation
tuning; for the agent, recipient-token validation and marketplace pagination.
Two defences were built for this. The first asks each Worker's configuration to
declare that a deploy preserves those values, which wrangler honours on both
the publish and the staged-version paths — so every way of spelling a deploy
becomes safe at once, including ways nobody has written yet. The second walked
the whole repository looking for a deploy command that did not carry the
preserving flag.

The second is now retired. Asking whether a piece of text will run a command,
and against which configuration, means holding the execution model of every
system that might run it — a workflow file's, a package manifest's, a
Makefile's variable language, a shell's quoting rules, a command interpreter's
name resolution — and the attempt did not converge. It accumulated fourteen
open issues, each a different parsing edge: a folded workflow scalar whose
character offsets do not line up with the file's, a Makefile whose recipe
marker is settable, a PowerShell here-string read as live code, a variable
spelled in a different case, a helper saved with an upper-case extension, a
semicolon after an assignment. Four of those were false reports — they redden a
tree that is correct — and none of the fourteen named a real file in this
repository. The check, its fixtures and its CI job come to about 23,800 lines,
and deleting them removes no guarantee: the declaration is verified
unconditionally on every pull request, over configurations the check discovers
rather than a list it is handed, and every Worker holding operator-managed
values carries it today.

The functional specification had already reached this conclusion and said so —
where a check would need another system's execution model, the answer is a
declaration from the deployment itself rather than a better approximation in
the check. So this closes the divergence in the direction the specification
pointed, by changing the code, and the eleven specification bullets that
constrained how the withdrawn approximation should behave go with it: they were
rules for a check the same specification rejected. What the remaining defence
does *not* cover is now written down where that defence lives, rather than left
to be inferred — a deploy that explicitly overrides the declaration, a
configuration outside the two directories the check walks, and a Worker whose
configuration declares no operator-managed values while values exist for it in
the dashboard. The first of those was never covered by the retired scanner
either; it is an exposure inherited, not created.

This is the third instance of one pattern, and it is recorded as such in the
contributor handbook alongside the other two: when successive review rounds
keep finding edges of the same predicate, the move is to remove the predicate,
not to add the next edge.

Closes #2085, #2110, #2112, #2113, #2114, #2115, #2116, #2117, #2118, #2119,
#2121, #2122, #2123, #2124, #2126.
