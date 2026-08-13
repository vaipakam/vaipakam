## Agent worker — configuration explained by a component that was removed (PR #TBD)

The agent worker's configuration was documented in nine places — its module
header, two interface comments, the chain-resolution helper, its deployment
config, its database binding, its README, its package description, and the
sibling keeper worker's config — by reference to a monitoring component that
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
with new ones. Two review rounds produced eight findings, every one of them in
prose written to describe how this worker uses its endpoints — how many
consumers there are, what happens when one is missing, whether a request still
reaches upstream. Each answer was close but wrong, and the wrongness was
invisible without tracing the code.

So the descriptions are now pointers, not summaries: the comments name the
consumers and say to read them, and state only what was verified end to end.
The one substantive finding is recorded plainly — the two Polygon endpoints
are unreachable today, because no Polygon deployment record exists and every
consumer checks for one first. They are provisioned ahead of need, which is a
legitimate operator choice; whether to keep them is a deployment question, not
a cleanup one.

A configuration comment that is confidently wrong is worse than one that tells
you where to look.

No behaviour changes.
