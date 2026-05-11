-- 0008_offer_is_stub.sql — replace the active-offer churn predicate
-- with a targeted is_stub flag.
--
-- Background: `refreshStubOffers` previously selected stale
-- rows via `lending_asset = '0x' OR status = 'active'`. The
-- second clause was a correctness-preserving sledgehammer for
-- partial-fill `amountFilled` ratcheting on Range-Order offers,
-- but in practice it re-pulls `getOfferDetails` for every active
-- offer every cron tick — exactly the kind of subrequest churn
-- that pegs the free-tier 50-subrequest cap when active-offer
-- count grows past ~30 per chain.
--
-- The fix: a boolean `is_stub` column. INSERT-time-stub rows set
-- it to 1; the inline-success path AND `refreshOfferDetails` UPDATE
-- it to 0 once canonical data lands. The new predicate becomes
-- `is_stub = 1` — refresh only the rows that actually need it.
--
-- Partial-fill ratcheting moves to event-driven UPDATE in
-- `processOfferLogs`'s new `OfferMatched` / `OfferClosed` handlers,
-- which carry enough payload to update `amount_filled` / `status`
-- without an RPC round-trip.
--
-- Backfill: any existing row whose `lending_asset` is the legacy
-- '0x' placeholder is treated as a stub. Active rows that already
-- have canonical data carry `is_stub = 0` from the DEFAULT — the
-- next cron tick will leave them alone (correct, since the new
-- event-driven path now handles ratcheting).

ALTER TABLE offers ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0;

UPDATE offers SET is_stub = 1 WHERE lending_asset = '0x';

CREATE INDEX IF NOT EXISTS idx_offers_chain_is_stub
  ON offers (chain_id, is_stub);
