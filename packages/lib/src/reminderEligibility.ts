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
 * principle: its window is bounded at 2,000 rows per chain per tick
 * (`SWEEP_LIMIT`), so even batched, verifying it on-chain would cost that
 * Worker twenty subrequests per chain against the invocation budget #2194
 * already reports as over. Batching moved the narrow lane's reads from
 * one-per-loan to one-per-chain; it does not make the wide one affordable.
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
 * Whether the quarantine memory is there — or whether the question failed.
 *
 * THREE ANSWERS, not two (#2213 r13 `4013570995`). `'absent'` and `'unknown'`
 * were one value until this round, and collapsing them is the same defect the
 * agent's cursor read had: a transient failure looked like a definite "the
 * table is not there", so the sweep dropped the exclusion, announced that the
 * migration was missing, and minted unretractable reminders for exactly the
 * loans being held back.
 *
 * The two callers then take OPPOSITE safe directions from `'unknown'`, which
 * is why this returns the fact rather than a boolean:
 *
 * - The reminder sweep DEFERS. It is about to send something it cannot
 *   retract, so an unanswered question is not permission.
 * - A close-out batch OMITS the release, exactly as it does for `'absent'`.
 *   Naming a table that might not exist would fail the whole batch, and that
 *   batch advances the chain cursor — so the cautious direction there is to
 *   write less, not to stop.
 */
export type QuarantineAvailability = 'present' | 'absent' | 'unknown';

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
 * **Only a PRESENT is cached.** A table does not un-exist, so the steady-state
 * cost is one read per isolate — while caching an absence would mean the
 * migration lands and this isolate goes on ignoring the quarantine until it
 * happens to recycle, with nothing saying so.
 */
export function createQuarantineAvailability(): (
  db: QuarantineProbeDb,
) => Promise<QuarantineAvailability> {
  let seen = false;
  return async (db: QuarantineProbeDb): Promise<QuarantineAvailability> => {
    if (seen) return 'present';
    try {
      const row = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${QUARANTINE_TABLE}'`,
        )
        .first<{ name: string }>();
      if (row) {
        seen = true;
        return 'present';
      }
      return 'absent';
    } catch {
      // STILL DOES NOT THROW. Its callers are a reminder sweep and a close-out
      // batch, and making either fail because the QUESTION failed would turn a
      // database hiccup into a stalled chain cursor or a dropped sweep. What
      // changed in r13 is that the answer is no longer a confident "absent":
      // the caller is told the question failed and decides for itself.
      return 'unknown';
    }
  };
}

/** Cadence enum value → interval in days. Mirrors `LibVaipakam.intervalDays`. */
export function periodicIntervalDays(cadence: number): number {
  switch (cadence) {
    case 1:
      return 30;
    case 2:
      return 90;
    case 3:
      return 180;
    case 4:
      return 365;
    default:
      return 0;
  }
}

/** The fields of the chain's loan record this rule reads. */
export interface PeriodicLoanState {
  id: bigint | number;
  status: number;
  periodicInterestCadence: number;
  lastPeriodicInterestSettledAt: bigint | number;
}

/** Why a loan may not be spoken about. `ok` is the only one that may send. */
export type PeriodicEligibility =
  | 'ok'
  | 'no-such-loan'
  | 'ended'
  | 'no-cadence'
  /**
   * The CHAIN has settled past the period this reminder is about.
   *
   * Ordinary index lag: the borrower paid and our copy has not caught up.
   * Self-healing, and nothing should be done about it.
   */
  | 'chain-ahead'
  /**
   * OUR ROW expects a period the chain has not reached.
   *
   * The opposite direction, and it is not the same problem (#2213 r21
   * `4015014110`). A settlement indexed and then reorged out, or a corrupted
   * row, leaves the stored checkpoint ahead of the chain — and the
   * active-loan reconciliation path does not repair a checkpoint, so nothing
   * heals this. Waiting for it to resolve suppresses that loan's reminders
   * indefinitely while the operator is told to wait.
   *
   * Both directions are equally disqualifying for SENDING, which is why the
   * check is a strict equality. They are not equally diagnosable, which is
   * why they are two verdicts.
   */
  | 'row-ahead';

/**
 * Whether the chain's answer justifies a PERIODIC-INTEREST reminder for the
 * checkpoint the caller is about to speak about.
 *
 * Four conditions, and each one exists because the obvious three were not
 * enough.
 *
 * **The loan has to exist.** `getLoanDetails` does not revert for an unknown
 * id — it returns the mapping's zero struct, whose `status` is `0`, which is
 * `Active`. So an orphaned row (one indexed from a reorged-out
 * `LoanInitiated`, say) reads back as a healthy running loan, which is
 * precisely the shape this check exists to catch. `id` is the
 * existence-bearing field: a real loan's id is its own non-zero key (#2213 r4
 * `4012114089`).
 *
 * **The status has to be exactly `Active(0)`.** Not "any non-terminal state":
 * `FallbackPending(4)` is non-terminal, and a first version allowed it — but
 * `RepayPeriodicFacet.settlePeriodicInterest` accepts only `Active` and
 * reverts on everything else, so telling a holder their payment is due on a
 * fallback-pending loan invites something the contract will refuse (#2213 r4
 * `4012114096`).
 *
 * **The cadence has to be one this build knows.** An unrecognised member
 * yields no interval, and a reminder computed from no interval is a reminder
 * about a date nobody can justify.
 *
 * **And the CHECKPOINT the caller is about to speak about has to be the one
 * the chain is still on** (#2213 r12 `4013387394`). This is the condition that
 * is easy to miss because the other three pass: a loan whose period was just
 * settled stays `Active`, and the stored row keeps the OLD checkpoint until
 * the indexer catches up — so the lane would tell someone their payment is due
 * moments after they paid it. The chain's own
 * `lastPeriodicInterestSettledAt` is in the same answer already being read,
 * and it settles the question outright.
 *
 * That last one is the general lesson restated: eligibility is the ACTION's
 * precondition. The action here is "pay THIS period's interest", so the period
 * is part of the precondition, not context around it.
 */
export function periodicInterestEligibility(
  loan: PeriodicLoanState,
  expectedCheckpoint: number,
): PeriodicEligibility {
  if (Number(loan.id) === 0) return 'no-such-loan';
  if (Number(loan.status) !== 0) return 'ended';
  const days = periodicIntervalDays(Number(loan.periodicInterestCadence));
  if (days === 0) return 'no-cadence';
  const onChain = Number(loan.lastPeriodicInterestSettledAt) + days * 86_400;
  // STRICT EQUALITY, not "the chain is not behind". A stored checkpoint AHEAD
  // of the chain's is just as wrong — it would be a reminder about a period
  // that has not begun — so neither direction justifies an unretractable
  // message.
  //
  // But they are REPORTED apart (#2213 r21 `4015014110`). Equally
  // disqualifying is not equally diagnosable: one is index lag that heals
  // itself, the other is a stored row nothing repairs. Collapsing them told
  // an operator to wait for a condition that never resolves.
  if (onChain > expectedCheckpoint) return 'chain-ahead';
  if (onChain < expectedCheckpoint) return 'row-ahead';
  return 'ok';
}
