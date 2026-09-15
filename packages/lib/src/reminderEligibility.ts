/**
 * Which loans a reminder lane may speak about (#2213 r2 `4011776403`).
 *
 * A loan the reconciliation pass could not settle against the chain is still
 * stored as `status = 'active'` — that is precisely what a permanently missed
 * terminal leaves behind — and `loan_reconcile_quarantine` remembers it until
 * a later pass settles it. Any surface that sends a user an unretractable
 * message derived from that stored status has to respect the memory.
 *
 * **There is more than one such lane, and that is why this is shared.** The
 * indexer's calendar sweep mints maturity and grace reminders; the agent's
 * periodic-interest pre-notify sends payment-due Push and Telegram and stamps
 * the checkpoint permanently. They live in different Workers, read the same
 * D1, and had no rule in common — so the first fix covered one of them and
 * left a user able to receive "your payment is due" for exactly the loan the
 * platform had declined to confirm.
 *
 * Copying the predicate into the second lane would have worked today and
 * drifted later; this repo has spent several review rounds on precisely that
 * (two copies of a head resolver, two copies of a buffer constant). One rule,
 * two callers.
 *
 * WHAT THIS DOES NOT DECIDE: whether a lane's message is unretractable at
 * all. A read surface that publishes a status a user can re-check does not
 * need this — suppressing there would hide the very rows an operator has to
 * see. The rule is for messages that cannot be taken back.
 */

/** The table the memory lives in. Named once so a rename cannot half-land. */
export const QUARANTINE_TABLE = 'loan_reconcile_quarantine';

/**
 * A `WHERE`-clause fragment excluding quarantined loans.
 *
 * Correlates on the OUTER query's own columns, so the caller passes the alias
 * its `loans` table is selected under. No binds, so it composes with any
 * parameter list.
 *
 * Belongs in SQL rather than a post-select filter: every caller applies a
 * `LIMIT`, and a quarantined row filtered afterwards has already occupied a
 * slot that an eligible row behind it needed.
 */
export function quarantineExclusionSql(loansAlias = 'loans'): string {
  return `NOT EXISTS (
            SELECT 1 FROM ${QUARANTINE_TABLE} q
             WHERE q.chain_id = ${loansAlias}.chain_id
               AND q.loan_id = ${loansAlias}.loan_id
          )`;
}

/** The single D1 method the probe needs, so this stays runtime-agnostic. */
export interface QuarantineProbeDb {
  prepare(query: string): { first<T>(): Promise<T | null> };
}

/**
 * Build a "has migration 0049 landed on this database?" probe.
 *
 * A FACTORY because the answer is cached per isolate and each Worker must
 * hold its own — a module-level cache shared by import would be fine today
 * and wrong the moment two databases are involved.
 *
 * **Why a probe and not a caught error.** The canonical deploy scripts
 * publish a Worker BEFORE applying its D1 migrations (#2214), so there is a
 * guaranteed window where this code runs against a database without the
 * table. "Does this table exist" has a definite answer; "was that failure a
 * missing table" is a guess about an error message, and a failure classifier
 * narrowed round after round cannot be sharpened into correctness.
 *
 * **Only a TRUE is cached.** A table does not un-exist, so the steady-state
 * cost is one read per isolate — while caching a false would mean the
 * migration lands and this isolate goes on ignoring the quarantine until it
 * happens to recycle, with nothing saying so.
 */
export function createQuarantineAvailability(): (db: QuarantineProbeDb) => Promise<boolean> {
  let seen = false;
  return async (db: QuarantineProbeDb): Promise<boolean> => {
    if (seen) return true;
    try {
      const row = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${QUARANTINE_TABLE}'`,
        )
        .first<{ name: string }>();
      if (row) seen = true;
      return Boolean(row);
    } catch {
      // A PROBE THAT CANNOT ANSWER MUST NOT THROW. Its callers are a reminder
      // sweep and a close-out batch; making either fail because the QUESTION
      // failed would turn a database hiccup into a stalled chain cursor or a
      // dropped sweep — strictly worse than the conservative answer, which is
      // "assume no memory": reminders behave as they did before the quarantine
      // existed, and no batch names a table that might not be there.
      return false;
    }
  };
}
