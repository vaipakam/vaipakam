-- #3921 part B2 — the signed offer book names the event that last changed
-- each row (TroubleshootingPictureDesign §4.6), as `offers`, `loans` and the
-- loan side tables do since migrations 0127 and 0128. Same three columns,
-- same meanings, same forward-only rule (src/lastEvent.ts). A signed offer
-- is born off chain (the maker's signature); until a chain event touches it
-- the columns stay NULL, which is the truth: no event has changed it yet.
-- Additive: nullable columns, no default.
ALTER TABLE signed_offers ADD COLUMN last_event_block INTEGER;
ALTER TABLE signed_offers ADD COLUMN last_event_tx_index INTEGER;
ALTER TABLE signed_offers ADD COLUMN last_event_log_index INTEGER;
