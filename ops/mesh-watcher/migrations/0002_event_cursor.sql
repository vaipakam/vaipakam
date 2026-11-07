-- Event-alert scan position (#3239 item 3, #3237).
--
-- One row per (chain, watched contract): the next block the event-alert
-- pass (`src/eventAlerts.ts`) will read from. It advances only past events
-- whose alert was DELIVERED (or already sent before), so an event whose
-- alert Telegram refused is read and alerted again on the next tick rather
-- than skipped. A missing row means the contract was never scanned, and
-- the pass then starts a disclosed look-back window instead of reading
-- from genesis. `start_notified` records whether the notice naming that
-- start block has reached the operator; until it has, the position stays
-- at the start block and the notice is sent again.
--
-- Additive: a new table, nothing the deployed Worker reads.
CREATE TABLE IF NOT EXISTS event_cursor (
  chain_id   INTEGER NOT NULL,
  contract   TEXT    NOT NULL,
  next_block INTEGER NOT NULL,
  start_notified INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract)
);
