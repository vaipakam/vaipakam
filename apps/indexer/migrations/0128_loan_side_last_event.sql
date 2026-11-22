-- #3921 part B2 — the loan side tables name the event that last changed each
-- row (TroubleshootingPictureDesign §4.6), as `offers` and `loans` do since
-- migration 0127. Same three columns, same meanings, same forward-only rule
-- (src/lastEvent.ts); test/lastEventGuard.test.ts refuses a write to these
-- tables that does not set them. Additive: nullable columns, no default.
ALTER TABLE loan_lifecycle_state ADD COLUMN last_event_block INTEGER;
ALTER TABLE loan_lifecycle_state ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE loan_lifecycle_state ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE rental_rights ADD COLUMN last_event_block INTEGER;
ALTER TABLE rental_rights ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE rental_rights ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE swap_to_repay_intents ADD COLUMN last_event_block INTEGER;
ALTER TABLE swap_to_repay_intents ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE swap_to_repay_intents ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE prepay_listings ADD COLUMN last_event_block INTEGER;
ALTER TABLE prepay_listings ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE prepay_listings ADD COLUMN last_event_log_index INTEGER;
ALTER TABLE loan_participants ADD COLUMN last_event_block INTEGER;
ALTER TABLE loan_participants ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE loan_participants ADD COLUMN last_event_log_index INTEGER;
