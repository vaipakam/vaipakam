## Troubleshooting — the failed transaction pass (PR #4011)

A new service finds every failed transaction sent to a contract in a network's deployment record. It decodes each one while the node still holds the state, and stores it in the failed transaction record (#3918). Failures by anyone, from any front end, are now kept with their error decoded at the time. Before this, they were found only if someone happened to look while a node still had the block.

It runs on the keeper machine as a separate service, not as a Cloudflare Worker. On the free plan a Worker gets 10 ms of CPU per run, and decoding one transaction against the platform's full interface takes several times that. The service holds no signing key and has no database. It writes only through the indexer's failed-transaction route under a token of its own, and reads its own position back the same way. It runs under its own user, cannot read the keeper's settings or state, and is deployed by its own install script from a named commit on main.

How it finds failures depends on what each network's node offers, as measured by the node capability check (#3913). On BNB testnet the node offers a trace filter, which covers direct calls and calls made through other contracts. On Base Sepolia and Arbitrum Sepolia it reads the explorer's list of transactions sent to each contract and keeps the failed ones. The contracts users call directly are read every five minutes and the rest hourly. On those networks, a random 30 minutes of each day is also audited by reading every block in full. A failure the list missed is recorded and alerted, so completeness there is a measured miss rate on the health route, not a claim.

Each record uses the best source the node offers: the node's own trace (the full explanation), else a replay of the call at the block before (the error only, with what it cannot hold listed), else "state no longer reachable". A node that does not answer never downgrades a record: the service waits and tries again. A block the chain later replaced is detected by reading the last checkpoint twice. Its records are marked rather than deleted, and the range is scanned again. A range that cannot be scanned is recorded as a gap and alerted.

Closes #3919

> Caveat: on a network without an explorer key the keeper's own sends would be the continuous source, and they arrive with the keeper decision record (§4.4). Until then such a network is watched only during its audit window, and the health route states that share of the day.
> Caveat: a local rebuild of a transaction is not run by the service; an operator adds one with the explainer through the same route.
> Caveat: installing the service and setting the writer token on the indexer are operator steps.
