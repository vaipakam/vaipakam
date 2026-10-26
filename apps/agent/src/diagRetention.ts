/**
 * When a diagnostics record may be deleted (#2758).
 *
 * A legal hold on a wallet's records (`diag_legal_holds`, keyed by the
 * same keyed hash as `diag_errors.wallet_hash`) means none of them may be
 * deleted, by anyone, for any reason, until the hold is lifted. Two paths
 * delete records: the user's signed erasure and the scheduled retention
 * prune. Only the erasure used to honour holds, so a held record was
 * deleted anyway once it passed the retention age — a hold a scheduled job
 * could delete was no hold.
 *
 * Both paths now delete only through this one condition, written into the
 * DELETE itself, so the hold is read in the same statement that deletes
 * and a hold placed a moment before the delete is still honoured. A record
 * with no wallet hash cannot be held, and the condition passes it.
 */
export const DIAG_RECORD_NOT_HELD = `NOT EXISTS (
  SELECT 1 FROM diag_legal_holds h WHERE h.wallet_hash = diag_errors.wallet_hash
)`;
