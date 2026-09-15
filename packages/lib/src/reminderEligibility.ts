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
 *
 * **AND IT IS FOR LANES THAT DERIVE FROM STORED STATUS.** There is a third
 * user-messaging lane — the keeper's health-factor band alerts — and it does
 * NOT need this, for a structural reason worth writing down so nobody "fixes"
 * it: it takes its loan set from the CHAIN (`getActiveLoansPaginated`, pinned
 * to one block) and consults D1 only to resolve who to tell. A loan the chain
 * considers ended is not in that list at all, so the case this rule exists
 * for cannot arise there.
 *
 * That is the test for a new lane: ask where its loan set comes from. From
 * `loans.status` — it needs this rule. From the chain — it already has a
 * better one.
 *
 * **The periodic-interest lane moved to the second answer (#2213 r3).** It
 * briefly used this rule, and three findings followed from the fact that it
 * was importing a suppression list another Worker writes on another schedule:
 * a race against that write, a deploy-window coupling, and an availability
 * answer that could not distinguish "absent" from "could not ask". None of
 * those are bugs in the rule; they are the cost of coordinating across
 * Workers to answer a question one of them can ask the chain directly. By the
 * time that lane is about to send, its candidates are the loans actually
 * inside the notification window, so it asks — in ONE batched call, and for a
 * bounded number of loans per invocation (#2213 r5). "The candidate set stays
 * small" was an assumption about load, and an assumption is not a limit.
 *
 * The calendar sweep keeps this rule, and the difference is width, not
 * principle: its window can hold a hundred rows per chain per tick, so
 * per-row chain reads there are the subrequest-budget problem #2194 tracks.
 * Cheap memory for the wide path; direct verification for the narrow one.
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

/**
 * Whether the chain's answer makes a loan eligible for a PERIODIC-INTEREST
 * reminder.
 *
 * Two conditions, and the first one is the one that is easy to miss.
 *
 * **The loan has to exist.** `getLoanDetails` does not revert for an unknown
 * id — it returns the mapping's zero struct, whose `status` is `0`, which is
 * `Active`. So an orphaned row (one indexed from a reorged-out
 * `LoanInitiated`, say) reads back as a healthy running loan, which is
 * precisely the shape this check exists to catch. `id` is the
 * existence-bearing field: a real loan's id is its own non-zero key. The
 * reconciliation reader has rejected the zero struct for this reason since
 * #2190; the rule belongs wherever the chain is asked, not in one reader
 * (#2213 r4 `4012114089`).
 *
 * **And the status has to be exactly `Active(0)`.** Not "any non-terminal
 * state": `FallbackPending(4)` is non-terminal, and a first version of this
 * allowed it — but `RepayPeriodicFacet.settlePeriodicInterest` accepts only
 * `Active` and reverts on everything else, so telling a holder their interest
 * payment is due on a fallback-pending loan invites them to attempt something
 * the contract will refuse (#2213 r4 `4012114096`).
 *
 * That is the general lesson for this predicate: eligibility is the ACTION's
 * precondition, not a generic liveness idea. A different lane, whose message
 * points at a different contract call, needs its own answer rather than this
 * one.
 *
 * An unrecognised status is ineligible — an allow-list, so a member appended
 * to the enum cannot silently become "still running" in a lane that messages
 * users about running loans.
 */
export function isPeriodicInterestEligible(loan: { id: bigint | number; status: number }): boolean {
  return Number(loan.id) !== 0 && Number(loan.status) === 0;
}
