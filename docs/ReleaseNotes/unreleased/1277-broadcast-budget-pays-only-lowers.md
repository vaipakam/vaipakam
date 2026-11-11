## Cross-chain tier pushes — the protocol budget pays only for a lowered tier (PR #<n>)

Base sends each user's VPFI discount tier to every other chain, and the
protocol's broadcast budget paid for those messages. It paid a lowered tier
at once and a raised one once per day per chain. Toggling the discount
consent off and on, then refreshing the tier, therefore cost the protocol
about two paid messages per chain per account per day, and cost the caller
only gas. Many accounts could drain the budget that way.

The budget now pays only for a push that takes a discount away: a push to
tier 0, or one that lowers the tier or its discount under the same tier
table without raising either. That push still goes out at once. Every other
push (a first discount on a chain, a raised tier, a later expiry on its own,
or any push under a new tier table) is delivered only when someone pays its
cross-chain fee through the existing delivery call. Until then the chain
keeps what it last received, which grants no more than before. Each paid
drop now needs a raise someone paid for first, so churn can never spend the
budget faster than the person churning spends their own funds. The daily
spacing window, its setter and its getter are removed; the storage slot is
kept and marked retired.

Two things are deliberately not paid by the budget. An earlier expiry on its
own: the expiry moves with every balance change, so paying for each one
would let small unstakes spend many messages per paid raise; the other
chain's copy lapses at the old expiry instead, never later than its maximum
age. And a push under a new tier table: after governance changes the table,
each user's discount on other chains returns only when a paid push carries
the new version.

The tier status view now says, per chain, whether the budget pays the owed
push, instead of when it may. The keeper's tier-push retry delivers only
those lanes and no longer treats an owed raise as its work. The connected
app does not offer the delivery call yet, so for now a raised tier reaches
another chain only through a direct contract call; a "use my discount on
other chains" action in the apps is follow-up #3579.

Closes #1277.

> Caveat: until the apps offer the paid delivery call, a user's first or raised discount does not reach other chains through the app.
> Caveat: a tier-table change leaves every other-chain discount reading as none until a paid push carries the new version.
