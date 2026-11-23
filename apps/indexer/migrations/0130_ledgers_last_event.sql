-- #3921 part B2 — the reward and recycling ledgers name the event that last
-- changed each row (TroubleshootingPictureDesign §4.6), the last handler
-- group: after this migration every event-derived table carries the three
-- columns. Same meanings and forward-only rule as migrations 0127-0129
-- (src/lastEvent.ts). Additive: nullable columns, no default.
ALTER TABLE keeper_commitment_reconciled ADD COLUMN last_event_block INTEGER;
ALTER TABLE keeper_commitment_reconciled ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE keeper_commitment_reconciled ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE recycle_chain_reported ADD COLUMN last_event_block INTEGER;
ALTER TABLE recycle_chain_reported ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE recycle_chain_reported ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE recycle_prelaunch ADD COLUMN last_event_block INTEGER;
ALTER TABLE recycle_prelaunch ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE recycle_prelaunch ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE recycle_day_pool ADD COLUMN last_event_block INTEGER;
ALTER TABLE recycle_day_pool ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE recycle_day_pool ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE reward_loop_totals ADD COLUMN last_event_block INTEGER;
ALTER TABLE reward_loop_totals ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE reward_loop_totals ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE reward_loop_day ADD COLUMN last_event_block INTEGER;
ALTER TABLE reward_loop_day ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE reward_loop_day ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE reward_day_user ADD COLUMN last_event_block INTEGER;
ALTER TABLE reward_day_user ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE reward_day_user ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE reward_retention ADD COLUMN last_event_block INTEGER;
ALTER TABLE reward_retention ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE reward_retention ADD COLUMN last_event_log_index INTEGER;
