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
and deleting them costs one real guarantee, which is kept rather than
surrendered. Review caught the first draft claiming it cost none: a deployment
can be pointed at a different configuration file, and the canonical config's
declaration is then not the one loaded — the one case the scanner demonstrably
handled. That is now answered where it belongs, as a property of configuration
files: every configuration naming a Worker with vars to lose must declare
preservation, wherever it sits and whichever command selects it. No text is
read as a command to establish that. Otherwise the declaration is verified
unconditionally on every pull request, over configurations the check discovers
rather than a list it is handed, and every Worker holding operator-managed
values carries it today.

The functional specification had already reached this conclusion and said so —
where a check would need another system's execution model, the answer is a
declaration from the deployment itself rather than a better approximation in
the check. So this closes the divergence in the direction the specification
pointed, by changing the code.

It does **not** withdraw the specification's separate, permissive allowance
that a secondary command-level check *may* exist. A first draft did, rewriting
that into "an implementation should not carry one", and review was right to
call it a reversal of ratified intent rather than a code-to-spec fix. The
allowance stands; the platform simply does not exercise it, which the allowance
permits. The constraints the specification already placed on any such future
check are kept in condensed form rather than deleted along with the
implementation, so a later attempt inherits what was learned instead of
rediscovering it.

What the remaining defence does *not* cover is written down where that defence
lives, rather than left to be inferred — a deploy that explicitly overrides the
declaration on the command line, a configuration that does not exist in the
tree when the check runs, and a Worker whose configuration declares no
operator-managed values while values exist for it in the dashboard. The first
was never covered by the retired scanner either, and the second was beyond it
for the same reason it is beyond a file scan: it read the selected
configuration's checked-in bytes, so a generated one was always invisible.
Both are exposures inherited, not created.

This is the third instance of one pattern, and it is recorded as such in the
contributor handbook alongside the other two: when successive review rounds
keep finding edges of the same predicate, the move is to remove the predicate,
not to add the next edge.

Closes #2085, #2110, #2112, #2113, #2114, #2115, #2116, #2117, #2118, #2119,
#2121, #2122, #2123, #2124, #2126.
