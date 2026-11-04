## Thread — Mesh watcher reads one chain per tick (PR #3142)

The mesh watcher now runs every five minutes, and each run reads the canonical
chain plus one chain of the mesh, in rotation. Reading the whole mesh in one
run went past the free Workers plan's limit on outbound requests per
invocation, so the last chain's reads and every alert send were refused. Every
check the watcher runs compares Base's record for one chain with that chain's
own books, and none adds up across chains, so splitting the reads loses no
check. Each run still reads Base's figures and the chain's figures together,
from the same moment.

The rotation is the canonical chain first, then the expected source chains in
ascending order. It comes from the canonical chain's own list on every run, so
a newly wired chain joins it without a redeploy. The slot is taken from the
scheduled time, so a late or doubled run cannot shift the order. With three
chains each chain is still read every fifteen minutes, which is what the two
alert windows were sized for.

A run now clears stored alert records only for the chain it read. Before, any
record not seen on a run was forgotten, which under a rotation would have
re-sent every other chain's open alerts each cycle.

The manual run takes a chain id, and verifying a deploy means one run per
chain.

Advances #1222 (Step 3f of the recycling activation ceremony).

> Caveat: The alert windows count observations of one chain. A fourth chain
> stretches each chain's cycle to twenty minutes and lengthens both windows by
> a third, so they need retuning then.
> Caveat: A one-chain run still uses more CPU than the free plan's nominal
> 10 ms. The first all-chain run used 93 ms and was allowed to finish, but
> nothing guarantees that. If runs start being cut off for CPU, the remedy is
> the paid Workers plan.
