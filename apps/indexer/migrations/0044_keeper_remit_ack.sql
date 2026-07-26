-- #1222 M3 B2-d2 — keeper state for the delivered-backing remit ledger.
--
-- Two concerns, both keeper-owned (schema lives here per the D1 discipline:
-- every table in the shared vaipakam-archive db is defined by an
-- apps/indexer migration, whichever Worker writes it):
--
-- 1. remit-ack driving (apps/keeper/src/remitAck.ts): Base's reservations
--    are dense (remitId 1..getRemitReservationNonce()), so the keeper scans
--    from a persisted frontier instead of re-reading every reservation each
--    tick, and rate-limits per-reservation ack attempts (an ack takes
--    minutes to deliver over CCIP — re-sending every tick would burn fees).
--
-- 2. commitment reconcile rediscovery (P7): the indexer persists every
--    Base-side CommitmentRemitEligibilityReconciled(dayId, chainId) so the
--    keeper's mirror commitment-report pass re-unions reconciled OLD days
--    that fell outside its bounded scan window.

-- Scan frontier per BASE chain: every reservation with
-- remit_id < next_remit_id is terminal (Acked/Released) — the keeper
-- resumes scanning at next_remit_id.
CREATE TABLE IF NOT EXISTS keeper_remit_ack_frontier (
  base_chain_id INTEGER NOT NULL,
  next_remit_id INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (base_chain_id)
);

-- Per-reservation ack attempt log (backoff + observability). `acked_at`
-- is stamped once Base reports the reservation Acked; rows are retained
-- as the audit trail of keeper-driven acks.
CREATE TABLE IF NOT EXISTS keeper_remit_ack (
  base_chain_id   INTEGER NOT NULL,
  remit_id        INTEGER NOT NULL,
  mirror_chain_id INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  acked_at        INTEGER,
  PRIMARY KEY (base_chain_id, remit_id)
);

-- Reconciled (day, mirror-chain) pairs from Base's
-- CommitmentRemitEligibilityReconciled events. `consumed_at` is stamped by
-- the keeper once the mirror's commitment report for the day is observed
-- sent (or the day is otherwise terminal), so the rediscovery union stays
-- bounded.
CREATE TABLE IF NOT EXISTS keeper_commitment_reconciled (
  base_chain_id   INTEGER NOT NULL,
  day_id          INTEGER NOT NULL,
  mirror_chain_id INTEGER NOT NULL,
  reconciled_at   INTEGER NOT NULL,
  consumed_at     INTEGER,
  PRIMARY KEY (base_chain_id, day_id, mirror_chain_id)
);

CREATE INDEX IF NOT EXISTS idx_keeper_commitment_reconciled_open
  ON keeper_commitment_reconciled (mirror_chain_id)
  WHERE consumed_at IS NULL;
