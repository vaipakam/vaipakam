// apps/keeper/src/rateRecord.ts
//
// #3683 / #3437 — the RATE RECORD step of the `priceCheckpoint` pass: the
// keeper's call of `PriceGuard.recordRate(token, hash)` for every rate binding
// a rate-priced token has had.
//
// A rate-priced token (a wrapped or yield-bearing token valued as an exchange
// rate against an underlying) is priced from the rate the guard has ACCEPTED,
// not from what its source reports. The accepted rate follows the source down
// at once and up by at most the binding's daily bound for the time since the
// last record, counted as at most one day. So a rate nobody records stops
// following honest growth: the collateral is undervalued (never overvalued)
// until someone calls `recordRate`. A loan keeps the binding it opened under
// (#3437), so every binding a token has had is recorded, not only its current
// one.
//
// Per chain, per run (the pass runs at :11 and :41):
//
//   1. The guard: the Diamond's `getPriceGuard`. Unset: nothing to record,
//      and the line says so.
//   2. DISCOVERY — the guard keeps no list of bindings, so they are found
//      from its own `RateBindingRegistered` logs, read from where the last run
//      stopped up to the chain's FINALIZED block, a bounded number of ranges
//      per run, and queued in the keeper's open-work queue (kind
//      `rate_binding`, item `<guard>:<token>:<hash>`). Queue first, cursor
//      second, so a failure between the two reads the range again. The
//      cursor is kept per guard, so a replacement guard is read from the
//      deployment's first block, not from where the old guard's reading
//      stopped. A binding is never retired from the queue: a loan may hold
//      it for as long as the loan is open.
//   3. DUE — each queued binding's state (`rateStateOf`). A binding recorded
//      within the last `RECORD_AFTER_SEC` (50 minutes) is not due, so the two
//      runs of an hour record each binding once. A binding whose state reads
//      as never recorded is named, not sent (the guard would refuse it).
//   4. SEND — `recordRate(token, hash)`, simulated first, oldest-checked
//      first, at most MAX_SENDS_PER_RUN per chain. The run's line names each
//      binding recorded, each one distrusted (`RateDistrusted`) and each one
//      under observation (`RateObserved`), from the receipt's own events.
//
// Permissionless, no value moves, and nobody chooses the rate: the guard
// reads the source itself and applies its own bounds.
//
// Gated by KEEPER_ENABLED + PRICE_CHECKPOINT_ENABLED + RATE_RECORD_ENABLED.
// Ships disarmed.

import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { OracleAdminFacetABI, PriceGuardABI } from '@vaipakam/contracts/abis';
import type { KeeperContext } from './keeper';
import { PastRunDeadline, settledGroupedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import type { WorkItem } from './db';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import type { ScanCursors } from './scanCursors';
import { StepSender } from './stepSender';

export const GUARD_ABI = PriceGuardABI as Abi;
export const ABI = [...GUARD_ABI, ...(OracleAdminFacetABI as Abi)] as Abi;

/** A binding recorded more recently than this is not due: the pass runs
 *  twice an hour, and this records each binding once an hour. */
export const RECORD_AFTER_SEC = 50 * 60;
export const MAX_SENDS_PER_RUN = 10;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** Blocks one log read covers, and log reads per chain per run. */
export const LOG_RANGE = 5_000n;
export const LOG_RANGES_PER_RUN = 20;
/** Queued bindings read per chain per run, least recently checked first. */
export const BINDINGS_PER_RUN = 200;
const READ_CHUNK = 100;

export const WORK_KIND = 'rate_binding' as const;
/** The discovery cursor's item, per guard. */
export const cursorItem = (guard: Address) => `rate-bindings-from:${guard.toLowerCase()}`;

const REGISTERED = GUARD_ABI.find((x) => x.type === 'event' && x.name === 'RateBindingRegistered')!;

/** The step's queue of bindings on one chain and Diamond. Injected so a run is testable. */
export interface BindingQueue {
  enqueue(items: readonly WorkItem<Record<string, never>>[]): Promise<void>;
  open(limit: number): Promise<string[]>;
  touch(items: readonly string[]): Promise<void>;
}

export interface RateRecordDeps {
  /** Deadline-bound client: single reads, logs and the finalized block. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the cutoff themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  queue: BindingQueue;
  cursors: ScanCursors;
  /** The deployment's first block: where a guard's discovery starts. */
  floor: number;
  visit: number;
}

export interface RateRecordReport {
  chainId: number;
  skipped?: string;
  guard: Address | null;
  discovery: { from: number; to: number; queued: number; caughtUp: boolean } | null;
  queued: number;
  notDue: number;
  /** `<token>:<hash prefix>` of bindings the guard reads as never recorded. */
  unknown: string[];
  recorded: string[];
  distrusted: string[];
  observed: string[];
  deferred: number;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

/** A queued item, `<guard>:<token>:<hash>`, or null when malformed. Pure. */
export function parseItem(item: string): { guard: Address; token: Address; hash: Hex } | null {
  const m = /^(0x[0-9a-f]{40}):(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/.exec(item);
  return m ? { guard: m[1] as Address, token: m[2] as Address, hash: m[3] as Hex } : null;
}

const label = (token: Address, hash: Hex) => `${token}:${hash.slice(0, 10)}`;

/** The bindings a page of `RateBindingRegistered` logs names, once each. Pure. */
export function registeredBindings(
  guard: Address,
  logs: readonly { args: { hash?: Hex; token?: Address }; blockNumber: bigint | null }[],
): WorkItem<Record<string, never>>[] {
  const out = new Map<string, WorkItem<Record<string, never>>>();
  for (const l of logs) {
    const token = l.args.token?.toLowerCase();
    const hash = l.args.hash?.toLowerCase();
    if (!token || !hash) continue;
    const item = `${guard.toLowerCase()}:${token}:${hash}`;
    if (!out.has(item)) out.set(item, { item, block: Number(l.blockNumber ?? 0n), payload: {} });
  }
  return [...out.values()];
}

export function describeReport(r: RateRecordReport): string {
  if (r.skipped) return `[keeper] priceCheckpoint rateRecord chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const d = r.discovery;
  const parts = [
    `[keeper] priceCheckpoint rateRecord chain=${r.chainId} guard=${r.guard}`,
    d === null ? 'discovery=unread' : `discovery=${d.from}..${d.to} queued=${d.queued}${d.caughtUp ? '' : ' (behind the finalized block)'}`,
    `bindings=${r.queued}`,
    `not-due=${r.notDue}`,
    `recorded=${r.recorded.join(',') || 'none'}`,
    ...(r.distrusted.length > 0 ? [`distrusted=${r.distrusted.join(',')} (a fall past the binding's bound; the guard observes it before it can be confirmed)`] : []),
    ...(r.observed.length > 0 ? [`under-observation=${r.observed.join(',')}`] : []),
    ...(r.unknown.length > 0 ? [`never-recorded=${r.unknown.join(',')} (the guard holds no state for these)`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (over this run's sends; next run)`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** One chain's run. Exported for tests. */
export async function recordRatesOnce(chainId: number, diamond: Address, deps: RateRecordDeps): Promise<RateRecordReport> {
  const readCutoff = readCutoffMs(deps.sendDeadline);
  const earlyCutoff = priorStageCutoffMs(readCutoff);
  const report: RateRecordReport = {
    chainId,
    guard: null,
    discovery: null,
    queued: 0,
    notDue: 0,
    unknown: [],
    recorded: [],
    distrusted: [],
    observed: [],
    deferred: 0,
    refused: new Map(),
    unread: new Map(),
    stopped: null,
  };

  let guard: Address;
  try {
    guard = (await boundedCall(earlyCutoff, 'the price guard', () =>
      deps.client.readContract({ address: diamond, abi: ABI, functionName: 'getPriceGuard' }),
    )) as Address;
  } catch (err) {
    return { ...report, skipped: err instanceof PastRunDeadline ? 'the run deadline passed during its first reads' : `the price guard could not be read (${shortErr(err)})` };
  }
  if (/^0x0{40}$/i.test(guard)) return { ...report, skipped: 'this Diamond has no price guard set, so no rate is priced through one' };
  report.guard = guard;

  const sender = new StepSender(
    {
      pass: 'priceCheckpoint',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: new Set(),
      pausedRefusal: 'EnforcedPause',
      describe: (s) => `rate binding ${s}`,
      spends: 'the gas',
      target: guard,
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  report.refused = sender.refused;
  report.unread = sender.unread;

  // 1. Discovery, before the queue is read, so a binding registered since the
  //    last run is worked in this one.
  try {
    report.discovery = await discover(guard, deps, earlyCutoff);
  } catch (err) {
    sender.noteUnread('discovery', err instanceof PastRunDeadline ? 'still in flight at its cutoff' : `the guard's binding logs (${shortErr(err)})`);
  }

  // 2. What is due.
  let items: string[];
  try {
    items = await boundedCall(earlyCutoff, 'the queued bindings', () => deps.queue.open(BINDINGS_PER_RUN));
  } catch (err) {
    sender.noteUnread('bindings', err instanceof PastRunDeadline ? 'still in flight at its cutoff' : `the queued bindings (${shortErr(err)})`);
    report.stopped = sender.stopped ? sender.stopReason : null;
    return report;
  }
  const mine = items.map(parseItem).filter((b): b is NonNullable<typeof b> => b !== null && b.guard === guard.toLowerCase());
  report.queued = mine.length;
  const due: { token: Address; hash: Hex }[] = [];
  if (mine.length > 0) {
    try {
      const [states, block] = await Promise.all([
        settledGroupedRead(
          deps.readClient,
          mine,
          READ_CHUNK,
          (b) => [{ address: guard, abi: GUARD_ABI, functionName: 'rateStateOf', args: [b.token, b.hash] }],
          'priceCheckpoint rateStateOf',
          readCutoff,
          deps.visit,
        ),
        boundedCall(readCutoff, "the chain's clock", () => deps.client.getBlock()),
      ]);
      const now = Number(block.timestamp);
      let unread = 0;
      for (const b of mine) {
        const [r] = states.get(b) ?? [];
        if (r?.status !== 'success') {
          unread++;
          continue;
        }
        const st = r.result as { at: bigint };
        const at = Number(st.at);
        if (at === 0) report.unknown.push(label(b.token, b.hash));
        else if (now - at < RECORD_AFTER_SEC) report.notDue++;
        else due.push({ token: b.token, hash: b.hash });
      }
      if (unread > 0) sender.noteUnread('bindings', `the state of ${unread} binding(s)`);
    } catch (err) {
      sender.noteUnread('bindings', err instanceof PastRunDeadline ? 'the run deadline passed during the binding reads' : `the binding states (${shortErr(err)})`);
    }
    await deps.queue.touch(items).catch((err) => sender.noteUnread('queue', `the checked mark (${shortErr(err)})`));
  }

  // 3. The guard decides.
  const picked = due.slice(0, MAX_SENDS_PER_RUN);
  report.deferred = due.length - picked.length;
  for (const b of picked) {
    if (sender.stopped) break;
    const name = label(b.token, b.hash);
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('record', name, 'recordRate', [b.token, b.hash]);
    if (res !== 'landed') continue;
    const outcome = recordOutcome(guard, sender.receipt?.logs ?? []);
    if (outcome === 'distrusted') report.distrusted.push(name);
    else if (outcome === 'observed') report.observed.push(name);
    else report.recorded.push(name);
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** What a landed `recordRate` did, from the guard's own event. Pure. */
export function recordOutcome(guard: Address, logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]): 'recorded' | 'distrusted' | 'observed' | 'unknown' {
  for (const log of logs) {
    if (log.address.toLowerCase() !== guard.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: GUARD_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === 'RateRecorded') return 'recorded';
      if (ev.eventName === 'RateDistrusted') return 'distrusted';
      if (ev.eventName === 'RateObserved') return 'observed';
    } catch {
      continue;
    }
  }
  return 'unknown';
}

/** The guard's binding logs from its cursor to the finalized block, queued
 *  before the cursor moves. */
async function discover(guard: Address, deps: RateRecordDeps, cutoff: number): Promise<NonNullable<RateRecordReport['discovery']>> {
  const fin = await boundedCall(cutoff, 'the finalized block', () => deps.client.getBlock({ blockTag: 'finalized' }));
  const through = fin.number as bigint;
  const stored = Number((await deps.cursors.get([cursorItem(guard)])).get(cursorItem(guard)) ?? 0);
  const start = BigInt(Math.max(deps.floor, Number.isSafeInteger(stored) ? stored : 0));
  let from = start;
  let queued = 0;
  for (let i = 0; i < LOG_RANGES_PER_RUN && from <= through; i++) {
    const to = from + LOG_RANGE - 1n > through ? through : from + LOG_RANGE - 1n;
    const lo = from;
    // eslint-disable-next-line no-await-in-loop
    const logs = await boundedCall(cutoff, 'the binding logs', () =>
      deps.client.getLogs({ address: guard, event: REGISTERED as never, fromBlock: lo, toBlock: to }),
    );
    const items = registeredBindings(guard, logs as unknown as readonly { args: { hash?: Hex; token?: Address }; blockNumber: bigint | null }[]);
    // eslint-disable-next-line no-await-in-loop
    await deps.queue.enqueue(items);
    // eslint-disable-next-line no-await-in-loop
    await deps.cursors.put(cursorItem(guard), String(to + 1n));
    queued += items.length;
    from = to + 1n;
  }
  return { from: Number(start), to: Number(from - 1n), queued, caughtUp: from > through };
}
