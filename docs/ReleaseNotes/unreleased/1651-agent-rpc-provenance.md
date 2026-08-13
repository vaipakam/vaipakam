## Agent worker — six notes explaining its configuration by a component that was removed (PR #TBD)

The agent worker carries the widest set of network endpoints of the three
workers. Six places — its module header, two interface comments, the
chain-resolution helper, the deployment config's secret inventory, and its
database binding — all explained that breadth the same way: a monitoring
component that reconciled the removed VPFI purchase flow across every chain it
was deployed on. Its README and package description said the same.

That component was removed along with the purchase flow. The endpoints were
not, and the open question was whether they are now dead configuration — which
on a worker holding credentials matters more than an out-of-date comment.

The honest answer is narrower than either guess. Two Polygon endpoints are
*mapped* by the request-chain resolver, so they are not orphaned — but neither
consumer can reach them today, because both check for a deployment record
first and no Polygon deployment exists. They are provisioned ahead of need.
That is a legitimate operator choice, and it is now written down as such,
rather than being justified by a component that no longer exists or quietly
removed on the assumption that unreachable means unwanted. Whether to keep
them is a question about Polygon deployment plans, and belongs to whoever owns
that decision.

Three related claims were also wrong and are corrected:

The chain-resolution helper said its table covers every chain with a diamond
**or** a purchase adapter. It was never derived from adapters: a chain is
included only when both its endpoint is configured and a deployment record
exists, so the set is deployment-driven and limits itself.

The two consumers behave *differently* when an endpoint is missing, and the
old note flattened them into one rule. For the periodic scan, a missing
endpoint drops the chain entirely. For the aggregator path it does not: the
on-chain validation step is skipped and the request is still submitted. An
operator reading the old wording could believe omitting an endpoint disables
that chain, when it actually removes a safety check.

The database binding listed a family of purchase-reconciliation tables among
what this worker reads. No such tables exist — nothing creates them and
nothing reads them. That one has consequences beyond tidiness: anyone auditing
what this worker can reach was told it reads data that was never there.

Also corrected: only one of the two Polygon endpoints is unique to this
worker. The other is bound by the indexer as well.

No behaviour changes — comments and configuration documentation only.
