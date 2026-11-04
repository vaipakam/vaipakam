## Thread — Mesh watcher deployed, credentials from the Secrets Store (PR #3141)

The recycling-mesh ledger watcher is now deployed as its own Worker with its
own alerts database. It no longer keeps private copies of the ops Telegram bot
token, the ops chat id or the per-chain RPC URLs. It binds to the same account
Secrets Store entries the keeper, indexer and agent read, and resolves them once
at the start of each run. A store read that fails is treated as an unset value,
so it shows up as a coverage gap or as unconfigured delivery rather than as a
silently skipped chain, and the failure log names the binding but never its
value. The manual run endpoint keeps its own per-Worker bearer token and stays
closed while that token is unset.

The shared deploy wrapper now finds wrangler through the bin entry its package
declares. The newest wrangler stopped exporting the file path the wrapper used,
which made every wrapped deploy fail before it started.

The cron-slot ledger, the deploy-lag check and the operator runbooks now
record the watcher as the live occupant of its slot.

Advances #1222 (Step 3f of the recycling activation ceremony).

> Caveat: At three chains a run that read the whole mesh did not fit the free
> Workers plan: it made more than the 50 outbound requests allowed per
> invocation and used about 93 ms of CPU against a 10 ms allowance. The
> one-chain-per-tick rotation (PR #3142) addresses the request limit.
