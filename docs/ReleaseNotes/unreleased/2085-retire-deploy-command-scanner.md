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
and deleting them costs **two** guarantees, of which **one is kept and one is
not**. Both are named here rather than only in the detail below, because this
paragraph is what an approver reads.

*Kept:* a deployment can be pointed at a different checked-in configuration
file, and the canonical one's declaration is then not what gets loaded. Review
caught the first draft claiming the retirement cost nothing at all; that case
is real, it is the one the retired check demonstrably handled, and it is
preserved — see below for the two attempts it took.

*Lost:* a configuration **generated or rewritten at deploy time**. The retired
check refused those, not by reading them — it could not — but by falling back
to judging the command when it could not trust the file it named. A check that
looks only at files has no such fallback. This is the reduction that wants a
deliberate acceptance, and it is set out in full further down.

Keeping it took two attempts, and the second is the more useful lesson. The
first kept it by deciding which configurations mattered — those naming a
Worker with values to lose, carrying a compatibility date, in one of two
directories. The next review round returned six findings against that, each a
different way a deployment reaches such a Worker through a configuration the
rule had excluded: the name can be overridden on the command line, the missing
date supplied there, a named environment selected, an arbitrary path chosen, a
newly added Worker absent from any list. Answering those needs the deployment
tool's own merge semantics — the same open-ended inference this change exists
to retire, moved from shell text into configuration files.

So the classification is gone. **Every deployment configuration in the tree
declares preservation**, whatever it names and wherever it sits, identified by
the tool's own filename convention rather than by anything about its contents.

Two exceptions qualify that, and both come from the deployment tool's own rules
rather than from any judgement the check makes about a file. A **static-site
project** — a different product mode of the same tool, recognised by that
mode's own marker — is exempt, because the tool *refuses* the declaration
there: requiring it would leave no version of such a file that satisfies both
the tool and the check. And a named environment is deliberately NOT required to
declare it separately —
an intermediate draft did require that, reasoning that inheritance could not be
established from here, and review pointed out the setting is top-level-only:
the tool rejects it inside an environment and reads the top-level value after
the environment is selected. Demanding it there would have forced an
unsupported field and a validation warning on every deployment. Not being able
to establish something is a reason to go and find out, not a licence to require
the cautious-looking thing. Two
Workers that hold no operator-managed values today declare it as well: that is
the point rather than an oversight — classifying them was the thing that kept
going wrong, and one that later gains a value is already safe. What it costs
them is the trade the others already accept: a deployment can no longer remove
such a value, so deleting one becomes a deliberate dashboard action.

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
lives, rather than left to be inferred — a deployment that explicitly
overrides the declaration on the command line, a configuration that does not
exist in the tree when the check runs because it is generated, and a
configuration checked in under a name that does not follow the tool's
convention.

Only the first of those is inherited. **The generated-configuration case is
coverage this change removes**, and an earlier draft of these notes said the
opposite — review disproved it by naming three of the retired check's own
fixtures. It did not read a generated file either; it fell back to judging the
command on its own terms and refused it, which is a defence a file scan
structurally cannot offer. That is a real reduction, it is the one thing here
that genuinely needs the owner's acceptance rather than a note, and saying so
is the point of writing these down at all. The third — a configuration named
outside the tool's convention — is the price of not classifying files by their
contents, which is what produced the false reports in the first place: one
accepted miss, named, in place of six edges.

This is the third and fourth instance of one pattern, and it is recorded as
such in the contributor handbook alongside the others: when successive review
rounds keep finding edges of the same rule, the move is to remove the rule,
not to add the next edge. It happened twice inside this one change — once for
the command scanner, and once for the classification written to replace part
of it — which is the clearest evidence available that the pattern is about the
shape of the question being asked, not about any particular implementation of
it.

Closes #2085, #2110, #2112, #2113, #2114, #2115, #2116, #2117, #2118, #2119,
#2121, #2122, #2123, #2124, #2126.
