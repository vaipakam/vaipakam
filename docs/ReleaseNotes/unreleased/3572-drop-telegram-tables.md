## Indexer — the shared Telegram tables are dropped

The Telegram link state moved into the agent's own Durable Object with #1722, and migration 0091 emptied the shared database's copies while the keeper then serving still read them. Nothing reads them any more: the keeper reaches Telegram only through the agent, and neither the keeper release now running nor any Worker names them. Migration 0112 therefore drops the four tables (the handshake codes, the pending alert-chat changes, the Telegram LOCK requests and the keeper's LOCK readiness) and the chat column on the alert thresholds. It is the second step of a two-step retirement, listed as such in the additivity check, and it is applied by the indexer's deploy like every shared migration.

The nightly archive stops exporting the handshake-code table. The restore converter still accepts an archive written before this change: it skips that table, rows and all, and strips the chat column from the thresholds rows, saying so for each, so an older archive restores into today's schema. That also retires the runbook step that told an operator to re-run 0091 after importing such an archive, because no chat id can now be put back where an alert could reach a chat its owner has removed. The runbook's clear list no longer names the dropped tables.

Closes #3572.
