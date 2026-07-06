# Connected app (defi) — resilience ports from alpha02 (#1031)

Three hardening behaviours proven on the alpha02 surface now also apply
to the connected app:

- **WebSocket-first RPC transport.** Each chain can carry an optional
  WebSocket endpoint (derived from the same env naming as the HTTP
  endpoint: `*_RPC_URL` → `*_WSS_URL`). When one is configured, the app
  connects over WebSocket and silently falls back to batched HTTP if
  the socket can't connect or drops. No behaviour change on chains
  without a configured WebSocket URL.
- **Honest allowance reads.** The Allowances page no longer silently
  omits a token whose allowance read failed. Failed reads are counted
  and surfaced in a warning banner (translated in all ten languages)
  with a retry button, so "no allowance shown" can't be mistaken for
  "no allowance granted".
- **Accurate wallet-rejection detection in diagnostics.** The journey
  log now recognises a wallet rejection wrapped inside a library error
  (the common shape modern wallets produce) instead of only the bare
  top-level rejection code. Rejections a user made in their wallet are
  classified as wallet events rather than misfiled as contract
  reverts, which keeps the Diagnostics drawer's story truthful.
