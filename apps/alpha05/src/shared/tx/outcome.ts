/**
 * Transaction tracking (rulebook §3.2): submitted, mined, MEASURED outcome,
 * partial success. A receipt proves inclusion, not the effect: the outcome
 * is read back from the chain (the position's new state, the balance that
 * moved) and a batch may land some legs and not others. A page therefore
 * renders three values, never a boolean, and never a figure the read-back
 * did not substantiate (RB-FUNDS).
 */

export type TxPhase =
  | { kind: 'idle' }
  | { kind: 'review' }
  | { kind: 'signing' }
  | { kind: 'submitted'; hash: `0x${string}`; at: number }
  | { kind: 'mined'; hash: `0x${string}`; blockNumber: bigint; reverted: boolean }
  | { kind: 'measured'; hash: `0x${string}`; outcome: MeasuredOutcome }
  | { kind: 'failed'; stage: 'signing' | 'submission'; message: string };

export type LegOutcome =
  | { status: 'done'; label: string }
  | { status: 'not-done'; label: string; reason: string }
  | { status: 'unknown'; label: string; reason: string };

export interface MeasuredOutcome {
  /** `partial` when at least one leg is done and at least one is not. */
  verdict: 'done' | 'partial' | 'not-done' | 'unknown';
  legs: readonly LegOutcome[];
  /** When the read-back that produced this verdict completed. */
  measuredAt: number;
}

export function summarize(legs: readonly LegOutcome[], measuredAt: number): MeasuredOutcome {
  const done = legs.filter((l) => l.status === 'done').length;
  const unknown = legs.filter((l) => l.status === 'unknown').length;
  let verdict: MeasuredOutcome['verdict'];
  if (legs.length === 0 || unknown === legs.length) verdict = 'unknown';
  else if (done === legs.length) verdict = 'done';
  else if (done === 0 && unknown === 0) verdict = 'not-done';
  else verdict = 'partial';
  return { verdict, legs, measuredAt };
}
