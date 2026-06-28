## Hardening — the app confirms your loans and claimables on-chain, not just from the indexer (#749)

The dashboard's "your loans" and "claimable funds" views start from the indexer's
cached list of which positions a wallet holds, then confirm each one directly
on-chain. Previously the app only consulted the chain *when the indexer returned
nothing* — so if the indexer's cache was briefly stale or incomplete and returned
*some* of a wallet's positions but not all, the missing ones could be hidden from
the user.

Now the app **always** reads the authoritative on-chain list of the wallet's
current position NFTs — using the user's **own** wallet/RPC, never the operator's
— and merges it with the indexer's cached list before confirming each position.
The indexer is treated as a cache that can only *add* candidates to check, never
as the sole source of truth, so a stale or partial cache can no longer hide a loan
or (more importantly) a claimable balance. If the on-chain read itself is
unavailable, the app falls back to the cached list rather than showing nothing.

This is the user-facing half of the indexer security work: the indexer's read
endpoints stay fast and make no on-chain calls of their own, while correctness is
guaranteed by this on-chain confirmation in the app.
