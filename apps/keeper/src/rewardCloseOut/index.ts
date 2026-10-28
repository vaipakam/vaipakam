// apps/keeper/src/rewardCloseOut/index.ts
//
// #2984 — the reward CLOSE-OUT pass: the permissionless steps that retire a
// reward day's obligations and release the value they no longer need. Each is
// open to anyone and nothing else calls it on a schedule, so without a keeper a
// day that is finished stays open on paper, the transport epochs that listed
// it keep their remainders, and a retired custody era keeps its row.
//
// Per chain, per run (every 15 minutes), in this order:
//
//   1. ERA — finalize every RETIRED custody era the contract would finalize
//      now (`RewardEraFacet.finalizeCustodyEra`): every day of its span proven
//      closed and no staging hold on its row. Its row goes to the live
//      baseline, or to pending surplus while the chain is Detached.
//   2. SURPLUS — on a chain with an active reward role, drain the whole
//      pending-surplus row into the live baseline
//      (`RewardEraFacet.drainPendingSurplus`). On a Detached chain the row is
//      the return transport's to send back to Base (`sendRetiredSurplusReturn`,
//      a separate pass), and this pass only says how much waits there.
//   3. RELEASE — on Base, for each remit destination taken off its
//      expected-source list whose release is unfinished, continue it
//      (`RewardRemitDestinationFacet.continueRemitDestinationRelease`, #2963):
//      release, day by day, the pool room Base still holds for the removed
//      chain's abandoned days. The removal's own write walks 128 days and stops
//      at the first abandoned day not yet finalized. The indexer's ledger of
//      `RemitDestinationRemoved` nominates the chains; a walk is sent only when
//      its simulation moves the release cursor.
//   4. CLOSURE — prove elapsed days closed (`RewardClosureFacet`): for each
//      day of its closure window not yet proven, oldest first, the pass scans
//      the chain's reward-entry sequence (`getRewardEntriesRange`) for the
//      entries covering it, checks that they sum to exactly the day's folded totals
//      and that every one has terminated (`isEntryTerminatedOn`), and only
//      then opens a walk (`startDayClosure`) and pages the ids in
//      (`proveDayClosurePage`). A day with an entry still open is left; it is
//      counted on the run's line, not sent. A day with nothing on either side
//      closes at the start. The keeper's unfinished walk for the day is
//      continued rather than replaced: its nonce is kept per day, since the
//      keeper's latest nonce names only its newest walk.
//   5. PARK — for each closed day in its park window, every transport epoch it
//      lists whose remainder is not parked, whose membership is whole, which
//      no staging record references and all of whose listed days are proven
//      closed, is parked (`RewardEpochFacet.parkTransportBatchRemainder`).
//      Releasing a parked remainder is the administrator's acknowledgment
//      (`acknowledgeTransportBatchRemainder`), which this pass never calls;
//      the run's line names each batch parked.
//   6. PRUNE — for each day of the closure window still open, when the epoch
//      after its consumption cursor is plainly exhausted (nothing left, fully
//      indexed, unreferenced), advance the cursor (`RewardEpochFacet.epochPruneTransportDayCursor`).
//      Exhausted only by its caps is not detected here; the day's next draw
//      prunes that in passing.
//   7. QUEUES — write each reconciliation queue's pending takes into its
//      records (`RewardReconciliationFacet.advanceReconciliationQueue`), on
//      every chain, while a queue holds any: a pool outflow's own walk is
//      bounded and leaves the rest pending, and while any is pending the
//      administrator's corrections on that side refuse. Moves no value. It
//      runs last, on what the run's send budget leaves.
//
// A run's reads are bounded and rotate (Codex #2993 r1–r2), so what one run
// reads is bounded while nothing is left out for good: retired eras 32 a run
// above a floor of finalized ones; closure days `REWARD_CLOSE_OUT_WINDOW_DAYS`
// a run above a floor of proven-closed ones; park days as many a run over
// every provable day; each closed day's epochs 50 a run; the entry scan from a
// floor below which every entry ended; removal rows 200 a run above a floor of
// rows whose chain's release is done. The floors and cursors are rows of the
// keeper's private database (`scanCursors.ts`), and only say where to start
// reading: every decision is still an on-chain read. The era, closure and
// release floors move only on what the chain's finalized block shows (Codex
// #2993 r4), so a finalization, closure or release walk reorged out stays
// above its floor and is done again.
//
// Every call is simulated on the current state first and waits for its
// receipt before the next (`stepSender.ts`), so the steps of one walk land in
// one run. None pays a fee, and none moves value to the keeper.
//
// Gated by KEEPER_ENABLED + REWARD_CLOSE_OUT_ENABLED. Ships disarmed.

import { createPublicClient, http, zeroAddress, type Abi, type Address, type PublicClient } from 'viem';
import {
  AdminFacetABI,
  InteractionRewardsLensFacetABI,
  RewardClosureFacetABI,
  RewardCustodyFacetABI,
  RewardEpochFacetABI,
  RewardEraFacetABI,
  RewardReconciliationFacetABI,
  RewardRemitDestinationFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  VaipakamDiamondABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env, PlainVarKey } from '../env';
import { getChainConfigs } from '../env';
import { buildKeeperContext, passIsArmed, resolveKeeperAccount, type KeeperContext } from '../keeper';
import type { PassTick } from '../passSchedule';
import { deadlineClient, PastRunDeadline, settledRead, type BatchResult } from '../batchRead';
import { shortErr } from '../callErrors';
import { d1EventLedger, decodePos, encodePos, posAfter, type EventLedger } from '../eventLedger';
import { decodeEntryFloor, encodeEntryFloor, ENTRY_PAGE, scanEntries, type EntryRow } from '../rewardEntries';
import { advanceFloor, d1ScanCursors, decodeIndex, finalFloor, finalizedBlockOnce, rotatingWindow, type FinalBlock, type ScanCursors } from '../scanCursors';
import { StepSender } from '../stepSender';
import {
  provableThrough,
  conservationGap,
  coveringEntries,
  epochPrunable,
  eraReadiness,
  pagesAfter,
  SIDE_BORROWER,
  SIDE_LENDER,
  type EraRecord,
  type ScannedEntry,
  type Side,
} from './plan';

export * from './plan';

export const ABI = [
  ...(AdminFacetABI as Abi),
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(RewardReporterFacetABI as Abi),
  ...(RewardClosureFacetABI as Abi),
  ...(RewardEraFacetABI as Abi),
  ...(RewardEpochFacetABI as Abi),
  ...(RewardCustodyFacetABI as Abi),
  ...(RewardReconciliationFacetABI as Abi),
  ...(RewardRemitDestinationFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
] as Abi;

/** The pass's cadence, in seconds; the scheduler reads it from here. Nothing
 *  this pass does is time-critical: a day it proves closed stays closed. */
export const PASS_CADENCE_SEC = 15 * 60;
/** Sends per chain per run. A walk is a start plus a page per 100 ids a side. */
export const MAX_SENDS_PER_RUN = 12;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Days a run reads for closure, and again for parking, unless
 *  `REWARD_CLOSE_OUT_WINDOW_DAYS` says otherwise. Each rotates over its whole
 *  range across runs (`scanCursors.rotatingWindow`), so this bounds a run's
 *  reads and never which days are ever visited. */
export const DEFAULT_WINDOW_DAYS = 60;
/** Entry ids per `proveDayClosurePage`. */
export const PAGE_IDS = 100;
/** Entry pages one run may read, from the scan's stored floor. A day whose
 *  entries the pages do not reach is not walked this run, and the line says
 *  so: a walk on a partial scan cannot close. */
export const MAX_ENTRY_PAGES = 20;
/** Retired eras looked at per run, rotating over every era not yet known
 *  finalized (`scanCursors.rotatingWindow`). */
export const MAX_ERAS = 32;
/** Epochs read per closed day for the park step, from the day's stored
 *  discovery cursor, so a day listing more is covered over several runs. */
export const MAX_BATCHES_PER_DAY = 50;
/** The scan-cursor items this pass keeps (`scanCursors.ts`). */
export const ENTRY_FLOOR_ITEM = 'entry-floor';
export const ERA_FLOOR_ITEM = 'era-floor';
export const ERA_NEXT_ITEM = 'era-next';
export const CLOSURE_FLOOR_ITEM = 'closure-floor';
export const CLOSURE_NEXT_ITEM = 'closure-next';
export const PARK_NEXT_ITEM = 'park-next';
export const parkCursorItem = (day: number) => `park:${day}`;
export const walkCursorItem = (day: number) => `walk:${day}`;
/** Park pages one batch may take in a run. */
export const MAX_PARK_PAGES = 8;
/** Days one `continueRemitDestinationRelease` walks: the removal's own write
 *  walks as many. A settled day costs a few reads, an armed unsent one about
 *  thirty thousand gas. */
export const RELEASE_DAYS = 128;
/** Removal rows read per run from the ledger, rotating above the release floor. */
export const RELEASE_PAGE = 200;
/** The scan-cursor items the release step keeps: ledger positions. */
export const RELEASE_FLOOR_ITEM = 'release-floor';
export const RELEASE_NEXT_ITEM = 'release-next';
const REMOVAL_EVENT = 'RemitDestinationRemoved';
/** Records one `advanceReconciliationQueue` visits. Each is a storage write or
 *  two. */
export const QUEUE_STEPS = 128;
const QUEUE_SIDE_FRESH = 0;
const QUEUE_SIDE_RECYCLED = 1;
/** The era the reconciliation queues are keyed under (one, until they are
 *  era-keyed). */
const RECONCILIATION_QUEUE_ERA = 0n;
/** Reads per aggregate. */
const READ_CHUNK = 100;

const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;
const ROLE_DETACHED = 3;

/** Refusals that mean another caller got there first. */
export const RACES = new Set(['ClosureDayAlreadyClosed', 'CustodyEraAlreadyFinalized', 'TransportRemainderAlreadyParked', 'RemitDestinationReleaseDone']);
export const PAUSED_REFUSAL = 'EnforcedPause';

const ZERO32 = `0x${'0'.repeat(64)}` as const;

/** What one chain's run reads and signs with. Injected so a run is testable. */
export interface CloseOutDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  /** The signing context, built only when there is something to send. */
  context: () => KeeperContext | null;
  /** The keeper's address, or null when the key is unset or malformed. */
  keeper: Address | null;
  sendDeadline: number;
  windowDays: number;
  /** Where its bounded reads got to on this chain, across runs. */
  cursors: ScanCursors;
  /** The indexer's event ledger: what nominates removed remit destinations. */
  ledger: EventLedger;
}

/** What a run did on one chain: its log line's figures, and what tests read. */
export interface CloseOutReport {
  chainId: number;
  /** Why the chain was not worked, when it was not. */
  skipped?: string;
  erasFinalized: number[];
  erasWaiting: string[];
  drained: bigint;
  /** Pending surplus left for the return transport on a Detached chain. */
  surplusForReturn: bigint;
  daysClosed: number[];
  /** Days left open because a covering entry has not terminated. */
  daysWaitingOnEntries: number[];
  /** Days whose scanned entries did not account for their totals. */
  daysScanGap: number[];
  parked: { batchId: string; amount: bigint }[];
  pruned: number[];
  /** Removed remit destinations whose release moved this run (Base). */
  released: { chain: number; from: number; to: number; bound: number }[];
  /** Releases waiting on an abandoned day's finalization. */
  releaseWaiting: string[];
  /** Reconciliation queues that held pending takes: what was written, what is left. */
  queues: { side: string; wrote: bigint; left: bigint }[];
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runRewardCloseOut(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardCloseOut', 'REWARD_CLOSE_OUT_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const windowDays = readPositive(env, 'REWARD_CLOSE_OUT_WINDOW_DAYS', DEFAULT_WINDOW_DAYS);
  const resolved = env.KEEPER_PRIVATE_KEY ? resolveKeeperAccount(env.KEEPER_PRIVATE_KEY) : null;
  const keeper = resolved && 'account' in resolved ? resolved.account.address : null;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await closeOutOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          keeper,
          sendDeadline,
          windowDays,
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'rewardCloseOut'),
          ledger: d1EventLedger(env.DB),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] rewardCloseOut chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

function readPositive(env: Env, key: PlainVarKey, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** The run's one line for a chain. */
export function describeReport(r: CloseOutReport): string {
  if (r.skipped) return `[keeper] rewardCloseOut chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const parts = [
    `[keeper] rewardCloseOut chain=${r.chainId}`,
    `eras-finalized=${r.erasFinalized.join(',') || 'none'}`,
    ...(r.erasWaiting.length > 0 ? [`eras-waiting=${r.erasWaiting.join('; ')}`] : []),
    ...(r.drained > 0n ? [`surplus-drained=${r.drained}`] : []),
    ...(r.surplusForReturn > 0n ? [`surplus-awaiting-return-transport=${r.surplusForReturn}`] : []),
    `days-closed=${r.daysClosed.join(',') || 'none'}`,
    ...(r.daysWaitingOnEntries.length > 0 ? [`days-waiting-on-open-entries=${summarizeDays(r.daysWaitingOnEntries)}`] : []),
    ...(r.daysScanGap.length > 0 ? [`days-scan-short=${r.daysScanGap.join(',')}`] : []),
    `parked=${r.parked.map((p) => `${p.batchId.slice(0, 10)}(${p.amount})`).join(',') || 'none'}${r.parked.length > 0 ? ' (release is the administrator\'s acknowledgment)' : ''}`,
    `pruned=${r.pruned.join(',') || 'none'}`,
    ...(r.released.length > 0 ? [`released=${r.released.map((x) => `chain ${x.chain} days ${x.from}..${x.to - 1} (${x.to >= x.bound ? 'done' : `${x.bound - x.to} left`})`).join(',')}`] : []),
    ...(r.releaseWaiting.length > 0 ? [`release-waiting=${r.releaseWaiting.join('; ')}`] : []),
    ...r.queues.map((q) => `queue-${q.side}=wrote ${q.wrote}, ${q.left} left`),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

function summarizeDays(days: readonly number[]): string {
  return days.length <= 6 ? days.join(',') : `${days.length} days (${days[0]}..${days[days.length - 1]})`;
}

/** One chain's run. Exported for tests. */
export async function closeOutOnce(chainId: number, diamond: Address, deps: CloseOutDeps): Promise<CloseOutReport> {
  const sender = new StepSender(
    {
      pass: 'rewardCloseOut',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: CloseOutReport = {
    chainId,
    erasFinalized: [],
    erasWaiting: [],
    drained: 0n,
    surplusForReturn: 0n,
    daysClosed: [],
    daysWaitingOnEntries: [],
    daysScanGap: [],
    parked: [],
    pruned: [],
    released: [],
    releaseWaiting: [],
    queues: [],
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new Reader(deps, diamond);
  try {
    const gate = await readGate(r, chainId);
    if (typeof gate === 'string') return { ...report, skipped: gate };
    await finalizeEras(r, sender, report, deps.cursors);
    await drainSurplus(r, sender, report, gate.role);
    if (gate.role === ROLE_CANONICAL) await releaseDestinations(r, sender, report, chainId, gate.paused, deps);
    const upTo = provableThrough(gate.today, gate.lenderFrontier, gate.borrowerFrontier);
    if (upTo >= 0 && gate.active) await workDays(r, sender, report, gate.paused, upTo, deps);
    await advanceQueues(r, sender, report);
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** Reads, each refused past the run's deadline. */
class Reader {
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`). */
  readonly finalized: () => Promise<FinalBlock | null>;

  constructor(
    readonly deps: CloseOutDeps,
    readonly diamond: Address,
  ) {
    this.finalized = finalizedBlockOnce(deps.client);
  }

  async one<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.deps.client.readContract({ address: this.diamond, abi: ABI, functionName, args })) as T;
  }

  /** Many reads of one function; `undefined` where a read did not come back.
   *  At the head, or at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += READ_CHUNK) {
      const part = calls.slice(i, i + READ_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const res: BatchResult[] = await settledRead(
        this.deps.readClient,
        part.map((c) => ({ address: this.diamond, abi: ABI, functionName: c.functionName, args: c.args })),
        `rewardCloseOut ${label}`,
        this.deps.sendDeadline,
        blockNumber,
      );
      for (const x of res) out.push(x.status === 'success' ? x.result : undefined);
    }
    return out;
  }

  days(days: readonly number[], functionName: string, label: string, blockNumber?: bigint): Promise<unknown[]> {
    return this.many(days.map((d) => ({ functionName, args: [BigInt(d)] })), label, blockNumber);
  }

}

interface Gate {
  role: number;
  today: number;
  active: boolean;
  paused: boolean;
  lenderFrontier: number;
  borrowerFrontier: number;
}

/** The reads every step depends on, or why the chain is not worked. The
 *  Diamond must name itself this chain: a deterministic deployment can put a
 *  Diamond at the same address on another chain, and an RPC pointed there
 *  would prove that chain's days. */
async function readGate(r: Reader, chainId: number): Promise<Gate | string> {
  const read = async <T>(functionName: string, what: string): Promise<T | string> => {
    try {
      return await r.one<T>(functionName);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return `${what} could not be read (${shortErr(err)})`;
    }
  };
  const cfg = await read<readonly [Address, number, number, boolean, bigint]>('getRewardReporterConfig', 'its reward reporter config');
  if (typeof cfg === 'string') return cfg;
  if (Number(cfg[1]) !== chainId) {
    return `the Diamond its RPC serves names itself chain ${Number(cfg[1])}, so the RPC configured for chain ${chainId} answers for another chain (or the Diamond's reporter config names the wrong local chain)`;
  }
  const role = await read<number>('getRewardRole', 'its reward role');
  if (typeof role === 'string') return role;
  const day = await read<readonly [bigint, boolean]>('getInteractionCurrentDay', 'its reward day');
  if (typeof day === 'string') return day;
  const paused = await read<boolean>('paused', 'whether the protocol is paused');
  if (typeof paused === 'string') return paused;
  const fr = await read<readonly [bigint, bigint]>('getInterestFrontiers', 'its interest frontiers');
  if (typeof fr === 'string') return fr;
  return {
    role: Number(role),
    today: Number(day[0]),
    active: day[1],
    paused,
    lenderFrontier: Number(fr[0]),
    borrowerFrontier: Number(fr[1]),
  };
}

// ─── 1. Eras ────────────────────────────────────────────────────────────────

async function finalizeEras(r: Reader, sender: StepSender, report: CloseOutReport, cursors: ScanCursors): Promise<void> {
  let current: bigint;
  try {
    current = await r.one<bigint>('getCustodyEraCurrent');
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread('era', `the live custody era (${shortErr(err)})`);
    return;
  }
  if (current === 0n) return;
  // The retired eras not yet known finalized are looked at MAX_ERAS a run,
  // rotating from where the last run stopped, above a stored floor every era
  // below which is finalized: a fixed window over the newest eras would leave
  // an older one out for good once enough role changes followed it
  // (Codex #2993 r2).
  const stored = await cursors.get([ERA_FLOOR_ITEM, ERA_NEXT_ITEM]);
  const floor = Math.min(decodeIndex(stored.get(ERA_FLOOR_ITEM)) ?? 0, Number(current));
  const win = rotatingWindow(floor, Number(current) - 1, MAX_ERAS, decodeIndex(stored.get(ERA_NEXT_ITEM)));
  if (win === null) return;
  const ids: number[] = [];
  for (let e = win.from; e <= win.to; e++) ids.push(e);
  // Each era's span ends at the next era's boundary, so one record past the window.
  const recs = await r.many([...ids, win.to + 1].map((e) => ({ functionName: 'getCustodyEra', args: [BigInt(e)] })), 'eras');
  const terminal = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    const era = ids[i];
    const rec = recs[i] as EraRecord | undefined;
    const next = recs[i + 1] as EraRecord | undefined;
    if (rec === undefined || next === undefined) {
      sender.noteUnread(`era:${era}`, 'its record or the next era\'s boundary');
      continue;
    }
    const ready = eraReadiness(rec, next.boundaryDay);
    if (ready === null) {
      terminal.add(era);
      continue;
    }
    if (ready !== 'ready') {
      report.erasWaiting.push(`${era}: ${ready}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('finalizeEra', `era ${era}`, 'finalizeCustodyEra', [BigInt(era)]);
    if (res === 'landed') {
      report.erasFinalized.push(era);
      terminal.add(era);
    }
  }
  const newFloor = await finalFloor(floor, ids, (e) => terminal.has(e), r.finalized, async (es, block) => {
    const recs = await r.many(es.map((e) => ({ functionName: 'getCustodyEra', args: [BigInt(e)] })), 'eras-final', block.number);
    return new Set(es.filter((_, i) => (recs[i] as EraRecord | undefined)?.terminal === true));
  });
  if (newFloor !== floor) await cursors.put(ERA_FLOOR_ITEM, String(newFloor));
  if (String(win.next) !== stored.get(ERA_NEXT_ITEM)) await cursors.put(ERA_NEXT_ITEM, String(win.next));
}

// ─── 2. Pending surplus ─────────────────────────────────────────────────────

async function drainSurplus(r: Reader, sender: StepSender, report: CloseOutReport, role: number): Promise<void> {
  let pending: bigint;
  try {
    const ledger = await r.one<readonly [boolean, bigint, bigint, bigint, bigint, bigint]>('rewardCustodyLedger');
    pending = ledger[5];
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread('surplus', `the custody ledger (${shortErr(err)})`);
    return;
  }
  if (pending === 0n) return;
  if (role === ROLE_DETACHED) {
    report.surplusForReturn = pending;
    return;
  }
  if (role !== ROLE_CANONICAL && role !== ROLE_MIRROR) {
    sender.noteUnread('surplus', `pending surplus of ${pending} on a chain whose reward role (${role}) is neither active nor Detached`);
    return;
  }
  const res = await sender.call('drain', 'pending surplus', 'drainPendingSurplus', [pending]);
  if (res === 'landed') report.drained = pending;
}

// ─── 3. Removed destinations (Base) ─────────────────────────────────────────

/**
 * Finish releasing what Base holds for each remit destination it took off its
 * expected-source list (`RewardRemitDestinationFacet.continueRemitDestinationRelease`,
 * #2963). The removal's own write walks a bounded number of days, and the walk
 * stops at the first abandoned day not yet finalized, so a removal can leave
 * days whose held pool room is released only by a later call; until it is,
 * that room stays out of the pool and the chain cannot be listed again.
 *
 * No view lists the removed chains, so the indexer's ledger of
 * `RemitDestinationRemoved` nominates them: a page a run, from where the last
 * run stopped and wrapping round, above a stored floor every row before which
 * names a chain whose release is done (the Codex #2993 r2 rule). The floor
 * moves only on what the finalized block shows (r4). Every decision is the
 * chain's own record (`getRemitDestinationRelease`), and a walk is sent only
 * when its simulation moves the release cursor, so a release waiting on a
 * day's finalization costs nothing.
 */
async function releaseDestinations(r: Reader, sender: StepSender, report: CloseOutReport, chainId: number, paused: boolean, deps: CloseOutDeps): Promise<void> {
  const { cursors } = deps;
  const stored = await cursors.get([RELEASE_FLOOR_ITEM, RELEASE_NEXT_ITEM]);
  const floor = decodePos(stored.get(RELEASE_FLOOR_ITEM));
  const next = decodePos(stored.get(RELEASE_NEXT_ITEM));
  const start = next !== null && (floor === null || posAfter(next, floor)) ? next : floor;
  const page = await deps.ledger.page(chainId, [REMOVAL_EVENT], start, RELEASE_PAGE);
  if (page === null) {
    sender.noteUnread('release', 'the event ledger of removed remit destinations');
    return;
  }
  const last = page.rows[page.rows.length - 1];
  // Past the last page the next run starts at the floor again.
  const nextPos = page.more && last !== undefined ? encodePos(last) : '';
  if (nextPos !== (stored.get(RELEASE_NEXT_ITEM) ?? '')) await cursors.put(RELEASE_NEXT_ITEM, nextPos);
  // The chain each row names; a row that names none nominates nothing.
  const rows: (number | null)[] = page.rows.map((row) => {
    const c = Number(row.args.dstChainId);
    return Number.isSafeInteger(c) && c > 0 && c <= 0xffffffff ? c : null;
  });
  const chains = [...new Set(rows.flatMap((c) => (c === null ? [] : [c])))];
  const readRelease = (cs: readonly number[], label: string, blockNumber?: bigint) =>
    r.many(cs.map((c) => ({ functionName: 'getRemitDestinationRelease', args: [c] })), label, blockNumber);
  const done = new Set<number>();
  const states = await readRelease(chains, 'releases');
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i];
    const subject = `chain ${chain}`;
    const st = states[i] as readonly [bigint, bigint] | undefined;
    if (st === undefined) {
      sender.noteUnread(`release:${subject}`, 'its release record');
      continue;
    }
    let [bound, cursor] = [Number(st[0]), Number(st[1])];
    if (cursor >= bound) {
      done.add(chain);
      continue;
    }
    if (paused) {
      sender.noteUnread(`release:${subject}`, 'the protocol is paused, so the release cannot continue');
      continue;
    }
    const from = cursor;
    while (cursor < bound) {
      const at = cursor;
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('release', subject, 'continueRemitDestinationRelease', [chain, BigInt(RELEASE_DAYS)], 0n, (sim) => Number((sim as readonly [bigint, bigint])[0]) > at);
      if (res === 'idle') {
        report.releaseWaiting.push(`${chain}: day ${cursor} of ${bound} is not finalized yet`);
        break;
      }
      if (res !== 'landed') break;
      // eslint-disable-next-line no-await-in-loop
      const after = (await readRelease([chain], 'release'))[0] as readonly [bigint, bigint] | undefined;
      if (after === undefined) {
        sender.noteUnread(`release:${subject}`, 'its release record after a walk');
        break;
      }
      [bound, cursor] = [Number(after[0]), Number(after[1])];
    }
    if (cursor > from) report.released.push({ chain, from, to: cursor, bound });
    if (cursor >= bound) done.add(chain);
  }
  // On a page read from the floor, the floor moves past the leading rows whose
  // chain's release is done, at the head AND at the finalized block: a walk a
  // reorg undoes leaves its row above the floor, to be walked again.
  if (start !== floor) return;
  const positions = page.rows.map((_, i) => i);
  const n = await finalFloor(0, positions, (i) => rows[i] === null || done.has(rows[i]!), r.finalized, async (passed, block) => {
    const named = [...new Set(passed.flatMap((i) => (rows[i] === null ? [] : [rows[i]!])))];
    const at = await readRelease(named, 'releases-final', block.number);
    const finished = new Set(named.filter((_, j) => {
      const st = at[j] as readonly [bigint, bigint] | undefined;
      return st !== undefined && st[1] >= st[0];
    }));
    return new Set(passed.filter((i) => rows[i] === null || finished.has(rows[i]!)));
  });
  if (n > 0) await cursors.put(RELEASE_FLOOR_ITEM, encodePos(page.rows[n - 1]));
}

// ─── Days read for 4–6 ─────────────────────────────────────────────────────

/**
 * Days are read `windowDays` a run, rotating, for two jobs (Codex #2993 r2):
 * closure over the days from a stored floor (every day below it is proven
 * closed, for good) up to the newest provable day, and parking over every
 * provable day, since a closed day's epochs may still hold a remainder. A
 * window fixed on the newest days would leave an older day out for good.
 */
async function workDays(r: Reader, sender: StepSender, report: CloseOutReport, paused: boolean, upTo: number, deps: CloseOutDeps): Promise<void> {
  const { cursors, windowDays } = deps;
  const stored = await cursors.get([CLOSURE_FLOOR_ITEM, CLOSURE_NEXT_ITEM, PARK_NEXT_ITEM]);
  const floor = Math.min(decodeIndex(stored.get(CLOSURE_FLOOR_ITEM)) ?? 0, upTo + 1);
  const known = new Map<number, boolean>();
  const readClosed = async (ds: readonly number[]) => {
    const want = ds.filter((d) => d >= floor && !known.has(d));
    if (want.length === 0) return;
    const closed = await r.days(want, 'isDayObligationsClosed', 'closure-state');
    want.forEach((d, i) => {
      const v = closed[i];
      if (v === undefined) sender.noteUnread(`closure:${d}`, 'whether the day is proven closed');
      else known.set(d, v as boolean);
    });
  };
  const isClosed = (d: number) => d < floor || known.get(d) === true;

  const win = rotatingWindow(floor, upTo, windowDays, decodeIndex(stored.get(CLOSURE_NEXT_ITEM)));
  const days = win === null ? [] : span(win.from, win.to);
  await readClosed(days);
  const open = days.filter((d) => known.get(d) === false);
  // The oldest day that may be open, as this run reads the head. It anchors
  // the entry scan and is never stored: a day reorged back open puts the
  // next run's anchor below the entry floor's recorded day, which restarts
  // that scan from the first entry. The stored closure floor moves only on
  // what finality shows, after any walk (finalFloor).
  const readFloor = advanceFloor(floor, days, isClosed);
  if (paused) {
    if (open.length > 0) sender.noteUnread('closure', 'the protocol is paused, so no closure walk can run');
  } else if (open.length > 0) {
    // Anchored there, the stored entry floor stays valid whichever window a
    // run reads.
    await proveDays(r, sender, report, open, readFloor, deps.keeper, cursors);
    for (const d of report.daysClosed) known.set(d, true);
  }
  const newFloor = await finalFloor(floor, days, isClosed, r.finalized, async (ds, block) => {
    const closed = await r.days(ds, 'isDayObligationsClosed', 'closure-final', block.number);
    return new Set(ds.filter((_, i) => closed[i] === true));
  });
  if (newFloor !== floor) await cursors.put(CLOSURE_FLOOR_ITEM, String(newFloor));
  if (win !== null && String(win.next) !== stored.get(CLOSURE_NEXT_ITEM)) await cursors.put(CLOSURE_NEXT_ITEM, String(win.next));

  const parkWin = rotatingWindow(0, upTo, windowDays, decodeIndex(stored.get(PARK_NEXT_ITEM)));
  if (parkWin !== null) {
    const parkDays = span(parkWin.from, parkWin.to);
    await readClosed(parkDays);
    await parkBatches(r, sender, report, parkDays.filter(isClosed), cursors);
    if (String(parkWin.next) !== stored.get(PARK_NEXT_ITEM)) await cursors.put(PARK_NEXT_ITEM, String(parkWin.next));
  }
  await pruneDays(r, sender, report, days.filter((d) => known.get(d) === false));
}

function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

// ─── 4. Closure ─────────────────────────────────────────────────────────────

interface WalkRecord {
  starter: Address;
  day: bigint;
  nonce: bigint;
  lenderComplete: boolean;
  borrowerComplete: boolean;
  completed: boolean;
  lenderCursor: bigint;
  borrowerCursor: bigint;
}

async function proveDays(
  r: Reader,
  sender: StepSender,
  report: CloseOutReport,
  allOpen: readonly number[],
  scanFrom: number,
  keeper: Address | null,
  cursors: ScanCursors,
): Promise<void> {
  if (keeper === null) {
    sender.noteUnread('closure', 'no signing key, so no walk can be started');
    return;
  }
  // The scan starts at its stored floor: entries below it all end before the
  // oldest open day, so what a run reads is the entries live across the open
  // days, not every entry the chain has made (Codex #2993 r1).
  const stored = (await cursors.get([ENTRY_FLOOR_ITEM])).get(ENTRY_FLOOR_ITEM);
  const scan = await scanEntries(
    (from, n) => r.one<readonly EntryRow[]>('getRewardEntriesRange', [from, n]),
    scanFrom,
    allOpen[allOpen.length - 1],
    MAX_ENTRY_PAGES,
    decodeEntryFloor(stored),
  );
  const floor = encodeEntryFloor(scan.floor);
  if (floor !== stored) await cursors.put(ENTRY_FLOOR_ITEM, floor);
  const open = allOpen.filter((d) => d <= scan.completeThrough);
  const beyond = allOpen.filter((d) => d > scan.completeThrough);
  if (beyond.length > 0) {
    sender.noteUnread(
      'closure',
      `the reward-entry scan reads at most ${MAX_ENTRY_PAGES} pages of ${ENTRY_PAGE} a run from its stored floor and reached only the entries starting by day ${scan.completeThrough}; days ${summarizeDays(beyond)} are not walked this run (a walk on a partial scan cannot close)`,
    );
  }
  if (open.length === 0) return;
  const entries = scan.entries;
  const totals = await r.many(open.map((d) => ({ functionName: 'getInteractionDayEntry', args: [BigInt(d), zeroAddress] })), 'day-totals');
  // Each day's walk nonce is kept per day, so a walk left unfinished is found
  // and continued however many walks on other days the keeper opened since
  // (Codex #2993 r3): the keeper's latest nonce names only its newest walk.
  const walkNonces = await cursors.get(open.map(walkCursorItem));
  let lastNonce: bigint;
  try {
    lastNonce = await r.one<bigint>('getClosureWalkNonce', [keeper]);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread('closure', `the keeper's walk nonce (${shortErr(err)})`);
    return;
  }
  for (let i = 0; i < open.length && !sender.stopped; i++) {
    const day = open[i];
    const t = totals[i] as readonly [bigint, bigint, bigint, bigint] | undefined;
    if (t === undefined) {
      sender.noteUnread(`closure:${day}`, 'the day\'s folded totals');
      continue;
    }
    const cover = coveringEntries(entries, day);
    const gap = conservationGap(cover, { lender: t[2], borrower: t[3] });
    if (gap !== null) {
      report.daysScanGap.push(day);
      sender.noteUnread(`closure:${day}`, gap);
      continue;
    }
    const ids = [...cover.lender, ...cover.borrower].map((e) => e.id);
    // eslint-disable-next-line no-await-in-loop
    const term = await r.many(ids.map((id) => ({ functionName: 'isEntryTerminatedOn', args: [id, BigInt(day)] })), `terminated ${day}`);
    if (term.some((x) => x === undefined)) {
      sender.noteUnread(`closure:${day}`, 'whether each covering entry has terminated');
      continue;
    }
    if (term.some((x) => x === false)) {
      report.daysWaitingOnEntries.push(day);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const stored = walkNonces.get(walkCursorItem(day));
    const candidates = [...new Set([...(stored !== undefined && /^\d+$/.test(stored) ? [BigInt(stored)] : []), lastNonce])];
    // eslint-disable-next-line no-await-in-loop
    const outcome = await walkDay(r, sender, day, keeper, candidates, cover);
    if (outcome.nonce > lastNonce) lastNonce = outcome.nonce;
    // eslint-disable-next-line no-await-in-loop
    if (outcome.nonce > 0n && String(outcome.nonce) !== stored) await cursors.put(walkCursorItem(day), String(outcome.nonce));
    if (outcome.closed) report.daysClosed.push(day);
  }
}

/** Continue the keeper's unfinished walk for `day` under the first of
 *  `nonces` that holds one, or open one, and page every remaining id in. */
async function walkDay(
  r: Reader,
  sender: StepSender,
  day: number,
  keeper: Address,
  nonces: readonly bigint[],
  cover: { lender: readonly ScannedEntry[]; borrower: readonly ScannedEntry[] },
): Promise<{ closed: boolean; nonce: bigint }> {
  const subject = `day ${day}`;
  let nonce = 0n;
  let walk: WalkRecord | null = null;
  for (const n of nonces) {
    if (n === 0n) continue;
    // eslint-disable-next-line no-await-in-loop
    const w = await r.one<WalkRecord>('getClosureWalk', [BigInt(day), keeper, n]);
    if (w.starter.toLowerCase() === keeper.toLowerCase() && BigInt(w.day) === BigInt(day) && !w.completed) {
      walk = w;
      nonce = n;
      break;
    }
  }
  if (walk === null) {
    const res = await sender.call('start', subject, 'startDayClosure', [BigInt(day)]);
    if (res !== 'landed') return { closed: false, nonce };
    nonce = await r.one<bigint>('getClosureWalkNonce', [keeper]);
    walk = await r.one<WalkRecord>('getClosureWalk', [BigInt(day), keeper, nonce]);
    if (walk.completed) return { closed: true, nonce };
  }
  const sides: { side: Side; done: boolean; cursor: bigint; ids: bigint[] }[] = [
    { side: SIDE_LENDER, done: walk.lenderComplete, cursor: walk.lenderCursor, ids: cover.lender.map((e) => e.id) },
    { side: SIDE_BORROWER, done: walk.borrowerComplete, cursor: walk.borrowerCursor, ids: cover.borrower.map((e) => e.id) },
  ];
  for (const s of sides) {
    if (s.done) continue;
    for (const page of pagesAfter(s.ids, s.cursor, PAGE_IDS)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call(s.side === SIDE_LENDER ? 'prove-lender' : 'prove-borrower', subject, 'proveDayClosurePage', [BigInt(day), nonce, s.side, page]);
      if (res !== 'landed') return { closed: false, nonce };
    }
  }
  const closed = await r.one<boolean>('isDayObligationsClosed', [BigInt(day)]);
  return { closed, nonce };
}

// ─── 5. Park ─────────────────────────────────────────────────────────────────

async function parkBatches(r: Reader, sender: StepSender, report: CloseOutReport, closedDays: readonly number[], cursors: ScanCursors): Promise<void> {
  if (closedDays.length === 0 || sender.stopped) return;
  // Each closed day's epochs are discovered a page at a time from where the
  // last run stopped, wrapping to the head at the end of the list: parking
  // an epoch does not take it out of the day's list, so reading from the head
  // every run would never get past the first page (Codex #2993 r1).
  const stored = await cursors.get(closedDays.map(parkCursorItem));
  const from = closedDays.map((d) => (stored.get(parkCursorItem(d)) as `0x${string}` | undefined) ?? ZERO32);
  const pages = await r.many(
    closedDays.map((d, i) => ({ functionName: 'getTransportDayBatchesFrom', args: [BigInt(d), from[i], BigInt(MAX_BATCHES_PER_DAY)] })),
    'day-batches',
  );
  const batches = new Set<string>();
  for (let i = 0; i < closedDays.length; i++) {
    const p = pages[i] as readonly [readonly string[], unknown, string] | undefined;
    if (p === undefined) {
      sender.noteUnread(`park:${closedDays[i]}`, 'the day\'s transport epochs');
      continue;
    }
    for (const id of p[0]) batches.add(id.toLowerCase());
    // The end of the list, or a stored node no longer in it (which pages
    // nothing), starts the next run from the head.
    const next = p[0].length === 0 ? ZERO32 : p[2].toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    if (next !== from[i].toLowerCase()) await cursors.put(parkCursorItem(closedDays[i]), next);
  }
  const known = new Set(closedDays);
  for (const batchId of batches) {
    if (sender.stopped) return;
    // eslint-disable-next-line no-await-in-loop
    const verdict = await parkable(r, batchId as `0x${string}`, known);
    if (verdict !== 'park') {
      if (verdict !== null) sender.noteUnread(`park:${batchId.slice(0, 10)}`, verdict);
      continue;
    }
    for (let page = 0; page < MAX_PARK_PAGES; page++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('park', batchId.slice(0, 10), 'parkTransportBatchRemainder', [batchId]);
      if (res !== 'landed') break;
      // eslint-disable-next-line no-await-in-loop
      const rem = await r.one<readonly [bigint, number, boolean, bigint]>('getTransportRemainder', [batchId]);
      if (Number(rem[1]) > 0) {
        report.parked.push({ batchId, amount: rem[0] });
        break;
      }
    }
  }
}

/** 'park', null (nothing to do), or what could not be read. */
async function parkable(r: Reader, batchId: `0x${string}`, closedKnown: ReadonlySet<number>): Promise<'park' | null | string> {
  const [batch, remainder, staged] = await r.many(
    [
      { functionName: 'getTransportBatch', args: [batchId] },
      { functionName: 'getTransportRemainder', args: [batchId] },
      { functionName: 'getTransportBatchStaged', args: [batchId] },
    ],
    'batch',
  );
  if (batch === undefined || remainder === undefined || staged === undefined) return 'the epoch\'s record';
  const b = batch as readonly [string, bigint, bigint, number, number, boolean];
  if (b[0] === ZERO32) return null;
  if (Number((remainder as readonly [bigint, number])[1]) > 0) return null; // parked already
  if (Number(b[4]) < Number(b[3])) return null; // membership not whole yet
  if ((staged as readonly [bigint, bigint, bigint])[2] !== 0n) return null; // a staging record references it
  const listed = (await r.one<readonly bigint[]>('getTransportBatchDays', [batchId])).map(Number);
  const unknown = listed.filter((d) => !closedKnown.has(d));
  if (unknown.length > 0) {
    const closed = await r.days(unknown, 'isDayObligationsClosed', 'listed-days');
    if (closed.some((x) => x === undefined)) return 'whether each listed day is proven closed';
    if (closed.some((x) => x === false)) return null;
  }
  return 'park';
}

// ─── 6. Prune ───────────────────────────────────────────────────────────────

async function pruneDays(r: Reader, sender: StepSender, report: CloseOutReport, openDays: readonly number[]): Promise<void> {
  if (openDays.length === 0 || sender.stopped) return;
  const index = await r.many(
    openDays.flatMap((d) => [
      { functionName: 'getTransportDayIndex', args: [BigInt(d)] },
      { functionName: 'getTransportDayBatches', args: [BigInt(d), 0n, 0n] },
    ]),
    'day-index',
  );
  for (let i = 0; i < openDays.length && !sender.stopped; i++) {
    const day = openDays[i];
    const idx = index[2 * i] as readonly [bigint, string] | undefined;
    const pos = index[2 * i + 1] as readonly [unknown, unknown, bigint, bigint] | undefined;
    if (idx === undefined || pos === undefined) {
      sender.noteUnread(`prune:${day}`, 'the day\'s transport index');
      continue;
    }
    const total = idx[0];
    const cursorNode = idx[1];
    if (total === 0n || pos[3] >= total) continue;
    const fromHead = cursorNode === ZERO32;
    // eslint-disable-next-line no-await-in-loop
    const page = await r.one<readonly [readonly string[], unknown, string]>('getTransportDayBatchesFrom', [BigInt(day), fromHead ? ZERO32 : cursorNode, fromHead ? 1n : 2n]);
    const next = fromHead ? page[0][0] : page[0][1];
    if (next === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    const [batch, staged] = await r.many(
      [
        { functionName: 'getTransportBatch', args: [next] },
        { functionName: 'getTransportBatchStaged', args: [next] },
      ],
      'prune-epoch',
    );
    if (batch === undefined || staged === undefined) {
      sender.noteUnread(`prune:${day}`, 'the epoch after the cursor');
      continue;
    }
    const b = batch as readonly [string, bigint, bigint, number, number, boolean];
    const prunable = epochPrunable({
      exists: b[0] !== ZERO32,
      balance: b[1],
      dayCount: Number(b[3]),
      indexedDays: Number(b[4]),
      references: (staged as readonly [bigint, bigint, bigint])[2],
    });
    if (!prunable) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('prune', `day ${day}`, 'epochPruneTransportDayCursor', [BigInt(day)]);
    if (res === 'landed') report.pruned.push(day);
  }
}

// ─── 7. Reconciliation queues ───────────────────────────────────────────────

/** A reconciliation queue's position: what its pending takes still hold, and
 *  the frontiers its walk moves. Either moving is progress. */
interface QueuePosition {
  pending: bigint;
  frontiers: readonly bigint[];
}

const QUEUES: readonly { side: number; name: string; read: (r: Reader) => Promise<QueuePosition> }[] = [
  {
    side: QUEUE_SIDE_FRESH,
    name: 'fresh',
    read: async (r) => {
      const q = await r.one<readonly bigint[]>('getFreshQueueState', [RECONCILIATION_QUEUE_ERA]);
      return { pending: q[4], frontiers: [q[0], q[6]] };
    },
  },
  {
    side: QUEUE_SIDE_RECYCLED,
    name: 'recycled',
    read: async (r) => {
      const q = await r.one<readonly bigint[]>('getRecycledQueueState');
      return { pending: q[4], frontiers: [q[0]] };
    },
  },
];

/**
 * Write each reconciliation queue's pending takes into its records
 * (`RewardReconciliationFacet.advanceReconciliationQueue`). A pool outflow's
 * own walk is bounded and leaves the rest pending, in order; while any is
 * pending, the administrator's corrections on that side refuse
 * (`ReconciliationQueueBehind`). The call moves no value and changes no total.
 * Sent while the queue still holds something, and repeated while a call moves
 * it, with what the run's send budget leaves.
 */
async function advanceQueues(r: Reader, sender: StepSender, report: CloseOutReport): Promise<void> {
  for (const q of QUEUES) {
    if (sender.stopped) return;
    let pos: QueuePosition;
    try {
      pos = await q.read(r);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      sender.noteUnread(`queue:${q.name}`, `the ${q.name} reconciliation queue (${shortErr(err)})`);
      continue;
    }
    if (pos.pending === 0n) continue;
    const had = pos.pending;
    while (pos.pending > 0n) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call('queue', q.name, 'advanceReconciliationQueue', [q.side, BigInt(QUEUE_STEPS)]);
      if (res !== 'landed') break;
      let after: QueuePosition;
      try {
        // eslint-disable-next-line no-await-in-loop
        after = await q.read(r);
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        sender.noteUnread(`queue:${q.name}`, `the ${q.name} reconciliation queue after a walk (${shortErr(err)})`);
        break;
      }
      const moved = after.pending < pos.pending || after.frontiers.some((f, i) => f > pos.frontiers[i]);
      pos = after;
      if (!moved) {
        sender.refused.set(`queue:${q.name}`, 'a walk landed and moved neither its pending figure nor its frontier');
        break;
      }
    }
    report.queues.push({ side: q.name, wrote: had - pos.pending, left: pos.pending });
  }
}
