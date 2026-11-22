-- #3921 part B2 — every row the indexer derives names the event that last
-- changed it (TroubleshootingPictureDesign §4.6). This migration adds the
-- three columns to the first two event-derived tables, `offers` and `loans`;
-- the other event-derived tables follow, one migration per handler group.
--
--   last_event_block      the block of the event that last changed the row
--   last_event_tx_index   its transaction's position in that block
--   last_event_log_index  its log's position in that block
--
-- A row set from a read of the chain's state carries the block it was read
-- at with both positions NULL. A row last written before this migration
-- carries all three NULL: unknown, never a guess. The columns only ever move
-- forward; the rule and its one SQL form live in src/lastEvent.ts, and
-- test/lastEventGuard.test.ts refuses a write to these tables that does not
-- set them. Additive: nullable columns, no default needed.
ALTER TABLE offers ADD COLUMN last_event_block INTEGER;
ALTER TABLE offers ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE offers ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE loans ADD COLUMN last_event_block INTEGER;
ALTER TABLE loans ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE loans ADD COLUMN last_event_log_index INTEGER;
