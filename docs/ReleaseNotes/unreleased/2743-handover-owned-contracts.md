## Thread — The handover moves every owned contract, and Diamond ownership needs the owner (PR #TBD)

Two gaps in the governance handover are closed. First, the all-in-one
admin transfer could move the Diamond's ownership for any holder of the
role root, even one that was not the owner. Ownership carries the right to
replace facets, so the transfer now also requires the caller to be the
current owner, as every other ownership change does. After the handover
both are the Timelock, so nothing changes for a correctly handed-over
chain; the check keeps the two authorities from being taken with one of
them.

Second, the 0x and 1inch swap adapters stayed owned by the key that
deployed them, and nothing in the handover or its exit gate looked at them.
Their owner edits the list of addresses a liquidation swap may call, so a
leaked deploy key could have added a hostile one. Adapters are now created
owned by whoever governs the Diamond at the time (the admin before the
handover, the Timelock after), never by the deploying key. And the
handover no longer works from a hand-kept list of owned contracts: it finds
them, from the chain's deployment record and from what the Diamond itself
names (its registered swap adapters, its rate model, its satellite
contracts), and moves every one whose owner is not the Diamond to the
Timelock. That brings the sanctions-list contracts along too. The exit gate
checks the same found set, so a contract still on the deploy or admin key
fails it, and on a production chain the handover refuses to start while any
owned contract sits on a key it cannot move. The scripts that record a
chain's storage layout now share the same walk over the chain's contracts,
so there is one list of what a chain consists of, not two.

One consequence is deliberate and stated: rotating 0x's Settler addresses
on an adapter is a governance action after the handover and waits out the
Timelock delay. Until it lands, a 0x quote naming the new Settler fails
that route and the swap failover tries the next adapter. Closes #2743.
