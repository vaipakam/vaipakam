-- #1222 M3 B2-d2 — keeper state for the delivered-backing remit ledger.
--
-- Two concerns, both keeper-owned (schema lives here per the D1 discipline:
-- every table in the shared vaipakam-warm db is defined by an
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

-- Scan state per BASE chain. `next_remit_id` is the terminal-prefix
-- frontier: every reservation below it is terminal (Acked/Released).
-- `scan_cursor` is a SEPARATE rotating cursor (Codex #1426 r1): a single
-- permanently-Pending early reservation pins the frontier, so without the
-- rotation the bounded per-tick window would re-read the same stuck range
-- forever and later reservations would never be discovered. Each tick scans
-- from max(frontier, scan_cursor), persists the window end, and wraps back
-- to the frontier after passing the ledger tip.
-- Keys include the canonical DIAMOND address (Codex #1426 r4): remit
-- numbering restarts per deployment, so a same-chain redeploy must start a
-- fresh scan namespace (an old frontier past the new deployment's nonce
-- would otherwise skip every new reservation forever).
CREATE TABLE IF NOT EXISTS keeper_remit_ack_frontier (
  base_chain_id INTEGER NOT NULL,
  diamond       TEXT    NOT NULL,
  next_remit_id INTEGER NOT NULL DEFAULT 1,
  scan_cursor   INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (base_chain_id, diamond)
);

-- Per-reservation ack attempt log (backoff + observability). `acked_at`
-- is stamped once Base reports the reservation Acked; rows are retained
-- as the audit trail of keeper-driven acks.
CREATE TABLE IF NOT EXISTS keeper_remit_ack (
  base_chain_id   INTEGER NOT NULL,
  diamond         TEXT    NOT NULL,
  remit_id        INTEGER NOT NULL,
  mirror_chain_id INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  acked_at        INTEGER,
  PRIMARY KEY (base_chain_id, diamond, remit_id)
);

-- Reconciled (day, mirror-chain) pairs from Base's
-- CommitmentRemitEligibilityReconciled events. `consumed_at` is stamped by
-- the keeper once the mirror's commitment report for the day is observed
-- sent (or the day is otherwise terminal), so the rediscovery union stays
-- bounded.
-- Namespaced by the emitting canonical DIAMOND (Codex #1426 r6, same
-- redeployment case as the two remit-ack tables above): day ids overlap
-- across a same-chain redeploy, so without the identity a consumed old row
-- would swallow the new deployment's reconcile event (INSERT OR IGNORE)
-- and an open stale row could drive the new deployment.
CREATE TABLE IF NOT EXISTS keeper_commitment_reconciled (
  base_chain_id   INTEGER NOT NULL,
  base_diamond    TEXT    NOT NULL,
  day_id          INTEGER NOT NULL,
  mirror_chain_id INTEGER NOT NULL,
  reconciled_at   INTEGER NOT NULL,
  consumed_at     INTEGER,
  PRIMARY KEY (base_chain_id, base_diamond, day_id, mirror_chain_id)
);

CREATE INDEX IF NOT EXISTS idx_keeper_commitment_reconciled_open
  ON keeper_commitment_reconciled (mirror_chain_id)
  WHERE consumed_at IS NULL;
