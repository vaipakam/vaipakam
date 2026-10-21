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
// #2561 — cases no wait resolves: a remittance sent before its mirror was
// redeployed behind a new adapter executes, if at all, behind the OLD one, so
// the mirror this keeper reads never holds its receipt; and a message waiting on
// CCIP for manual execution, or executed at a receiver since replaced, looks
// the same from here. Each path first CLASSIFIES every reservation it read
// (receipts read in batches per mirror, whatever the send budget), then sends
// what the budget allows, then reports what it classified: a missing receipt on
// a retired route (`remitRoute.ts`), or on a Pending reservation long past its
// send, goes to the operator with the evidence instead of waiting in silence.
// Acknowledging itself is unchanged: a receipt on the configured mirror proves
// the delivery reached it, whatever the route.
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
import { deadlineClient, failedOnOwnCall, PastRunDeadline, settleBy, settledChunkedRead, settledRead } from './batchRead';
import { priorStageCutoffMs, readCutoffMs, runIndex } from './runWindow';
import { walkFrom } from './rotate';
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
  parseUndeliveredAlertKey,
  readRemitRoutes,
  UNDELIVERED_ALERT_REPEAT_SEC,
  undeliveredAlertDetail,
  undeliveredAlertFooter,
  undeliveredAlertHeader,
  undeliveredAlertKey,
  undeliveredAlertPattern,
  undeliveredReason,
  type LateOutstanding,
  type RemitPath,
  type UndeliveredReason,
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

  // Which run this is, so every list the deadline can cut partway starts at a
  // point that moves each run (`runWindow.ts` rule 2, Codex #2607 r13).
  const run = runIndex(tick, 60_000);

  // Chains side by side (#2572 r5, `runWindow.ts` rule 1).
  await Promise.all(
    getChainConfigs(env).map(async (chain) => {
      try {
        await ackFromBaseLedger(env, chain, deadline, run);
      } catch (err) {
        console.error(`[keeper] remitAck chain=${chain.id} failed:`, err);
      }
    }),
  );
}

async function ackFromBaseLedger(env: Env, chain: ChainConfig, deadline: number, run: number): Promise<void> {
  const publicClient = deadlineClient(createPublicClient({ transport: http(chain.rpc) }), deadline);
  const diamond = chain.diamond as Address;

  // The plans stop reading at the read cutoff, abandoning any read still in
  // flight then (Codex #2607 r7, `runWindow.ts` rule 3), so the sends always
  // keep their reserve whatever one destination's RPC does. The Base reads
  // ahead of the plans stop earlier still (Codex #2607 r14): the ledger scan
  // feeds the Pending plan's receipt reads, which stop at
  // `priorStageCutoffMs(readCutoff)`, so it leaves them a stage reserve, and
  // the reads before it settle by the same time.
  const readCutoff = readCutoffMs(deadline);
  const scanCutoff = priorStageCutoffMs(priorStageCutoffMs(readCutoff));
  const settled = <T>(read: Promise<T>, what: string): Promise<T> =>
    settleBy(read, scanCutoff, () => {
      throw new PastRunDeadline(`${what}: still in flight at the scan cutoff — next run`);
    });

  // The reservation ledger lives on Base only.
  const cfg = (await settled(publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  }), 'getRewardReporterConfig')) as readonly [Address, number, number, boolean, bigint];
  const baseChainId = Number(cfg[1]);
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  // One client per destination chain, bound to the RUN deadline: the plans
  // read through it only until their read cutoff (`settledRead`), and the
  // sends reuse it until the deadline.
  const mirrorConfigs = new Map<number, ChainConfig>();
  for (const c of getChainConfigs(env)) mirrorConfigs.set(c.id, c);
  const mirrorClients = new Map<number, PublicClient>();
  for (const c of mirrorConfigs.values()) mirrorClient(mirrorClients, c, deadline);
  // ONE send budget for the whole tick (#2497 r2): the late-ack path and the
  // Pending path draw on the same MAX_ACKS_PER_TICK, so a tick never sends
  // more than the cap however its work splits between them.
  const ackBudget: AckBudget = { remaining: MAX_ACKS_PER_TICK, deadline };
  // The late path needs nothing the Pending path reads — not the ledger nonce,
  // not the scan state, not the scan — so it starts first, straight after the
  // canonical check both share (Codex #2607 r14, r18): whatever of the Pending
  // path is slow, aborts or fails, the late acknowledgements and their alerts
  // still run. A released reservation may still see its delivery land late,
  // so it runs in the caught-up state too (#1461).
  const late = planLateDeliveriesContained(env, publicClient as never, baseChainId, diamond, mirrorConfigs, mirrorClients, readCutoff, run);
  // ONE PIPELINE PER PATH, the two side by side (Codex #2607 r3–r6). Each
  // path is read and classified, then its alerts post concurrently with its
  // acknowledgement sends, so no slow ops channel, slow send or slow mirror
  // spends the deadline another step needed. The late path is a backlog that
  // can reach unhealthy destinations, so its planning never sits in front of
  // the Pending sends.
  // PENDING ACKS FIRST (#2497 r13): they are the ordinary work — a
  // reservation stays reserved on Base until acked — so the late sends get only
  // the slots the Pending acks were not handed, never the other way round
  // (`AckBudget`).
  const { pending, cleared } = await pendingPath(env, publicClient, baseChainId, diamond, mirrorConfigs, mirrorClients, settled, scanCutoff, readCutoff, run);
  await Promise.all([cleared, alertAndSend(env, baseChainId, diamond, pending, late, mirrorClients, ackBudget, deadline, run)]);
}

/**
 * The Pending path's ledger work, CONTAINED as one unit (Codex #2607 r18):
 * the nonce read, the scan state, the scan and its cursor write. Any of them
 * failing is reported and ends only this path for the run; the late path,
 * started before it, never depends on it.
 */
async function pendingPath(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  mirrorConfigs: Map<number, ChainConfig>,
  mirrorClients: Map<number, PublicClient>,
  settled: <T>(read: Promise<T>, what: string) => Promise<T>,
  scanCutoff: number,
  readCutoff: number,
  run: number,
): Promise<{ pending: Promise<AckPlan | undefined>; cleared: Promise<void> }> {
  const none = { pending: Promise.resolve(undefined), cleared: Promise.resolve() };
  try {
    const nonce = (await settled(publicClient.readContract({
      address: diamond,
      abi: REMIT_ABI,
      functionName: 'getRemitReservationNonce',
    }), 'getRemitReservationNonce')) as bigint;
    if (nonce === 0n) return none;
    const { frontier, scanCursor } = await getRemitAckScanState(env.KEEPER_DB, baseChainId, diamond);
    if (BigInt(frontier) > nonce) {
      // Caught up — the steady state.
      return { pending: none.pending, cleared: clearSettledPendingAlerts(env, baseChainId, diamond, frontier, new Set()) };
    }
    const w = await scanPendingWindow(env, publicClient, baseChainId, diamond, frontier, scanCursor, nonce, scanCutoff);
    if (!w) return none;
    await putRemitAckScanState(env.KEEPER_DB, baseChainId, diamond, w.contiguousTerminal, w.to);
    return {
      pending: planPendingContained(env, publicClient as never, baseChainId, diamond, w.pendingIds, w.reservations, mirrorConfigs, mirrorClients, readCutoff, run),
      cleared: clearSettledPendingAlerts(env, baseChainId, diamond, w.contiguousTerminal, w.terminalInWindow),
    };
  } catch (err) {
    console.error(`[keeper] remitAck ledger scan failed this tick (late deliveries continue): ${(err as Error).message}`);
    return none;
  }
}

/**
 * One bounded window of the reservation ledger (#1426, #1896): the Pending
 * reservations it holds, the terminal ones it marks acknowledged, and where
 * the frontier and the cursor move to. A read that failed or did not settle
 * by `cutoff` ends the window there, since neither the frontier nor the cursor
 * may advance past a reservation whose status is unknown; `undefined` only
 * when not even the window's first reservation was read.
 */
async function scanPendingWindow(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  frontier: number,
  scanCursor: number,
  nonce: bigint,
  cutoff: number,
): Promise<{ pendingIds: number[]; reservations: Map<number, RemitReservationView>; contiguousTerminal: number; terminalInWindow: Set<number>; to: number } | undefined> {
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
  // Ids this window read as terminal, for the Pending alerts (#2561).
  const terminalInWindow = new Set<number>();

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
    const part = await settledRead(
      publicClient as never,
      chunk.map((id) => ({
        address: diamond,
        abi: REMIT_ABI,
        functionName: 'getRemitReservation' as const,
        args: [id] as const,
      })),
      `remitAck getRemitReservation ${i}/${windowIds.length}`,
      cutoff,
    );
    scanResults.push(...part);
  }

  // The window ENDS at its first unread reservation (Codex #2607 r15): what
  // was read before it is worked this run, and the cursor stops there, so the
  // next run resumes at that id. Neither the frontier nor the cursor may pass
  // an id whose status is unknown, and the ids read before it are never
  // discarded with it: a cutoff that always lands in the same chunk would
  // otherwise re-read that window forever and work none of it.
  let end = to;
  for (let idx = 0; idx < windowIds.length; idx++) {
    const id = windowIds[idx];
    const res = scanResults[idx];
    if (!res || res.status !== 'success') {
      console.warn(
        `[keeper] remitAck scan ${idx === 0 ? 'read nothing' : `stopped at remit=${id} (the ${idx} before it are worked)`}: ${String(
          res?.error ?? 'no result',
        ).slice(0, 200)}`,
      );
      if (idx === 0) return undefined;
      end = id;
      break;
    }
    const r = res.result as RemitReservationView;
    if (r.status === 2 || r.status === 3) {
      terminalInWindow.add(Number(id));
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
  return { pendingIds, reservations, contiguousTerminal, terminalInWindow, to: Number(end) };
}

/**
 * The tick's ONE send budget (#2497 r2), shared by both paths: never more
 * than `MAX_ACKS_PER_TICK` sends however the work splits between them.
 *
 * The slots are HANDED OUT, never raced for (Codex #2607 r17). Each path
 * quotes its candidates first, and only a candidate whose quote came back
 * takes a slot, so a failed or stalled quote costs nothing and leaves no slot
 * held. The Pending acks are handed their slots first (#2497 r13), from their
 * own quotes alone; the late acks get what is left once that is settled,
 * which waits on the Pending QUOTES and never on a Pending send. Within each
 * path the slots go round the mirrors ({@link allotSlots}), so a mirror whose
 * RPC answers more slowly is never left without a send by a faster one.
 */
interface AckBudget {
  remaining: number;
  deadline: number;
}

/**
 * Hand out up to `slots` sends across the mirrors' queues: one from each
 * mirror in turn, from a mirror that moves each run (`runWindow.ts` rule 2),
 * then round again, until the slots or the queues run out. Each queue keeps
 * its own order. Pure; pinned by the tests.
 */
export function allotSlots<T>(queues: ReadonlyMap<number, readonly T[]>, slots: number, run: number): Map<number, T[]> {
  const mirrors = walkFrom([...queues.keys()].sort((a, b) => a - b), run);
  const out = new Map<number, T[]>();
  let given = 0;
  for (let round = 0; given < slots; round++) {
    let any = false;
    for (const m of mirrors) {
      if (given >= slots) break;
      const item = queues.get(m)?.[round];
      if (item === undefined) continue;
      any = true;
      given++;
      out.set(m, [...(out.get(m) ?? []), item]);
    }
    if (!any) break;
  }
  return out;
}

/**
 * Deliver each path's alerts and broadcasts as soon as THAT path is planned
 * (Codex #2607 r6). Each path's alerts start the moment its own plan is ready,
 * whatever the other path is doing.
 *
 * The broadcasts run in ONE LANE PER MIRROR, the lanes side by side (Codex
 * #2607 r13, `runWindow.ts` rule 1): a stalled broadcast on one destination
 * holds up that destination's acknowledgements only, never a healthy
 * mirror's. The quotes ahead of them are one read per mirror, settled by a
 * cutoff that leaves the sends a reserve (rule 3), so a stalled quote is
 * abandoned there and the healthy mirrors' sends still go. Within a lane the
 * Pending acknowledgements go first and the late ones follow; the sender's
 * nonce on each chain is serialized by the submission slot either way. Both
 * plans are contained, so this never rejects.
 */
async function alertAndSend(
  env: Env,
  baseChainId: number,
  diamond: Address,
  pendingPlan: Promise<AckPlan | undefined>,
  latePlan: Promise<AckPlan | undefined>,
  mirrorClients: Map<number, PublicClient>,
  ackBudget: AckBudget,
  deadline: number,
  run: number,
): Promise<void> {
  const alert = (plan: Promise<AckPlan | undefined>) =>
    plan.then((p) => deliverUndelivered(env, baseChainId, diamond, [p?.undelivered], deadline));
  const quoteCutoff = priorStageCutoffMs(deadline);
  const quoted = (plan: Promise<AckPlan | undefined>) =>
    plan.then(async (p) => ({ p, queues: await quoteLanes(env, p, mirrorClients, diamond, quoteCutoff, deadline, run) }));
  const lanes = new Map<number, Promise<void>>();
  const queue = ({ p, queues }: { p: AckPlan | undefined; queues: Map<number, QuotedAck[]> }): Promise<void>[] => {
    const allotted = allotSlots(queues, ackBudget.remaining, run);
    for (const sends of allotted.values()) ackBudget.remaining -= sends.length;
    return [...allotted].map(([mirrorId, sends]) => {
      const tail = (lanes.get(mirrorId) ?? Promise.resolve())
        .then(() => sendLane(env, p!, sends, baseChainId, diamond, ackBudget.deadline))
        .catch((err) => console.error(`[keeper] remitAck${p!.late ? ' late' : ''} sends to mirror=${mirrorId} failed this tick: ${(err as Error).message}`));
      lanes.set(mirrorId, tail);
      return tail;
    });
  };
  // The Pending acks take their slots as soon as their own quotes are in; the
  // late acks take what is left after that, so they wait on no Pending send.
  const pendingQueued = quoted(pendingPlan).then(queue);
  const lateQueued = Promise.all([quoted(latePlan), pendingQueued]).then(([q]) => queue(q));
  const [pendingSends, lateSends] = await Promise.all([pendingQueued, lateQueued, alert(pendingPlan), alert(latePlan)]);
  await Promise.all([...pendingSends, ...lateSends]);
}

/** The rotation order for acknowledgements: never attempted first, then the
 *  least recently attempted, then by id. Pure; pinned by the tests. */
export function ackOrder(ids: readonly number[], attempts: ReadonlyMap<number, { lastAttemptAt: number }>, run = 0): number[] {
  // The never-attempted ids start at a point that moves each run (Codex #2607
  // r13, `runWindow.ts` rule 2): one whose quote or broadcast stalls is never
  // recorded as attempted, so a fixed order would put it first every run.
  const at = (id: number) => attempts.get(id)?.lastAttemptAt ?? 0;
  const never = walkFrom(ids.filter((id) => at(id) === 0).sort((a, b) => a - b), run);
  const tried = ids.filter((id) => at(id) !== 0).sort((a, b) => at(a) - at(b) || a - b);
  return [...never, ...tried];
}

/** One path's classified work (#2561, Codex #2607 r3/r4): every candidate
 *  with its receipt read and its undelivered state classified, waiting on the
 *  alert delivery and the broadcast. */
interface AckPlan {
  late: boolean;
  /** `mirrorCfg` is absent for a destination this keeper has no RPC or
   *  deployment for: such a reservation is reported, never dropped. */
  /** `sendable: false` marks one classified on an unread value: reported,
   *  never paid for (Codex #2607 r9). */
  candidates: readonly { remitId: number; v: RemitReservationView; mirrorCfg?: ChainConfig; sendable?: boolean }[];
  receipts: ReadonlyMap<number, MirrorReceipt | null>;
  /** `null` when the attempt log could not be read: classification and alerts
   *  still run, and this run's broadcasts are skipped (Codex #2607 r6). */
  attempts: Awaited<ReturnType<typeof getRemitAckAttempts>> | null;
  undelivered?: UndeliveredReport;
}

/** The attempt log for `ids`, or `null` when it cannot be read. The log only
 *  paces broadcasts, so an unread one must never stop the classification or
 *  the alerts (Codex #2607 r6); the sends wait for a run that can read it. */
async function readAttempts(env: Env, baseChainId: number, diamond: Address, ids: number[], path: RemitPath) {
  try {
    return await getRemitAckAttempts(env.KEEPER_DB, baseChainId, diamond, ids);
  } catch (err) {
    console.error(`[keeper] remitAck${path === 'late' ? ' late' : ''} attempt log unread; this run classifies and alerts but sends nothing: ${(err as Error).message}`);
    return null;
  }
}

async function planPending(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  pendingIds: readonly number[],
  reservations: ReadonlyMap<number, RemitReservationView>,
  mirrorConfigs: Map<number, ChainConfig>,
  mirrorClients: Map<number, PublicClient>,
  deadline: number,
  run: number,
): Promise<AckPlan | undefined> {
  if (pendingIds.length === 0) return undefined;
  const attempts = await readAttempts(env, baseChainId, diamond, [...pendingIds], 'pending');
  // CLASSIFY first (Codex #2607 r2): every Pending reservation in the window
  // has its receipt read, whatever the send budget, so the report below covers
  // them all; the budget gates only the broadcast.
  const candidates = pendingIds.flatMap((remitId) => {
    const v = reservations.get(remitId);
    return v ? [{ remitId, v, mirrorCfg: mirrorFor(mirrorConfigs, v.dstChainId, remitId) }] : [];
  });
  // The receipts leave the route reads that follow them a reserve (Codex
  // #2607 r8): a mirror stalled until the receipt cutoff is abandoned there,
  // and the healthy mirrors' missing receipts are still classified.
  const { receipts, unreadable } = await readReceipts(candidates, mirrorClients, diamond, priorStageCutoffMs(deadline), run);
  const undelivered = await classifyUndelivered(publicClient, 'pending', baseChainId, diamond, candidates, receipts, unreadable, deadline, run);
  return { late: false, candidates, receipts, attempts, undelivered };
}

type SendCandidate = AckPlan['candidates'][number] & { mirrorCfg: ChainConfig };

/** A candidate this run can pay for: its fee quoted, its signer built. */
interface QuotedAck {
  c: SendCandidate;
  fee: bigint;
  ctx: NonNullable<ReturnType<typeof buildKeeperContext>>;
}

/** A plan's acknowledgements this run may send, grouped by mirror. Only a
 *  candidate holding a receipt is sent, a late one only once its receipt is
 *  settled, and one attempted within the backoff waits. Least recently
 *  attempted first, never-attempted first of all (#2497 r16/r17): ascending
 *  id order let the first ids re-take the budget every backoff window while
 *  later ones waited indefinitely. */
function sendLanes(plan: AckPlan | undefined, run: number): Map<number, SendCandidate[]> {
  const lanes = new Map<number, SendCandidate[]>();
  if (!plan || !plan.attempts) return lanes;
  const attempts = plan.attempts;
  const now = Math.floor(Date.now() / 1000);
  const byId = new Map(plan.candidates.map((c) => [c.remitId, c]));
  for (const remitId of ackOrder([...byId.keys()], attempts, run)) {
    const c = byId.get(remitId)!;
    const receipt = plan.receipts.get(remitId);
    if (!receipt || !c.mirrorCfg || c.sendable === false) continue;
    // A LATE ack (a released reservation) only resolves a settled receipt:
    // Base's released branch stamps nothing for a provisional one, so sending
    // it would pay the CCIP fee every backoff window for nothing.
    if (plan.late && !lateAckUseful(receipt.classification)) {
      console.log(`[keeper] remitAck late remit=${remitId}: the receipt is still provisional — waits for its broadcast`);
      continue;
    }
    const prior = attempts.get(remitId);
    if (prior && now - prior.lastAttemptAt < ACK_RETRY_BACKOFF_SEC) continue;
    const lane = lanes.get(c.mirrorCfg.id) ?? [];
    lane.push(c as SendCandidate);
    lanes.set(c.mirrorCfg.id, lane);
  }
  return lanes;
}

/**
 * Quote each mirror's first `MAX_ACKS_PER_TICK` candidates, in one read per
 * mirror, the mirrors side by side, settled by `cutoff` (`settledRead`). Only
 * a candidate whose quote answered is returned, in its lane's order, so a
 * slot is never held by an acknowledgement that cannot be paid for. A mirror
 * this keeper has no signer for returns nothing.
 */
async function quoteLanes(
  env: Env,
  plan: AckPlan | undefined,
  mirrorClients: Map<number, PublicClient>,
  baseDiamond: Address,
  cutoff: number,
  deadline: number,
  run: number,
): Promise<Map<number, QuotedAck[]>> {
  const out = new Map<number, QuotedAck[]>();
  await Promise.all([...sendLanes(plan, run)].map(async ([mirrorId, lane]) => {
    const head = lane.slice(0, MAX_ACKS_PER_TICK);
    const cfg = head[0].mirrorCfg;
    const client = mirrorClients.get(mirrorId)!;
    const ctx = buildKeeperContext(env, cfg, client, { notAfterMs: deadline });
    if (!ctx || !ctx.wallet.account) return;
    const fees = await settledRead(
      client,
      head.map((c) => ({ address: cfg.diamond as Address, abi: REMIT_ABI, functionName: 'quoteRemitAckFee' as const, args: [BigInt(c.remitId), baseDiamond] as const })),
      `remitAck${plan!.late ? ' late' : ''} fee quotes mirror=${mirrorId}`,
      cutoff,
    );
    const ok: QuotedAck[] = [];
    head.forEach((c, i) => {
      const f = fees[i];
      if (f?.status === 'success') ok.push({ c, fee: BigInt(f.result as bigint), ctx });
      else console.log(`[keeper] remitAck${plan!.late ? ' late' : ''} remit=${c.remitId} mirror=${mirrorId}: fee quote unread this run — next run`);
    });
    if (ok.length > 0) out.set(mirrorId, ok);
  }));
  return out;
}

/** Broadcast one mirror's allotted acknowledgements, in order, until the
 *  deadline. Each already holds its slot of the tick's budget, so the lane
 *  charges nothing and releases nothing. */
async function sendLane(
  env: Env,
  plan: AckPlan,
  sends: readonly QuotedAck[],
  baseChainId: number,
  diamond: Address,
  deadline: number,
): Promise<void> {
  for (const q of sends) {
    // Past the deadline: the rest of the lane waits for the next run.
    if (Date.now() >= deadline) break;
    const dst = Number(q.c.v.dstChainId);
    try {
      // eslint-disable-next-line no-await-in-loop
      await broadcastAck(q, diamond);
      // eslint-disable-next-line no-await-in-loop
      await recordAttemptBestEffort(env, baseChainId, diamond, q.c.remitId, dst);
    } catch (err) {
      reportSendError(`[keeper] remitAck${plan.late ? ' late' : ''} remit=${q.c.remitId} dst=${dst}`, err, `skipped: ${(err as Error).message}`, console.log);
    }
  }
}

/** A mirror receipt as `getReceivedRemit` returns it. */
interface MirrorReceipt {
  srcChainId: number;
  receivedAt: bigint;
  amount: bigint;
  classification: number;
}

/** The mirror client for `cfg`, built once per destination chain. */
function mirrorClient(clients: Map<number, PublicClient>, cfg: ChainConfig, deadline: number): PublicClient {
  let client = clients.get(cfg.id);
  if (!client) {
    client = deadlineClient(createPublicClient({ transport: http(cfg.rpc) }), deadline) as PublicClient;
    clients.set(cfg.id, client);
  }
  return client;
}

/** Receipt reads per `aggregate3` (#1946). */
const RECEIPT_READ_CHUNK = 100;

/**
 * Each candidate's receipt on its configured mirror, read in bounded batches
 * per mirror (#2561 r2). A held receipt maps to it; a read that found NONE maps
 * to `null`; an unread one is absent, and nothing is decided about it this run.
 * A read the destination ANSWERED with an error (a revert, or data that does
 * not decode: a deployment entry naming a Diamond without the receipt surface,
 * say) is not a transient gap, so it is listed under `unreadable` with the
 * error and reported (Codex #2607 r14); it would otherwise stay Pending with
 * nothing said, run after run.
 */
async function readReceipts(
  candidates: readonly { remitId: number; mirrorCfg?: ChainConfig }[],
  clients: Map<number, PublicClient>,
  baseDiamond: Address,
  deadline: number,
  run: number,
): Promise<{ receipts: Map<number, MirrorReceipt | null>; unreadable: Map<number, string> }> {
  const out = new Map<number, MirrorReceipt | null>();
  const unreadable = new Map<number, string>();
  const byMirror = new Map<number, { cfg: ChainConfig; ids: number[] }>();
  for (const c of candidates) {
    if (!c.mirrorCfg) continue;
    const g = byMirror.get(c.mirrorCfg.id) ?? { cfg: c.mirrorCfg, ids: [] };
    g.ids.push(c.remitId);
    byMirror.set(c.mirrorCfg.id, g);
  }
  // The mirrors are read side by side, each settled by `deadline` (the plan's
  // read cutoff): a slow destination RPC leaves only its own reservations
  // unread this run, and never holds the others past the cutoff (Codex #2607
  // r6/r7). The client is the run-deadline one built for this pass.
  // Each mirror's ids start at a point that moves each run (Codex #2607 r13,
  // `settledChunkedRead`): the cutoff can end a mirror's reads partway.
  await Promise.all([...byMirror.values()].map(async ({ cfg, ids }) => {
    const client = mirrorClient(clients, cfg, deadline);
    const res = await settledChunkedRead(
      client as never,
      ids,
      RECEIPT_READ_CHUNK,
      (id) => ({ address: cfg.diamond as Address, abi: REMIT_ABI, functionName: 'getReceivedRemit' as const, args: [baseDiamond, BigInt(id)] as const }),
      `remitAck getReceivedRemit dst=${cfg.id}`,
      deadline,
      run,
    );
    for (const [id, r] of res) {
      if (failedOnOwnCall(r, 'getReceivedRemit')) unreadable.set(id, shortError(r.error));
      if (r?.status !== 'success') continue;
      const receipt = r.result as MirrorReceipt;
      out.set(id, receipt.receivedAt === 0n ? null : receipt);
    }
  }));
  return { receipts: out, unreadable };
}

/** An error's one-line summary for an alert line. */
function shortError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown };
  return String(e?.shortMessage ?? e?.message ?? err).split('\n')[0].slice(0, 160);
}

/** What one path's classification found (#2561): the reason that holds for
 *  each reservation classified this run (none when its receipt is held or it
 *  is not yet due), and the alert entries that reason produces. */
interface UndeliveredReport {
  path: RemitPath;
  holding: Map<number, UndeliveredReason | undefined>;
  entries: Map<UndeliveredReason, OpsAlertEntry[]>;
}

/**
 * #2561 — classify the reservations this path read whose configured mirror
 * holds no receipt: read their routes and decide, with the evidence, which are
 * undelivered and why. Reads only; nothing is posted here, so every path is
 * classified before any alert or acknowledgement is sent (Codex #2607 r3/r4).
 * A reservation whose receipt or route was not read is left out, so it keeps
 * its alerts. Contained: a failure is logged and classifies nothing.
 */
async function classifyUndelivered(
  publicClient: PublicClient,
  path: RemitPath,
  baseChainId: number,
  diamond: Address,
  candidates: readonly { remitId: number; v: RemitReservationView; mirrorCfg?: ChainConfig; outstanding?: LateOutstanding }[],
  receipts: ReadonlyMap<number, MirrorReceipt | null>,
  unreadable: ReadonlyMap<number, string>,
  deadline: number,
  run: number,
): Promise<UndeliveredReport | undefined> {
  if (candidates.length === 0 || Date.now() >= deadline) return undefined;
  try {
    const noReceipt = candidates.filter((c) => receipts.get(c.remitId) === null);
    // Unobservable: no destination configured, or one whose receipt read the
    // destination answered with an error (Codex #2607 r14). Its route is read
    // too (Codex #2607 r11): it needs no destination RPC, and a retired route
    // is evidence that fixing the destination would not help.
    const unobservable = candidates.filter((c) => !c.mirrorCfg || unreadable.has(c.remitId));
    const routed = [...noReceipt, ...unobservable];
    const routes = await readRemitRoutes(publicClient, diamond, routed.map((c) => c.remitId), deadline, run);
    const nowSec = Math.floor(Date.now() / 1000);
    const holding = new Map<number, UndeliveredReason | undefined>();
    for (const c of candidates) if (receipts.get(c.remitId)) holding.set(c.remitId, undefined);
    const entries = new Map<UndeliveredReason, OpsAlertEntry[]>();
    for (const { remitId, v, outstanding, mirrorCfg } of routed) {
      const read = routes.get(remitId);
      const route = read && read.kind !== 'unread' ? read : undefined;
      const receiptError = unreadable.get(remitId);
      const observable = mirrorCfg !== undefined && receiptError === undefined;
      if (observable && !route) continue;
      // Where the receipt cannot be read, a retired route is still the retired
      // case (fixing the destination would not reach a receipt behind the old
      // adapter); otherwise the unreadable receipt is the reason.
      const reason: UndeliveredReason | undefined = observable
        ? undeliveredReason(path, route!, v.sentAt, nowSec)
        : route?.kind === 'retired'
          ? 'retired'
          : 'unobservable';
      holding.set(remitId, reason);
      if (!reason) continue;
      const detail = undeliveredAlertDetail({
        remitId,
        dstChainId: Number(v.dstChainId),
        route,
        unconfigured: !mirrorCfg,
        receiptError,
        ageSec: Math.max(0, nowSec - Number(v.sentAt)),
        ccipMessageId: v.ccipMessageId,
        totalWei: BigInt(v.total),
        outstanding,
      });
      console.warn(`[keeper] remitAck${path === 'late' ? ' late' : ''} remit=${remitId}: undelivered (${reason}) — ${detail} Not acknowledgeable by this keeper; operator alerted.`);
      const list = entries.get(reason) ?? [];
      list.push({ key: undeliveredAlertKey(path, baseChainId, diamond, reason, remitId), id: `remit ${remitId}`, detail });
      entries.set(reason, list);
    }
    return { path, holding, entries };
  } catch (err) {
    console.error(`[keeper] remitAck${path === 'late' ? ' late' : ''} undelivered classification failed this run: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * #2561 — deliver what {@link classifyUndelivered} found, for every path at
 * once, after all of them are classified. One digest post per path and reason
 * however many are due (each reservation keeps its own key, so each re-posts
 * daily and clears on its own), so a redeploy that strands many remittances
 * costs a bounded number of posts. The posts run CONCURRENTLY, with each other
 * and with the tick's acknowledgement sends (Codex #2607 r5): a slow or
 * unreachable ops channel costs one post timeout in total, and never the time
 * an acknowledgement or another digest needed.
 *
 * Then, for every reservation classified this run, an open alert whose reason
 * no longer holds (the receipt appeared, the adapter is the lane's again) is
 * cleared, so a recurrence alerts at once. That reconciliation is contained on
 * its own (Codex #2607 r4): an unreadable alert list never withholds a new
 * alert, since the digest itself fails open on unread sent-state. It never
 * clears a key this run posts, so it can follow the posts. Never rejects, so
 * the caller may start it and await it after the sends.
 */
async function deliverUndelivered(
  env: Env,
  baseChainId: number,
  diamond: Address,
  reports: readonly (UndeliveredReport | undefined)[],
  deadline: number,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const posts = reports.flatMap((r) => (r ? [...r.entries].map(([reason, list]) => ({ path: r.path, reason, list })) : []));
  // Contained by the digest itself: a failed post is logged and stays due.
  await Promise.allSettled(
    posts.map(({ path, reason, list }) =>
      sendOpsAlertDigest(
        env,
        (count) => undeliveredAlertHeader(path, reason, baseChainId, count),
        list,
        undeliveredAlertFooter(path, reason),
        UNDELIVERED_ALERT_REPEAT_SEC,
        nowSec,
        baseChainId,
      ),
    ),
  );
  for (const r of reports) {
    if (!r || Date.now() >= deadline) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const open = await listOpsAlertKeys(env.KEEPER_DB, undeliveredAlertPattern(r.path, baseChainId, diamond));
      for (const key of open) {
        const k = parseUndeliveredAlertKey(key);
        if (!k || !r.holding.has(k.remitId) || r.holding.get(k.remitId) === k.reason) continue;
        // eslint-disable-next-line no-await-in-loop
        await resolveOpsAlert(env, key);
      }
    } catch (err) {
      console.error(`[keeper] remitAck${r.path === 'late' ? ' late' : ''} alert reconciliation failed this run (new alerts were still sent): ${(err as Error).message}`);
    }
  }
}

/**
 * #2561 — clear the Pending-path alerts whose reservation is settled, from what
 * the scan already proves and with no read: every id below the frontier is
 * terminal by construction (the frontier is the contiguous terminal prefix),
 * and so is every id this window read as acknowledged or released. A terminal
 * reservation never returns to Pending. Contained: a failure is logged and
 * never unwinds the pass.
 */
async function clearSettledPendingAlerts(
  env: Env,
  baseChainId: number,
  diamond: Address,
  frontier: number,
  terminal: ReadonlySet<number>,
): Promise<void> {
  try {
    const open = await listOpsAlertKeys(env.KEEPER_DB, undeliveredAlertPattern('pending', baseChainId, diamond));
    for (const key of open) {
      const k = parseUndeliveredAlertKey(key);
      if (!k || (k.remitId >= frontier && !terminal.has(k.remitId))) continue;
      // eslint-disable-next-line no-await-in-loop
      await resolveOpsAlert(env, key);
    }
  } catch (err) {
    console.error(`[keeper] remitAck settled undelivered alerts not cleared this run: ${(err as Error).message}`);
  }
}

/** Send one ack from the mirror for a remittance whose receipt the caller
 *  already read there, at the fee quoted for it this run. The slot it spends
 *  was taken when it was allotted (#2497 r4): a send that broadcasts and then
 *  throws, or a record that fails after it, still counts against the cap. */
async function broadcastAck(
  q: QuotedAck,
  // r4 — receipts key by (remitter, remitId); the remitter is the Base
  // diamond whose reservation ledger this pass is scanning.
  baseDiamond: Address,
): Promise<void> {
  const { c, fee, ctx } = q;
  const hash = await ctx.wallet.writeContract({
    address: c.mirrorCfg.diamond as Address,
    abi: REMIT_ABI,
    functionName: 'sendRemitAck',
    args: [BigInt(c.remitId), baseDiamond, ctx.wallet.account!.address],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  console.log(
    `[keeper] remitAck remit=${c.remitId} mirror=${c.mirrorCfg.id} fee=${fee} tx=${hash}`,
  );
  // No receipt wait: Base finalizes idempotently and the D1 backoff bounds
  // re-sends — a dropped tx simply retries after the backoff window.
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
/** The Pending path, CONTAINED (Codex #2607 r6): it runs beside the late
 *  path, so a failure of its own is reported and never unwinds the other. */
async function planPendingContained(...args: Parameters<typeof planPending>): Promise<AckPlan | undefined> {
  try {
    return await planPending(...args);
  } catch (err) {
    console.error(`[keeper] remitAck pending plan failed this tick (late deliveries continue): ${(err as Error).message}`);
    return undefined;
  }
}

async function planLateDeliveriesContained(...args: Parameters<typeof planLateDeliveries>): Promise<AckPlan | undefined> {
  try {
    return await planLateDeliveries(...args);
  } catch (err) {
    console.error(`[keeper] remitAck late deliveries failed this tick (pending acks continue): ${(err as Error).message}`);
    return undefined;
  }
}

async function planLateDeliveries(
  env: Env,
  publicClient: PublicClient,
  baseChainId: number,
  diamond: Address,
  mirrorConfigs: Map<number, ChainConfig>,
  mirrorClients: Map<number, PublicClient>,
  deadline: number,
  run: number,
): Promise<AckPlan | undefined> {
  // DISCOVER new releases into the open-work queue, then WORK a bounded slice
  // of what is open (#2497 r8, `workQueue.ts`): a release leaves only when the
  // chain shows it finished, and one that never does pins no read.
  await discoverWork<{ remitId: number }>(env, baseChainId, diamond, LATE_KIND, deploymentFloor(baseChainId), async (from, through, limit) => {
    const page = await discoverReleasedRemits(env.DB, baseChainId, from, through, limit);
    return { items: page.rows.map((r) => ({ item: String(r.remitId), block: r.block, payload: { remitId: r.remitId } })), next: page.next };
  });
  const open = await listOpenWork<{ remitId: number }>(env.KEEPER_DB, baseChainId, diamond, LATE_KIND, LATE_OPEN_SLICE);
  if (open.length === 0) return undefined;
  const ids = open.map((o) => o.payload.remitId);
  // The release ledger feeds the gate read, which feeds the receipt reads,
  // which feed the route reads: each stage leaves the next its reserve (Codex
  // #2607 r8/r9).
  const receiptCutoff = priorStageCutoffMs(deadline);
  const gateCutoff = priorStageCutoffMs(receiptCutoff);
  const ledgerCutoff = priorStageCutoffMs(gateCutoff);
  // From a start that moves each run (Codex #2607 r16): the open slice comes
  // back in a stable order, so a cutoff that always lands in its first chunk
  // would otherwise leave the rest of it unread every run.
  const byId = await settledChunkedRead(
    publicClient as never,
    ids,
    LATE_READ_CHUNK,
    (id) => ({ address: diamond, abi: REMIT_ABI, functionName: 'getRemitReservation' as const, args: [BigInt(id)] as const }),
    'remitAck late deliveries',
    ledgerCutoff,
    run,
  );
  const res = ids.map((id) => byId.get(id));
  // Retired before any send, so a failed send cannot lose them. Only a release
  // actually READ rotates to the back; an unread one keeps its place.
  // Which reservation holds each destination's COMPENSATION gate (#2571 r2):
  // a released compensation remit carries no stranded recycled share, yet its
  // late ack is what clears that gate on Base. One read per destination, not
  // per id; an unread gate counts as held (never retire on an unread value).
  const dsts = [...new Set(res.flatMap((r) => (r?.status === 'success' ? [Number((r.result as RemitReservationView).dstChainId)] : [])))];
  const gates = await settledRead(
    publicClient as never,
    dsts.map((d) => ({ address: diamond, abi: REMIT_ABI, functionName: 'getCompensationOutstanding' as const, args: [d] as const })),
    'remitAck compensation gates',
    gateCutoff,
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
  await resolveFinishedLateAlerts(env, baseChainId, diamond, finished);
  await touchOpenWork(
    env.KEEPER_DB,
    baseChainId,
    diamond,
    LATE_KIND,
    ids.filter((id, i) => res[i]?.status === 'success' && !fin.has(id)).map(String),
  );
  // The attempts feed the same rotation rule as the Pending acks (#2497 r17),
  // applied in `sendPlanned`.
  const attempts = await readAttempts(env, baseChainId, diamond, ids, 'late');
  // CLASSIFY first (Codex #2607 r2), as on the Pending path: every candidate
  // read this run has its receipt read, whatever the send budget.
  const candidates = ids.flatMap((id, i) => {
    const r = res[i];
    if (!r || r.status !== 'success') return [];
    const v = r.result as RemitReservationView;
    // An UNREAD gate is unknown (Codex #2607 r9): the reservation is still
    // classified, and reported with the gate stated as unknown, but no ack is
    // paid for on an unread value.
    if (!isLateDeliveryCandidate(v, holdsGate(id, v, true))) return [];
    const sendable = isLateDeliveryCandidate(v, holdsGate(id, v, false));
    const gate = gateOf.get(Number(v.dstChainId));
    const mirrorCfg = mirrorFor(mirrorConfigs, Number(v.dstChainId), id, 'late');
    return [{ remitId: id, v, mirrorCfg, sendable, outstanding: lateOutstanding(v, gate === null || gate === undefined ? 'unread' : gate === BigInt(id)) }];
  });
  // The receipts leave the route reads that follow them a reserve (Codex
  // #2607 r8): a mirror stalled until the receipt cutoff is abandoned there,
  // and the healthy mirrors' missing receipts are still classified.
  const { receipts, unreadable } = await readReceipts(candidates, mirrorClients, diamond, receiptCutoff, run);
  const undelivered = await classifyUndelivered(publicClient, 'late', baseChainId, diamond, candidates, receipts, unreadable, deadline, run);
  return { late: true, candidates, receipts, attempts, undelivered };
}

/** What a released candidate still waits on, as Base shows it (#2561 r2): the
 *  compensation gate it holds, else that the share is not stamped yet (a
 *  default zero is not a resolved share), else its stamped stranded share, or
 *  — when that share is zero and the gate was unread — that the gate is not
 *  known (Codex #2607 r9). */
export function lateOutstanding(
  v: { strandedRecycled?: bigint; strandedStamped?: boolean },
  holdsCompensationGate: boolean | 'unread',
): LateOutstanding {
  if (holdsCompensationGate === true) return { kind: 'gate' };
  if (v.strandedStamped !== true) return { kind: 'unstamped' };
  const wei = BigInt(v.strandedRecycled ?? 0n);
  if (wei === 0n && holdsCompensationGate === 'unread') return { kind: 'gate-unread' };
  return { kind: 'stranded', wei };
}

/** #2561 — clear the late-path undelivered alerts of the releases that just
 *  finished (the chain shows they need nothing more), whatever their reason.
 *  Only keys actually open are touched. Contained: a failure is logged and the
 *  alerts stay. */
async function resolveFinishedLateAlerts(
  env: Env,
  baseChainId: number,
  diamond: Address,
  finished: readonly number[],
): Promise<void> {
  if (finished.length === 0) return;
  try {
    const done = new Set(finished);
    for (const key of await listOpsAlertKeys(env.KEEPER_DB, undeliveredAlertPattern('late', baseChainId, diamond))) {
      const k = parseUndeliveredAlertKey(key);
      // eslint-disable-next-line no-await-in-loop
      if (k && done.has(k.remitId)) await resolveOpsAlert(env, key);
    }
  } catch (err) {
    console.error(`[keeper] remitAck late undelivered alerts not cleared this run: ${(err as Error).message}`);
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

