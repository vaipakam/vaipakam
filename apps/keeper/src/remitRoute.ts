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
// The record does not see everything. A receiver replaced behind the SAME
// adapter after a message executed, but before it was acknowledged, holds the
// receipt on a Diamond the keeper no longer reads, and the route still reads
// as current; so does a message waiting on CCIP for manual execution. So a
// Pending reservation is also reported when it has no receipt long after its
// send, whatever its route, with the route given as evidence and the cause
// stated as unknown (Codex #2607 r2).
//
// This module states which case a reservation is in. It decides nothing about
// funds: each case is reported to the operator with its evidence, and the
// terminal (`finalizeRemitReservation` on proven consumption,
// `releaseRemitReservation` when it will never execute, or for a released one
// a late acknowledgement or a recovery record) stays an operator decision. See
// the DeploymentRunbook, "drain the remittances".

import type { Abi, Address, PublicClient } from 'viem';
import { RewardRemittanceLensFacetABI } from '@vaipakam/contracts/abis';
import { extractRevertName, extractRevertSelector } from '@vaipakam/lib/decodeContractError';
import { settledChunkedRead, type BatchResult } from './batchRead';

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
  held: readonly number[],
  deadline: number,
  /** The run, so the cutoff leaves a different tail unread each run (Codex
   *  #2607 r13, `runWindow.ts` rule 2). */
  run = 0,
): Promise<Map<number, RemitRouteVerdict>> {
  const out = new Map<number, RemitRouteVerdict>();
  const res = await settledChunkedRead(
    client as never,
    held,
    ROUTE_READ_CHUNK,
    (id) => ({ address: diamond, abi: LENS_ABI, functionName: 'getRemitRoute' as const, args: [BigInt(id)] as const }),
    'remitAck getRemitRoute',
    deadline,
    run,
  );
  for (const [id, r] of res) out.set(id, remitRouteVerdict(r));
  return out;
}

/** How often a still-open undelivered-remittance alert is posted again. */
export const UNDELIVERED_ALERT_REPEAT_SEC = 24 * 3600;

/**
 * How long after its send a Pending remittance may go without a receipt on the
 * configured mirror before it is reported whatever its route. CCIP's
 * smart-execution window is typically 8 hours; a message still unexecuted past
 * it needs manual execution, and one that executed has its receipt somewhere
 * the keeper does not read (docs.chain.link/ccip/concepts/manual-execution).
 */
export const REMIT_OVERDUE_SEC = 8 * 3600;

/** Which pass found the reservation: Pending, or released (the late path). */
export type RemitPath = 'pending' | 'late';

/** Why a reservation with no receipt on the configured mirror is reported. */
export type UndeliveredReason =
  /** Sent through a remote adapter the lane no longer names. */
  | 'retired'
  /** Pending, past {@link REMIT_OVERDUE_SEC}, on the current or an unrecorded
   *  route: the cause is not known to the keeper. */
  | 'overdue'
  /** Its receipt cannot be read: sent to a chain this keeper has no RPC or
   *  deployment for (Codex #2607 r6), or one whose Diamond answers the
   *  receipt read with an error (Codex #2607 r14). The keeper can neither
   *  read the receipt nor acknowledge it. */
  | 'unobservable';

const REASONS: readonly UndeliveredReason[] = ['retired', 'overdue', 'unobservable'];

/**
 * Whether a reservation the configured mirror holds no receipt for is reported,
 * and why. Pure; pinned by the tests. An unread route decides nothing. A
 * released reservation is reported only for a retired route: having no receipt
 * on its current route is what a release normally means, and the operator who
 * released it already decided on that.
 */
export function undeliveredReason(
  path: RemitPath,
  route: RemitRouteVerdict,
  sentAtSec: bigint | number,
  nowSec: number,
): UndeliveredReason | undefined {
  if (route.kind === 'unread') return undefined;
  if (route.kind === 'retired') return 'retired';
  if (path === 'late') return undefined;
  return nowSec - Number(sentAtSec) >= REMIT_OVERDUE_SEC ? 'overdue' : undefined;
}

/** The alert key for one reservation, path and reason. A reason is part of the
 *  key so that a change of reason alerts at once instead of waiting out the
 *  previous reason's repeat interval. */
export function undeliveredAlertKey(
  path: RemitPath,
  baseChainId: number,
  diamond: Address,
  reason: UndeliveredReason,
  remitId: number,
): string {
  return `remit-undelivered:${path}:${baseChainId}:${diamond.toLowerCase()}:${reason}:${remitId}`;
}

/** The key prefix every undelivered-remittance alert of one path on one
 *  Diamond carries, whatever the reason. A literal prefix, not a `LIKE`
 *  pattern: with the Diamond in it, it is longer than D1 lets a pattern be
 *  (#2677). */
export function undeliveredAlertPrefix(path: RemitPath, baseChainId: number, diamond: Address): string {
  return `remit-undelivered:${path}:${baseChainId}:${diamond.toLowerCase()}:`;
}

/** The reason and remitId a key from {@link undeliveredAlertKey} names, or
 *  undefined for anything else. */
export function parseUndeliveredAlertKey(key: string): { reason: UndeliveredReason; remitId: number } | undefined {
  const parts = key.split(':');
  if (parts.length !== 6 || parts[0] !== 'remit-undelivered') return undefined;
  const reason = parts[4] as UndeliveredReason;
  const remitId = Number(parts[5]);
  if (!REASONS.includes(reason) || !Number.isSafeInteger(remitId) || remitId <= 0) return undefined;
  return { reason, remitId };
}

/** What a released reservation still waits on, as far as Base shows it. */
export type LateOutstanding =
  /** Its recycled share counted as stranded, stamped on Base. */
  | { kind: 'stranded'; wei: bigint }
  /** Its stranded share is not stamped yet, so its size is not known. */
  | { kind: 'unstamped' }
  /** It holds its destination's compensation gate: a fresh-only remittance,
   *  with no recycled share stranded. */
  | { kind: 'gate' }
  /** Its stamped stranded share is zero, and its destination's compensation
   *  gate could not be read this run, so whether it holds it is not known
   *  (Codex #2607 r9): reported as unknown, never as settled. */
  | { kind: 'gate-unread' };

/** One reported reservation, as the alert states it. */
export interface UndeliveredEvidence {
  remitId: number;
  dstChainId: number;
  /** The route verdict: `retired`, `current` or `unrecorded`. Absent only
   *  when the route could not be read this run (an unconfigured destination
   *  is still reported then). */
  route?: Exclude<RemitRouteVerdict, { kind: 'unread' }>;
  /** The keeper has no RPC or deployment for the destination (Codex #2607
   *  r6/r11). */
  unconfigured?: boolean;
  /** The destination answered the receipt read with this error (Codex #2607
   *  r14), so the receipt cannot be read there. */
  receiptError?: string;
  /** Seconds since the send. */
  ageSec: number;
  ccipMessageId: string;
  totalWei: bigint;
  /** Late path only. */
  outstanding?: LateOutstanding;
}

/** The digest heading for `count` reservations of one path and reason. */
export function undeliveredAlertHeader(path: RemitPath, reason: UndeliveredReason, baseChainId: number, count: number): string {
  if (reason === 'unobservable') {
    const which = path === 'late' ? 'released remittance(s) still waiting on a late acknowledgement' : 'remittance(s) still Pending on Base';
    return `[chain ${baseChainId}] ${count} ${which} went to a chain where this keeper cannot read their receipts (each line says why), so it can neither read nor acknowledge them:`;
  }
  if (path === 'late') {
    return `[chain ${baseChainId}] ${count} released remittance(s) still wait on a late acknowledgement, and were sent through a remote adapter the lane no longer names. The keeper reads no receipt for them on any mirror it is configured for:`;
  }
  return reason === 'retired'
    ? `[chain ${baseChainId}] ${count} remittance(s) still Pending on Base were sent through a remote adapter the lane no longer names. The keeper reads no receipt for them on any mirror it is configured for, so it cannot acknowledge them:`
    : `[chain ${baseChainId}] ${count} remittance(s) still Pending on Base have no receipt on the mirror the keeper reads, more than ${REMIT_OVERDUE_SEC / 3600} hours after the send. The keeper does not know why:`;
}

/** The digest footer: what settles each case, and that it is the operator's
 *  decision. */
export function undeliveredAlertFooter(path: RemitPath, reason: UndeliveredReason): string {
  const runbook = 'An operator decision on evidence; see DeploymentRunbook, "drain the remittances".';
  // finalizeRemitReservation is the operator's CONSUMPTION attestation: it
  // stamps the reservation consumed with a zero received figure, books its
  // recycled share and clears a compensation gate (Codex #2607 r6). Execution
  // alone is not that evidence.
  const valves =
    "Only if the destination receipt shows the remittance CONSUMED (not quarantined, not still provisional) may finalizeRemitReservation(remitId) be used: it attests consumption with a zero received figure, books the recycled share and clears any compensation gate. A quarantined or provisional receipt is not that evidence and must not be finalized this way: it is acknowledged from the Diamond that holds it, which Base accepts only from the lane's current peers (the runbook says how to restore one for the purpose). If it never executes, releaseRemitReservation(remitId) (seven days after the send) releases it.";
  if (reason === 'unobservable') {
    return `None of these is known to have been sent through a retired adapter (a route Base holds no record of, or that could not be read this run, says so in its line). For a chain the keeper has no RPC or deployment for, give it both; where the destination answered the receipt read with an error, point the keeper's deployment entry for that chain at the Diamond that holds the receipts. It then reads their receipts there and acknowledges any it finds, and reports the rest by their route. ${runbook}`;
  }
  if (path === 'late') {
    return `A late acknowledgement resolves each, from the mirror Diamond that holds its receipt: the receiver its adapter had registered when the message executed, which the destination transaction shows (find it by CCIP message id). If the message has not executed, no mirror can acknowledge it yet. Recovery records also resolve each: recordRecoveryCeremony books value a governance ceremony brought back to the Diamond, and recordRecoveryTerminalLoss books governance-evidenced loss of the rest; a compensation gate clears once the two cover the remittance's total. ${runbook}`;
  }
  return reason === 'retired'
    ? `Each message executes, if at all, behind the adapter it was sent to. ${valves} ${runbook}`
    : `Check each CCIP message id on the CCIP explorer. If it waits for manual execution, execute it there; the keeper acknowledges it once the receipt appears. If it executed at a receiver since replaced behind the same adapter, that receiver's Diamond holds the receipt and can acknowledge it once its channel is registered again. Otherwise: ${valves} ${runbook}`;
}

const hours = (sec: number) => `${Math.floor(sec / 3600)}h`;

/** One reservation's line in the digest: what is known about it. */
export function undeliveredAlertDetail(e: UndeliveredEvidence): string {
  const routeText =
    e.route === undefined
      ? 'its route could not be read this run'
      : e.route.kind === 'retired'
        ? `sent to adapter ${e.route.sent}, lane now names ${same(e.route.live, ZERO) ? 'no adapter' : e.route.live}`
        : e.route.kind === 'current'
          ? 'sent to the adapter the lane still names'
          : 'Base holds no record of the adapter it was sent to';
  const route = e.unconfigured
    ? `${routeText}; the keeper has no RPC or deployment for chain ${e.dstChainId}, so it cannot read the receipt`
    : e.receiptError !== undefined
      ? `${routeText}; chain ${e.dstChainId}'s Diamond answered the receipt read with an error (${e.receiptError}), so the keeper cannot read the receipt`
      : routeText;
  const o = e.outstanding;
  const outstanding =
    o === undefined
      ? ''
      : o.kind === 'stranded'
        ? `; stranded share ${o.wei} VPFI wei still unresolved`
        : o.kind === 'unstamped'
          ? '; its stranded share is not stamped on Base yet, so its size is not known'
          : o.kind === 'gate-unread'
            ? `; no recycled share stranded, and whether it holds chain ${e.dstChainId}'s compensation gate is not known (the gate could not be read this run)`
            : `; holds chain ${e.dstChainId}'s compensation gate (fresh-only, no recycled share stranded)`;
  return `to chain ${e.dstChainId}; sent ${hours(e.ageSec)} ago; ${route}; CCIP message ${e.ccipMessageId}; total ${e.totalWei} VPFI wei${outstanding}.`;
}
