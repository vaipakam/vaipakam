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
  /** `hash` is the transaction that MINED; `submittedHash` the one this flow
   *  sent. They differ only when the wallet repriced it (sped it up: the same
   *  call at a higher fee), which still runs the intended action. */
  | { kind: 'mined'; hash: `0x${string}`; submittedHash: `0x${string}`; blockNumber: bigint; reverted: boolean }
  /** `blockNumber`: the block the measured transaction mined in. */
  | { kind: 'measured'; hash: `0x${string}`; submittedHash: `0x${string}`; blockNumber: bigint; outcome: MeasuredOutcome }
  /** The wallet replaced the submitted transaction with one that does NOT
   *  run the intended action: `cancelled` (the nonce was spent on an empty
   *  self-transfer) or `replaced` (a different call took its place). The
   *  intended effects are not measured, because they cannot have happened
   *  through this flow; both hashes are kept so the page can say so. */
  | { kind: 'superseded'; submittedHash: `0x${string}`; minedHash: `0x${string}`; reason: SupersededReason; blockNumber: bigint }
  /** Submitted, but the receipt could not be read (the node timed out or
   *  went away): the transaction may still execute, so the hash is kept and
   *  shown, tracking can resume, and no new review starts from here. */
  | { kind: 'receipt-unknown'; hash: `0x${string}`; at: number; message: string }
  /** The wallet refused or failed before anything was submitted. */
  | { kind: 'failed'; message: string };

export type SupersededReason = 'cancelled' | 'replaced';

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
  if (legs.length === 0) verdict = 'unknown';
  else if (done === legs.length) verdict = 'done';
  // `partial` is reserved for a batch with at least one CONFIRMED successful
  // leg. With none confirmed, an unknown leg makes the whole outcome unknown:
  // a reverted claim beside one whose read-back failed has substantiated no
  // payout, and saying "partial success" would present one (RB-FUNDS).
  else if (done === 0) verdict = unknown > 0 ? 'unknown' : 'not-done';
  else verdict = 'partial';
  return { verdict, legs, measuredAt };
}

/** What a `partial` verdict is made of, so the summary sentence states only
 *  what the legs substantiate (RB-FUNDS): `failed` when every unconfirmed
 *  leg is known not to have landed, `unknown` when none of them could be
 *  read back, `mixed` when both kinds are present. A done-only or
 *  unconfirmed-only set is not partial and is not asked here.
 */
export type PartialMix = 'failed' | 'unknown' | 'mixed';

export function partialMix(legs: readonly LegOutcome[]): PartialMix {
  const notDone = legs.some((l) => l.status === 'not-done');
  const unknown = legs.some((l) => l.status === 'unknown');
  if (notDone && unknown) return 'mixed';
  return unknown ? 'unknown' : 'failed';
}
