## Thread — Reward metrics answer an unserved chain as unavailable (PR #3128)

The indexer's two reward-metric reads, the loop-closure ratios and the recycling account, now follow the same rule as its loan, offer, signed-offer and protocol-config reads. A chain the indexer is not serving gets a "chain not configured" unavailable answer, never its stored figures. Before this, a chain whose RPC was removed or failed still had its stored figures served with a normal answer. After a chain was retired, those historical figures could read as current.

The loop-closure read asks the same question as the other reads: is this chain deployed, and does its RPC resolve. The recycling read is answered before the indexer resolves its secrets, deliberately, so a slow secret store cannot push it past the browser's time limit. So it asks a narrower question that needs no secret: is the chain deployed, and is its RPC configured. That refuses a retired chain or one never set up. A configured chain whose secret fails still answers from its stored series. In that case the series' own day coverage says where its record ends, and the indexer's ingest health check reports the stall.

The app already shows both surfaces as unavailable when the indexer gives no usable answer, so nothing a user sees changes for a served chain.

Closes #2654.
