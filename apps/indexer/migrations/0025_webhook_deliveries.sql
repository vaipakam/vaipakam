-- #757 Phase A — inbound chain-webhook delivery dedupe.
--
-- The Alchemy webhook (POST /hooks/chain-event) is a LATENCY trigger, not a
-- source of truth: after HMAC-verifying a delivery the Worker forwards a
-- (chainId, target-block) hint to that chain's ingest Durable Object and
-- returns 200. Alchemy RETRIES on any non-2xx and can also re-deliver, so a
-- single mined event may arrive several times.
--
-- This table is the exact-seen dedupe gate. The Worker:
--   1. checks it BEFORE forwarding (a delivery already recorded is dropped —
--      200 ack, no DO work), and
--   2. records the row only AFTER the DO has durably accepted the target
--      (`INSERT OR IGNORE`), so a delivery whose forward FAILED is NOT marked
--      seen and Alchemy's retry will re-forward it (the trigger isn't lost).
--
-- Correctness never depends on this table — the cron backstop + the DO's
-- cursor-derived scan converge regardless. It only bounds duplicate work, so a
-- short retention window is enough: a dedicated prune in the scheduled path
-- deletes rows past WEBHOOK_DELIVERY_RETENTION (well beyond any provider retry
-- horizon). `delivery_id` is the Alchemy delivery id when present, else a
-- synthesized `<network>:<maxBlock>` key.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL   -- unix seconds; drives the retention prune
);

-- Prune predicate support — delete WHERE seen_at < cutoff.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_seen_at
  ON webhook_deliveries (seen_at);
