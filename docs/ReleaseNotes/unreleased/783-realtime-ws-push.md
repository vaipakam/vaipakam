## Near-real-time UI updates — WebSocket push from the indexer (#757 Phase B)

The connected app already keeps itself fresh by polling the indexer in the
background. This adds a faster, optional path on top: the indexer can now **push**
a small "this changed" signal to the app over a WebSocket the instant it finishes
recording an on-chain change, so the relevant screen refreshes within seconds
instead of waiting for the next poll.

How it works, in plain terms:

- The per-chain ingest component (added in Phase A) now also holds the browser
  connections for that chain. Right after it records a batch of changes, it
  notifies every connected app: "offers changed", "a loan was updated", "new
  activity", and so on.
- The signal carries **only the fact that something changed**, never the data
  itself. The app then re-reads the affected slice through the exact same
  endpoints it already uses — so nothing about what the app trusts, or where it
  reads authoritative data from, changes.
- A new line in the connection-status popover shows whether the page is getting
  **Live** push updates or is on the always-on **Polling** fallback.

This is purely additive and degrades safely: if the WebSocket can't connect, the
deployment doesn't have the realtime channel enabled, or the connection drops,
the app simply keeps polling exactly as it did before — there is no change to the
decentralized read-and-fallback path. The realtime channel is only active when an
operator has enabled the Phase A ingest path; otherwise the app shows "Polling"
and behaves identically to before. No change to any lending, borrowing, or
settlement behaviour.
