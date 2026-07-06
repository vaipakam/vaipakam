# RPC diet — the app stops streaming chain polls (alpha02)

A live measurement on the deployed site showed one open tab — signed
in or not — issuing about 3,700 chain-RPC calls per hour: the live
block-refresh layer's HTTP fallback polled the block number every
second-and-a-bit, and each new block dragged the Offer Book's nominal
30-second refresh cycle down to about five seconds, log-scans
included. Four changes bring a parked tab down to a handful of calls
per minute, with near zero once you look away:

- **Block-driven live refresh is now push-only.** The per-block
  refresh layer runs only when a WebSocket RPC is configured for the
  chain (a true subscription — no request cost per block). Deploys
  without one — including today's — no longer block-poll at all; the
  ordinary 30-second refresh, the instant refresh after your own
  actions, and the indexer push channel carry freshness instead.
  Operators can restore the seconds-fast third-party freshness at any
  time by setting the chain's WebSocket URL — no code change.
- **Hidden tabs hold no subscription.** Previously a hidden tab
  stopped refreshing but kept the block poller running; now the
  watcher itself is off while the tab is hidden.
- **Idle sessions back off.** A visible tab with no interaction
  (taps, keys, scrolling all count) for two minutes stretches every
  periodic refresh to a quarter of its usual pace. The first
  interaction after an idle stretch immediately refreshes the
  transaction-driven data (offers, positions, claims, balances) and
  restores the normal pace; configuration-style data follows at its
  next tick, and returning to the tab refreshes everything on focus
  as before.
- **One static read stopped repeating.** The VPFI token address — a
  value that cannot change without a redeploy — was re-read every 30
  seconds, and for signed-out visitors it was the only chain call in
  the cycle; it is now read once per session per network.

Nothing visible changes: pages render the same, your own actions
still reflect instantly, and the block-driven refresh returns
automatically wherever a WebSocket RPC is configured. A CI check now
fails if a parked Offer Book tab ever streams block polls again, and
a committed live audit driver measures the deployed site's real
traffic against the same budget.
