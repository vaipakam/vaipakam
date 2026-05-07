-- 2026-05-08 — cancelled-offer capture window for the
-- Dashboard's "Cancelled" filter.
--
-- Why this column at all:
--   The contract's `cancelOffer` deletes the storage slot, so an
--   on-chain re-read of a cancelled offer returns the zero
--   creator and is indistinguishable from "never existed". The
--   frontend's Dashboard "Cancelled" filter therefore can't be
--   served from a `getOffer(id)` round-trip — it has to come from
--   an event-replay surface. Indexing cancelled rows in D1 (with
--   the same per-row shape we already keep for active rows) is
--   the only way to back that filter without re-implementing
--   client-side log scanning across cancelled-since-deployment
--   history.
--
-- Why a separate `cancelled_at` column rather than reading the
-- existing `updated_at`:
--   `updated_at` is the LAST mutation timestamp for the row —
--   it gets bumped on every status flip, partial-fill ratchet,
--   and detail re-fetch. The retention prune below needs a
--   STABLE reference for "when did the cancel happen", not "when
--   was the row last touched". A dedicated column is also cheap
--   (one INTEGER per cancelled row) and the index needed to
--   serve the prune is trivial.
--
-- Why retention rather than indefinite keep:
--   Cancelled rows are noise on the active surfaces (the
--   `idx_offers_chain_status` covers `(chain, status)` queries
--   and the prune doesn't help those) but they accumulate over
--   time. A 30-day default window strikes a balance: long enough
--   for a user to find a cancellation they're investigating in
--   their Activity history; short enough that the table doesn't
--   grow unbounded. Operators can dial the window via the
--   `CANCELLED_OFFER_RETENTION_DAYS` env knob without a schema
--   change.

ALTER TABLE offers ADD COLUMN cancelled_at INTEGER;

-- Partial index — only cancelled rows carry a non-NULL value, so
-- the index stays small even as cancelled rows accumulate. The
-- retention prune below uses this index to skip every active /
-- accepted row in one bound.
CREATE INDEX IF NOT EXISTS idx_offers_cancelled_at
  ON offers(cancelled_at)
  WHERE cancelled_at IS NOT NULL;
