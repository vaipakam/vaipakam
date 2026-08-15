## Agent worker — configuration explained by a component that was removed (PR #TBD)

The agent worker's configuration was documented in many places — both of
its module headers, two interface comments, the chain-resolution helper, its
deployment config and that config's own header, its database binding, its
README, its package description, the sibling keeper worker's config, and the
active Cloudflare staging plan — by reference to a monitoring component that
reconciled the removed VPFI purchase flow. That component went with the
purchase flow. The explanations stayed.

Three of those were false in ways that mattered beyond tidiness:

The database binding listed a family of purchase-reconciliation tables among
what this worker reads. No such tables exist — nothing creates them and
nothing reads them. Anyone auditing what this worker can reach was told it
reads data that was never there.

Two configs claimed both Polygon endpoints were unique to this worker. One is
also used by the indexer.

The README and package description advertised cross-chain reconciliation as a
current responsibility. It was removed rather than renamed: the worker has no
other cross-chain-monitoring concern, and inventing a replacement to preserve
the bullet would have been the same defect in a new coat.

**What this change deliberately does not do** is replace the old explanations
with new ones. Review repeatedly caught the replacements being wrong in the
same way: any sentence summarising how this worker uses its endpoints — how
many consumers there are, what happens when one is missing, whether a request
still reaches upstream — read as plausible and turned out not to survive
tracing the actual code path.

So the descriptions are now pointers, not summaries: the comments name the
consumers and say to read them, and state only what was verified end to end.
The one substantive finding is recorded plainly — the two Polygon endpoints
are unreachable today, because no Polygon deployment record exists and every
consumer checks for one first. They are provisioned ahead of need, which is a
legitimate operator choice; whether to keep them is a deployment question, not
a cleanup one.

One explanation **is** replaced rather than removed, and it is worth saying why
that is not the same mistake. The active staging plan told the operator to
create the Workers' secrets with a command that creates a different kind of
secret than the one the Workers actually bind. That command completes
successfully and leaves the binding empty, so the failure surfaces at runtime
as a missing secret rather than at provisioning time — the least legible place
to find it. Removing the step was not an option, since the operator still has
to provision the secrets somehow.

So this one was verified end to end instead of deferred: the store identifier
comes from the Worker configs, which all three share; the required flags come
from the tool's own help text, including one that defaults to writing
somewhere the deploy never reads. The plan now separates the two mechanisms
and says which secrets use which, because the two lists are genuinely
different and the overlap is what made the original wrong. The related
follow-up issue was closed as fixed here rather than left open.

A configuration comment that is confidently wrong is worse than one that tells
you where to look.

No behaviour changes.
