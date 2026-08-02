## Indexer — a mis-pointed RPC now fails loudly, never silently (PR #<n>)

During the July ingest outage, the final silent phase came from an RPC
URL that answered for the wrong network: its chain was shorter than
ours, so every scan concluded "nothing new" and exited cleanly — no
error, no log line, no cursor movement — while the tail showed only
healthy-looking ticks. Diagnosing it took a day of correlating public
API staleness, database cursors, and log silence.

Two guards close that class:

- Before scanning, the indexer now asks the RPC which chain it serves
  and compares. A mismatch logs one unmistakable error line (naming
  the reported chain and the RPC host — never the full URL, which
  carries the API key) and the scan is skipped as a retryable failure,
  so it can never masquerade as "caught up". A verified pairing is
  remembered per running instance, so the steady-state cost is one
  extra call per deployment restart; a transport hiccup is not treated
  as a verdict and simply re-probes next pass.
- Separately, if a scan finds the chain head sitting far BELOW our own
  stored position — never a healthy state — it logs a loud stale-or-
  mis-pointed-RPC warning instead of quietly treating it as caught up.

Had these existed in July, the whole hunt would have been one log
line: "RPC for chain 84532 answered eth_chainId=1".
