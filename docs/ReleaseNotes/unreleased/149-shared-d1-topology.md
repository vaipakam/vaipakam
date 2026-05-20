## Thread — Document the shared `vaipakam-archive` D1 topology (PR #<n>)

Closed issue #149 by making the existing D1 topology explicit in the
per-Worker READMEs, the staging-state doc, and `CLAUDE.md`. The
investigation that gated this card found that the "missing migrations"
gap the card originally flagged does not actually exist:

The three plain Workers (`apps/indexer`, `apps/keeper`, `apps/agent`)
all bind to a **single shared D1 database** — `vaipakam-archive`,
database_id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`. Every table that
keeper or agent reads/writes (`user_thresholds`, `notify_state`,
`telegram_links`, `liquidity_confidence`, `diag_errors`,
`diag_legal_holds`, `diag_legal_hold_audit`, plus reads of `loans` /
`offers` / `oracle_snapshot_state`) is already covered by the existing
`apps/indexer/migrations/` directory. The schema is fully tracked; the
gap was purely documentation.

This PR records the topology in three places. Each per-Worker README
gets a new "D1 — shared `vaipakam-archive`" subsection explaining the
binding, the tables that Worker touches, and the rule that schema
changes land in `apps/indexer/migrations/` even when they're for
tables the indexer itself doesn't write. The `CLAUDE.md`
"Cloudflare D1 schema discipline" section codifies the
"every schema change is a migration file under `apps/indexer/`" rule
so the convention survives contributor turnover. The staging-state doc
replaces its stale "migrations not yet applied — will run from
`apps/agent/`" note with the current reality (single shared D1,
indexer-owned migrations).

`ops/lz-watcher`'s separate `vaipakam-lz-alerts-db` D1 is also called
out — that one stays separate by design (trust-boundary isolation for
internal ops alerts).
