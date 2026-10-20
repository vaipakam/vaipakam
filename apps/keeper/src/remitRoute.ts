// apps/keeper/src/remitRoute.ts
//
// #2561 — where each reward-budget remittance was actually sent.
//
// Base records, at dispatch, the remote messenger and the reward-budget
// receiver the lane named for the destination (`getRemitRoute`), and reports
// beside it the pair the lane names NOW. The ack pass reads a remittance's
// receipt on the mirror Diamond this keeper is configured with. When a mirror
// is redeployed and the lane re-pointed, a remittance sent before that landed
// at the OLD receiver, so the new Diamond never holds its receipt and the
// reservation would wait for an acknowledgement nobody can send.
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

/** One end of a route: the remote messenger and the receiver behind it. */
export interface RemitRouteLeg {
  messenger: Address;
  recipient: Address;
}

export type RemitRouteVerdict =
  /** Sent where the lane points now: ack it as usual. */
  | { kind: 'current' }
  /** No route on record: sent before #2561, or a Diamond without the getter.
   *  The route is UNKNOWN, not unchanged; the pass acts as it did before. */
  | { kind: 'unrecorded' }
  /** Sent to a destination the lane no longer names. */
  | { kind: 'retired'; sent: RemitRouteLeg; live: RemitRouteLeg }
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
  const [sentMessenger, sentRecipient, liveMessenger, liveRecipient] = r.result as readonly [
    Address,
    Address,
    Address,
    Address,
  ];
  if (same(sentMessenger, ZERO) && same(sentRecipient, ZERO)) return { kind: 'unrecorded' };
  if (same(sentMessenger, liveMessenger) && same(sentRecipient, liveRecipient)) return { kind: 'current' };
  return {
    kind: 'retired',
    sent: { messenger: sentMessenger, recipient: sentRecipient },
    live: { messenger: liveMessenger, recipient: liveRecipient },
  };
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

/** The operator's evidence for one retired-route reservation. States what is
 *  known (where it went, where the lane points, the amount and the message)
 *  and that the keeper will not settle it. */
export function retiredRouteAlertText(a: {
  path: 'pending' | 'late';
  baseChainId: number;
  remitId: number;
  dstChainId: number;
  sent: RemitRouteLeg;
  live: RemitRouteLeg;
  ccipMessageId: string;
  totalWei: bigint;
}): string {
  const what =
    a.path === 'pending'
      ? `Remittance ${a.remitId} is still Pending on Base`
      : `Released remittance ${a.remitId} still counts its recycled share as in transit`;
  const next =
    a.path === 'pending'
      ? `If the message executed at the old receiver, finalizeRemitReservation(${a.remitId}) records it as delivered; if it never will, releaseRemitReservation(${a.remitId}) (seven days after the send) releases it.`
      : `Only a late acknowledgement from the old mirror resolves that share.`;
  return [
    `[chain ${a.baseChainId}] ${what}, and the keeper cannot acknowledge it.`,
    `It was sent to chain ${a.dstChainId} through a destination the lane no longer names, and the mirror the keeper reads holds no receipt for it.`,
    `Sent to: messenger ${a.sent.messenger}, receiver ${a.sent.recipient}.`,
    `Lane now: messenger ${a.live.messenger}, receiver ${a.live.recipient}.`,
    `CCIP message ${a.ccipMessageId}, total ${a.totalWei} VPFI wei.`,
    `${next} This is an operator decision on evidence; see DeploymentRunbook, "drain the remittances".`,
  ].join('\n');
}
