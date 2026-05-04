-- T-034 PR2 — Periodic Interest Payment fields on the loans table.
-- Three columns added so the worker can:
--   * filter loans by cadence in the pre-notify cron lane,
--   * compute the next checkpoint timestamp without re-fetching the
--     loan struct from chain on every pass,
--   * de-dup pre-notify pushes so the same checkpoint never gets two
--     notifications even if the cron over-fires.
--
-- Bootstrap policy mirrors migration 0006: values are pulled from
-- `getLoanDetails(loanId)` once per loan (at LoanInitiated event time
-- or on the first indexer pass that sees a row missing them). After
-- bootstrap the cadence is immutable (snapshotted at loan-init on the
-- contract); `last_period_settled_at` advances exactly one cadence
-- interval per `PeriodicInterestSettled` / `PeriodicInterestAutoLiquidated`
-- / `RepayPartialPeriodAdvanced` event. `period_pre_notified_at`
-- carries the period boundary timestamp the watcher most recently
-- pushed a pre-notify for; the de-dup check is "have we already
-- pushed for this exact `next_checkpoint_at`?".
--
-- Existing rows get the safe defaults — cadence 0 (None) means the
-- pre-notify lane skips them entirely, which is the correct behavior
-- for any legacy loan created before T-034 was active on-chain.

ALTER TABLE loans ADD COLUMN periodic_interest_cadence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN last_period_settled_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans ADD COLUMN period_pre_notified_at INTEGER NOT NULL DEFAULT 0;

-- Pre-notify cron lane filters by `cadence > 0 AND status = 'active'
-- AND next_checkpoint_at - now <= preNotifyDays * 86400`. Index lets
-- the lane run as a single bounded scan rather than a full table walk
-- per tick.
CREATE INDEX IF NOT EXISTS idx_loans_periodic_pending
ON loans (chain_id, periodic_interest_cadence, status, last_period_settled_at)
WHERE periodic_interest_cadence > 0 AND status = 'active';
