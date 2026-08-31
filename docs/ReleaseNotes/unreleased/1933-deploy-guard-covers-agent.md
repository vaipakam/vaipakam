## Thread — The deploy guard now covers the agent, and says which Worker it means (PR #1995)

A guard added earlier this year fails the build on any deploy command anywhere
in the repository that would wipe the keeper Worker's dashboard-managed
settings. It only ever knew about the keeper. The agent has the identical
hazard — its code reads two settings that its own configuration does not
declare, so a plain deploy switches recipient-token validation off and resets
how far the OpenSea integration will page — and review had already found nine
places, across runbooks and the deploy scripts themselves, telling operators to
deploy it that way. The guard could not see any of them.

It now covers both Workers, and its report names the one at fault: the right
package to deploy with, and the specific settings that deploy would have erased.
A keeper-worded remedy standing next to an agent problem sends the reader to the
wrong configuration file.

Widening it turned up one live instruction to fix — a deployment-runbook step
that told an operator to redeploy the agent plainly — and six places that merely
quote the unsafe command while explaining or recording it, which are exempted by
name with a stated reason. Two of those sit on a single line of the follow-up
list, which recorded the same completed action twice; exemptions now compose, so
a line carrying two of them is cleared, while a line carrying an exemption and a
real command is still caught.

The two operations Workers that had never been audited were audited, and
**neither belongs in scope**. One declares everything it reads. The other looks
unsafe at a glance — its configuration declares no settings at all while its
code reads five — but three of them are secrets, which a deploy never touches,
and the other two are set by writing them into the committed configuration,
where every deploy re-applies them. Its own documentation says
plainly that it needs no flags, and that documentation is correct; adding it
would have contradicted a true statement on the strength of a wrong reading. The
finding, and the evidence for it, is recorded in the guard itself so the next
person does not repeat the audit.

Scope here is deliberately evidence-led rather than cautious. Every Worker added
makes prose that quotes the unsafe command fail until someone exempts it by
hand, which is a real cost, and one worth paying only where the danger is real.

Refs #1933.
