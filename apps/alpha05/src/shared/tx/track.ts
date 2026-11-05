/**
 * The transaction tracker's transitions (rulebook §3.2), as a pure function
 * so the sequence a page may show is one rule: idle → review → signing →
 * submitted → mined → measured, with `failed` reachable from signing only
 * (nothing was submitted) and `receipt-unknown` from submission (the hash
 * exists and is kept; tracking may resume into `mined`). A receipt proves
 * inclusion, not the effect; `mined` is never the last word a page shows,
 * `measured` is (RB-FUNDS). A submitted hash is never dropped from the
 * phase: a page can always show and reconcile it.
 */
import type { MeasuredOutcome, TxPhase } from './outcome';

export type TxEvent =
  | { type: 'review' }
  | { type: 'sign' }
  | { type: 'submitted'; hash: `0x${string}`; at: number }
  | { type: 'mined'; hash: `0x${string}`; blockNumber: bigint; reverted: boolean }
  | { type: 'measured'; hash: `0x${string}`; outcome: MeasuredOutcome }
  | { type: 'receipt-unknown'; hash: `0x${string}`; message: string }
  | { type: 'failed'; message: string }
  | { type: 'reset' };

export class IllegalTransition extends Error {
  constructor(from: TxPhase['kind'], event: TxEvent['type']) {
    super(`tx: cannot apply "${event}" in phase "${from}"`);
    this.name = 'IllegalTransition';
  }
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
      if (event.type === 'mined' && event.hash === phase.hash) return { kind: 'mined', hash: event.hash, blockNumber: event.blockNumber, reverted: event.reverted };
      if (event.type === 'receipt-unknown' && event.hash === phase.hash) return { kind: 'receipt-unknown', hash: event.hash, message: event.message };
      break;
    case 'receipt-unknown':
      // Tracking resumed and found the receipt; the same hash, nothing else.
      if (event.type === 'mined' && event.hash === phase.hash) return { kind: 'mined', hash: event.hash, blockNumber: event.blockNumber, reverted: event.reverted };
      if (event.type === 'receipt-unknown' && event.hash === phase.hash) return { kind: 'receipt-unknown', hash: event.hash, message: event.message };
      break;
    case 'mined':
      if (event.type === 'measured' && event.hash === phase.hash) return { kind: 'measured', hash: event.hash, outcome: event.outcome };
      break;
    case 'measured':
    case 'failed':
      if (event.type === 'review') return { kind: 'review' };
      break;
  }
  throw new IllegalTransition(phase.kind, event.type);
}
