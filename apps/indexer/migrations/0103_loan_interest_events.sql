-- #3755 / #3768 — the interest each loan paid, one row per statement.
--
-- The contracts state every interest payment on a loan once, at the one step
-- every payment passes through (`LoanInterestPaid`), and state a take-back
-- when a payment parked for the lender side arrived short
-- (`LoanInterestUndelivered`). The interest a loan has paid up to a moment is
-- the sum of its 'paid' rows less the sum of its 'undelivered' rows up to
-- that moment, which is how the contracts' own counter moves.
--
-- `gross` is the amount in the loan's principal asset, smallest unit, as a
-- decimal string (it can exceed SQLite's 64-bit integers, so it is summed in
-- the Worker, never in SQL). A fallback recovery and an NFT rental state no
-- row, as the contracts state none.
--
-- Keyed by the log, written with INSERT OR IGNORE, so a re-read of a block
-- range never counts a statement twice. Replay-derived: a restore clears it
-- and the chain pass rebuilds it. Carries chain_id, so a fresh Diamond's
-- epoch reset clears it with the chain's other rows. Additive: a new table.
CREATE TABLE IF NOT EXISTS loan_interest_events (
  chain_id      INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  loan_id       INTEGER NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('paid', 'undelivered')),
  asset         TEXT    NOT NULL,   -- lower-case 0x address
  gross         TEXT    NOT NULL,   -- decimal string, smallest unit
  block_at      INTEGER NOT NULL,   -- block time, unix seconds
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_loan_interest_events_loan
  ON loan_interest_events (chain_id, loan_id);

CREATE INDEX IF NOT EXISTS idx_loan_interest_events_time
  ON loan_interest_events (chain_id, block_at);
