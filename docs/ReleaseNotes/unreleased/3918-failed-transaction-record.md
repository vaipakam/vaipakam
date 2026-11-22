## Troubleshooting — the failed transaction record (PR #<n>)

The indexer now keeps a record of every failed transaction sent to a contract in a network's deployment record, with the error decoded at the time, while the node still holds the state. It is the stored half of the troubleshooting picture: a failure seen days later can be read from the record instead of being rebuilt from a node that may no longer have the block.

The record is written only through a new internal route, under a token of its own. The writer is a separate service on the keeper machine (#3919), with its own user and no database binding, so the most it can do is add records, move its own cursor and mark ranges the chain replaced. It can touch no other table. Each write is bounded (twenty records, a size bound on each explanation) and refused whole if any part of it does not fit the rules.

Each record says which source found it (the keeper's own sends, the explorer's list of transactions to a contract, the daily sampled audit, a trace filter, or a block scan), the pass's mode for that network at the time, and where its decoding came from (a node trace, a local rebuild, a plain replay, or none). It says what it cannot hold rather than leaving a blank: a replay has no call path, and a record whose block state was no longer reachable says so. A better source later replaces a weaker one; a weaker one never overwrites a better one.

A block the chain replaced is marked with the time it was found replaced, never deleted, and a transaction re-mined in the replacement block is a second record. Nothing in the record can be replayed from the chain, so it is kept across a fresh Diamond and is part of the nightly backup and the restore. Records and their range rows are kept for 400 days; the indexer's scheduled pass removes anything older.

A new health route reports, per network, the pass's mode and how far behind its cursor is, the newest checkpoint, the last replacement, the gaps it could not scan, and for networks without a trace filter the audit's miss rate: how many failures a full scan found in the sampled windows that the other sources had missed.

Closes #3918

> Caveat: the record is for operators. Sender addresses are as public as the transactions, but the public data feed's address rules apply before any of it is shared outside.
