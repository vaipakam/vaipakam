-- #2382 — a borrower offer's committed collateral RANGE.
--
-- `collateral_amount` has always held the FLOOR of a borrower offer's
-- collateral range (the on-chain `collateralAmount`). The ceiling
-- (`collateralAmountMax`) and the portion already consumed by partial
-- matches (`collateralAmountFilled`) were never stored, so the Offer Book
-- could only say "at least <floor>".
--
-- `collateral_amount_max` is the EFFECTIVE ceiling: the chain stores 0 for a
-- single-value (legacy) offer, which the indexer writes as the floor, so a
-- reader never has to know that sentinel.
--
-- NULL in either column means NOT YET READ from the chain — never zero, never
-- "same as the floor". The API serves null, which the app renders as the
-- floor-only wording it used before.
--
-- `collateral_range_stale` is the EXPLICIT "re-read the range" marker
-- (#2382 r6): set by every path that can change the range (this backfill, a
-- new row, a match) and cleared only by a completed read in the indexer's
-- heal lane, which reads at the scan's settled block. The backfill marks
-- ACTIVE rows only: a terminal offer's range is history the Offer Book does
-- not show, and re-reading every closed offer is not this migration's job.
--
-- ADDITIVE (#2409): two nullable columns, one defaulted flag, and a flag
-- backfill the running Workers do not read.
ALTER TABLE offers ADD COLUMN collateral_amount_max TEXT;
ALTER TABLE offers ADD COLUMN collateral_amount_filled TEXT;
ALTER TABLE offers ADD COLUMN collateral_range_stale INTEGER NOT NULL DEFAULT 0;
UPDATE offers SET collateral_range_stale = 1 WHERE status = 'active';
