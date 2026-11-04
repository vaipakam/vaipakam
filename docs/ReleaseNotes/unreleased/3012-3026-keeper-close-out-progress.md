## Keeper — the reward close-out sends a call only when it would progress (PR #<n>)

The reward heartbeat's close-out step retires closed reward entries whose
remaining window is worth nothing, and sweeps the loans of forfeited entries
into the recycle bucket. Both calls can make progress without moving any
value. A sweep may only prepare its records or advance its own cursor, and a
retirement may only advance the pricing cursor it depends on. Until now the
keeper could not see that progress. It swept every loan with an unfinished
forfeited entry once each round, whether or not anything would happen, which
cost a transaction each round for a loan still waiting. It also never sent a
retirement that only advanced the cursor, so an entry far enough behind
could wait on some other caller.

The protocol now reports, for each call, whether it changed any entry's
settlement state (#3012, #3026). The keeper simulates each call and sends it
only when the protocol says it would progress, then repeats it within the
run while it still does. A loan whose sweep cannot progress yet costs a
simulation each round and no transaction. A retirement that only advances
the cursor is now sent.

The temporary read of the older, shorter results is removed. This needs
every served chain to run the refreshed reward facets, so it is merged only
after Base Sepolia, BNB testnet and Arbitrum Sepolia are all refreshed.

Closes #3012. Closes #3026.
