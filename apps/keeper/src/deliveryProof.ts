// apps/keeper/src/deliveryProof.ts
//
// #1944 consequence 1 + the transport epochs — INDEX and PROVE every reward-
// budget delivery's days on each mirror.
//
// A delivery that lands on a mirror funds the days it lists, but the chain
// learns WHICH days only when somebody supplies the list against the
// commitment the delivery's own ingress stamped (the destination's gas budget
// is spent by the ingress itself, so no per-day write rides the delivery).
// Every route is permissionless and moves no value; nothing calls them by
// itself, so this pass does, on every mirror. Every budget delivery is ROOTED
// (d6) — the mirror receiver refuses any older wire shape — and its list is
// worked chunk by chunk, each chunk with its Merkle proof:
//
//   - a delivery holding a transport EPOCH (a batch) is INDEXED
//     (`materializeTransportBatchChunk`). Until its days are indexed an epoch
//     funds nothing a claim can find;
//   - a delivery holding NO epoch (one that landed before custody activation)
//     is PROVEN (`proveDeliveryDayChunk`) — the step the #1944 delivery gate
//     waits on before a mirror day may be priced.
//
// The list is REBUILT from Base, per the runbook's reconstruction rule:
// the reservation's day list (every day the remit closed, a superset) filtered
// to the days actually funded for this chain, chunked and rooted with the
// wire's own rules (`@vaipakam/lib/d6Wire`) and checked against BOTH the
// reservation's and the packet's root before any proof is sent. Every write is
// simulated first.
//
// ALERTS (#2516) go to the OPS channel, per mirror, each raised and cleared on a
// measurement, never on what a send is assumed to have done: a delivery still
// not whole one full scan after the first scan that could have reached it (its
// days fund nothing a claim can find, and an armed day-delivery gate holds
// them). That first scan is the one that QUEUED it, so the allowance starts
// when this pass could first see the delivery, not when it arrived (#2775). A
// delivery this run worked on is READ AGAIN after its sends before it counts as
// whole. The other alert is a proof or index call that reverts for any reason other
// than the work already being done (named, with the contract's reason, a mined
// revert included). A revert alert stands only while its delivery is still open
// work on this Diamond.
//
// Gated by KEEPER_ENABLED + REWARD_DELIVERY_PROOF_ENABLED.

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  RewardEpochFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { summarizeFailure } from '@vaipakam/lib/errorDescription';
import { digestText, resolveOpsAlert, sendOpsAlert, sendOpsAlertDigest } from './opsAlert';
import { boundedRead, deadlineClient, PastRunDeadline } from './batchRead';
import { reportSendError } from './submissionQueue';
import { deploymentFloor, discoverBudgetDeliveries, finishWork, listOpenWorkPage, listOpsAlertKeys, openWorkAmong, touchOpenWork, type BudgetDeliveryRow } from './db';
import { discoverWork } from './workQueue';
import type { PassTick } from './passSchedule';
import { d6Chunk, d6Leaves, d6Proof, d6Root, fundedDaysFromBits } from '@vaipakam/lib/d6Wire';
import { hintsForDays, type DayOrderReader, type OrderPage } from './transportHints';

const ABI = [
  ...(RewardEpochFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
] as Abi;

/** Transactions per chain per tick (each indexes or proves one chunk). */
const MAX_WRITES_PER_TICK = 20;
/** How long one send may take to be mined before this tick's sends stop. */
const RECEIPT_TIMEOUT_MS = 30_000;
/** Reads per `aggregate3` (#1946). */
const READ_CHUNK = 100;
/** This pass's open-work kind (`keeper_work_open.kind`). */
const WORK_KIND = 'delivery_proof' as const;
/** Open deliveries one tick works on (the rest wait their turn in rotation). */
const OPEN_SLICE = 200;
/** This pass's cadence in seconds. `passSchedule` schedules the pass from it,
 *  so the alert below, aged in scans, always counts real scans (#2775). */
export const PASS_CADENCE_SEC = 5 * 60;
/** A delivery not whole this long after this pass first QUEUED it is reported
 *  (#2516): the scan that found it and one whole further scan have both left
 *  it not whole.
 *
 *  The clock starts at the queueing, never at the packet's arrival (#2775).
 *  The pass finds a delivery only once the indexer's settled ledger holds it,
 *  and how long that takes is the CHAIN's: the indexer reads up to the `safe`
 *  head, which trails by minutes on Arbitrum (its L1 batch posting) and barely
 *  on BNB. Aged from arrival, a normal index on Arbitrum landed 8.8 and 9.4
 *  min in against a 10-min bound, one slow tick from a false alert, because
 *  the chain's settlement lag was spent out of the keeper's allowance. Aged
 *  from the queueing, both readings are the keeper's own clock, too.
 *
 *  One and a half cadences puts the bound midway between the scan after the
 *  finding (about one cadence in, still allowed) and the one after that
 *  (about two in, reported), so a late or early tick moves neither across it.
 *  How late the indexer records a delivery is not this alert's to judge: an
 *  undiscovered delivery is in no queue and raises nothing here. */
export const AWAITING_ALERT_SEC = PASS_CADENCE_SEC + PASS_CADENCE_SEC / 2;
/** What a run keeps for its alerts after its last send. */
export const PASS_ALERT_WINDOW_MS = 15_000;
/** Repeat an open alert at most this often. */
const ALERT_REPEAT_SEC = 6 * 3600;
/** Reverts that mean the work is ALREADY DONE (another caller, or this pass
 *  last run, got there first). Never a failure. */
export const ALREADY_DONE = new Set(['TransportChunkAlreadyIndexed']);

/** What a packet's ingress recorded, as the pass reads it. */
export interface PacketState {
  /** Where the packet was remitted from, by the packet's own record. */
  sourceChainId: number;
  remitter: Address;
  remitId: bigint;
  kind: number;
  batchId: Hex;
  dayListRoot: Hex;
  chunkCount: number;
  /** Bit `i` set = chunk `i` landed (indexed or proven). */
  chunksIndexed: bigint;
  disposed: bigint;
  /** When the packet's ingress landed (unix seconds). */
  arrivedAt: number;
}

export type ProofAction =
  | { kind: 'indexChunk'; batchId: Hex; chunkIndex: number; dayIds: bigint[]; proof: Hex[] }
  | { kind: 'proveChunk'; packetHash: Hex; chunkIndex: number; dayIds: bigint[]; proof: Hex[] };

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/**
 * The actions a delivery still needs. Pure: the packet's recorded state and
 * its REBUILT day list (already checked against the root by the caller) in;
 * one call per chunk not yet landed out — nothing for a disposed packet, a
 * non-budget packet, or one whose list cannot be had.
 */
export function planDelivery(args: { packetHash: Hex; packet: PacketState; rootedDays: bigint[] | null }): ProofAction[] {
  const { packetHash, packet } = args;
  if (!packetMayNeedWork(packet)) return [];
  const days = args.rootedDays;
  if (!days || days.length === 0) return [];
  const leaves = d6Leaves(days);
  if (leaves.length !== packet.chunkCount) return [];
  const batched = packet.batchId !== ZERO32;
  const out: ProofAction[] = [];
  for (let c = 0; c < packet.chunkCount; c++) {
    if ((packet.chunksIndexed >> BigInt(c)) & 1n) continue;
    const chunk = d6Chunk(days, c);
    const proof = d6Proof(leaves, c);
    out.push(
      batched
        ? { kind: 'indexChunk', batchId: packet.batchId, chunkIndex: c, dayIds: chunk, proof }
        : { kind: 'proveChunk', packetHash, chunkIndex: c, dayIds: chunk, proof },
    );
  }
  return out;
}

/**
 * The canonical (Base) chain a mirror's deliveries come from, from
 * `getRewardReporterConfig` — `(rewardMessenger, localChainId, baseChainId,
 * isCanonical, grace)`. Field 2, never field 1: field 1 is the MIRROR's own id,
 * and reading it sent every rooted-list rebuild to the mirror itself, where the
 * reservation reads as empty and no rooted delivery was ever indexed or proven.
 * Null on the canonical chain, which funds itself.
 */
export function canonicalChainOf(cfg: readonly [Address, number, number, boolean, bigint]): number | null {
  if (cfg[3]) return null;
  const base = Number(cfg[2]);
  return base > 0 ? base : null;
}

/** Whether a packet can still need a write — checked BEFORE any read of its
 *  rooted list, so a finished one costs nothing. A delivery is FINISHED on
 *  chain (and leaves the pass's queue for good, Codex #2489 r1) exactly when
 *  this is false: disposed, not a budget packet, no rooted list (nothing to
 *  prove), or every chunk landed. */
export function packetMayNeedWork(packet: PacketState): boolean {
  if (packet.kind !== 1 || packet.disposed !== 0n || packet.dayListRoot === ZERO32) return false;
  // The chunk bitmap is a uint256, so "every chunk" is 2^n − 1 for n ≤ 256 —
  // never -1n, which no non-negative bitmap can equal: a full 256-chunk
  // packet would never be seen finished and would be rebuilt every tick
  // (#2497 r1).
  const all = (1n << BigInt(Math.min(packet.chunkCount, 256))) - 1n;
  return packet.chunkCount > 0 && (packet.chunksIndexed & all) !== all;
}

export async function runDeliveryProof(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'deliveryProof', 'REWARD_DELIVERY_PROOF_ENABLED')) return;
  const chains = getChainConfigs(env);
  const byId = new Map(chains.map((c) => [c.id, c]));
  // Inside this run's own cadence (#2497 r18): mirrors CONCURRENTLY (each chain
  // has its own nonce lane in the submission queue), and no new send past the
  // run's deadline — the rest stays queued for the next run, five minutes on.
  // Sends stop a little before the run's end so its alerts still go out.
  const deadline = tick.deadlineMs - PASS_ALERT_WINDOW_MS;
  await Promise.all(
    chains.map(async (chain) => {
      try {
        await proveOnMirror(env, chain, byId, deadline, tick.deadlineMs);
      } catch (err) {
        console.error(`[keeper] deliveryProof chain=${chain.id} failed:`, err);
      }
    }),
  );
}

async function proveOnMirror(
  env: Env,
  chain: ChainConfig,
  byId: Map<number, ChainConfig>,
  deadline: number,
  alertDeadline: number = deadline,
): Promise<void> {
  // Every read of this run is refused past its deadline (`deadlineClient`).
  const client = deadlineClient(createPublicClient({ transport: http(chain.rpc) }), deadline) as PublicClient;
  const diamond = chain.diamond as Address;
  const cfg = (await client.readContract({
    address: diamond,
    abi: ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const baseChainId = canonicalChainOf(cfg);
  if (baseChainId === null) return; // the canonical chain funds itself: nothing is delivered to it

  // DISCOVER new deliveries into the open-work queue, then WORK a bounded
  // slice of what is open (#2497 r8, `workQueue.ts`). A delivery leaves the
  // queue only when the chain shows it whole; one that never completes holds
  // only its own slot and pins no read.
  const discovery = await discoverWork<BudgetDeliveryRow>(env, chain.id, diamond, WORK_KIND, deploymentFloor(chain.id), async (from, through, limit) => {
    const page = await discoverBudgetDeliveries(env.DB, chain.id, from, through, limit);
    return { items: page.rows.map((r) => ({ item: r.packetHash.toLowerCase(), block: r.block, payload: r })), next: page.next };
  });
  // One past the slice, so the run knows whether the slice is the whole queue.
  const page = await listOpenWorkPage<BudgetDeliveryRow>(env.KEEPER_DB, chain.id, diamond, WORK_KIND, OPEN_SLICE + 1);
  // The slice is the whole queue only when the page did not overflow AND every
  // row in it could be read (Codex #2599 r3): an unreadable row stays queued
  // but unseen, so a run that skipped one has not measured every delivery.
  // Nor is the queue every delivery until discovery has caught up with what
  // the indexer has recorded (Codex #2599 r5): a backlog past this run's
  // discovery pages may hold one already overdue.
  const overflow = page.rows > OPEN_SLICE || !discovery.caughtUp;
  const unreadRows = Math.min(page.rows, OPEN_SLICE + 1) - page.items.length;
  const open = page.items.slice(0, OPEN_SLICE);
  const nowSec = Math.floor(Date.now() / 1000);
  const openWork = (items: readonly string[]) => openWorkAmong(env.KEEPER_DB, chain.id, diamond, WORK_KIND, items);
  if (open.length === 0) {
    // Nothing readable open: nothing is awaiting — measured only if no row was
    // skipped — and no revert alert can stand (its delivery is no longer open
    // work).
    await raiseDeliveryAlerts(env, chain.id, {
      failures: new Map(),
      cleared: new Set(),
      openWork,
      awaiting: [],
      awaitingMeasured: !overflow && unreadRows === 0,
      nowSec,
      deadline: alertDeadline,
    });
    return;
  }
  const rows = open.map((o) => o.payload);
  // When this pass first queued each delivery: the clock its "not whole"
  // alert runs on (#2775).
  const queuedAt = new Map(open.map((o) => [o.item, o.addedAt] as const));

  const { packets, unread: unreadPackets } = await readPackets(client, diamond, rows.map((r) => r.packetHash as Hex), deadline);
  // Packets read as finished are retired however the tick ends (a failed
  // send, no key to send with), so they are never read again.
  const finished = new Set<string>();
  // The chain each rooted packet was REMITTED from, by the packet's own
  // record (#2497 r6) — never the canonical chain as configured today.
  const sources = sourceReader(byId, deadline);
  const ctx = buildKeeperContext(env, chain, client as never, { notAfterMs: deadline });
  const canSend = Boolean(ctx?.wallet.account);
  if (!canSend) console.warn(`[keeper] deliveryProof chain=${chain.id}: no keeper key — nothing sent`);
  const budget = { writes: canSend ? MAX_WRITES_PER_TICK : 0 };
  /** The rows this tick actually EXAMINED (#2497 r16): only these rotate to the
   *  back. A row the budget never reached keeps its place, so the rotation
   *  moves through the whole queue instead of re-serving the slice's head. */
  const examined = new Set<string>();
  /** Moved packets a fresh read after the sends found still not whole. */
  const remeasured = new Set<string>();
  /** Packets whose call reverted this run, with why (#2516). */
  const failures = new Map<string, string>();
  /** Packets this run worked with every call going through: their revert
   *  alert, if any, is disproved. Says nothing about whether the delivery is
   *  now whole — the run's budget may have stopped before its last chunk. */
  const clean = new Set<string>();
  /** Packets whose delivery this run read as NOT whole (a plan was built). */
  const notWhole = new Set<string>();
  /** Of those, the ones at least one of whose calls landed or was already
   *  done: their state may have moved, so they are read again before counting. */
  const moved = new Set<string>();
  // Whatever ends the work — a read that throws, a queue write that fails —
  // the refusals this run measured are still raised (Codex #2599 r4): they
  // live only in memory until then.
  let workErr: unknown = null;
  try {
    for (const row of rows) {
      const key = row.packetHash.toLowerCase();
      // The deadline binds whether or not there is a key to send with.
      if (Date.now() >= deadline || (canSend && budget.writes <= 0)) break; // the rest keep their turn
      const packet = packets.get(key);
      if (!packet) continue; // unread, or not arrived: it keeps its place and is read first next run
      examined.add(key); // only a row actually READ rotates to the back
      if (!packetMayNeedWork(packet)) {
        finished.add(key);
        continue;
      }
      // One row's failed read (a canonical RPC outage, say) skips that row, never
      // the chain's whole pass.
      let plan: DeliveryPlan;
      try {
        // eslint-disable-next-line no-await-in-loop
        plan = await actionsFor(chain.id, row, packet, sources);
      } catch (err) {
        console.error(`[keeper] deliveryProof packet=${row.packetHash} read failed: ${summarizeFailure(err)}`);
        continue;
      }
      if (plan.complete) {
        finished.add(key);
        continue;
      }
      notWhole.add(key);
      const refused: string[] = [];
      let reached = true;
      for (const a of plan.actions) {
        if (budget.writes <= 0 || Date.now() >= deadline) {
          reached = false;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const out = await send(ctx!, budget, a);
        if (out.kind === 'failed') {
          // Named in the journal the moment it is measured, scoped to the days
          // the call covers (Codex #2599 r4): an alert names only as many as
          // fit, and points here for the rest.
          const what = `${actionScope(a)}: ${out.reason}`;
          console.warn(`[keeper] deliveryProof chain=${chain.id} packet=${key} refused: ${what}`);
          refused.push(what);
        } else if (out.kind === 'stopped') reached = false;
        else moved.add(key);
      }
      if (refused.length > 0) failures.set(key, refused.join('; '));
      else if (reached && plan.actions.length > 0) clean.add(key);
    }
    // MEASURE what the sends did (Codex #2599 r1): a delivery counts as whole
    // only on a fresh read, never because its calls went through. Bounded by
    // a share of the alert window, so the alerts still go out; a delivery the
    // re-read did not reach stays undetermined.
    if (moved.size > 0) {
      const verifyDeadline = deadline + Math.floor((alertDeadline - deadline) / 2);
      const after = await measureWhole(env, chain, diamond, rows.filter((r) => moved.has(r.packetHash.toLowerCase())), verifyDeadline);
      for (const [key, whole] of after) {
        if (whole) finished.add(key);
        else remeasured.add(key);
      }
    }
  } catch (err) {
    workErr = err;
  }
  try {
    await finishWork(env.KEEPER_DB, chain.id, diamond, WORK_KIND, [...finished]);
    // The rest of the slice goes to the back of the rotation.
    await touchOpenWork(env.KEEPER_DB, chain.id, diamond, WORK_KIND, [...examined].filter((k) => !finished.has(k)));
  } catch (err) {
    workErr ??= err;
  }

  // A delivery this run READ as not whole — and, if its sends may have moved
  // it, read again as still not whole — aged from when this pass first queued
  // it (a packet not yet arrived awaits nothing on this mirror). A run that could not
  // settle every open delivery — a packet or plan unread, a row the run's
  // budget never reached, a re-read that did not land, a slice that is not the
  // whole queue — can raise the alert but never clear it.
  const { awaiting, undetermined } = awaitingDeliveries({ rows, packets, queuedAt, finished, notWhole, moved, remeasured, nowSec });
  // A run whose work ended early has not measured everything awaiting: what it
  // did read is still reported, as a lower bound, and it clears nothing
  // (Codex #2599 r6).
  const measured = workErr === null;
  // A delivery this run measured whole has nothing a refusal could be holding
  // back (another caller finished it, say): no revert alert for it (Codex
  // #2599 r3). Its refusal stays in the journal.
  for (const key of finished) failures.delete(key);
  await raiseDeliveryAlerts(env, chain.id, {
    failures,
    cleared: new Set([...clean, ...finished]),
    openWork,
    awaiting,
    awaitingMeasured: measured && unreadPackets.size === 0 && undetermined === 0 && !overflow && unreadRows === 0,
    nowSec,
    deadline: alertDeadline,
  });
  if (workErr !== null) throw workErr;
}

/** Day ids as their contiguous runs — `10–12, 15` — so a list with a gap
 *  never reads as covering the days in the gap (Codex #2599 r6). Pure;
 *  exported for the tests. */
export function dayRuns(ids: readonly bigint[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1n) j++;
    runs.push(j === i ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(', ');
}

/** Which days a call covers, for an alert that names a refusal (Codex #2599
 *  r4): a delivery is held back only by the chunk refused — its other chunks
 *  land on their own. Pure. */
export function actionScope(a: ProofAction): string {
  const n = a.dayIds.length;
  return `chunk ${a.chunkIndex}, ${n} day${n === 1 ? '' : 's'}${n === 0 ? '' : ` (days ${dayRuns(a.dayIds)})`}`;
}

/**
 * The overdue deliveries a run MEASURED as not whole, and how many open
 * deliveries it could not settle either way. A delivery counts as not whole
 * only on a read: its first read built a plan, and — when any of its calls
 * landed or was already done — a fresh read after the sends still found it
 * not whole. One whose re-read did not land is undetermined, as is one never
 * read; an unread packet is the caller's to count. It is overdue once
 * {@link AWAITING_ALERT_SEC} has passed since this pass first QUEUED it
 * (`queuedAt`, by lowercase packet hash), whenever the packet arrived (#2775).
 * Pure; pinned by the tests.
 */
export function awaitingDeliveries(m: {
  rows: readonly { packetHash: string }[];
  packets: ReadonlyMap<string, { arrivedAt: number }>;
  queuedAt: ReadonlyMap<string, number>;
  finished: ReadonlySet<string>;
  notWhole: ReadonlySet<string>;
  moved: ReadonlySet<string>;
  remeasured: ReadonlySet<string>;
  nowSec: number;
}): { awaiting: AwaitingDelivery[]; undetermined: number } {
  const awaiting: AwaitingDelivery[] = [];
  let undetermined = 0;
  for (const row of m.rows) {
    const key = row.packetHash.toLowerCase();
    if (m.finished.has(key)) continue;
    const p = m.packets.get(key);
    if (!p) continue; // not arrived, or unread (the caller counts those)
    if (!m.notWhole.has(key) || (m.moved.has(key) && !m.remeasured.has(key))) {
      undetermined += 1;
      continue;
    }
    const queued = m.queuedAt.get(key);
    // Every row comes from the queue, so this is never missing; if it were, the
    // run could not age the delivery, and says so as undetermined.
    if (queued === undefined || !Number.isSafeInteger(queued)) {
      undetermined += 1;
      continue;
    }
    if (m.nowSec - queued > AWAITING_ALERT_SEC) awaiting.push({ packetHash: key, arrivedAt: p.arrivedAt, queuedAt: queued });
  }
  return { awaiting, undetermined };
}

/** An open delivery a run measured as not whole past its allowance. */
export interface AwaitingDelivery {
  packetHash: string;
  /** When its packet reached this mirror (block time). */
  arrivedAt: number;
  /** When this pass first queued it (keeper clock) — what the alert ages. */
  queuedAt: number;
}

/** What a run measured, for its alerts. */
export interface DeliveryAlertInput {
  /** Packets whose call reverted this run, with why. */
  failures: ReadonlyMap<string, string>;
  /** Packets whose revert alert this run disproves (finished, or every call went through). */
  cleared: ReadonlySet<string>;
  /** Which of the given packets are still open work on this Diamond. A revert
   *  alert whose delivery is not — retired by a run whose clear did not land,
   *  or a Diamond since replaced — has nothing left to stand on. */
  openWork: (packets: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Open deliveries queued more than {@link AWAITING_ALERT_SEC} ago — all of
   *  them when `awaitingMeasured`, otherwise only those this run could read. */
  awaiting: readonly AwaitingDelivery[];
  /** False when the run could not look at every open delivery. */
  awaitingMeasured: boolean;
  nowSec: number;
  /** Past this, clears and the "not whole" alert wait for the next run, which
   *  measures them again; a refusal is raised regardless. */
  deadline: number;
}

/** Raise or clear the pass's ops alerts for one mirror. Exported for tests. */
export async function raiseDeliveryAlerts(env: Env, chainId: number, m: DeliveryAlertInput): Promise<void> {
  const prefix = `delivery-revert:${chainId}:`;
  let open: Set<string>;
  try {
    open = new Set(await listOpsAlertKeys(env.KEEPER_DB, 'delivery-', chainId));
  } catch (err) {
    // Nothing is cleared on an unread alert table, but this run's refusals are
    // still raised: the next run cannot measure them again.
    console.error(`[keeper] deliveryProof chain=${chainId}: open alerts unread, nothing cleared this run: ${summarizeFailure(err)}`);
    open = new Set();
  }
  // What the next run can MEASURE again — a clear, the "not whole" state —
  // waits for it once this run is out of time. A refusal cannot be measured
  // again (a later call may go through), so it is raised even past the
  // deadline (Codex #2599 r3): never dropped. All of them go in one post, so
  // that overrun is one send's own timeout, however many refused.
  const toggle = async (key: string, on: boolean, text: () => string): Promise<void> => {
    if (Date.now() >= m.deadline) return;
    if (on) await sendOpsAlert(env, key, text(), ALERT_REPEAT_SEC, m.nowSec, chainId);
    else if (open.has(key)) await resolveOpsAlert(env, key);
  };
  const tag = `[chain ${chainId}] reward delivery proofs`;
  // Every refusal in ONE post (Codex #2599 r4), so however many deliveries
  // refuse, raising them costs one bounded send; each keeps its own key, so it
  // repeats and clears on its own.
  if (m.failures.size > 0) {
    await sendOpsAlertDigest(
      env,
      (n) => `${tag}: a proof or index call for ${n} deliver${n === 1 ? 'y' : 'ies'} was refused by the contract:`,
      [...m.failures].map(([packet, why]) => ({ key: `${prefix}${packet}`, id: packet, detail: why })),
      'Until a refused call goes through, the days it covers fund nothing a claim can find, and an armed day-delivery gate holds them. Days of the same delivery that are already indexed or proven are not affected.',
      ALERT_REPEAT_SEC,
      m.nowSec,
      chainId,
    );
  }
  // Open revert alerts this run did not re-raise: cleared when this run
  // disproved them, or when their delivery is no longer open work at all.
  const standing = [...open].filter((k) => k.startsWith(prefix) && !m.failures.has(k.slice(prefix.length))).map((k) => k.slice(prefix.length));
  if (standing.length > 0) {
    let stillOpen: ReadonlySet<string> | null = null;
    try {
      stillOpen = await m.openWork(standing.filter((p) => !m.cleared.has(p)));
    } catch (err) {
      console.error(`[keeper] deliveryProof chain=${chainId}: open work unread, only disproved revert alerts cleared: ${summarizeFailure(err)}`);
    }
    for (const packet of standing) {
      const gone = m.cleared.has(packet) || (stillOpen !== null && !stillOpen.has(packet));
      // eslint-disable-next-line no-await-in-loop
      if (gone) await toggle(`${prefix}${packet}`, false, () => '');
    }
  }
  if (m.awaiting.length > 0 || m.awaitingMeasured) {
    const sorted = [...m.awaiting].sort((a, b) => a.arrivedAt - b.arrivedAt);
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    const lines = sorted.map((a) => `${a.packetHash} arrived ${iso(a.arrivedAt)}, found ${iso(a.queuedAt)}`);
    const n = m.awaiting.length;
    // Every one is named in the journal on every run that finds it; the alert
    // names as many as one message holds and counts the rest (Codex #2599 r5).
    if (n > 0) console.warn(`[keeper] deliveryProof chain=${chainId} not whole ${AWAITING_ALERT_SEC / 60} min after found: ${lines.join('; ')}`);
    // A run that could not read every open delivery knows only a lower bound,
    // and only the order of the ones it read: say so.
    const count = m.awaitingMeasured ? `${n}` : `at least ${n}`;
    const order = m.awaitingMeasured ? 'oldest first' : 'oldest of those this run could read first; it could not look at every open delivery';
    await toggle(`delivery-awaiting:${chainId}:all`, n > 0, () =>
      digestText(
        `${tag}: ${count} deliver${n === 1 && m.awaitingMeasured ? 'y is' : 'ies are'} not yet whole two scans after this keeper found ${n === 1 && m.awaitingMeasured ? 'it' : 'them'} (more than ${AWAITING_ALERT_SEC / 60} min; ${order}):`,
        lines,
        'Their days not yet indexed or proven fund nothing a claim can find, and an armed day-delivery gate holds them.',
      ),
    );
  }
}

/**
 * Whether each of `rows`' deliveries is whole NOW, by a fresh read bounded by
 * `deadline` (Codex #2599 r1). Read only for the deliveries a run's sends may
 * have moved; the verdict is {@link packetMayNeedWork}'s on that read, so a
 * list with a chunk still out reads not whole. A delivery whose read did not
 * land is absent from the result: undetermined, not whole and not "not whole".
 */
async function measureWhole(
  env: Env,
  chain: ChainConfig,
  diamond: Address,
  rows: readonly BudgetDeliveryRow[],
  deadline: number,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (rows.length === 0 || Date.now() >= deadline) return out;
  const client = deadlineClient(createPublicClient({ transport: http(chain.rpc) }), deadline) as PublicClient;
  try {
    const { packets } = await readPackets(client, diamond, rows.map((r) => r.packetHash as Hex), deadline);
    for (const row of rows) {
      const key = row.packetHash.toLowerCase();
      const packet = packets.get(key);
      if (packet) out.set(key, !packetMayNeedWork(packet));
    }
  } catch (err) {
    console.warn(`[keeper] deliveryProof chain=${chain.id}: re-read after sends failed, left undetermined: ${summarizeFailure(err)}`);
  }
  return out;
}

/** A client per remitting chain, made on first use. */
function sourceReader(byId: ReadonlyMap<number, ChainConfig>, deadline: number): (chainId: number) => PublicClient | null {
  const made = new Map<number, PublicClient>();
  return (chainId) => {
    const c = byId.get(chainId);
    if (!c) return null;
    let cl = made.get(chainId);
    if (!cl) {
      cl = deadlineClient(createPublicClient({ transport: http(c.rpc) }), deadline) as PublicClient;
      made.set(chainId, cl);
    }
    return cl;
  };
}

/** What one delivery still needs, and whether it is already finished. */
interface DeliveryPlan {
  actions: ProofAction[];
  complete: boolean;
}

/** Exported for the tests. */
export async function actionsFor(
  chainId: number,
  row: BudgetDeliveryRow,
  packet: PacketState,
  sources: (chainId: number) => PublicClient | null,
): Promise<DeliveryPlan> {
  const packetHash = row.packetHash as Hex;
  if (!packetMayNeedWork(packet)) return { actions: [], complete: true };
  // The reservation lives where the packet says it was remitted from — its
  // authenticated `remitter` on its `sourceChainId`, under its `remitId`
  // (#2497 r6). The canonical Diamond configured TODAY may be a fresh deploy
  // whose remit ids restarted, and reading there would match nothing (or the
  // wrong reservation) and leave the packet gated forever. A wrong source
  // cannot pass anyway: the rebuilt root must equal the packet's.
  const sourceClient = sources(packet.sourceChainId);
  if (!sourceClient) {
    console.warn(`[keeper] deliveryProof packet=${packetHash}: no RPC for its source chain ${packet.sourceChainId} — cannot rebuild its list`);
    return { actions: [], complete: false };
  }
  const rootedDays = await rebuildRootedList(sourceClient, packet.remitter, chainId, packet.remitId, packet.dayListRoot);
  if (!rootedDays) return { actions: [], complete: false };
  return { actions: planDelivery({ packetHash, packet, rootedDays }), complete: false };
}

/**
 * The runbook's reconstruction rule: Base's reservation lists every day the
 * remit CLOSED; the wire lists only the days FUNDED for this chain, in order.
 * The funded ones are read from the reservation's own record, written once at
 * dispatch (Codex #2489 r2): the live per-day mark this used to filter by is
 * deleted by a release and rewritten by a later remit of the same days, so a
 * delivery that executed after its release rebuilt an empty or wrong list
 * forever. Then chunk, root — and refuse unless the rebuilt root equals the
 * reservation's AND the packet's, so a wrong list is never submitted.
 *
 * A reservation WITHOUT the record is declined, never rebuilt from the live
 * mark (#2516 forbids it, and this used to be the fallback). Slices 2–3 reach
 * a chain only by fresh deploy (owner decision O1 = A), so every reservation a
 * Diamond running this code holds carries the record; one that does not is an
 * unknown, logged by name, and the day stays gated rather than proven from a
 * list that may have been rewritten.
 */
async function rebuildRootedList(
  sourceClient: PublicClient,
  remitter: Address,
  chainId: number,
  remitId: bigint,
  packetRoot: Hex,
): Promise<bigint[] | null> {
  if (remitId === 0n || /^0x0{40}$/i.test(remitter)) return null;
  const r = (await sourceClient.readContract({
    address: remitter,
    abi: ABI,
    functionName: 'getRemitReservation',
    args: [remitId],
  })) as { dayIds: readonly bigint[]; dayListRoot: Hex; dstChainId: number; fundedDayBits?: readonly bigint[] };
  if (Number(r.dstChainId) !== chainId) {
    console.warn(`[keeper] deliveryProof remit=${remitId}: the reservation names chain ${r.dstChainId}, not ${chainId} — skipped`);
    return null;
  }
  const recorded = fundedDaysFromBits(r.dayIds, r.fundedDayBits ?? []);
  if (recorded === null) {
    console.warn(
      `[keeper] deliveryProof remit=${remitId}: the reservation carries no funded-day record, so its list is not rebuilt (never from the live remitted map) — the day stays gated`,
    );
    return null;
  }
  return checkedRoot(recorded, r.dayListRoot, packetRoot, remitId);
}

/** `funded`, only when its d6 root equals BOTH the reservation's and the
 *  packet's; null (and a warning) otherwise, so a wrong list is never sent. */
function checkedRoot(funded: bigint[], reservationRoot: Hex, packetRoot: Hex, remitId: bigint): bigint[] | null {
  if (funded.length === 0) return null;
  const root = d6Root(d6Leaves(funded));
  if (root.toLowerCase() !== reservationRoot.toLowerCase() || root.toLowerCase() !== packetRoot.toLowerCase()) {
    console.warn(`[keeper] deliveryProof remit=${remitId}: rebuilt root ${root} disagrees with the reservation or the packet — skipped`);
    return null;
  }
  return funded;
}

/** The ingress packets of `hashes` that have ARRIVED, and the ones whose read
 *  failed (`unread`). A hash in neither has not arrived yet. */
async function readPackets(
  client: PublicClient,
  diamond: Address,
  hashes: Hex[],
  deadline: number,
): Promise<{ packets: Map<string, PacketState>; unread: Set<string> }> {
  const out = new Map<string, PacketState>();
  const unread = new Set<string>();
  for (let i = 0; i < hashes.length; i += READ_CHUNK) {
    const chunk = hashes.slice(i, i + READ_CHUNK);
    // Bounded by the run's deadline (#2497 r19): an unread packet is simply
    // read again in its turn.
    // eslint-disable-next-line no-await-in-loop
    const res = await boundedRead(
      client as never,
      chunk.map((h) => ({ address: diamond, abi: ABI, functionName: 'getIngressPacket' as const, args: [h] as const })),
      'deliveryProof packets',
      deadline,
    );
    res.forEach((r, j) => {
      if (!r || r.status !== 'success') {
        unread.add(chunk[j].toLowerCase());
        return;
      }
      const p = r.result as {
        sourceChainId: number;
        remitter: Address;
        remitId: bigint;
        kind: number;
        batchId: Hex;
        dayListRoot: Hex;
        chunkCount: number;
        chunksIndexed: bigint;
        disposed: bigint;
        arrivedAt: bigint;
      };
      if (!p.arrivedAt) return;
      out.set(chunk[j].toLowerCase(), {
        sourceChainId: Number(p.sourceChainId),
        remitter: p.remitter,
        remitId: BigInt(p.remitId),
        kind: Number(p.kind),
        batchId: p.batchId,
        dayListRoot: p.dayListRoot,
        chunkCount: Number(p.chunkCount),
        chunksIndexed: BigInt(p.chunksIndexed),
        disposed: BigInt(p.disposed),
        arrivedAt: Number(p.arrivedAt),
      });
    });
  }
  return { packets: out, unread };
}

/** One contract call: the function and its arguments. */
interface Call {
  functionName: string;
  args: readonly unknown[];
}

/** The UNHINTED call for an action — the cheap common case. */
function callFor(a: ProofAction): Call {
  return a.kind === 'indexChunk'
    ? { functionName: 'materializeTransportBatchChunk', args: [a.batchId, BigInt(a.chunkIndex), a.dayIds, a.proof, [], []] }
    : { functionName: 'proveDeliveryDayChunk', args: [a.packetHash, BigInt(a.chunkIndex), a.dayIds, a.proof] };
}

/** Whether `err` is the contract refusing an unhinted link past its bounded
 *  walk — the one failure a verified hint cures. Read from the decoded revert,
 *  with the message as a fallback for a node that returns no data. */
export function isWalkExceeded(err: unknown): boolean {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'TransportIndexWalkExceeded') {
      return true;
    }
  }
  return String((err as { message?: string })?.message ?? '').includes('TransportIndexWalkExceeded');
}

/** The chain's own day-order views, read through `client` (#2489 r2). */
function dayOrderReader(client: PublicClient, diamond: Address): DayOrderReader {
  const read = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: diamond, abi: ABI, functionName, args } as never) as Promise<unknown>;
  const asPage = (r: unknown): OrderPage => {
    const [page, arrivedAt, next] = r as readonly [readonly Hex[], readonly (bigint | number)[], Hex];
    return { page, arrivedAt: arrivedAt.map((x) => BigInt(x)), next };
  };
  return {
    cursor: async (day) => ((await read('getTransportDayIndex', [day])) as readonly [bigint, Hex])[1],
    listFrom: async (day, from, limit) => asPage(await read('getTransportDayBatchesFrom', [day, from, BigInt(limit)])),
    lateFrom: async (day, from, limit) => asPage(await read('getTransportDayLateFrom', [day, from, BigInt(limit)])),
  };
}

/** The HINTED call for an index action, its hints derived from the chain's
 *  own views and verified by the contract (`transportHints.ts`): a chunk links
 *  every day it carries. */
async function hintedCallFor(ctx: KeeperContext, a: ProofAction): Promise<Call | null> {
  if (a.kind !== 'indexChunk') return null;
  const client = ctx.client as unknown as PublicClient;
  const packet = (await client.readContract({
    address: ctx.diamond,
    abi: ABI,
    functionName: 'getIngressPacket',
    args: [a.batchId],
  } as never)) as { arrivedAt: bigint | number };
  const arrived = BigInt(packet.arrivedAt);
  const h = await hintsForDays(dayOrderReader(client, ctx.diamond), a.dayIds, 0, a.dayIds.length, a.batchId, arrived);
  return {
    functionName: 'materializeTransportBatchChunk',
    args: [a.batchId, BigInt(a.chunkIndex), a.dayIds, a.proof, h.hints, h.lateHints],
  };
}

/** What a send did: `ok` (landed, or the work was already done), `failed`
 *  (a revert, with why), or `stopped` (not sent, or no receipt in time — this
 *  run sends no more and the next re-reads). */
type SendOutcome = { kind: 'ok' } | { kind: 'failed'; reason: string } | { kind: 'stopped' };

/** A refused call: the work already done, or a reason to report. (The proof
 *  and index calls are deliberately not pausable, so a pause is not a case.)
 *  Pure; exported for the tests. */
export function classifyRevert(err: unknown): { kind: 'done' } | { kind: 'failed'; reason: string } {
  const name = revertName(err);
  if (name !== undefined && ALREADY_DONE.has(name)) return { kind: 'done' };
  return { kind: 'failed', reason: name ?? summarizeFailure(err) };
}

async function send(ctx: KeeperContext, budget: { writes: number }, a: ProofAction): Promise<SendOutcome> {
  let call = callFor(a);
  const simulate = (c: Call) =>
    ctx.client.simulateContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: c.functionName,
      args: c.args as never,
      account: ctx.wallet.account!,
    });
  try {
    await simulate(call);
  } catch (err) {
    // A day too crowded for the contract's bounded walk (Codex #2489 r2):
    // retry once with verified hints, rather than skipping the same action
    // on every tick and leaving the batch forever short of whole.
    const hinted = isWalkExceeded(err) ? await hintedCallFor(ctx, a).catch(() => null) : null;
    if (!hinted) {
      console.log(`[keeper] deliveryProof ${call.functionName} skipped: ${summarizeFailure(err)}`);
      return outcomeOf(err, call.functionName);
    }
    try {
      await simulate(hinted);
      call = hinted;
    } catch (err2) {
      console.log(`[keeper] deliveryProof ${hinted.functionName} (hinted) skipped: ${summarizeFailure(err2)}`);
      return outcomeOf(err2, hinted.functionName);
    }
  }
  try {
    const hash = await ctx.wallet.writeContract({
      address: ctx.diamond,
      abi: ABI,
      functionName: call.functionName,
      args: call.args,
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never);
    budget.writes -= 1;
    console.log(`[keeper] deliveryProof ${call.functionName} chain=${ctx.chainId} tx=${hash}`);
    // Wait for inclusion before the next send (the matcher's pattern): the
    // liquidator and matcher sign from the same account, so a burst of
    // unmined sends would race them for nonces. Every step here is
    // idempotent; one that does not land in time ends this pass's sends for
    // the tick and the next tick re-reads the packet.
    // Never past the run's send deadline (Codex #2599 r2): what is left of the
    // run after it belongs to the re-read and the alerts, and a refusal held in
    // memory would be lost if they ran out of time. A send not mined by then is
    // `stopped`, and the next run re-reads its packet.
    const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs(ctx.notAfterMs) });
    if (receipt.status !== 'success') {
      console.error(`[keeper] deliveryProof ${call.functionName} reverted on chain: tx=${hash}`);
      return await minedRevertOutcome(simulate, call, hash);
    }
    return { kind: 'ok' };
  } catch (err) {
    // The contract refusing the call before broadcast — gas estimation after
    // the state moved since the simulation (Codex #2599 r3) — is a refused
    // call like any other, classified by the same rule. Only a failure that
    // carries no contract reason (transport, nonce, a receipt not in time)
    // stops this run's sends.
    const refused = refusedBeforeBroadcast(err, call.functionName);
    if (refused) {
      console.log(`[keeper] deliveryProof ${call.functionName} refused before broadcast: ${summarizeFailure(err)}`);
      return refused;
    }
    reportSendError(`[keeper] deliveryProof ${call.functionName}`, err, `send failed: ${summarizeFailure(err)}`);
    budget.writes = 0;
    return { kind: 'stopped' };
  }
}

/**
 * A MINED revert, classified by the same rule as a refused simulation (Codex
 * #2599 r1): the call is simulated again on the state the revert left. Another
 * caller finishing the same chunk or admission between this send's simulation
 * and its inclusion reads "already done" now — no failure. Any other refusal is
 * named with the contract's reason. A call that would now go through (the
 * revert was not the contract's, say out of gas) or a re-check that cannot be
 * made is a failure naming the transaction, so the operator can look it up.
 */
export async function minedRevertOutcome(simulate: (c: Call) => Promise<unknown>, call: Call, hash: Hex): Promise<SendOutcome> {
  try {
    await simulate(call);
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) {
      const c = classifyRevert(err);
      if (c.kind === 'done') return { kind: 'ok' };
      if (revertName(err) !== undefined) return { kind: 'failed', reason: `${call.functionName}: ${c.reason} (tx ${hash})` };
    }
  }
  return { kind: 'failed', reason: `${call.functionName} reverted on chain (tx ${hash})` };
}

/** How long a send may wait for its receipt: {@link RECEIPT_TIMEOUT_MS}, cut
 *  to what is left before the run's send deadline — never below 1 ms, because
 *  viem reads a timeout of 0 as "no timeout" and would wait indefinitely.
 *  Pure; exported for tests. */
export function receiptTimeoutMs(notAfterMs: number, nowMs: number = Date.now()): number {
  return Math.max(1, Math.min(RECEIPT_TIMEOUT_MS, notAfterMs - nowMs));
}

/** A send that failed with the CONTRACT's reason (gas estimation refusing it,
 *  say) as an outcome classified like any refused call; null for a failure
 *  that carries no contract reason, which stops the run's sends. Pure;
 *  exported for the tests. */
export function refusedBeforeBroadcast(err: unknown, fn: string): SendOutcome | null {
  return contractRefused(err) ? outcomeOf(err, fn) : null;
}

/**
 * A failed call as a send outcome, by ONE rule (Codex #2599 r4): it is a
 * refusal only when the CONTRACT refused it — the chain evaluated the call and
 * reverted, with or without a reason the ABI decodes. A timeout, a transport
 * error or a deadline is not: the chain never judged the call, so nothing is
 * reported and the next run tries again. Exported for the tests.
 */
export function outcomeOf(err: unknown, fn: string): SendOutcome {
  if (err instanceof PastRunDeadline || !contractRefused(err)) return { kind: 'stopped' };
  const c = classifyRevert(err);
  if (c.kind === 'done') return { kind: 'ok' };
  return { kind: 'failed', reason: `${fn}: ${c.reason}` };
}

/** Whether the chain evaluated the call and reverted it: viem carries that as
 *  a {@link ContractFunctionRevertedError}, decoded or not. */
function contractRefused(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

/** The decoded custom error a call reverted with, when the ABI names it. */
function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}


