-- 0047 — M5 (#1218 / #1349): pre-cutover day figures, recomputed on demand.
--
-- Widening the day-close event changed its topic, so days finalized BEFORE
-- that upgrade were announced under the old five-argument signature and can
-- never supply `freshDrawdown` or `armed`. The ingest REFUSES them rather
-- than reading the absent fields as zero (which would fabricate finalized,
-- unarmed, zero-drawdown days). This table is where those days come from
-- instead: recomputed from `getRecycleDayMetrics` by an operator-run pass.
--
-- ─────────────────────────────────────────────────────────────────────
-- BORN-OFF-CHAIN. This table is ARCHIVED and RE-IMPORTED on restore.
-- It must NEVER appear in the clear-before-replay command.
-- ─────────────────────────────────────────────────────────────────────
--
-- Every other recycling table is a fold of chain logs, so a block-zero
-- replay rebuilds it byte-identically. These rows are not: the getter
-- recomputes from `dayCapThreshold18`, and `setBroadcastDayCapThreshold`
-- is a second writer of that slot which can overwrite it for an
-- already-finalized day on a Diamond demoted from the canonical role. Once
-- that happens the original is unrecoverable from anything — the day
-- carries no widened event to fall back on. Re-running the backfill after
-- a demotion produces DIFFERENT numbers, so these rows must be preserved,
-- never regenerated.
--
-- That is also why they are not a `source` column on `recycle_day_pool`:
-- a table cannot be half-cleared and the restore classification is
-- per-table, so mixing the two classes would guarantee one of them the
-- wrong treatment during exactly the incident the classification exists
-- for.
--
-- OPERATOR ORDERING REQUIREMENT (from the ratified plan, restated because
-- it comes from the data model rather than the ceremony): run the backfill
-- BEFORE any demotion or role migration, and treat the stored values as
-- the record from that point.
--
-- ─────────────────────────────────────────────────────────────────────
-- ARMING STATUS IS MANDATORY PER ROW.
-- ─────────────────────────────────────────────────────────────────────
--
-- `getRecycleDayMetrics` returns the recomputed figures and NO armed bit.
-- Days before `governorCommitArmedFromDay` are every day of the documented
-- initial unarmed deployment — most of what a first backfill covers — so
-- they come back as non-zero figures that nothing reserved. Storing them
-- bare would republish unreserved ESTIMATES as net emission: precisely
-- what the event's `armed` field exists to prevent, in the flattering
-- direction. The writer resolves `armedFromDay` once and stamps every row.
--
-- `a_bar` and `margin_bps` are NULLABLE and usually NULL: the getter does
-- not return them, so a backfilled day genuinely does not know them. NULL
-- rather than 0 — a zero margin is a real, different thing.
CREATE TABLE IF NOT EXISTS recycle_day_backfill (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  stamped INTEGER NOT NULL DEFAULT 0,
  schedule_floor TEXT NOT NULL DEFAULT '0',
  recycled_budget TEXT NOT NULL DEFAULT '0',
  fresh_drawdown TEXT NOT NULL DEFAULT '0',
  absorbed_local TEXT NOT NULL DEFAULT '0',
  absorbed_mirror TEXT NOT NULL DEFAULT '0',
  armed INTEGER NOT NULL,
  a_bar TEXT,
  margin_bps INTEGER,
  -- Provenance of the run that produced the row: which commit's script,
  -- and the `armedFromDay` it resolved. An operator comparing two
  -- backfills after a role change needs to know they were taken against
  -- different arming records.
  armed_from_day INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, day_id)
);
