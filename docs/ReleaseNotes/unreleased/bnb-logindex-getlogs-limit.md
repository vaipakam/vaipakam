## Frontend — BNB testnet log-index recovers from the public RPC's "limit exceeded"

On BNB testnet, the app's on-chain log scan (which backs Dashboard/Activity/Offer
history when reading directly from the chain) was failing outright with
`getLogs …: limit exceeded` and never recovering.

The scanner already copes with RPC providers that cap how many blocks or how many
logs a single request may return: it detects the rejection and automatically
retries with a smaller block window. But it recognised that rejection only by the
wording other providers use ("block range", "response size", "query returned more
than …"). BNB testnet's public RPC rejects with the terse phrase "limit exceeded",
which didn't match, so instead of shrinking the window and retrying, the scan gave
up and surfaced an error.

The detector now also recognises "limit exceeded" (and a few equivalent phrasings),
so the scan shrinks its request window and completes on BNB testnet's public RPC
the same way it already did on other chains. This is chain-agnostic — any RPC that
reports its cap this way now recovers automatically.
