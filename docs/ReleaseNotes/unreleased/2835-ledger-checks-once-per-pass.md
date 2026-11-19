## Thread — reward and recycling ledgers check their one-time work once per pass

Since the indexer began scanning one block at a time, the reward loop-closure ledger and the recycling day series each re-read their "has the one-time replay already run" flags for every block that carried an event, even though the scan pass had already run those same checks once, at its start. In steady state that was three extra database reads per event block, and the platform's per-invocation query budget is what limits how many blocks one pass can finish.

The two per-block writers no longer repeat the checks. They rely on the pass's opening step, which already runs every one-time replay before any return and before the pass records any activity row, so the ordering rule the replays depend on is unchanged. A block with none of a ledger's events now costs that ledger no query at all.

No figure, row or published number changes: both ledgers stay exactly-once through their own dedup tables, and a pass that runs out of room still stops at a block boundary. A structural test now pins that each writer is called only after the pass's opening checks, and new tests confirm the writers read no one-time flag per block. The checks still run once in every pass, after the pass has confirmed which deployment it is indexing and before its first block, and nothing about them is remembered from one pass to the next: a test drives a pass, a deployment reset and the next pass, and the checks run again after the reset.

Closes #2835
