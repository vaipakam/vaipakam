## Indexer — a mis-pointed RPC now fails loudly, never silently (PR #<n>)

During the July ingest outage, the final silent phase came from an RPC
URL that answered for the wrong network: its chain was shorter than
ours, so every scan concluded "nothing new" and exited cleanly — no
error, no log line, no cursor movement — while the tail showed only
healthy-looking ticks. Diagnosing it took a day of correlating public
API staleness, database cursors, and log silence.

Two guards close that class:

- Before scanning, the indexer now asks the RPC which chain it serves
  and compares. A mismatch logs one unmistakable error line naming the
  expected and reported chain ids — deliberately no part of the RPC
  URL, not even the hostname, since some providers embed the access
  credential there; the expected chain id alone identifies which
  per-chain RPC secret is mis-pointed — and the scan is skipped as a
  retryable failure, so it can never masquerade as "caught up". A
  verified pairing is remembered per running instance, so the
  steady-state cost is one extra call per deployment restart. A
  transport hiccup on the probe is not treated as a verdict, but it
  does not let the scan proceed either — an endpoint whose identity
  was never established could be the mis-pointed one, and scanning a
  wrong chain whose history is LONGER than ours would advance our
  position past real blocks and permanently skip them. The pass is
  skipped as the same retryable failure and the probe simply re-runs
  next pass.
- Separately, if a scan finds the chain head sitting far BELOW our own
  stored position — never a healthy state — it logs a loud stale-or-
  mis-pointed-RPC warning instead of quietly treating it as caught up.

Had these existed in July, the whole hunt would have been one log
line: "RPC for chain 84532 answered eth_chainId=1 — mis-pointed
RPC secret".
