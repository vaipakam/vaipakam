## Indexer — a health route that says whether ingest is advancing, and why not (#2469)

When the indexer was published ahead of a database migration, its schema gate correctly paused all scheduled ingest until the migration was applied. The gate said so only in the Worker's logs, so the stall went unnoticed until stale screens did the reporting.

The indexer now answers a read-only health route. For each chain it scans, the route reports the last block it reached and how long ago it got there. It also reports whether this build's migrations are all applied and, if not, names the missing ones. It states facts, not a verdict: what counts as stale depends on the caller, and a chain the indexer no longer scans keeps its last position forever. The route reads only the database, so it still answers when the secrets service, one of the things that can stall ingest, is degraded. Responses are never cached.

What calls this route and alerts the operator is decided separately. The account's scheduled-trigger budget is fully committed, so a new watcher Worker cannot simply be added.
