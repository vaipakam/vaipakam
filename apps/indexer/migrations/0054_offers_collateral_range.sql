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
-- "same as the floor". Rows that predate this migration are re-read by the
-- detail-refresh lane (active offers first), and the API serves null until
-- then, which the app renders as the floor-only wording it used before.
ALTER TABLE offers ADD COLUMN collateral_amount_max TEXT;
ALTER TABLE offers ADD COLUMN collateral_amount_filled TEXT;
