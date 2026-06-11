-- T-092-C (#532) — pre-grace notification dedupe table.
--
-- Tracks when the keeper bot last warned a borrower that one of
-- their active loans is approaching the grace-period boundary with
-- auto-refinance caps enabled but (possibly) no compatible offer
-- in the book.
--
-- Separate from `notify_state` (which holds the HF-band hysteresis
-- per loan) so the two concerns can't trip over each other when the
-- borrower opts out of one channel but stays on the other.
--
-- Dedupe rule: don't re-notify the same (wallet, chain_id, loan_id)
-- triple within a configurable window (default 12 hours, enforced
-- in apps/keeper/src/preGraceWatcher.ts). The window is short
-- enough that a borrower who repays + immediately takes a new loan
-- doesn't carry the dedupe across loans; long enough that a
-- transient RPC blip doesn't spam them on every cron tick.
CREATE TABLE IF NOT EXISTS pre_grace_notify_state (
  wallet         TEXT NOT NULL,
  chain_id       INTEGER NOT NULL,
  loan_id        INTEGER NOT NULL,
  last_sent_ts   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wallet, chain_id, loan_id),
  FOREIGN KEY (wallet, chain_id) REFERENCES user_thresholds(wallet, chain_id) ON DELETE CASCADE
);
