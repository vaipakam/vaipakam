/**
 * The transaction tracker's transitions (rulebook §3.2), as a pure function
 * so the sequence a page may show is one rule: idle → review → signing →
 * submitted → mined → measured, with `failed` reachable from signing only
 * (nothing was submitted), `receipt-unknown` from submission (the hash
 * exists and is kept; `resume` puts it back in `submitted`, in flight
 * again, BEFORE any wait starts, so no reset or second resume can race
 * the receipt), and `superseded`
 * from submission when the wallet cancelled or replaced the transaction
 * (the intended action never ran, so there is nothing of it to measure). A
 * mined receipt may carry another hash than the one submitted only when the
 * wallet REPRICED it (the same call at a higher fee). A receipt proves
 * inclusion, not the effect; `mined` is never the last word a page shows,
 * `measured` is (RB-FUNDS). A submitted hash is never dropped from the
 * phase: a page can always show and reconcile it.
 */
import type { LegOutcome, MeasuredOutcome, SupersededReason, TxPhase } from './outcome';

export type TxEvent =
  | { type: 'review' }
  | { type: 'sign' }
  | { type: 'submitted'; hash: `0x${string}`; at: number }
  /** `submittedHash` names the transaction this flow sent; `hash` the one
   *  that mined. They may differ only with `repriced`. */
  | { type: 'mined'; submittedHash: `0x${string}`; hash: `0x${string}`; repriced: boolean; blockNumber: bigint; reverted: boolean }
  | { type: 'superseded'; submittedHash: `0x${string}`; minedHash: `0x${string}`; reason: SupersededReason; blockNumber: bigint; unwound?: readonly LegOutcome[] }
  | { type: 'measured'; hash: `0x${string}`; outcome: MeasuredOutcome }
  | { type: 'receipt-unknown'; hash: `0x${string}`; message: string }
  /** Track a `receipt-unknown` hash again: back to `submitted`, in flight. */
  | { type: 'resume'; hash: `0x${string}` }
  | { type: 'failed'; message: string }
  | { type: 'reset' };

export class IllegalTransition extends Error {
  constructor(from: TxPhase['kind'], event: TxEvent['type']) {
    super(`tx: cannot apply "${event}" in phase "${from}"`);
    this.name = 'IllegalTransition';
  }
}

/** A `mined` event is accepted for the submitted hash, or for another hash
 *  only when the wallet repriced it (the same call): a different mined
 *  transaction that is NOT a reprice is a supersession, never a success. */
function minedFrom(submitted: `0x${string}`, event: TxEvent): TxPhase | null {
  if (event.type !== 'mined' || event.submittedHash !== submitted) return null;
  if (event.hash !== submitted && !event.repriced) return null;
  return { kind: 'mined', hash: event.hash, submittedHash: submitted, blockNumber: event.blockNumber, reverted: event.reverted };
}

export function transition(phase: TxPhase, event: TxEvent): TxPhase {
  if (event.type === 'reset') {
    // A flow in flight cannot be reset: the wallet may still be asked, and
    // a submitted hash is never forgotten while it is being tracked.
    // Measured, failed, idle and receipt-unknown may (the last only by the
    // reader's own act, with the hash on screen to reconcile).
    if (phase.kind === 'signing' || phase.kind === 'submitted' || phase.kind === 'mined') throw new IllegalTransition(phase.kind, event.type);
    return { kind: 'idle' };
  }
  switch (phase.kind) {
    case 'idle':
      if (event.type === 'review') return { kind: 'review' };
      break;
    case 'review':
      if (event.type === 'sign') return { kind: 'signing' };
      break;
    case 'signing':
      if (event.type === 'submitted') return { kind: 'submitted', hash: event.hash, at: event.at };
      if (event.type === 'failed') return { kind: 'failed', message: event.message };
      break;
    case 'submitted':
    case 'receipt-unknown': {
      // The receipt (first try, or a resumed one) for THIS flow's hash.
      const mined = minedFrom(phase.hash, event);
      if (mined) return mined;
      if (event.type === 'superseded' && event.submittedHash === phase.hash && event.minedHash !== phase.hash) {
        return {
          kind: 'superseded',
          submittedHash: event.submittedHash,
          minedHash: event.minedHash,
          reason: event.reason,
          blockNumber: event.blockNumber,
          unwound: event.unwound ?? [],
        };
      }
      if (event.type === 'receipt-unknown' && event.hash === phase.hash) return { kind: 'receipt-unknown', hash: event.hash, at: phase.at, message: event.message };
      if (event.type === 'resume' && phase.kind === 'receipt-unknown' && event.hash === phase.hash) return { kind: 'submitted', hash: phase.hash, at: phase.at };
      break;
    }
    case 'mined':
      if (event.type === 'measured' && event.hash === phase.hash) return { kind: 'measured', hash: event.hash, submittedHash: phase.submittedHash, blockNumber: phase.blockNumber, outcome: event.outcome };
      break;
    case 'measured':
    case 'failed':
    case 'superseded':
      if (event.type === 'review') return { kind: 'review' };
      break;
  }
  throw new IllegalTransition(phase.kind, event.type);
}
