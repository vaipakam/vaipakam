-- #2230 — the pre-notify lane remembers, per loan, which pass examined it.
--
-- The lane works through the active periodic loans whose payment deadline is
-- inside the reminder window, nearest deadline first, within a bounded
-- allowance per tick. Until now it remembered how far it had got as one place
-- in that order (`prenotify_scan_cursor`, migration 0050). A loan that arrived
-- IN FRONT of that place (newly indexed, or a period that just entered the
-- window) waited for the whole pass to wrap round, even when its deadline was
-- the nearest.
--
-- A place cannot fix that, and re-checking the front every tick would bring
-- back the starvation the place was added to end. Loans that are examined but
-- never stamped would hold the allowance on every tick. So the lane records,
-- on each loan it examines, the pass that examined it and the period that
-- examination was for. A tick then works through the loans the current pass
-- has not examined, nearest deadline first, wherever they sit in the order.
--
--   prenotify_examined_lap        — the pass number; 0 = never examined.
--   prenotify_examined_checkpoint — the period's unmoved end the examination
--                                   was for. A mark for any other period than
--                                   the one now due counts as no mark.
--
-- And it records, per chain, the pass in progress and when it began
-- (`prenotify_pass`). The record, not the marks, dates a pass: a marked loan
-- leaves the window once its deadline passes, so a start read from the marks
-- still in the window keeps moving forward, and a pass running longer than the
-- window could never be seen to. The row changes only when a pass begins,
-- which is also the only moment the lane writes it, before it marks anything
-- under the new number.
--
-- These belong to apps/agent's pre-notify lane, beside
-- `period_pre_notified_at` (migration 0007), its reminder stamp. They live in
-- this file because apps/indexer/migrations is the single owner of the shared
-- database's schema (CLAUDE.md, "Cloudflare D1 schema discipline"), not
-- because the indexer reads them. The indexer never writes them. A loan row it
-- rebuilds starts at 0, which means "not examined", so a rebuild makes the
-- lane look at a loan again rather than skip it; a missing pass row makes the
-- lane begin a new pass, numbered above every mark it finds.
--
-- Additive: two columns with defaults and a new table, none of which the
-- deployed agent reads or writes. `prenotify_scan_cursor` stops being read
-- once the new agent deploys. It is dropped by a later migration, not this
-- one, because the agent still serving while this lands reads it.
ALTER TABLE loans ADD COLUMN prenotify_examined_lap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN prenotify_examined_checkpoint INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS prenotify_pass (
  chain_id   INTEGER PRIMARY KEY,
  lap        INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
