// apps/keeper/src/remitAck.ts
//
// #1222 M3 B2-d2 — delivered-backing remit-ACK automation (P7).
//
// Base reserves every reward-budget remittance into a `RemitReservation`
// (Pending) and finalizes it only on the mirror's authenticated ack
// (`RewardRemittanceFacet.sendRemitAck`, mirror-side, permissionless +
// re-sendable). Nothing sends that ack by itself — this pass drives it:
//
//   1. On Base: reservations are DENSE (remitId 1..getRemitReservationNonce),
//      so the pass scans from a D1-persisted frontier (all ids below it are
//      terminal) — no event scanning, no unbounded re-reads.
//   2. For each Pending reservation, it checks the destination mirror's
//      receipt record (`getReceivedRemit`) — present means the CCIP delivery
//      landed and the ack is sendable.
//   3. It quotes + sends the ack FROM the mirror (the keeper EOA pays the
//      CCIP fee), with a D1-backed attempt backoff: an ack takes minutes to
//      deliver, so re-sending every tick would burn fees. The mirror send is
//      content-free for the caller (the Diamond echoes its own receipt), and
//      Base finalizes idempotently — a duplicate ack is harmless.
//
// A reservation whose delivery has NOT landed (no receipt) is left Pending —
// the recovery for a stuck CCIP message is re-execution (operator), then the
// receipt appears and this pass acks it. Operator terminals
// (finalize/release valves) are deliberately manual and NOT driven here.
//
// #2561 — one case no wait resolves: a remittance sent before its mirror was
// redeployed landed at the OLD receiver, so the mirror this keeper reads never
// holds its receipt. When the receipt is missing, the pass reads the route Base
// recorded at dispatch (`remitRoute.ts`); if the lane no longer names it, the
// operator is alerted with the evidence instead of the reservation waiting in
// silence. Acknowledging itself is unchanged: a receipt on the configured
// mirror proves the delivery reached it, whatever the route.
//
// Gated by KEEPER_ENABLED + REWARD_REMIT_ENABLED (the ack completes remits —
// same arming as the remit pass itself).

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardReporterFacetABI,
  RewardRemittanceLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { batchedRead, boundedRead, deadlineClient } from './batchRead';
import type { PassTick } from './passSchedule';
import {
  discoverReleasedRemits,
  finishWork,
  listOpenWork,
  touchOpenWork,
  deploymentFloor,
  getRemitAckScanState,
  putRemitAckScanState,
  getRemitAckAttempts,
  recordRemitAckAttempt,
  markRemitAcked,
  listOpsAlertKeys,
} from './db';
import { discoverWork } from './workQueue';
import { reportSendError } from './submissionQueue';
import { resolveOpsAlert, sendOpsAlertDigest, type OpsAlertEntry } from './opsAlert';
import {
  readRemitRoutes,
  remitIdOfAlertKey,
  RETIRED_ROUTE_ALERT_REPEAT_SEC,
  retiredRouteAlertDetail,
  retiredRouteAlertFooter,
  retiredRouteAlertHeader,
  retiredRouteAlertKey,
  retiredRouteAlertPattern,
} from './remitRoute';

// #1660 r9 - quoteRemitAckFee moved to the LENS facet for EIP-170
// headroom on the mutating facet; viem resolves functions from the
// SUPPLIED ABI before any RPC, so the keeper's remit surface must
// combine both facets' ABIs (the Diamond routes either selector).
const REMIT_ABI = [
  ...(RewardRemittanceFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
] as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;

/** Max reservation ids examined per tick (scan stays O(bounded)). */
const MAX_SCAN_PER_TICK = 200;
/** Reservations per `aggregate3`. Matches the other passes' bound (#1946). */
const SCAN_CHUNK = 100;
/** Max ack sends per tick (each is a CCIP fee spend). */
const MAX_ACKS_PER_TICK = 5;
/** Min seconds between ack attempts for one reservation (CCIP delivery
 *  takes minutes; Base finalizes idempotently so overlap is safe, just
 *  wasteful). */
const ACK_RETRY_BACKOFF_SEC = 15 * 60;

interface RemitReservationView {
  dstChainId: number;
  status: number;
  /** #1461 — the share a release counted as stranded and not yet resolved. */
  strandedRecycled?: bigint;
  /** #1461 — the acknowledgement stamps; a late ack resolves only while neither is set. */
  consumedAcked?: boolean;
  quarantineAcked?: boolean;
  /** #2497 r1 — whether the stranded share above has been STAMPED; until it
   *  is, `strandedRecycled` is a default 0, not a resolved share. */
  strandedStamped?: boolean;
  sentAt: bigint;
  ccipMessageId: `0x${string}`;
  total: bigint;
  fresh: bigint;
  recycled: bigint;
  armedFreshFull: bigint;
  recycledFull: bigint;
  dayIds: readonly bigint[];
}

export async function runRemitAck(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'remitAck', 'REWARD_REMIT_ENABLED')) return;
  // The run's deadline (#2497 re-cut review): every read through this run's
  // clients is refused past it, and no send starts after it.
  const deadline = tick.deadlineMs;

  // Chains side by side (#2572 r5, `runWindow.ts` rule 1).
  await Promise.all(
    getChainConfigs(env).map(async (chain) => {
      try {
        await ackFromBaseLedger(env, chain, deadline);
      } catch (err) {
        console.error(`[keeper] remitAck chain=${chain.id} failed:`, err);
      }
    }),
  );
}

async function ackFromBaseLedger(env: Env, chain: ChainConfig, deadline: number): Promise<void> {
  const publicClient = deadlineClient(createPublicClient({ transport: http(chain.rpc) }), deadline);
  const diamond = chain.diamond as Address;

  // The reservation ledger lives on Base only.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const baseChainId = Number(cfg[1]);
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  const nonce = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'getRemitReservationNonce',
  })) as bigint;
  if (nonce === 0n) return;

  const { frontier, scanCursor } = await getRemitAckScanState(env.KEEPER_DB, baseChainId, diamond);
  // Mirror clients are built lazily, once per destination chain.
  const mirrorConfigs = new Map<number, ChainConfig>();
  for (const c of getChainConfigs(env)) mirrorConfigs.set(c.id, c);
  const mirrorClients = new Map<number, PublicClient>();
  // ONE send budget for the whole tick (#2497 r2): the late-ack path and the
  // Pending path draw on the same MAX_ACKS_PER_TICK, so a tick never sends
  // more than the cap however its work splits between them.
  const ackBudget = { remaining: MAX_ACKS_PER_TICK, deadline };
  if (BigInt(frontier) > nonce) {
    // Caught up — the steady state. A released reservation may still see its
    // delivery land late, so that step runs here too (#1461).
    await ackLateDeliveriesContained(env, publicClient as never, baseChainId, diamond, mirrorConfigs, mirrorClients, ackBudget);
    await resolveRetiredPendingAlerts(env, publicClient as never, baseChainId, diamond, deadline);
    return;
  }
  // Rotating window (Codex #1426 r1): start from the persisted cursor when
  // it is ahead of the frontier — a stuck early Pending pins the frontier,
  // and without the rotation the bounded window would re-read that range
  // every tick while later reservations went undiscovered. Wrap back to the
  // frontier once the cursor passes the ledger tip.
  let from = BigInt(Math.max(frontier, scanCursor));
  if (from > nonce) from = BigInt(frontier);
  const to = from + BigInt(MAX_SCAN_PER_TICK) < nonce + 1n
    ? from + BigInt(MAX_SCAN_PER_TICK)
    : nonce + 1n;

  const pendingIds: number[] = [];
  const reservations = new Map<number, RemitReservationView>();
  let contiguousTerminal = frontier;
  // The terminal-prefix frontier may only advance when this window actually
  // starts AT the frontier (a rotated window proves nothing about the ids
  // it skipped).
  let prefixUnbroken = from === BigInt(frontier);

  // BATCHED (#1896). This was one `getRemitReservation` per id in the window —
  // up to MAX_SCAN_PER_TICK subrequests per tick against a 50-per-invocation
  // ceiling, and the per-selector attribution measured 200 of them on a pass
  // whose transaction work is 8% of its traffic. The window, its bounds and the
  // order of processing are unchanged; only the round-trips collapse.
  const windowIds: bigint[] = [];
  for (let id = from; id < to; id++) windowIds.push(id);
  const scanResults: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (let i = 0; i < windowIds.length; i += SCAN_CHUNK) {
    const chunk = windowIds.slice(i, i + SCAN_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const part = await batchedRead(
      publicClient as never,
      chunk.map((id) => ({
        address: diamond,
        abi: REMIT_ABI,
        functionName: 'getRemitReservation' as const,
        args: [id] as const,
      })),
      `remitAck getRemitReservation ${i}/${windowIds.length}`,
    );
    scanResults.push(...part);
  }

  for (let idx = 0; idx < windowIds.length; idx++) {
    const id = windowIds[idx];
    const res = scanResults[idx];
    if (!res || res.status !== 'success') {
      // A read failure ABORTS the scan, which is what the sequential version
      // did: the throw unwound to the per-chain catch, so `putRemitAckScanState`
      // never ran and neither the frontier nor the cursor advanced past an id
      // whose status is unknown. Advancing either on an unread reservation is
      // the one outcome worth avoiding here, so the failure is preserved rather
      // than turned into a per-id skip. Ids already processed above keep their
      // (idempotent) acked marks, exactly as before.
      console.warn(
        `[keeper] remitAck scan aborted at remit=${id}: ${String(
          res?.error ?? 'no result',
        ).slice(0, 200)}`,
      );
      return;
    }
    const r = res.result as RemitReservationView;
    if (r.status === 2 || r.status === 3) {
      if (r.status === 2) await markRemitAcked(env.KEEPER_DB, baseChainId, diamond, Number(id));
      if (prefixUnbroken) contiguousTerminal = Number(id) + 1;
      continue;
    }
    prefixUnbroken = false;
    if (r.status === 1) {
      pendingIds.push(Number(id));
      reservations.set(Number(id), r);
    }
    // status 0 past the frontier can only be the tail beyond the nonce —
    // the loop bound already excludes it.
  }
  await putRemitAckScanState(env.KEEPER_DB, baseChainId, diamond, contiguousTerminal, Number(to));
  // PENDING FIRST, late after (#2497 r13): the Pending acks are the ordinary
  // work — a reservation stays reserved on Base until acked — and the late path
  // is a backlog that can be large, so it gets only what the Pending acks left
  // of the tick's one budget, never the other way round.
  await ackPending(env, publicClient as never, baseChainId, diamond, pendingIds, reservations, mirrorConfigs, mirrorClients, ackBudget);
  await ackLateDeliveriesContained(env, publicClient as never, baseChainId, diamond, mirrorConfigs, mirrorClients, ackBudget);
  await resolveRetiredPendingAlerts(env, publicClient as never, baseChainId, diamond, deadline);
}

/** The rotation order for acknowledgements: never attempted first, then the
 *  least recently attempted, then by id. Pure; pinned by the tests. */
export function ackOrder(ids: readonly number[], attempts: ReadonlyMap<number, { lastAttemptAt: number }>): number[] {
  return [...ids].sort((a, b) => (attempts.get(a)?.lastAttemptAt ?? 0) - (attempts.get(b)?.lastAttemptAt ?? 0) || a - b);
}

async function ackPending(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  pendingIds: readonly number[],
  reservations: ReadonlyMap<number, RemitReservationView>,
  mirrorConfigs: Map<number, ChainConfig>,
  mirrorClients: Map<number, PublicClient>,
  ackBudget: { remaining: number; deadline: number },
): Promise<void> {
  if (pendingIds.length === 0) return;
  const attempts = await getRemitAckAttempts(env.KEEPER_DB, baseChainId, diamond, [...pendingIds]);
  const now = Math.floor(Date.now() / 1000);
  // Least recently attempted first, never-attempted first of all (#2497 r16):
  // the same rotation rule as the open-work queues. Ascending id order let the
  // first ids re-take the budget every backoff window while later ones waited
  // indefinitely.
  // Reservations whose receipt the configured mirror does not hold (#2561).
  const noReceipt: { remitId: number; v: RemitReservationView }[] = [];
  for (const remitId of ackOrder(pendingIds, attempts)) {
    if (ackBudget.remaining <= 0 || Date.now() >= ackBudget.deadline) break;
    const r = reservations.get(remitId);
    if (!r) continue;
    const prior = attempts.get(remitId);
    if (prior && now - prior.lastAttemptAt < ACK_RETRY_BACKOFF_SEC) continue;

    const mirrorCfg = mirrorFor(mirrorConfigs, r.dstChainId, remitId);
    if (!mirrorCfg) continue;
    try {
      const outcome = await sendAckFromMirror(env, mirrorCfg, mirrorClients, remitId, diamond, ackBudget);
      if (outcome === 'sent') await recordAttemptBestEffort(env, baseChainId, diamond, remitId, r.dstChainId);
      else if (outcome === 'no-receipt') noReceipt.push({ remitId, v: r });
    } catch (err) {
      reportSendError(`[keeper] remitAck remit=${remitId} dst=${r.dstChainId}`, err, `skipped: ${(err as Error).message}`, console.log);
    }
  }
  await alertRetiredRoutes(env, publicClient, 'pending', baseChainId, diamond, noReceipt, ackBudget.deadline);
}

/**
 * #2561 — of reservations whose receipt the configured mirror does not hold,
 * report to the operator the ones Base recorded as bound to a remote adapter
 * the lane no longer names. No receipt with a current or unrecorded route is
 * the ordinary wait for a delivery in flight, and stays silent.
 *
 * One digest post per run however many are due (each keeps its own key, so
 * each re-posts daily and clears on its own), so a redeploy that strands many
 * remittances costs one bounded post, not one per reservation. A reservation
 * whose recorded adapter is the lane's again (an operator restored the old
 * peer to hand-ack it) has its alert cleared, so a later retirement alerts at
 * once. Contained: a failure here is logged and never unwinds the pass.
 */
async function alertRetiredRoutes(
  env: Env,
  publicClient: PublicClient,
  path: 'pending' | 'late',
  baseChainId: number,
  diamond: Address,
  items: readonly { remitId: number; v: RemitReservationView }[],
  deadline: number,
): Promise<void> {
  if (items.length === 0 || Date.now() >= deadline) return;
  try {
    const routes = await readRemitRoutes(publicClient, diamond, items.map((i) => i.remitId), deadline);
    const entries: OpsAlertEntry[] = [];
    const nowCurrent: string[] = [];
    for (const { remitId, v } of items) {
      const route = routes.get(remitId);
      const key = retiredRouteAlertKey(path, baseChainId, diamond, remitId);
      if (route?.kind === 'current') nowCurrent.push(key);
      if (route?.kind !== 'retired') continue;
      const detail = retiredRouteAlertDetail({
        remitId,
        dstChainId: Number(v.dstChainId),
        sent: route.sent,
        live: route.live,
        ccipMessageId: v.ccipMessageId,
        totalWei: BigInt(v.total),
        strandedWei: path === 'late' ? BigInt(v.strandedRecycled ?? 0n) : undefined,
      });
      console.warn(`[keeper] remitAck${path === 'late' ? ' late' : ''} remit=${remitId}: retired route — ${detail} Not acknowledgeable by this keeper; operator alerted.`);
      entries.push({ key, id: `remit ${remitId}`, detail });
    }
    if (nowCurrent.length > 0) {
      const open = new Set(await listOpsAlertKeys(env.KEEPER_DB, retiredRouteAlertPattern(path, baseChainId, diamond)));
      for (const key of nowCurrent) {
        // eslint-disable-next-line no-await-in-loop
        if (open.has(key)) await resolveOpsAlert(env, key);
      }
    }
    if (entries.length === 0 || Date.now() >= deadline) return;
    await sendOpsAlertDigest(
      env,
      (count) => retiredRouteAlertHeader(path, baseChainId, count),
      entries,
      retiredRouteAlertFooter(path),
      RETIRED_ROUTE_ALERT_REPEAT_SEC,
      Math.floor(Date.now() / 1000),
      baseChainId,
    );
  } catch (err) {
    console.error(`[keeper] remitAck${path === 'late' ? ' late' : ''} retired-route check failed this run: ${(err as Error).message}`);
  }
}

/**
 * #2561 — clear the Pending-path retired-route alerts whose reservation is no
 * longer Pending (acknowledged, finalized or released by the operator). Reads
 * only the reservations that hold an open alert, which are few. An unread
 * reservation keeps its alert. Contained like {@link alertRetiredRoutes}.
 */
async function resolveRetiredPendingAlerts(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  deadline: number,
): Promise<void> {
  if (Date.now() >= deadline) return;
  try {
    const keys = await listOpsAlertKeys(env.KEEPER_DB, retiredRouteAlertPattern('pending', baseChainId, diamond));
    const open = keys.flatMap((key) => {
      const remitId = remitIdOfAlertKey(key);
      return remitId === undefined ? [] : [{ key, remitId }];
    });
    if (open.length === 0) return;
    const res = await boundedRead(
      publicClient as never,
      open.map((o) => ({
        address: diamond,
        abi: REMIT_ABI,
        functionName: 'getRemitReservation' as const,
        args: [BigInt(o.remitId)] as const,
      })),
      'remitAck retired-route alerts',
      deadline,
    );
    for (let i = 0; i < open.length; i++) {
      const r = res[i];
      if (r?.status !== 'success') continue;
      // eslint-disable-next-line no-await-in-loop
      if ((r.result as RemitReservationView).status !== 1) await resolveOpsAlert(env, open[i].key);
    }
  } catch (err) {
    console.error(`[keeper] remitAck retired-route alerts not cleared this run: ${(err as Error).message}`);
  }
}

/** Send one ack from the mirror. `'no-receipt'` when the mirror holds no
 *  receipt for the remittance (nothing to ack there); `'declined'` when it does
 *  but no ack is sent (a provisional late receipt, no signer, no budget). */
async function sendAckFromMirror(
  env: Env,
  mirrorCfg: ChainConfig,
  clients: Map<number, PublicClient>,
  remitId: number,
  // r4 — receipts key by (remitter, remitId); the remitter is the Base
  // diamond whose reservation ledger this pass is scanning.
  baseDiamond: Address,
  /** The tick's ONE send budget (#2497 r2), charged at the broadcast. */
  ackBudget: { remaining: number; deadline: number },
  // A LATE ack (a released reservation) only resolves a settled receipt: Base's
  // released branch stamps nothing for a provisional one, so sending it would
  // pay the CCIP fee every backoff window for nothing.
  late = false,
): Promise<'sent' | 'no-receipt' | 'declined'> {
  let client = clients.get(mirrorCfg.id);
  if (!client) {
    client = deadlineClient(createPublicClient({ transport: http(mirrorCfg.rpc) }), ackBudget.deadline) as PublicClient;
    clients.set(mirrorCfg.id, client);
  }
  const diamond = mirrorCfg.diamond as Address;

  const receipt = (await client.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'getReceivedRemit',
    args: [baseDiamond, BigInt(remitId)],
  })) as { srcChainId: number; receivedAt: bigint; amount: bigint; classification: number };
  if (receipt.receivedAt === 0n) return 'no-receipt';
  if (late && !lateAckUseful(receipt.classification)) {
    console.log(`[keeper] remitAck late remit=${remitId}: the receipt is still provisional — waits for its broadcast`);
    return 'declined';
  }

  const ctx = buildKeeperContext(env, mirrorCfg, client, { notAfterMs: ackBudget.deadline });
  if (!ctx || !ctx.wallet.account) return 'declined';

  const fee = (await client.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemitAckFee',
    args: [BigInt(remitId), baseDiamond],
  })) as bigint;

  // Charged AT THE DISPATCH (#2497 r4): before `writeContract`, so a send that
  // broadcasts and then throws, or a record that fails after it, still counts
  // against the cap; a decline above costs nothing, so it cannot starve the
  // queue behind it.
  if (ackBudget.remaining <= 0) return 'declined';
  ackBudget.remaining--;
  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'sendRemitAck',
    args: [BigInt(remitId), baseDiamond, ctx.wallet.account.address],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  console.log(
    `[keeper] remitAck remit=${remitId} mirror=${mirrorCfg.id} fee=${fee} tx=${hash}`,
  );
  // No receipt wait: Base finalizes idempotently and the D1 backoff bounds
  // re-sends — a dropped tx simply retries after the backoff window.
  return 'sent';
}

/** Reservation reads per `aggregate3` (#1946). */
const LATE_READ_CHUNK = 100;
/** The late-ack pass's open-work kind (`keeper_work_open.kind`). */
const LATE_KIND = 'late_ack' as const;
/** Open releases one tick reads (the rest wait their turn in rotation). */
const LATE_OPEN_SLICE = 300;

/**
 * #1461 — a RELEASED reservation whose delivery executed after all still
 * counts its recycled share as stranded in transit on Base, overstating the
 * coverage allowance, until the destination acknowledges it. The mirror's ack
 * is permissionless and content-free (it echoes the receipt), and Base's late-
 * ack branch resolves the share once. So: for each recent release that still
 * holds a stranded share, ack it from the mirror once the receipt shows the
 * delivery landed — under the same per-reservation backoff as the main scan.
 *
 * Every release is a candidate until the chain shows it needs nothing more
 * ({@link lateAckDone}), when it joins the keeper's done set and is never read
 * again (Codex #2489 r1: the newest-50 window let an open one drop out).
 */
/** Record a sent ack's attempt; a failure is logged, never thrown — the send
 *  already happened and the budget is already charged. Without the record the
 *  backoff restarts, which costs at most one early retry (Base finalizes
 *  idempotently), never an extra send inside this tick. */
async function recordAttemptBestEffort(
  env: Env,
  baseChainId: number,
  diamond: Address,
  remitId: number,
  dstChainId: number,
): Promise<void> {
  try {
    await recordRemitAckAttempt(env.KEEPER_DB, baseChainId, diamond, remitId, dstChainId);
  } catch (err) {
    console.error(`[keeper] remitAck remit=${remitId} sent but its attempt was not recorded: ${(err as Error).message}`);
  }
}

/** The destination's chain config, or undefined after saying so by name —
 *  ONE rule for both the Pending and the late paths (#2497 r2): a remit whose
 *  mirror has no configured RPC is live accounting work this keeper cannot
 *  drive, never a silent skip. */
function mirrorFor(
  mirrorConfigs: Map<number, ChainConfig>,
  dstChainId: number,
  remitId: number,
  path: 'pending' | 'late' = 'pending',
): ChainConfig | undefined {
  const cfg = mirrorConfigs.get(dstChainId);
  if (!cfg) {
    console.warn(
      `[keeper] remitAck${path === 'late' ? ' late' : ''} remit=${remitId} dst=${dstChainId} has no configured RPC — cannot drive the ack`,
    );
  }
  return cfg;
}

/** The late path, CONTAINED (#2497 r5): it is auxiliary to the Pending acks,
 *  so a failure of its own (the release ledger unreadable, say) is reported and
 *  never unwinds the tick before the Pending reservations are acknowledged. */
async function ackLateDeliveriesContained(...args: Parameters<typeof ackLateDeliveries>): Promise<void> {
  try {
    await ackLateDeliveries(...args);
  } catch (err) {
    console.error(`[keeper] remitAck late deliveries failed this tick (pending acks continue): ${(err as Error).message}`);
  }
}

async function ackLateDeliveries(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  mirrorConfigs: Map<number, ChainConfig>,
  mirrorClients: Map<number, PublicClient>,
  ackBudget: { remaining: number; deadline: number },
): Promise<void> {
  // DISCOVER new releases into the open-work queue, then WORK a bounded slice
  // of what is open (#2497 r8, `workQueue.ts`): a release leaves only when the
  // chain shows it finished, and one that never does pins no read.
  await discoverWork<{ remitId: number }>(env, baseChainId, diamond, LATE_KIND, deploymentFloor(baseChainId), async (from, through, limit) => {
    const page = await discoverReleasedRemits(env.DB, baseChainId, from, through, limit);
    return { items: page.rows.map((r) => ({ item: String(r.remitId), block: r.block, payload: { remitId: r.remitId } })), next: page.next };
  });
  const open = await listOpenWork<{ remitId: number }>(env.KEEPER_DB, baseChainId, diamond, LATE_KIND, LATE_OPEN_SLICE);
  if (open.length === 0) return;
  const ids = open.map((o) => o.payload.remitId);
  const res: Awaited<ReturnType<typeof batchedRead>> = [];
  for (let i = 0; i < ids.length; i += LATE_READ_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const part = await boundedRead(
      publicClient as never,
      ids.slice(i, i + LATE_READ_CHUNK).map((id) => ({
        address: diamond,
        abi: REMIT_ABI,
        functionName: 'getRemitReservation' as const,
        args: [BigInt(id)] as const,
      })),
      `remitAck late deliveries ${i}/${ids.length}`,
      ackBudget.deadline,
    );
    res.push(...part);
  }
  // Retired before any send, so a failed send cannot lose them. Only a release
  // actually READ rotates to the back; an unread one keeps its place and is
  // read first next run.
  // Which reservation holds each destination's COMPENSATION gate (#2571 r2):
  // a released compensation remit carries no stranded recycled share, yet its
  // late ack is what clears that gate on Base. One read per destination, not
  // per id; an unread gate counts as held (never retire on an unread value).
  const dsts = [...new Set(res.flatMap((r) => (r?.status === 'success' ? [Number((r.result as RemitReservationView).dstChainId)] : [])))];
  const gates = await boundedRead(
    publicClient as never,
    dsts.map((d) => ({ address: diamond, abi: REMIT_ABI, functionName: 'getCompensationOutstanding' as const, args: [d] as const })),
    'remitAck compensation gates',
    ackBudget.deadline,
  );
  const gateOf = new Map(dsts.map((d, i) => [d, gates[i]?.status === 'success' ? BigInt(gates[i].result as bigint) : null]));
  /** `unreadIsHeld`: for RETIREMENT an unread gate counts as held (never
   *  retire on an unread value); for SENDING only a positive read does (never
   *  pay for an ack on an unread value). */
  const holdsGate = (id: number, v: RemitReservationView, unreadIsHeld: boolean): boolean => {
    const g = gateOf.get(Number(v.dstChainId));
    return g === null || g === undefined ? unreadIsHeld : g === BigInt(id);
  };
  const finished = ids.filter((id, i) => {
    const r = res[i];
    return r?.status === 'success' && lateAckDone(r.result as RemitReservationView, holdsGate(id, r.result as RemitReservationView, true));
  });
  const fin = new Set(finished);
  await finishWork(env.KEEPER_DB, baseChainId, diamond, LATE_KIND, finished.map(String));
  await resolveRetiredLateAlerts(env, baseChainId, diamond, finished);
  await touchOpenWork(
    env.KEEPER_DB,
    baseChainId,
    diamond,
    LATE_KIND,
    ids.filter((id, i) => res[i]?.status === 'success' && !fin.has(id)).map(String),
  );
  const attempts = await getRemitAckAttempts(env.KEEPER_DB, baseChainId, diamond, ids);
  const now = Math.floor(Date.now() / 1000);
  // The same rotation rule as the Pending acks (#2497 r17): least recently
  // attempted first, so a candidate is never stuck behind ones re-taking the
  // budget every backoff window.
  const at = new Map(ids.map((id, i) => [id, i]));
  const noReceipt: { remitId: number; v: RemitReservationView }[] = [];
  for (const id of ackOrder(ids, attempts)) {
    if (ackBudget.remaining <= 0 || Date.now() >= ackBudget.deadline) break;
    const i = at.get(id)!;
    const r = res[i];
    if (!r || r.status !== 'success') continue;
    const v = r.result as RemitReservationView;
    if (!isLateDeliveryCandidate(v, holdsGate(id, v, false))) continue;
    const prior = attempts.get(ids[i]);
    if (prior && now - prior.lastAttemptAt < ACK_RETRY_BACKOFF_SEC) continue;
    const mirrorCfg = mirrorFor(mirrorConfigs, Number(v.dstChainId), ids[i], 'late');
    if (!mirrorCfg) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await sendAckFromMirror(env, mirrorCfg, mirrorClients, ids[i], diamond, ackBudget, true);
      // eslint-disable-next-line no-await-in-loop
      if (outcome === 'sent') await recordAttemptBestEffort(env, baseChainId, diamond, ids[i], Number(v.dstChainId));
      else if (outcome === 'no-receipt') noReceipt.push({ remitId: ids[i], v });
    } catch (err) {
      reportSendError(`[keeper] remitAck late remit=${ids[i]}`, err, `skipped: ${(err as Error).message}`, console.log);
    }
  }
  await alertRetiredRoutes(env, publicClient, 'late', baseChainId, diamond, noReceipt, ackBudget.deadline);
}

/** #2561 — clear the late-path retired-route alerts of the releases that just
 *  finished (the chain shows they need nothing more). Only keys actually open
 *  are touched. Contained: a failure is logged and the alerts stay. */
async function resolveRetiredLateAlerts(
  env: Env,
  baseChainId: number,
  diamond: Address,
  finished: readonly number[],
): Promise<void> {
  if (finished.length === 0) return;
  try {
    const open = new Set(await listOpsAlertKeys(env.KEEPER_DB, retiredRouteAlertPattern('late', baseChainId, diamond)));
    for (const id of finished) {
      const key = retiredRouteAlertKey('late', baseChainId, diamond, id);
      // eslint-disable-next-line no-await-in-loop
      if (open.has(key)) await resolveOpsAlert(env, key);
    }
  } catch (err) {
    console.error(`[keeper] remitAck late retired-route alerts not cleared this run: ${(err as Error).message}`);
  }
}

/** A released reservation (status 3) that still holds an unresolved stranded
 *  share AND carries no acknowledgement stamp yet — the only kind a late
 *  acknowledgement changes anything for. Once the mirror's classification is
 *  stamped the ack has done its work: a trusted consumption resolved the share
 *  in that call, and a quarantine leaves it to the recovery ceremony or the
 *  terminal-loss record, so re-acking would spend gas every pass for nothing. */
/** Whether a late acknowledgement can change anything for a mirror receipt of
 *  `classification` (0 consumed / 1 quarantined / 2 provisional): only a
 *  SETTLED receipt — consumed or quarantined — is stamped by Base's released
 *  branch; a provisional one waits for its day's broadcast to settle it. */
export function lateAckUseful(classification: number | bigint): boolean {
  return Number(classification) !== 2;
}

/** Whether a RELEASED reservation is finished for the late-ack pass: it reads
 *  as released (status 3) and is no longer a {@link isLateDeliveryCandidate} —
 *  its stranded share resolved, or its classification stamped. Neither undoes
 *  itself on a released reservation, so the pass never needs to read it again.
 *  Any other status is not taken as finished: read again next tick. */
export function lateAckDone(
  v: {
    status: number | bigint;
    strandedRecycled?: bigint;
    consumedAcked?: boolean;
    quarantineAcked?: boolean;
    strandedStamped?: boolean;
  },
  /** This reservation still holds its destination's compensation gate
   *  (#2571 r2), whose clearing is the late ack's work too. */
  holdsCompensationGate = false,
): boolean {
  if (Number(v.status) !== 3) return false;
  // An acknowledgement stamp is positive evidence the ack did its work
  // (#2571 r1) — whether or not the stranded-share history was stamped, which a
  // QUARANTINED delivery never triggers (Base's settle returns before the
  // history stamp when the consumption is not trusted).
  if (v.consumedAcked === true || v.quarantineAcked === true) return true;
  if (holdsCompensationGate) return false;
  return v.strandedStamped === true && (v.strandedRecycled ?? 0n) === 0n;
}

/** #2497 r1 — POSITIVE evidence only. A released reservation whose stranded
 *  share has not been STAMPED yet (the remittance facet's lazy history stamp,
 *  or `backfillRemitHistory`, has not reached it) reads `strandedRecycled == 0`
 *  by default, which is not the same as "nothing stranded". It stays a
 *  candidate, so the acknowledgement can perform that stamp, and it is never
 *  entered into the permanent done set on a default-decoded field. */
export function isLateDeliveryCandidate(
  v: {
    status: number | bigint;
    strandedRecycled?: bigint;
    consumedAcked?: boolean;
    quarantineAcked?: boolean;
    strandedStamped?: boolean;
  },
  /** See {@link lateAckDone}: a held compensation gate is work for the ack. */
  holdsCompensationGate = false,
): boolean {
  if (Number(v.status) !== 3) return false;
  // Acked already (consumed OR quarantined): nothing an ack can change, even
  // with the history unstamped — re-sending would pay the CCIP fee every
  // backoff window forever (#2571 r1).
  if (v.consumedAcked === true || v.quarantineAcked === true) return false;
  // A released COMPENSATION remit is fresh-only, so its stranded share is 0 —
  // but the ack still clears the gate it holds (#2571 r2).
  if (holdsCompensationGate) return true;
  if (v.strandedStamped !== true) return true;
  return (v.strandedRecycled ?? 0n) > 0n;
}

