## Thread — The index says when it is rebuilding (#3733)

Two events make the indexer clear a network's rows and read them again from the deployment block: adopting a new deployment, and the reorg guard's rebuild after a block it had already read was replaced. Until that replay reaches the chain's safe head, every list and position status it serves for the network is partial. The cursor's age could not show this, because a replay scans every few seconds, so a reader that judged freshness by age called a half-built index fresh.

The indexer now records, per network, why it is replaying and the safe head its last pass read. The replay starts in the same write that starts the reset, and ends only when a settled pass finds the cursor within one scan pass of the safe head, never while a reset is still pending. After that, ordinary lag is reported as lag in blocks, not as a replay. A pass that could not read a settled head records the head as unknown, so the gap is unknown, never zero, and no replay ends on a guess.

The ingest health route states this per network beside the cursor, and every chain-keyed read (offers, signed offers, loans, activity, claims, notifications) carries the same statement for its network under one key, added where the router hands those answers back, so a route added later carries it too. If the statement cannot be read, the answer still goes out and says the replay state is unknown. A database without the new columns reads as unknown, never as "not replaying". The new columns live on the existing deployment record in an additive migration.

The connected app reads the statement before the cursor's age. While the index is rebuilding, every market list says the figures are being rebuilt and may be incomplete; a gap beyond the caught-up cut is stated in blocks; the Support drawer calls the index up to date only when the indexer said it is not rebuilding. The new copy is translated into all nine shipped languages.

Closes #3733.

> Caveat: the alpha05 app's notice is built in its own thread against the same field.
