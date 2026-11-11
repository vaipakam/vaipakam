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

// ─── The closed-day remainder return (#3360 part B) ────────────────────────

/**
 * What a run read about one transport batch on a mirror, and the budget packet
 * that opened it. A batch funds one reward day; once that day is proven closed
 * every obligation it could pay has terminated, and what the batch still holds
 * is the remainder this step sends home.
 */
export interface RemainderState {
  /** Whether a batch exists under the id (`getTransportBatch`). */
  exists: boolean;
  /** Untyped value the batch still holds, while its remainder is not parked. */
  balance: bigint;
  /** Whether its remainder is parked, and what the parked remainder holds. */
  parked: boolean;
  parkedAmount: bigint;
  /** The administrator's acknowledgment: it releases the remainder for
   *  classification on this chain, which is the operator's disposition. */
  acknowledged: boolean;
  /** Whether the batch's one day is proven closed. */
  dayClosed: boolean;
  /** Staging records referencing the batch; a referenced batch cannot be
   *  parked, so its remainder cannot leave until they settle. */
  references: bigint;
  /** What the packet still holds untyped (`IngressPacket.unclassified`): a
   *  return is bounded by it as well as by the remainder. */
  unclassified: bigint;
  /** Whether the packet's receipt has a live stranded-recovery record, which
   *  the contract refuses a return beside (`UntypedReturnPacketReserved`). */
  reserved: boolean;
}

export type RemainderStep =
  /** Nothing more for the keeper: `absent` (no batch under the id),
   *  `operator` (acknowledged, so the operator disposes of it), or `empty`
   *  (its day is closed and nothing is left). */
  | { kind: 'done'; why: 'absent' | 'operator' | 'empty' }
  /** Its day is not proven closed yet. */
  | { kind: 'open' }
  /** It cannot leave now; it may later, with no operator step. */
  | { kind: 'wait'; why: string }
  /** It cannot leave until an operator looks. */
  | { kind: 'stall'; why: string }
  /** Return up to `amount` (the lanes size the part sent). */
  | { kind: 'return'; amount: bigint };

/**
 * The step one batch calls for. The order follows the contract
 * (`RepatriationFacet.returnClosedDayRemainder`): the day must be proven
 * closed, an unparked batch is parked in the same call (refused while a
 * staging record references it), a packet whose receipt is reserved by a
 * stranded recovery is refused, and the amount is bounded by both the
 * remainder and the packet's untyped figure.
 */
export function remainderStep(s: RemainderState): RemainderStep {
  if (!s.exists) return { kind: 'done', why: 'absent' };
  if (s.acknowledged) return { kind: 'done', why: 'operator' };
  if (!s.dayClosed) return { kind: 'open' };
  const remaining = s.parked ? s.parkedAmount : s.balance;
  if (remaining === 0n) return { kind: 'done', why: 'empty' };
  if (!s.parked && s.references !== 0n) {
    return { kind: 'wait', why: `${s.references} staging record(s) reference it, so it cannot be parked until they settle` };
  }
  if (s.reserved) {
    return { kind: 'wait', why: 'its packet\'s receipt holds a live stranded-recovery record, which the stranded return empties first' };
  }
  if (s.unclassified === 0n) {
    return { kind: 'stall', why: `it holds ${remaining} but its packet holds nothing untyped, so no return can be bounded by both; the custody ledger needs an operator's look` };
  }
  return { kind: 'return', amount: remaining < s.unclassified ? remaining : s.unclassified };
}

/** Whether the keeper is finished with a batch for good, so its ledger row may
 *  fall below the rotation's floor (read at the finalized block too). */
export const remainderFinished = (s: RemainderState): boolean => remainderStep(s).kind === 'done';
