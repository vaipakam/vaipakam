// apps/keeper/src/rewardReturnTransport/plan.ts
//
// The return-transport pass's pure rules: what to send for one repatriation
// authorization, and how large a chunked return may be. No reads and no sends:
// `index.ts` feeds these with what it read and carries out what they name.

/** A CCIP lane bucket as a lens view reports it (`getRemitLaneBucket`,
 *  `getRemitInboundLaneBucket`). */
export interface LaneBucket {
  readable: boolean;
  limited: boolean;
  tokens: bigint;
  capacity: bigint;
}

// Base's authorization status (`getRepatriationAuthorization`): 0 for an id
// not issued, then pending, and finished as settled or released.
export const AUTH_PENDING = 1;
export const AUTH_SETTLED = 2;
export const AUTH_RELEASED = 3;
// The mirror's instruction state (`getRepatriationInstruction`).
export const INSTR_NONE = 0;
export const INSTR_PENDING = 1;
export const INSTR_EXECUTED = 2;
export const INSTR_TOMBSTONED = 3;

/** What a run read about one Base repatriation authorization. Times are unix
 *  seconds: the last time each re-sendable message left, from the indexer's
 *  ledger or this keeper's own record, whichever is later. */
export interface RepatState {
  authId: bigint;
  dstChainId: number;
  amount: bigint;
  baseStatus: number;
  mirrorState: number;
  instructionSentAt: number | null;
  executedAt: number | null;
  ackSentAt: number | null;
}

export type RepatStep =
  /** Base: dispatch the instruction to the mirror. */
  | { kind: 'dispatch' }
  /** Mirror: execute the recorded instruction (sends the VPFI home). */
  | { kind: 'execute' }
  /** Mirror: send the cancellation ACK for a tombstoned instruction. */
  | { kind: 'ack' }
  /** Nothing to send now. `stalled` when the wait has run past the landing
   *  allowance and an operator should look. */
  | { kind: 'wait'; why: string; stalled: boolean }
  /** Base no longer holds it pending: settled or released. */
  | { kind: 'done' };

/**
 * The step one authorization calls for at `now`.
 *
 * A message the contracts let anyone re-send (the instruction, the ACK) is sent
 * once. It is not re-sent while it is in flight, and it is not re-sent when it
 * runs late either: a CCIP message that fails on its destination stays there,
 * failed and manually re-executable, so a second send would only pay a second
 * fee for a message most likely already queued. A late one is said, and the
 * operator decides.
 */
export function repatStep(s: RepatState, now: number, landingSec: number): RepatStep {
  if (s.baseStatus !== AUTH_PENDING) return { kind: 'done' };
  const late = (at: number) => now - at > landingSec;
  switch (s.mirrorState) {
    case INSTR_NONE:
      if (s.instructionSentAt === null) return { kind: 'dispatch' };
      return late(s.instructionSentAt)
        ? { kind: 'wait', stalled: true, why: `its instruction left Base at ${s.instructionSentAt} and has not been recorded on chain ${s.dstChainId}; a CCIP message that failed there is re-executed by hand` }
        : { kind: 'wait', stalled: false, why: 'its instruction is in flight to the mirror' };
    case INSTR_PENDING:
      return { kind: 'execute' };
    case INSTR_EXECUTED:
      if (s.executedAt !== null && late(s.executedAt)) {
        return { kind: 'wait', stalled: true, why: `chain ${s.dstChainId} executed it at ${s.executedAt}, and Base has not settled the return` };
      }
      return { kind: 'wait', stalled: false, why: 'its return is in flight to Base' };
    case INSTR_TOMBSTONED:
      if (s.ackSentAt === null) return { kind: 'ack' };
      return late(s.ackSentAt)
        ? { kind: 'wait', stalled: true, why: `its cancellation ACK left chain ${s.dstChainId} at ${s.ackSentAt}, and Base has not released the authorization` }
        : { kind: 'wait', stalled: false, why: 'its cancellation ACK is in flight to Base' };
    default:
      return { kind: 'wait', stalled: true, why: `chain ${s.dstChainId} reports instruction state ${s.mirrorState}, which this keeper does not know` };
  }
}

/**
 * Whether a repatriation of `amount` can leave the mirror now, by its outbound
 * lane: null when it can, otherwise why not. The contract refuses an amount
 * above the bucket's capacity (it waits for the operator to cancel or for the
 * lane to be raised, so that is stalled); one above the bucket's tokens waits
 * for refill.
 */
export function executeBlocked(amount: bigint, outbound: LaneBucket | null): { why: string; stalled: boolean } | null {
  if (outbound === null || !outbound.readable) return { why: 'the mirror\'s outbound lane toward Base could not be read', stalled: false };
  if (!outbound.limited) return null;
  if (amount > outbound.capacity) {
    return { why: `its amount ${amount} is above the mirror's outbound lane capacity of ${outbound.capacity}, so it cannot execute until the administrator cancels it or the lane is raised`, stalled: true };
  }
  if (amount > outbound.tokens) return { why: `the mirror's outbound lane holds ${outbound.tokens} of the ${amount} it needs; it refills`, stalled: false };
  return null;
}

export type ChunkPlan = { amount: bigint; note: string | null } | { wait: string };

/**
 * How much of a chunked return (`sendStrandedReturn`, `sendRetiredSurplusReturn`)
 * to send now: all of `remaining`, bounded by the mirror's outbound bucket (its
 * tokens, since the source consumes at send, and its capacity) and by Base's
 * inbound capacity when that end can be read. Base's inbound bucket is bounded
 * by its capacity rather than its tokens: it is drawn when the message executes
 * there, after anything still in flight, so the tokens read now do not describe
 * the bucket the chunk will meet. A chunk below `minPart` that would leave
 * something behind waits instead of spending a CCIP fee on dust; the last chunk
 * is always sent.
 *
 * An unread outbound end sizes nothing. An unread inbound end does not stop the
 * send: the contract bounds a return by the outbound lane alone, under the lane
 * pairing rule (a mirror's outbound toward Base never exceeds Base's inbound
 * from it), and the plan says it went out on that rule.
 */
export function returnChunk(remaining: bigint, outbound: LaneBucket | null, inbound: LaneBucket | null, minPart: bigint): ChunkPlan {
  if (remaining <= 0n) return { wait: 'nothing remains to return' };
  if (outbound === null || !outbound.readable) return { wait: 'the outbound lane toward Base could not be read' };
  let amount = remaining;
  if (outbound.limited) {
    if (outbound.tokens < amount) amount = outbound.tokens;
    if (outbound.capacity < amount) amount = outbound.capacity;
  }
  let note: string | null = null;
  if (inbound !== null && inbound.readable) {
    if (inbound.limited && inbound.capacity < amount) amount = inbound.capacity;
  } else {
    note = 'Base\'s inbound lane could not be read, so the chunk is bounded by the outbound lane alone (the lane pairing rule)';
  }
  if (amount === 0n) return { wait: 'the lane bucket is empty; it refills' };
  if (amount < remaining && amount < minPart) {
    return { wait: `the lanes admit ${amount} of the ${remaining} remaining, below the minimum part of ${minPart}; it waits for the lanes to refill` };
  }
  return { amount, note };
}
