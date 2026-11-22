-- #3919 — the failed transaction pass's own position state, on its cursor
-- row (failed_tx_cursor, migration 0123). Written only through
-- `POST /internal/failed-tx` (src/failedTx.ts), under the pass's token.
--
--   slow_block_number  list-and-audit mode: the explorer's list of the
--                      contracts users do not call directly is read hourly,
--                      so it keeps its own position (the block it is read
--                      to); null in the other modes
--   list_from_block    list-and-audit mode: the first block of the lists'
--                      present unbroken run of coverage (set when the
--                      network enters the mode, cleared when it leaves it).
--                      An audit window that starts below it was never asked
--                      of the list, so its finds are not counted as misses
--   audit_day          the day's audit window (TroubleshootingPictureDesign
--   audit_from         §4.3): a random 30 minutes of the previous UTC day,
--   audit_to           chosen once and scanned in slices; null where no
--                      window is planned
--
-- Additive: nullable columns only, so the code already serving reads and
-- writes the table unchanged.
ALTER TABLE failed_tx_cursor ADD COLUMN slow_block_number INTEGER;
ALTER TABLE failed_tx_cursor ADD COLUMN list_from_block INTEGER;
ALTER TABLE failed_tx_cursor ADD COLUMN audit_day TEXT;
ALTER TABLE failed_tx_cursor ADD COLUMN audit_from INTEGER;
ALTER TABLE failed_tx_cursor ADD COLUMN audit_to INTEGER;
