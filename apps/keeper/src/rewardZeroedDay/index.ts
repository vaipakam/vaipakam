// apps/keeper/src/rewardZeroedDay/index.ts
//
// #2984 — the reward ZEROED-DAY pass: the permissionless steps that carry a
// deliberately zeroed reward day on a mirror to its end. When Base finalizes a
// day without a mirror's report, the mirror's share of that day is zeroed and
// can be restored only by compensation, which Base's administrator dispatches
// against the mirror's own quote of what the day owed. Nothing else calls the
// quote or the lapse terminals on a schedule, so without a keeper a zeroed day
// is never quoted (Base has no figure to compensate against) and never lapses
// (its users' claims for later days defer behind it).
//
// Per mirror, per run (every 15 minutes), for each day of its window that the
// mirror records as deliberately zeroed (`getDayDeliberatelyZeroed`). The
// window is `REWARD_ZEROED_DAY_WINDOW_DAYS` elapsed days a run, rotating above
// a stored floor of settled days, so no zeroed day is left out for good:
//
//   QUOTE — while the day is neither compensated nor past its frozen expiry,
//     and not yet quoted: scan the chain's reward entries for the ones
//     covering the day (`../rewardEntries`), check they sum exactly to the
//     day's folded totals, page them into the quote's accumulation in
//     ascending id order (`accumulateCompQuoteBatch`), and once both sides are
//     complete dispatch the quote toward Base
//     (`quoteZeroedDayCompensation`), paying the messenger's quoted CCIP fee
//     under this pass's own ceiling (`REWARD_ZEROED_DAY_MAX_FEE_WEI`). A day
//     whose folded totals are zero on both sides quotes (0, 0), which is its
//     resolved-zero terminal. A side whose cursor was moved past covering ids
//     never submitted cannot complete; the pass sends nothing for it and
//     raises an operator alert naming the administrator's reset.
//   LAPSE — a never-compensated day past its frozen expiry is retired
//     (`lapseZeroedDay`), and its users' loss is recorded on chain. When the
//     quote had not completed, the record is partial and the pass keeps
//     accumulating until it is exact (dispatch is refused after a lapse).
//   SHORT LAPSE — a confirmed compensated day still funded below its quote
//     past its bounded deadline switches to pool-scaled pricing
//     (`lapseShortCompensatedDay`).
//
// Every lapse the pass makes is posted as an operator notice with the loss the
// chain recorded. Every call is simulated first and waits for its receipt
// before the next (`../stepSender`). Gated by KEEPER_ENABLED +
// REWARD_ZEROED_DAY_ENABLED. Ships disarmed.

import { createPublicClient, http, zeroAddress, type Abi, type Address, type PublicClient } from 'viem';
import {
  InteractionRewardsLensFacetABI,
  RewardAggregatorFacetABI,
  RewardCommitmentFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  VaipakamDiamondABI,
  VaipakamRewardMessengerABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env, PlainVarKey } from '../env';
import { getChainConfigs } from '../env';
import { buildKeeperContext, passIsArmed, resolveKeeperAccount, type KeeperContext } from '../keeper';
import type { PassTick } from '../passSchedule';
import { deadlineClient, PastRunDeadline, settledRead, type BatchResult } from '../batchRead';
import { shortErr } from '../callErrors';
import { feeCeiling } from '../feeCeiling';
import { sendOpsAlert } from '../opsAlert';
import { conservationGap, coveringEntries, decodeEntryFloor, encodeEntryFloor, scanEntries, SIDE_BORROWER, SIDE_LENDER, type EntryRow, type ScannedEntry, type Side } from '../rewardEntries';
import { advanceFloor, d1ScanCursors, decodeIndex, finalFloor, finalizedBlockOnce, rotatingWindow, type FinalBlock, type ScanCursors } from '../scanCursors';
import { StepSender, type SendFeeCeiling } from '../stepSender';
import { pagesAfter } from '../rewardCloseOut/plan';
import { accumulationWedge, zeroedDayStep, type ZeroedDayState } from './plan';

export * from './plan';

export const ABI = [
  ...(RewardReporterFacetABI as Abi),
  ...(RewardCommitmentFacetABI as Abi),
  ...(RewardRemittanceLensFacetABI as Abi),
  ...(RewardAggregatorFacetABI as Abi),
  ...(InteractionRewardsLensFacetABI as Abi),
  ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'),
] as Abi;
const MESSENGER_ABI = VaipakamRewardMessengerABI as Abi;

export const PASS_CADENCE_SEC = 15 * 60;
/** Sends per chain per run: quote pages, dispatches and lapses together. */
export const MAX_SENDS_PER_RUN = 12;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Days a run reads, unless `REWARD_ZEROED_DAY_WINDOW_DAYS` says otherwise.
 *  They rotate over every elapsed day above a stored floor of settled days
 *  (`scanCursors.rotatingWindow`), so this bounds a run's reads and never
 *  which days are ever visited. */
export const DEFAULT_WINDOW_DAYS = 60;
/** Entry ids per `accumulateCompQuoteBatch`. */
export const PAGE_IDS = 100;
/** Entry pages one run may read, from the scan's stored floor. */
export const MAX_ENTRY_PAGES = 20;
/** The scan-cursor item this pass keeps (`scanCursors.ts`). */
export const ENTRY_FLOOR_ITEM = 'entry-floor';
export const DAY_FLOOR_ITEM = 'day-floor';
export const DAY_NEXT_ITEM = 'day-next';
export const MAX_FEE_VAR = 'REWARD_ZEROED_DAY_MAX_FEE_WEI';
/** An operator alert about a wedged accumulation re-sends after this. */
const WEDGE_ALERT_INTERVAL_SEC = 6 * 3600;
/** A lapse notice is a one-off: its key is never re-sent. */
const NOTICE_INTERVAL_SEC = 10 * 365 * 86_400;
const READ_CHUNK = 100;

const ROLE_MIRROR = 1;

/** Refusals that mean another caller got there first. */
export const RACES = new Set(['CompQuoteAlreadyDispatched', 'CommitmentEntriesNotAscending', 'LapseDayAlreadyTerminal']);
export const PAUSED_REFUSAL = 'EnforcedPause';

export interface ZeroedDayDeps {
  client: PublicClient;
  readClient: PublicClient;
  context: () => KeeperContext | null;
  keeper: Address | null;
  sendDeadline: number;
  windowDays: number;
  feeCeiling: SendFeeCeiling;
  /** Where its entry scan got to on this chain, across runs. */
  cursors: ScanCursors;
  /** Posts an operator alert; resolves whether it went out. Injected so a run
   *  is testable. */
  alert: (key: string, text: string, minIntervalSec: number) => Promise<unknown>;
}

export interface ZeroedDayReport {
  chainId: number;
  skipped?: string;
  /** Zeroed days seen in the lookback. */
  zeroed: number[];
  quoted: number[];
  /** Pages of quote accumulation that landed. */
  pagesLanded: number;
  lapsed: number[];
  shortLapsed: number[];
  /** Days a full lapse left with a partial loss figure, refined this run. */
  refined: number[];
  waiting: string[];
  wedged: string[];
  scanGap: number[];
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runRewardZeroedDay(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardZeroedDay', 'REWARD_ZEROED_DAY_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const windowDays = readPositive(env, 'REWARD_ZEROED_DAY_WINDOW_DAYS', DEFAULT_WINDOW_DAYS);
  const resolved = env.KEEPER_PRIVATE_KEY ? resolveKeeperAccount(env.KEEPER_PRIVATE_KEY) : null;
  const keeper = resolved && 'account' in resolved ? resolved.account.address : null;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await zeroedDayOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          keeper,
          sendDeadline,
          windowDays,
          feeCeiling: feeCeiling(env.REWARD_ZEROED_DAY_MAX_FEE_WEI, chain.id, MAX_FEE_VAR),
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'rewardZeroedDay'),
          alert: (key, text, interval) => sendOpsAlert(env, key, text, interval, undefined, chain.id),
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] rewardZeroedDay chain=${chain.id} failed: ${shortErr(err)}`);
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

export function describeReport(r: ZeroedDayReport): string {
  if (r.skipped) return `[keeper] rewardZeroedDay chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const list = (xs: readonly number[]) => xs.join(',') || 'none';
  const parts = [
    `[keeper] rewardZeroedDay chain=${r.chainId}`,
    `zeroed=${list(r.zeroed)}`,
    `quoted=${list(r.quoted)}`,
    ...(r.pagesLanded > 0 ? [`quote-pages=${r.pagesLanded}`] : []),
    `lapsed=${list(r.lapsed)}`,
    `short-lapsed=${list(r.shortLapsed)}`,
    ...(r.refined.length > 0 ? [`loss-refined=${list(r.refined)}`] : []),
    ...(r.waiting.length > 0 ? [`waiting=${r.waiting.join('; ')}`] : []),
    ...(r.wedged.length > 0 ? [`wedged=${r.wedged.join('; ')}`] : []),
    ...(r.scanGap.length > 0 ? [`days-scan-short=${list(r.scanGap)}`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** One chain's run. Exported for tests. */
export async function zeroedDayOnce(chainId: number, diamond: Address, deps: ZeroedDayDeps): Promise<ZeroedDayReport> {
  const sender = new StepSender(
    {
      pass: 'rewardZeroedDay',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      describe: (s) => `day ${s}`,
      spends: 'the gas and CCIP fee',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline, feeCeiling: deps.feeCeiling },
  );
  const report: ZeroedDayReport = {
    chainId,
    zeroed: [],
    quoted: [],
    pagesLanded: 0,
    lapsed: [],
    shortLapsed: [],
    refined: [],
    waiting: [],
    wedged: [],
    scanGap: [],
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new Reader(deps, diamond);
  try {
    const gate = await readGate(r, chainId);
    if (typeof gate === 'string') return { ...report, skipped: gate };
    // The elapsed days not yet settled are read `windowDays` a run, rotating
    // above a stored floor every day below which is settled for good: its
    // clock installed and either not zeroed or at a terminal. A window fixed
    // on the newest days would leave an older zeroed day unquoted and
    // unlapsed for good (Codex #2993 r2, the same rule as the close-out pass).
    // The floor moves only on what the finalized block shows (Codex #2993 r4),
    // so a lapse a reorg undoes stays above it and is sent again.
    const stored = await deps.cursors.get([DAY_FLOOR_ITEM, DAY_NEXT_ITEM]);
    const floor = Math.min(decodeIndex(stored.get(DAY_FLOOR_ITEM)) ?? 0, gate.today);
    const win = rotatingWindow(floor, gate.today - 1, deps.windowDays, decodeIndex(stored.get(DAY_NEXT_ITEM)));
    const days: number[] = [];
    if (win !== null) for (let d = win.from; d <= win.to; d++) days.push(d);
    const flags = await r.days(days, 'getDayDeliberatelyZeroed', 'zeroed');
    const clocks = await r.days(days, 'getDayLapseClock', 'clock');
    const settled = new Set<number>();
    days.forEach((d, i) => {
      const clock = clocks[i] as readonly [bigint, ...unknown[]] | undefined;
      if (flags[i] === undefined || clock === undefined) sender.noteUnread(`day:${d}`, 'whether the day is deliberately zeroed');
      else if (flags[i] === true) report.zeroed.push(d);
      // A day's zeroed marker is written with its clock, once, so a day with a
      // clock and no marker never becomes one.
      else if (BigInt(clock[0]) !== 0n) settled.add(d);
    });
    const readFloor = advanceFloor(floor, days, (d) => settled.has(d));
    if (report.zeroed.length > 0) {
      for (const d of await workDays(r, sender, report, gate.messenger, deps, readFloor)) settled.add(d);
    }
    const newFloor = await finalFloor(floor, days, (d) => settled.has(d), r.finalized, (ds, block) => settledAt(r, ds, block));
    if (newFloor !== floor) await deps.cursors.put(DAY_FLOOR_ITEM, String(newFloor));
    if (win !== null && String(win.next) !== stored.get(DAY_NEXT_ITEM)) await deps.cursors.put(DAY_NEXT_ITEM, String(win.next));
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

class Reader {
  /** The chain's finalized block, read once a run (`scanCursors.finalFloor`). */
  readonly finalized: () => Promise<FinalBlock | null>;

  constructor(
    readonly deps: ZeroedDayDeps,
    readonly diamond: Address,
  ) {
    this.finalized = finalizedBlockOnce(deps.client);
  }

  async one<T>(functionName: string, args: readonly unknown[] = [], address: Address = this.diamond, abi: Abi = ABI): Promise<T> {
    return (await this.deps.client.readContract({ address, abi, functionName, args })) as T;
  }

  /** At the head, or at `blockNumber` when one is given. */
  async many(calls: readonly { functionName: string; args: readonly unknown[] }[], label: string, blockNumber?: bigint): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < calls.length; i += READ_CHUNK) {
      const part = calls.slice(i, i + READ_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const res: BatchResult[] = await settledRead(
        this.deps.readClient,
        part.map((c) => ({ address: this.diamond, abi: ABI, functionName: c.functionName, args: c.args })),
        `rewardZeroedDay ${label}`,
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
  today: number;
  messenger: Address;
}

/** The Diamond must name itself this chain, hold the Mirror role and have a
 *  live reward clock: only a mirror has zeroed days of its own. */
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
  if (Number(role) !== ROLE_MIRROR) return `its reward role is ${Number(role)}, not Mirror: only a mirror has zeroed days to quote or lapse`;
  const day = await read<readonly [bigint, boolean]>('getInteractionCurrentDay', 'its reward day');
  if (typeof day === 'string') return day;
  if (!day[1]) return 'its reward clock is not running';
  return { today: Number(day[0]), messenger: cfg[0] };
}

/** Every zeroed day's state, read in one batch per field. */
async function readStates(
  r: Reader,
  onUnread: (day: number) => void,
  days: readonly number[],
  blockNumber?: bigint,
): Promise<Map<number, ZeroedDayState & { totals: { lender: bigint; borrower: bigint } }>> {
  const fns = ['getChainReportSentAt', 'getDayPoolStamp', 'getCompQuoteAccum', 'getDayLapseClock', 'getDayCompensation', 'getDayResolvedZero', 'getLapsedDayLoss', 'getShortLapseDeadline'];
  const calls = days.flatMap((d) => [
    ...fns.map((functionName) => ({ functionName, args: [BigInt(d)] as readonly unknown[] })),
    { functionName: 'getInteractionDayEntry', args: [BigInt(d), zeroAddress] as readonly unknown[] },
  ]);
  const res = await r.many(calls, blockNumber === undefined ? 'day-state' : 'day-state-final', blockNumber);
  const width = fns.length + 1;
  const out = new Map<number, ZeroedDayState & { totals: { lender: bigint; borrower: bigint } }>();
  days.forEach((d, i) => {
    const row = res.slice(i * width, (i + 1) * width);
    if (row.some((x) => x === undefined)) {
      onUnread(d);
      return;
    }
    const [sentAt, stamp, accum, clock, comp, resolvedZero, loss, short, totals] = row as [
      bigint,
      readonly [boolean, ...unknown[]],
      readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint],
      readonly [bigint, number, bigint, bigint],
      { compensated: boolean; provisional: boolean; lenderPool18: bigint; borrowerPool18: bigint },
      boolean,
      { recorded: boolean; partialFigure: boolean },
      readonly [bigint, bigint, bigint],
      readonly [bigint, bigint, bigint, bigint],
    ];
    out.set(d, {
      day: d,
      closeSentAt: BigInt(sentAt),
      stamped: stamp[0],
      accum: { cursorLender: accum[0], cursorBorrower: accum[1], accumLender: accum[2], accumBorrower: accum[3], consLender: accum[4], consBorrower: accum[5], sentAt: BigInt(accum[6]) },
      clock: { finalizedAt: BigInt(clock[0]), scheduleVersion: Number(clock[1]), lapseWindowSeconds: BigInt(clock[2]) },
      comp: { compensated: comp.compensated, provisional: comp.provisional, lenderPool: BigInt(comp.lenderPool18), borrowerPool: BigInt(comp.borrowerPool18) },
      resolvedZero,
      loss: { recorded: loss.recorded, partialFigure: loss.partialFigure },
      // A deadline of 0 means "not applicable" (no window): unread as a time.
      shortDeadline: comp.compensated && short[2] > 0n ? short[2] : null,
      totals: { lender: totals[2], borrower: totals[3] },
    });
  });
  return out;
}

/** The days of `days` settled at `block`, by the same rule the run applies
 *  at the head: a clock installed and no zeroed marker, or a zeroed day at a
 *  terminal. A value that cannot be read there reads as not settled. */
async function settledAt(r: Reader, days: readonly number[], block: FinalBlock): Promise<Set<number>> {
  const flags = await r.days(days, 'getDayDeliberatelyZeroed', 'zeroed-final', block.number);
  const clocks = await r.days(days, 'getDayLapseClock', 'clock-final', block.number);
  const out = new Set<number>();
  const zeroed: number[] = [];
  days.forEach((d, i) => {
    const clock = clocks[i] as readonly [bigint, ...unknown[]] | undefined;
    if (flags[i] === true) zeroed.push(d);
    else if (flags[i] === false && clock !== undefined && BigInt(clock[0]) !== 0n) out.add(d);
  });
  if (zeroed.length > 0) {
    const states = await readStates(r, () => {}, zeroed, block.number);
    for (const [d, s] of states) if (zeroedDayStep(s, block.timestamp).kind === 'done') out.add(d);
  }
  return out;
}

/** Works every zeroed day of the run; returns the ones at a terminal. The
 *  entry scan is anchored at `scanFrom`, the oldest day the pass may still
 *  work, so its stored floor stays valid whichever window a run reads. */
async function workDays(r: Reader, sender: StepSender, report: ZeroedDayReport, messenger: Address, deps: ZeroedDayDeps, scanFrom: number): Promise<number[]> {
  const states = await readStates(r, (d) => sender.noteUnread(`day:${d}`, 'its quote, clock, compensation or loss record'), report.zeroed);
  const now = (await deps.client.getBlock({ blockTag: 'latest' })).timestamp;
  // One entry scan for every day that needs a walk this run.
  const plans = [...states.values()].map((s) => ({ s, step: zeroedDayStep(s, now) }));
  const walkDays = plans.filter((p) => p.step.kind === 'quote' || p.step.kind === 'refine').map((p) => p.s.day);
  let entries: ScannedEntry[] = [];
  let completeThrough = Number.POSITIVE_INFINITY;
  if (walkDays.length > 0) {
    // From the stored floor: entries below it ended before the oldest day
    // the pass may still work, so a run reads the entries live across those
    // days, not the chain's whole history (`rewardEntries.ts`, Codex #2993 r1).
    const stored = (await deps.cursors.get([ENTRY_FLOOR_ITEM])).get(ENTRY_FLOOR_ITEM);
    const scan = await scanEntries(
      (from, n) => r.one<readonly EntryRow[]>('getRewardEntriesRange', [from, n]),
      scanFrom,
      walkDays[walkDays.length - 1],
      MAX_ENTRY_PAGES,
      decodeEntryFloor(stored),
    );
    const floor = encodeEntryFloor(scan.floor);
    if (floor !== stored) await deps.cursors.put(ENTRY_FLOOR_ITEM, floor);
    entries = scan.entries;
    completeThrough = scan.completeThrough;
    const beyond = walkDays.filter((d) => d > completeThrough);
    if (beyond.length > 0) {
      sender.noteUnread('quote', `the reward-entry scan reads at most ${MAX_ENTRY_PAGES} pages a run from its stored floor and reached only the entries starting by day ${completeThrough}, so days ${beyond.join(',')} are not accumulated this run (a quote on a partial scan cannot complete)`);
    }
  }
  const terminal = plans.filter((p) => p.step.kind === 'done').map((p) => p.s.day);
  for (const { s, step } of plans) {
    if (sender.stopped) return terminal;
    const d = s.day;
    switch (step.kind) {
      case 'done':
        break;
      case 'wait':
        report.waiting.push(`${d}: ${step.why}`);
        break;
      case 'lapse': {
        // eslint-disable-next-line no-await-in-loop
        const res = await sender.call('lapse', d, 'lapseZeroedDay', [BigInt(d)]);
        if (res === 'landed') {
          report.lapsed.push(d);
          // eslint-disable-next-line no-await-in-loop
          await noticeLapse(r, deps, report.chainId, d, false);
        }
        break;
      }
      case 'short-lapse': {
        // eslint-disable-next-line no-await-in-loop
        const res = await sender.call('short-lapse', d, 'lapseShortCompensatedDay', [BigInt(d)]);
        if (res === 'landed') {
          report.shortLapsed.push(d);
          // eslint-disable-next-line no-await-in-loop
          await noticeLapse(r, deps, report.chainId, d, true);
        }
        break;
      }
      case 'quote':
      case 'refine': {
        if (d > completeThrough) break;
        if (deps.keeper === null && step.kind === 'quote') {
          sender.noteUnread(`quote:${d}`, 'no signing key, so no quote can be dispatched');
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const done = await accumulate(r, sender, report, deps, s, entries);
        if (!done) break;
        if (step.kind === 'refine') {
          report.refined.push(d);
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await dispatch(r, sender, report, messenger, deps.keeper!, d);
        break;
      }
    }
  }
  return terminal;
}

/** Page every covering id past each side's cursor into the quote; true once
 *  both sides are complete. */
async function accumulate(
  r: Reader,
  sender: StepSender,
  report: ZeroedDayReport,
  deps: ZeroedDayDeps,
  s: ZeroedDayState & { totals: { lender: bigint; borrower: bigint } },
  entries: readonly ScannedEntry[],
): Promise<boolean> {
  const d = s.day;
  const cover = coveringEntries(entries, d);
  const gap = conservationGap(cover, s.totals);
  if (gap !== null) {
    report.scanGap.push(d);
    sender.noteUnread(`quote:${d}`, gap);
    return false;
  }
  const sides: { side: Side; name: string; cover: readonly ScannedEntry[]; cursor: bigint; conserved: bigint; total: bigint }[] = [
    { side: SIDE_LENDER, name: 'lender', cover: cover.lender, cursor: s.accum.cursorLender, conserved: s.accum.consLender, total: s.totals.lender },
    { side: SIDE_BORROWER, name: 'borrower', cover: cover.borrower, cursor: s.accum.cursorBorrower, conserved: s.accum.consBorrower, total: s.totals.borrower },
  ];
  let complete = true;
  for (const side of sides) {
    if (side.conserved === side.total) continue;
    const wedge = accumulationWedge(side.cover, side.cursor, side.conserved);
    const key = `zeroed-day-wedge:${report.chainId}:${d}:${side.side}`;
    if (wedge !== null) {
      report.wedged.push(`${d} ${side.name}: ${wedge}`);
      // eslint-disable-next-line no-await-in-loop
      await deps.alert(
        key,
        `⚠️ Zeroed reward day ${d} on chain ${report.chainId}: the ${side.name}-side compensation quote cannot complete — ${wedge}. Only the administrator's resetCompQuoteAccumulation(${d}, ${side.side}) frees it; until then the day is not quoted, so Base has no figure to compensate it against before it lapses.`,
        WEDGE_ALERT_INTERVAL_SEC,
      );
      complete = false;
      continue;
    }
    for (const page of pagesAfter(side.cover.map((e) => e.id), side.cursor, PAGE_IDS)) {
      // eslint-disable-next-line no-await-in-loop
      const res = await sender.call(`accumulate-${side.name}`, d, 'accumulateCompQuoteBatch', [BigInt(d), side.side, page]);
      if (res !== 'landed') return false;
      report.pagesLanded += 1;
    }
  }
  return complete;
}

async function dispatch(r: Reader, sender: StepSender, report: ZeroedDayReport, messenger: Address, keeper: Address, d: number): Promise<void> {
  const accum = await r.one<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>('getCompQuoteAccum', [BigInt(d)]);
  let fee: bigint;
  try {
    fee = await r.one<bigint>('quoteSendCompQuote', [BigInt(d), accum[2], accum[3]], messenger, MESSENGER_ABI);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    sender.noteUnread(`quote:${d}`, `the messenger's fee for the quote (${shortErr(err)})`);
    return;
  }
  const res = await sender.call('quote', d, 'quoteZeroedDayCompensation', [BigInt(d), keeper], fee);
  if (res === 'landed') report.quoted.push(d);
}

/** One operator notice per lapse the keeper made, with the loss the chain
 *  recorded for it, read back from the chain rather than computed here. */
async function noticeLapse(r: Reader, deps: ZeroedDayDeps, chainId: number, d: number, short: boolean): Promise<void> {
  let figure: string;
  try {
    const loss = await r.one<{ lender18: bigint; borrower18: bigint; partialFigure: boolean }>('getLapsedDayLoss', [BigInt(d)]);
    figure = `recorded loss: lender side ${loss.lender18}, borrower side ${loss.borrower18} (numeraire, 18 decimals)${loss.partialFigure ? ', a PARTIAL figure: the quote had not completed, and the keeper keeps accumulating until it is exact' : ''}`;
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    figure = `the recorded loss could not be read back (${shortErr(err)}); read getLapsedDayLoss(${d})`;
  }
  const what = short
    ? `was funded below its quote past its deadline and now prices from the pool it was funded with`
    : `was never compensated before its frozen expiry and retired at zero for its users`;
  await deps.alert(`zeroed-day-lapse:${chainId}:${d}`, `ℹ️ Zeroed reward day ${d} on chain ${chainId} ${what}; ${figure}.`, NOTICE_INTERVAL_SEC);
}
