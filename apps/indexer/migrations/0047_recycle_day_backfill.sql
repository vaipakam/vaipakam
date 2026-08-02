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
  -- Provenance of the run that produced the row. `armed_from_day` is the
  -- sentinel it resolved; `generator_rev` identifies the computation.
  -- These rows are non-reproducible and first-write-wins, so two captures
  -- under the same sentinel would otherwise be indistinguishable even if a
  -- revised script produced one of them (Codex #1513 r4).
  armed_from_day INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  generator_rev TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (chain_id, day_id)
);

-- Per-source ATTRIBUTED cumulative, beside the reported one (#1513 r4).
--
-- The runway numerator needs the lifetime recycled stock across the mesh.
-- Reported cumulatives come per source; the day series' mirror term is
-- already summed across mirrors on chain (`dayMirrorRecycledCredit`), so a
-- fold of it cannot be decomposed per source afterwards.
--
-- Taking `max(sum of reported, sum of fold)` looked right and is not: a
-- mirror present only in the backfilled fold is dropped whenever another
-- mirror's reported cumulative dominates the comparison. Recording what
-- each source's reports were ATTRIBUTED lets the reconciliation happen per
-- source — each contributes the larger of its reported and attributed
-- figures — with whatever the fold saw beyond ALL attributed sources added
-- as stock no report accounts for.
ALTER TABLE recycle_chain_reported
  ADD COLUMN attributed_cumulative TEXT NOT NULL DEFAULT '0';
