// apps/keeper/src/remitDayStatus.ts
//
// #2760 — why a finalized day was neither remitted nor closed.
//
// `quoteRemitDayPlans` reads a day as zero and not actionable for many reasons:
// already settled, nothing owed to this mirror, or still owed but gated. The
// remit pass used to warn about every such day that was not closed, which on a
// quiet mirror is every day that owed it nothing, every tick. Base now reports
// the send's own verdict per day (`quoteRemitDayStatuses`), from the same plan
// the send applies, so the pass can name the days that are actually owed and
// say why. A Diamond without the view is told apart from a failed read: only
// the Diamond answering that it routes no such function counts as an older
// build, and the pass then keeps its earlier probe and warning.

import type { Abi, Address, PublicClient } from 'viem';
import { RewardRemittanceFacetABI } from '@vaipakam/contracts/abis';
import { extractRevertName, extractRevertSelector } from '@vaipakam/lib/decodeContractError';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
/** `FunctionDoesNotExist()`: the Diamond's fallback for an unrouted selector. */
const FUNCTION_DOES_NOT_EXIST_SELECTOR = '0xa9ad62f8';

/** `LibRemitDayLedger.RemitDayStatus`, in declaration order (the ABI carries
 *  the enum as a `uint8`). `remitDayStatus.test.ts` pins this list to the
 *  contract's own declaration. `Partial` (#918): the day acts, but the part
 *  this cap allows leaves it still owing the rest. */
export const REMIT_DAY_STATUSES = [
  'NotFinalized',
  'Repeated',
  'Remitted',
  'Closed',
  'NothingOwed',
  'Ineligible',
  'AwaitingCommitment',
  'Unbacked',
  'Closeable',
  'Partial',
] as const;
export type RemitDayStatus = (typeof REMIT_DAY_STATUSES)[number];

/** What each owed-but-not-closeable status means for the operator. */
const OWED_REASON: Partial<Record<RemitDayStatus, string>> = {
  AwaitingCommitment: 'awaiting its commitment report',
  Unbacked: 'recycled backing short',
  Ineligible: 'remit-ineligible, funded by the manual-budget path',
};

export type RemitStatusRead =
  | { kind: 'read'; statuses: RemitDayStatus[] }
  /** The Diamond answered that it routes no such view: an older build. */
  | { kind: 'unrouted' }
  /** The read failed for another reason: nothing is decided from it. */
  | { kind: 'unread'; error: string };

/** The status name for one returned value, or `undefined` for a value this
 *  build does not know (a newer contract). */
export function remitDayStatusName(v: unknown): RemitDayStatus | undefined {
  const n = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) ? REMIT_DAY_STATUSES[n] : undefined;
}

/** A failed read's verdict: unrouted only on the Diamond's own answer. */
export function remitStatusReadFailure(err: unknown): RemitStatusRead {
  const unrouted =
    extractRevertName(err) === 'FunctionDoesNotExist' ||
    extractRevertSelector(err) === FUNCTION_DOES_NOT_EXIST_SELECTOR;
  return unrouted ? { kind: 'unrouted' } : { kind: 'unread', error: summarizeFailure(err) };
}

/** The send's own verdict for each of `days`, aligned to the list. */
export async function readRemitDayStatuses(
  client: PublicClient,
  diamond: Address,
  mirrorId: number,
  days: readonly bigint[],
  /** #918 — the part cap the plan was quoted under; the statuses are that
   *  plan's own (a day is `Partial` or `Closeable` only relative to a cap). */
  partCap: bigint,
  /** The block the batch was planned at, so the status is that plan's own
   *  verdict; omitted, the latest head. */
  blockNumber?: bigint,
): Promise<RemitStatusRead> {
  let raw: readonly unknown[];
  try {
    raw = (await client.readContract({
      address: diamond,
      abi: REMIT_ABI,
      functionName: 'quoteRemitDayStatuses',
      args: [mirrorId, days, partCap],
      blockNumber,
    })) as readonly unknown[];
  } catch (err) {
    return remitStatusReadFailure(err);
  }
  const statuses: RemitDayStatus[] = [];
  for (const v of raw) {
    const name = remitDayStatusName(v);
    // A value this build cannot name is not guessed at.
    if (name === undefined) return { kind: 'unread', error: `unknown remit day status ${String(v)}` };
    statuses.push(name);
  }
  if (statuses.length !== days.length) {
    return { kind: 'unread', error: `remit day statuses misaligned (${statuses.length} for ${days.length} days)` };
  }
  return { kind: 'read', statuses };
}

/** The days still owed that this tick cannot close, each with its reason.
 *  Pure; settled days, days owing nothing and closeable days are not here. */
export function owedButBlocked(
  days: readonly bigint[],
  statuses: readonly RemitDayStatus[],
): { day: bigint; status: RemitDayStatus; reason: string }[] {
  const out: { day: bigint; status: RemitDayStatus; reason: string }[] = [];
  days.forEach((day, i) => {
    const status = statuses[i];
    const reason = status === undefined ? undefined : OWED_REASON[status];
    if (status !== undefined && reason !== undefined) out.push({ day, status, reason });
  });
  return out;
}
