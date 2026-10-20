// apps/keeper/src/remitRoute.ts
//
// #2561 — where each reward-budget remittance was actually sent.
//
// Base records, at dispatch, the remote adapter the remittance's message was
// bound to (`getRemitRoute`), and reports beside it the adapter the lane names
// NOW. Only the adapter is recorded because only the adapter is bound into the
// message: the handler behind it is resolved on the destination when it
// executes. The ack pass reads a remittance's receipt on the mirror Diamond
// this keeper is configured with. When a mirror is redeployed and the lane
// re-pointed, a remittance sent before that executes behind the OLD adapter,
// so the new Diamond never holds its receipt and the reservation would wait
// for an acknowledgement nobody can send.
//
// This module states which case a reservation is in. It decides nothing about
// funds: a retired route is reported to the operator with its evidence, and
// the terminal (`finalizeRemitReservation` on proven delivery,
// `releaseRemitReservation` when it will never execute) stays an operator
// decision. See the DeploymentRunbook, "drain the remittances".

import type { Abi, Address, PublicClient } from 'viem';
import { RewardRemittanceLensFacetABI } from '@vaipakam/contracts/abis';
import { extractRevertName, extractRevertSelector } from '@vaipakam/lib/decodeContractError';
import { boundedRead, type BatchResult } from './batchRead';

const LENS_ABI = RewardRemittanceLensFacetABI as Abi;
/** Route reads per `aggregate3` (#1946). */
const ROUTE_READ_CHUNK = 100;
/** `FunctionDoesNotExist()`: the Diamond's fallback for an unrouted selector. */
const FUNCTION_DOES_NOT_EXIST_SELECTOR = '0xa9ad62f8';
const ZERO = '0x0000000000000000000000000000000000000000';

export type RemitRouteVerdict =
  /** Sent where the lane points now: ack it as usual. */
  | { kind: 'current' }
  /** No route on record: sent before #2561, or a Diamond without the getter.
   *  The route is UNKNOWN, not unchanged; the pass acts as it did before. */
  | { kind: 'unrecorded' }
  /** Bound to a remote adapter the lane no longer names. `live` is zero when
   *  the lane names none now. */
  | { kind: 'retired'; sent: Address; live: Address }
  /** The read failed: nothing is decided about this reservation this run. */
  | { kind: 'unread' };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The verdict for one `getRemitRoute` result. Pure; pinned by the tests. */
export function remitRouteVerdict(r: BatchResult | undefined): RemitRouteVerdict {
  if (!r) return { kind: 'unread' };
  if (r.status !== 'success') {
    const err = r.error;
    const unrouted =
      extractRevertName(err) === 'FunctionDoesNotExist' ||
      extractRevertSelector(err) === FUNCTION_DOES_NOT_EXIST_SELECTOR;
    return unrouted ? { kind: 'unrecorded' } : { kind: 'unread' };
  }
  const [sent, live] = r.result as readonly [Address, Address];
  if (same(sent, ZERO)) return { kind: 'unrecorded' };
  if (same(sent, live)) return { kind: 'current' };
  return { kind: 'retired', sent, live };
}

/** The route verdict for each id, read in bounded batches on Base. */
export async function readRemitRoutes(
  client: PublicClient,
  diamond: Address,
  ids: readonly number[],
  deadline: number,
): Promise<Map<number, RemitRouteVerdict>> {
  const out = new Map<number, RemitRouteVerdict>();
  for (let i = 0; i < ids.length; i += ROUTE_READ_CHUNK) {
    const chunk = ids.slice(i, i + ROUTE_READ_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const res = await boundedRead(
      client as never,
      chunk.map((id) => ({
        address: diamond,
        abi: LENS_ABI,
        functionName: 'getRemitRoute' as const,
        args: [BigInt(id)] as const,
      })),
      `remitAck getRemitRoute ${i}/${ids.length}`,
      deadline,
    );
    chunk.forEach((id, j) => out.set(id, remitRouteVerdict(res[j])));
  }
  return out;
}

/** How often a still-open retired-route alert is posted again. */
export const RETIRED_ROUTE_ALERT_REPEAT_SEC = 24 * 3600;

/** The alert key for one reservation; `path` separates the Pending and the
 *  released (late) cases, which end on different conditions. */
export function retiredRouteAlertKey(path: 'pending' | 'late', baseChainId: number, diamond: Address, remitId: number): string {
  return `remit-route-retired:${path}:${baseChainId}:${diamond.toLowerCase()}:${remitId}`;
}

/** The pattern matching every retired-route alert of one path on one Diamond. */
export function retiredRouteAlertPattern(path: 'pending' | 'late', baseChainId: number, diamond: Address): string {
  return `remit-route-retired:${path}:${baseChainId}:${diamond.toLowerCase()}:%`;
}

/** The remitId a key from {@link retiredRouteAlertKey} names, or undefined. */
export function remitIdOfAlertKey(key: string): number | undefined {
  const id = Number(key.slice(key.lastIndexOf(':') + 1));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** One retired-route reservation, as the alert states it. */
export interface RetiredRouteEvidence {
  remitId: number;
  dstChainId: number;
  sent: Address;
  live: Address;
  ccipMessageId: string;
  totalWei: bigint;
  /** Late path only: the released reservation's stranded share still
   *  unresolved. */
  strandedWei?: bigint;
}

/** The digest heading for `count` retired-route reservations on one path. */
export function retiredRouteAlertHeader(path: 'pending' | 'late', baseChainId: number, count: number): string {
  return path === 'pending'
    ? `[chain ${baseChainId}] ${count} remittance(s) still Pending on Base were sent through a remote adapter the lane no longer names. The mirror the keeper reads holds no receipt for them, so the keeper cannot acknowledge them:`
    : `[chain ${baseChainId}] ${count} released remittance(s) still count a stranded share as in transit, and were sent through a remote adapter the lane no longer names. The mirror the keeper reads holds no receipt for them:`;
}

/** The digest footer: what settles each case, and that it is the operator's
 *  decision. */
export function retiredRouteAlertFooter(path: 'pending' | 'late'): string {
  return path === 'pending'
    ? 'Each message executes, if at all, behind the adapter it was sent to. If it executed there, finalizeRemitReservation(remitId) records it as delivered; if it never will, releaseRemitReservation(remitId) (seven days after the send) releases it. An operator decision on evidence; see DeploymentRunbook, "drain the remittances".'
    : 'A late acknowledgement from the old mirror resolves the stranded share. So does a recovery record: recordRecoveryCeremony books value a governance ceremony brought back to the Diamond, and recordRecoveryTerminalLoss books governance-evidenced loss of the rest. An operator decision on evidence; see DeploymentRunbook, "drain the remittances".';
}

/** One reservation's line in the digest: what is known about it. */
export function retiredRouteAlertDetail(e: RetiredRouteEvidence): string {
  const stranded = e.strandedWei === undefined ? '' : `, stranded share ${e.strandedWei} VPFI wei still unresolved`;
  return `to chain ${e.dstChainId}; sent to adapter ${e.sent}, lane now names ${same(e.live, ZERO) ? 'no adapter' : e.live}; CCIP message ${e.ccipMessageId}; total ${e.totalWei} VPFI wei${stranded}.`;
}
