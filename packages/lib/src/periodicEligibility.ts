/**
 * Whether the chain's answer justifies a PERIODIC-INTEREST reminder.
 *
 * Split out of `reminderEligibility` in #2213 r22 (`4015173433`). That module
 * had held two things: this chain-state arithmetic, and the indexer's
 * quarantine table name, schema probe and SQL fragment. They were one module
 * while BOTH reminder lanes shared the quarantine rule — and this PR is what
 * ended that, by moving the periodic lane to asking the chain directly. What
 * was left was a package module coupling an indexer-owned D1 concern to
 * chain-state arithmetic only the agent reads, so either subsystem's changes
 * widened the other's public surface.
 *
 * The quarantine half now lives beside the table it describes, in
 * `apps/indexer/src/loanQuarantine.ts`. Nothing imports both.
 */

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
   * The chain's cadence is not the cadence the stored row was read with.
   *
   * Distinct from `no-cadence`, which is a value this build cannot interpret
   * at all (#2213 r22 `4015173426`). Here both are valid and they DISAGREE,
   * and the derived dates can still coincide — a stored quarterly checkpoint
   * and a chain monthly one whose last settlement is sixty days later land on
   * the same timestamp. The date matching is then not confirmation of
   * anything; the reminder goes out permanently stamped and labelled with a
   * cadence the chain does not have.
   */
  | 'cadence-mismatch'
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
  /**
   * The cadence the CALLER derived `expectedCheckpoint` from, and which its
   * message will be labelled with.
   *
   * Required, not optional (#2213 r22 `4015173426`). The action this
   * eligibility gates is "pay THIS period's interest at THIS cadence", so the
   * cadence is part of the precondition rather than context around it — the
   * same argument the checkpoint itself is here for. Making it optional would
   * let a caller keep the old, coincidence-prone behaviour by forgetting it.
   */
  storedCadence: number,
): PeriodicEligibility {
  if (Number(loan.id) === 0) return 'no-such-loan';
  if (Number(loan.status) !== 0) return 'ended';
  const days = periodicIntervalDays(Number(loan.periodicInterestCadence));
  if (days === 0) return 'no-cadence';
  // BEFORE the date arithmetic, because the dates cannot settle this. Two
  // different cadences produce the same checkpoint whenever the settlement
  // times differ by exactly the gap between them, and the caller then sends a
  // message naming the wrong one.
  if (Number(loan.periodicInterestCadence) !== Number(storedCadence)) {
    return 'cadence-mismatch';
  }
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
