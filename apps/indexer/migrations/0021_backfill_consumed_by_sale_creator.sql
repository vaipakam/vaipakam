-- T-086 Round-8 §19.7e (#358) + Codex round-18 P2 #3 — backfill
-- existing `OfferConsumedBySale` activity_events rows with the
-- offer's `creator` so the dapp's `indexedToActivityEvent` address-
-- walk surfaces the borrower in the row's participants list. The
-- Round-8 indexer writes `args = {offerId, executor, creator}` for
-- every new sale event (`recordActivityEvents` in chainIndexer.ts
-- enriches the args bag before INSERT). But pre-existing rows
-- written before this PR carry `args = {offerId, executor}` only,
-- and `INSERT OR IGNORE` means those rows are never re-written. The
-- result: every sold-before-acceptance offer indexed before the
-- chainIndexer update stays hidden from the borrower's indexer-fed
-- Activity feed.
--
-- This one-time migration UPDATEs every such row with the offer
-- creator looked up from the `offers` table. Rows where the offer
-- row no longer exists (pruned / never created in D1) keep their
-- pre-PR shape. Rows where the args_json already contains `creator`
-- are skipped (json_extract returns non-null) — the WHERE clause
-- gates the UPDATE to OfferConsumedBySale rows whose args bag is
-- missing the field.
--
-- D1's `json_set` builds a new JSON value by adding the `$.creator`
-- field on top of the existing args bag. The composite primary key
-- (chain_id, block_number, log_index) restricts the UPDATE to
-- exactly one row per match — no per-event index needed.

UPDATE activity_events
SET args_json = json_set(
  activity_events.args_json,
  '$.creator',
  (
    SELECT creator
    FROM offers
    WHERE offers.chain_id = activity_events.chain_id
      AND offers.offer_id = activity_events.offer_id
    LIMIT 1
  )
)
WHERE kind = 'OfferConsumedBySale'
  AND json_extract(args_json, '$.creator') IS NULL
  AND EXISTS (
    SELECT 1
    FROM offers
    WHERE offers.chain_id = activity_events.chain_id
      AND offers.offer_id = activity_events.offer_id
  );
