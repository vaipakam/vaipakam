## Agent worker — six notes explaining its configuration by a component that was removed (PR #TBD)

The agent worker carries the widest set of network endpoints of the three
workers, including two chains no other worker needs. Six places — its module
header, two interface comments, the chain-resolution helper, the deployment
config's secret inventory, and its database binding — all explained that
breadth the same way: a monitoring component that reconciled the removed VPFI
purchase flow across every chain it was deployed on.

That component was removed along with the purchase flow. The endpoints were
not, and the working assumption when this was first written up was that they
might be dead configuration — which on a worker holding credentials would
matter more than an out-of-date comment.

They are not dead. The endpoints have a live consumer: the aggregator commit
pre-check resolves one per request chain, which is exactly what the two
extra chains serve. So the correct outcome was to fix the explanations and
leave the configuration alone — the opposite of what the stale comments
implied, and the reason this was checked before anything was removed.

Two related claims were also wrong and are corrected:

The chain-resolution helper said its table covers every chain with a diamond
**or** a purchase adapter. It was never derived from adapters: a chain is
included only when both its endpoint is configured and a deployment record
exists for it, so the set is deployment-driven and limits itself. Listing a
chain that has neither is inert, which is why one deliberately-unset entry can
sit in the table harmlessly.

The database binding listed a family of purchase-reconciliation tables among
what this worker reads. No such tables exist — nothing creates them and nothing
reads them. That one is worth more than tidiness: anyone auditing what this
worker can reach would have been told it reads data that was never there.

No behaviour changes — comments and configuration documentation only.
