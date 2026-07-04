## Thread — Live block-driven refresh (WebSocket-preferred)

alpha02 now reflects on-chain transactions in the UI within a block
instead of waiting on the 30-second indexer poll. A single mounted
`LiveChainSync` component watches the head block and, on each new block,
invalidates only the transaction-driven query caches (offers, loans,
positions, claimables, vault balances, sale/refinance pendings) —
static config (protocol fees, tier tables, token metadata, curated
lists) is deliberately left alone so a fast block cadence doesn't churn
reads that never move per block. Two transaction-driven surfaces are
deliberately NOT in the block-driven set: per-loan keeper enables and
the VPFI snapshot. Their toggles patch the cache with the mined value
at the call site, and a block-driven refetch through a lagging public
RPC could overwrite that patch with pre-transaction state — they
reconcile via their own interval refetch instead.

The layer is transport-adaptive. When a chain has a WebSocket RPC URL
configured (new optional `VITE_<CHAIN>_WSS_URL` env vars, defaulting to
the HTTP key with `_RPC_URL` → `_WSS_URL`), the wagmi transport wraps it
in a `fallback` ahead of HTTP and viem's block watcher uses
`eth_subscribe('newHeads')` — a true push, so reflection is near-instant.
Without a WS URL it transparently falls back to HTTP block polling
(~4s), still far tighter than the old 30s cadence, and any WS drop
degrades to the HTTP transport without breaking reads. Invalidations are
throttled (min 4s) and pause while the tab is hidden so a burst of blocks
or a backgrounded tab can't storm the indexer. A user's own action still
refreshes its own keys synchronously at the call site, unchanged — this
adds ecosystem-wide freshness (other users' fills, repayments,
liquidations) on top.

Operators opt in per deploy by setting the `_WSS_URL` env vars (e.g. the
dRPC endpoints already in use expose the same path over `wss://`). No
indexer or Worker changes are required.
