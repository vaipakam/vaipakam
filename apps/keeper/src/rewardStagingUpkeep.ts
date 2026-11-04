// apps/keeper/src/rewardStagingUpkeep.ts
//
// #3097 — the reward staging upkeep pass: the keeper backstop for the seven
// permissionless staging steps the #2984 ledger recorded as gaps, plus the
// general case of the two resolution pages.
//
// A claim day one call could not settle is held in a STAGING RECORD (#1566
// A2): the claim, forfeit and expiry walks open it, and from then on only the
// permissionless entries move it. Nothing else calls them, so without this
// pass a record waits for whoever happens to call, a Resolving record (which
// has no deadline) never finishes, and a released batch's priority window
// lapses with nobody registered. Each run, per chain:
//
//   Continuation (step `advance`), for every open subject the event ledger
//   names, decided from its own state read on chain:
//     - a standalone record that is Staging: `prepareStagedDay` while its scan
//       is incomplete, then `reserveStagedDay` once the day is covered;
//     - a Reserved or Resolving record: `resolveStagedDayPage` until it pays
//       and closes;
//     - a claim domain: `reserveDomainPage` once its claims have prepared it
//       (a day record whose scan is incomplete gets `prepareStagedDay` first,
//       as the page asks), then `resolveDomainPage` until it clears;
//     - a legacy slice still preparing or consuming: `stepLegacySlice`.
//   Priority windows (step `register`): a record that found a released batch
//   contested is registered for the batch's open window
//   (`registerForBatchWindow`) when that makes it the oldest registrant, and
//   once the window closes the oldest registrant takes its priority right
//   through its next `prepareStagedDay`.
//   Unwinds (step `unwind`, its own flag): a record or claim domain past its
//   deadline that the continuation cannot cover, a stale record (the
//   contract's own finding), and an unwind already under way, are unwound
//   page by page (`unwindStagedDayPage`, `unwindDomainPage`). An unwind
//   returns exactly what the record held; it is a release, never a payout.
//
// The keeper moves nothing of its own and receives nothing: every value
// movement is the record's own, made by the contract from storage. The one
// payout this pass leaves alone is a claim payout the sanctions screen would
// HOLD (the claimant is flagged): that page is the sanctions-hold pass's,
// which observes the screen on it (`rewardSanctionsHold`).
//
// Every call is simulated first (`StepSender`). Two pages can do more than
// their name says, and for those the contract's own preview decides
// (`pageEffect`, read from an eth_simulateV1 of the page): a Reserved
// record's first resolution page and a domain's reservation page each
// revalidate first and UNWIND on a stale finding, so a preview that shows the
// unwind is routed to the unwind step and its flag; and a domain reservation
// that would stop on an uncovered day with nothing reserved is not sent (the
// stop is the contract's own `StagingDomainReserveStopped`, and only it ever
// leads to a deadline unwind). Every other landed page is checked by
// re-reading its subject: when nothing it reads changed, the subject is
// recorded idle at that state and not tried again until its state changes or
// a day has passed (`STAGING_RETRY_CADENCE`), since coverage depends on
// sources outside the record. A record's membership of a claim domain is the
// contract's to say (`StagingRecordInDomain`), never inferred from a
// domain's extent.
//
// Gated by KEEPER_ENABLED + REWARD_STAGING_UPKEEP_ENABLED (the unwinds also
// by REWARD_STAGING_UNWIND_ENABLED). Ships disarmed.

import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Abi,
  type Address,
  type Log,
  type PublicClient,
} from 'viem';
import {
  DIAMOND_ABI_VIEM,
  ProfileFacetABI,
  RewardStagingDomainFacetABI,
  RewardStagingFacetABI,
  RewardStagingSettleFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, subStepArmed, type KeeperContext } from './keeper';
import type { PassTick } from './passSchedule';
import { deadlineClient, PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { deploymentFloor, listBatchContests, listOpenLegacySlices, listOpenStaging, type BatchContest, type OpenStaging } from './db';
import { PassReader } from './passReader';
import { pickBatch } from './rotate';
import { runIndex } from './runWindow';
import { d1ScanCursors, type ScanCursors } from './scanCursors';
import { StepSender, type CallResult } from './stepSender';

const pick = (abi: unknown, names: readonly string[]): Abi =>
  (abi as Abi).filter((x) => (x.type === 'function' || x.type === 'event') && names.includes(x.name)) as Abi;

export const ABI = [
  ...pick(RewardStagingFacetABI, ['prepareStagedDay', 'reserveStagedDay']),
  ...pick(RewardStagingSettleFacetABI, ['resolveStagedDayPage', 'unwindStagedDayPage', 'registerForBatchWindow']),
  ...pick(RewardStagingDomainFacetABI, [
    'reserveDomainPage',
    'resolveDomainPage',
    'unwindDomainPage',
    'stepLegacySlice',
    'getStagingRecord',
    'getStagingDomain',
    'getLegacySliceDomain',
    'getTransportBatchWindow',
    'isTransportBatchPriorityUsed',
    // The events a page's preview is read for (`pageEffect`).
    'StagingRecordStale',
    'StagingDomainPhase',
    'StagingDomainReserveStopped',
  ]),
  ...pick(ProfileFacetABI, ['isSanctionedAddress']),
  // Every error the Diamond can revert with, so a refusal from deep in a page
  // (a pricing check, the sanctions screen) is named, not hex.
  ...DIAMOND_ABI_VIEM.filter((x) => x.type === 'error'),
] as Abi;

/** The pass's cadence, in seconds. A record's deadline and a batch window
 *  are both days long, so an hour is not material to either. */
export const PASS_CADENCE_SEC = 60 * 60;
/** Each step's share of a run's sends, per chain. */
export const MAX_ADVANCE_PER_RUN = 10;
export const MAX_REGISTER_PER_RUN = 2;
export const MAX_UNWIND_PER_RUN = 4;
export const MAX_SENDS_PER_RUN = MAX_ADVANCE_PER_RUN + MAX_REGISTER_PER_RUN + MAX_UNWIND_PER_RUN;
/** Pages one subject may take in a run, so one long record cannot spend the
 *  step's whole share. */
export const MAX_PAGES_PER_SUBJECT = 3;
/** Subjects read per run and kind, rotating when there are more. */
export const SUBJECTS_PER_RUN = 100;
export const RECEIPT_TIMEOUT_MS = 30_000;
/** `LibRewardCustody.STAGING_RETRY_CADENCE`: how long a subject recorded idle
 *  waits before it is tried again at an unchanged state, and how long a
 *  closed window's oldest registrant holds its priority right. */
export const STAGING_RETRY_CADENCE = 86_400n;

/** `LibVaipakam.StagingPhase`. */
export const PHASE = { none: 0, staging: 1, reserved: 2, resolving: 3, unwinding: 4 } as const;
/** `LibVaipakam.DomainPhase`. */
export const DOMAIN_PHASE = { none: 0, staging: 1, reserving: 2, resolving: 3, unwinding: 4 } as const;
/** `LibVaipakam.StagingOp`. */
export const OP = { none: 0, claim: 1, forfeit: 2, expiry: 3, legacySlice: 4 } as const;

export const PAUSED_REFUSAL = 'EnforcedPause';
/** Refusals that say a subject is not ready yet: reported as a wait, not as a
 *  fault, and tried again on a later run. */
export const WAITS: ReadonlyMap<string, string> = new Map([
  ['StagingNotCovered', 'the day is not covered yet (live sources or cap headroom short)'],
  ['StagingNotExpired', 'its deadline has not passed'],
  ['StagingDomainNotExpired', 'its deadline has not passed'],
  ['StagingDomainNotPrepared', "its claimant's claims have not prepared every day yet"],
  ['StagingNotWaiting', 'it is not waiting on this batch'],
  ['StagingPriorityUsed', 'it has used its priority reservation on this batch'],
  ['TransportBatchWindowNotOpen', 'the batch window is not open'],
  ['LegacySliceNotPending', 'the slice is not pending'],
]);
/** Refusals that say another caller moved the subject first. */
export const RACES: ReadonlySet<string> = new Set(['StagingRecordUnknown', 'StagingPhaseInvalid', 'StagingDomainPhaseInvalid']);

/** A staging record, as `getStagingRecord` reads it (the fields the pass
 *  decides on; the rest are carried for the idle measure). */
export interface StagingRecordView {
  user: Address;
  side: number;
  op: number;
  phase: number;
  day: bigint;
  openedAt: bigint;
  deadline: bigint;
  batchCount: bigint;
  resolveCursor: bigint;
  scanComplete: boolean;
  pendingOverflow: boolean;
  [field: string]: unknown;
}

/** A claim domain, as `getStagingDomain` reads it. */
export interface StagingDomainView {
  domainKey: string;
  phase: number;
  firstDay: bigint;
  lastDay: bigint;
  preparedThrough: bigint;
  reserveCursor: bigint;
  resolveCursor: bigint;
  unwindCursor: bigint;
  liveRecords: number;
  openedAt: bigint;
  deadline: bigint;
  chunks: bigint;
  entryCount: bigint;
}

/** A legacy slice's domain, as `getLegacySliceDomain` reads it. */
export interface LegacySliceView {
  domainKey: string;
  phase: number;
  firstDay: bigint;
  lastDay: bigint;
  preparedThrough: bigint;
  consumeCursor: bigint;
  liveRecords: number;
  epochFresh: bigint;
}

/** Where the subjects come from: the indexer's event ledger. Injected so a
 *  run is testable. */
export interface StagingSource {
  open(): Promise<OpenStaging[]>;
  legacySlices(): Promise<bigint[]>;
  contests(): Promise<BatchContest[]>;
}

export function d1StagingSource(db: D1Database, chainId: number): StagingSource {
  const floor = deploymentFloor(chainId);
  return {
    open: () => listOpenStaging(db, chainId, floor),
    legacySlices: () => listOpenLegacySlices(db, chainId, floor),
    contests: () => listBatchContests(db, chainId, floor),
  };
}

export interface StagingUpkeepDeps {
  /** Deadline-bound client: single reads and simulations. */
  client: PublicClient;
  /** Plain client for the batched reads, which carry the deadline themselves. */
  readClient: PublicClient;
  context: () => KeeperContext | null;
  sendDeadline: number;
  source: StagingSource;
  /** Idle markers, per subject. */
  cursors: ScanCursors;
  /** Which run this is (`runIndex`): the rotation when subjects overflow. */
  visit: number;
  /** The unwinds (REWARD_STAGING_UNWIND_ENABLED). Off when absent. */
  unwind?: boolean;
}

/** One call the pass made or left, for the run's line. */
export interface Action {
  /** The subject, as the line names it (`record 0xabcd…`, `slice 12`). */
  subject: string;
  /** What happened: `prepareStagedDay landed`, `waits: …`, `left: …`. */
  what: string;
}

export interface StagingUpkeepReport {
  chainId: number;
  skipped?: string;
  /** Open subjects the ledger named, per kind, and how many were read. */
  named: { records: number; domains: number; slices: number; contests: number };
  /** Pages that landed, by entry point. */
  landed: Map<string, number>;
  /** Subjects that closed or cleared this run. */
  closed: string[];
  /** Subjects that wait, and on what. */
  waiting: Action[];
  /** Subjects left to another pass or to their claimant, and why. */
  left: Action[];
  /** Subjects whose landed page changed nothing they read: recorded idle. */
  idle: string[];
  /** Unwinds that were due but not sent because the unwind step is off. */
  unwindsHeld: Action[];
  /** Subjects deferred to a later run by rotation or a step's share. */
  deferred: number;
  refused: Map<string, string>;
  unread: Map<string, string>;
  stopped: string | null;
}

export async function runRewardStagingUpkeep(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardStagingUpkeep', 'REWARD_STAGING_UPKEEP_ENABLED')) return;
  const sendDeadline = tick.deadlineMs;
  const unwind = subStepArmed(env, 'rewardStagingUpkeep', 'the unwinds', 'REWARD_STAGING_UNWIND_ENABLED');
  const visit = runIndex(tick, PASS_CADENCE_SEC * 1000);
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  // Chains side by side (runWindow.ts, rule 1): each has its own nonce lane.
  await Promise.all(
    chains.map(async (chain: ChainConfig) => {
      try {
        const plain = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
        const client = deadlineClient(plain, sendDeadline);
        const report = await stagingUpkeepOnce(chain.id, chain.diamond as Address, {
          client,
          readClient: plain,
          context: () => buildKeeperContext(env, chain, client, { notAfterMs: sendDeadline }),
          sendDeadline,
          source: d1StagingSource(env.DB, chain.id),
          cursors: d1ScanCursors(env.KEEPER_DB, chain.id, chain.diamond as string, 'rewardStagingUpkeep'),
          visit,
          unwind,
        });
        console.log(describeReport(report));
      } catch (err) {
        console.error(`[keeper] rewardStagingUpkeep chain=${chain.id} failed: ${shortErr(err)}`);
      }
    }),
  );
}

const short = (hex: string) => `${hex.slice(0, 10)}…`;
const list = (xs: readonly Action[]) => xs.map((a) => `${a.subject}(${a.what})`).join('; ');

/** The run's one line for a chain. */
export function describeReport(r: StagingUpkeepReport): string {
  if (r.skipped) return `[keeper] rewardStagingUpkeep chain=${r.chainId}: not worked this run: ${r.skipped}`;
  const n = r.named;
  const parts = [
    `[keeper] rewardStagingUpkeep chain=${r.chainId}`,
    `open=records:${n.records},domains:${n.domains},slices:${n.slices},contests:${n.contests}`,
    `landed=${[...r.landed].map(([fn, c]) => `${fn}×${c}`).join(',') || 'none'}`,
    ...(r.closed.length > 0 ? [`closed=${r.closed.join(',')}`] : []),
    ...(r.waiting.length > 0 ? [`waiting=${list(r.waiting)}`] : []),
    ...(r.left.length > 0 ? [`left=${list(r.left)}`] : []),
    ...(r.idle.length > 0 ? [`idle=${r.idle.join(',')} (a landed page changed nothing; retried when the state changes or after a day)`] : []),
    ...(r.unwindsHeld.length > 0 ? [`unwind-due=${list(r.unwindsHeld)} (REWARD_STAGING_UNWIND_ENABLED not armed)`] : []),
    ...(r.deferred > 0 ? [`deferred=${r.deferred} (taken on later runs)`] : []),
    ...(r.refused.size > 0 ? [`refused=${[...r.refused].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.unread.size > 0 ? [`unread=${[...r.unread].map(([k, v]) => `${k}(${v})`).join(',')}`] : []),
    ...(r.stopped ? [`stopped=${r.stopped}`] : []),
  ];
  return parts.join(' ');
}

/** `LibRewardCustody.stagingKey`: a claimant's day record. */
export function stagingKey(user: Address, side: number, day: bigint): string {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }, { type: 'uint256' }], [user, side, day]));
}

/** `LibRewardCustody.domainKey`: a claimant's domain on one side. */
export function domainKey(user: Address, side: number): string {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint8' }], [user, side]));
}

/** `LibRewardCustody.legacyRecordKey`: a legacy slice's record of one day. */
export function legacyRecordKey(legacyDomain: string, day: bigint): string {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [legacyDomain as `0x${string}`, day]));
}

/** What a page would do, read from its preview's logs. Exported for tests. */
export interface PageEffect {
  /** The page unwinds `key`: a stale finding on a record's first
   *  resolution page, or a domain sent to Unwinding by its revalidation. */
  unwinds: boolean;
  /** The day a domain's reservation stops on, not covered; null when it does
   *  not stop. */
  reserveStoppedAt: bigint | null;
}

export function pageEffect(diamond: Address, logs: readonly Log[], key: string): PageEffect {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const k = key.toLowerCase();
  const out: PageEffect = { unwinds: false, reserveStoppedAt: null };
  for (const e of parseEventLogs({ abi: ABI, logs: own as Log[] })) {
    const a = e.args as Record<string, unknown>;
    const of = String(a.key ?? a.domainKey ?? '').toLowerCase();
    if (of !== k) continue;
    if (e.eventName === 'StagingRecordStale') out.unwinds = true;
    else if (e.eventName === 'StagingDomainPhase' && Number(a.phase) === DOMAIN_PHASE.unwinding) out.unwinds = true;
    else if (e.eventName === 'StagingDomainReserveStopped') out.reserveStoppedAt = BigInt(a.day as bigint);
  }
  return out;
}

/** The measure a landed page is checked against: a digest of everything the
 *  subject's reads returned. Exported for tests. */
export function stateDigest(...views: readonly unknown[]): string {
  return keccak256(stringToHex(JSON.stringify(views, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
}

const idleItem = (subject: string) => `idle:${subject}`;

/** What a subject's own state says to do next. Exported for tests. */
export type RecordMove =
  | { kind: 'gone' }
  | { kind: 'in-domain' }
  | { kind: 'prepare' }
  | { kind: 'reserve' }
  | { kind: 'resolve'; payoutOnly: boolean }
  | { kind: 'unwind'; why: string };

/** A record's next move, from its own state. A record whose op is a legacy
 *  slice is the slice's. One inside a claim domain is not told apart here:
 *  its view does not carry its domain, and the entries refuse it by name
 *  (`StagingRecordInDomain`), which the run reads as the domain's. */
export function recordMove(rec: StagingRecordView): RecordMove {
  const phase = Number(rec.phase);
  if (phase === PHASE.none) return { kind: 'gone' };
  if (Number(rec.op) === OP.legacySlice) return { kind: 'in-domain' };
  if (phase === PHASE.unwinding) return { kind: 'unwind', why: 'its unwind is under way' };
  if (phase === PHASE.reserved || phase === PHASE.resolving) {
    return { kind: 'resolve', payoutOnly: phase === PHASE.resolving && BigInt(rec.resolveCursor) >= BigInt(rec.batchCount) };
  }
  if (rec.pendingOverflow) return { kind: 'unwind', why: 'its pending work overflowed (it can only unwind)' };
  return rec.scanComplete ? { kind: 'reserve' } : { kind: 'prepare' };
}

/** One chain's run. Exported for tests. */
export async function stagingUpkeepOnce(chainId: number, diamond: Address, deps: StagingUpkeepDeps): Promise<StagingUpkeepReport> {
  const sender = new StepSender(
    {
      pass: 'rewardStagingUpkeep',
      abi: ABI,
      maxSends: MAX_SENDS_PER_RUN,
      stepBudgets: { advance: MAX_ADVANCE_PER_RUN, register: MAX_REGISTER_PER_RUN, unwind: MAX_UNWIND_PER_RUN },
      receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
      races: RACES,
      pausedRefusal: PAUSED_REFUSAL,
      unrecorded: new Set([...WAITS.keys(), 'StagingScanIncomplete', 'RewardEntrySetMismatch', 'StagingPendingOverflow', 'StagingRecordInDomain']),
      describe: (s) => String(s),
      spends: 'the gas',
    },
    { context: deps.context, sendDeadline: deps.sendDeadline },
  );
  const report: StagingUpkeepReport = {
    chainId,
    named: { records: 0, domains: 0, slices: 0, contests: 0 },
    landed: new Map(),
    closed: [],
    waiting: [],
    left: [],
    idle: [],
    unwindsHeld: [],
    deferred: 0,
    refused: sender.refused,
    unread: sender.unread,
    stopped: null,
  };
  const r = new PassReader(deps, deps.sendDeadline, diamond, ABI, 'rewardStagingUpkeep');
  try {
    let served: number;
    try {
      served = await r.call('the chain id', (c) => c.getChainId());
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      return { ...report, skipped: `the RPC's chain id could not be read (${shortErr(err)})` };
    }
    if (served !== chainId) return { ...report, skipped: `the RPC configured for chain ${chainId} serves chain ${served}` };
    let open: OpenStaging[];
    let slices: bigint[];
    let contests: BatchContest[];
    try {
      [open, slices, contests] = await Promise.all([deps.source.open(), deps.source.legacySlices(), deps.source.contests()]);
    } catch (err) {
      return { ...report, skipped: `the event ledger could not be read (${shortErr(err)})` };
    }
    const records = open.filter((o) => o.what === 'record');
    const domains = open.filter((o) => o.what === 'domain');
    report.named = { records: records.length, domains: domains.length, slices: slices.length, contests: contests.length };
    if (records.length + domains.length + slices.length === 0) return report;
    const now = (await r.call('the head block', (c) => c.getBlock())).timestamp;
    const keeper = deps.context()?.wallet.account?.address ?? null;
    const w = new Worker(r, sender, report, deps, now, keeper);
    // Domains first: a domain's reservation can ask for one of its day
    // records to be prepared, which it does in its own order.
    await w.domains(domains);
    await w.records(records);
    await w.contests(contests, records);
    await w.slices(slices);
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    sender.noteUnread('run', 'the run deadline passed during its reads');
  }
  report.stopped = sender.stopped ? sender.stopReason : null;
  return report;
}

/** A claim domain the run found open: its key, owner, side and state. */
interface OpenDomain {
  key: string;
  user: Address;
  side: number;
  view: StagingDomainView;
}

class Worker {
  constructor(
    private readonly r: PassReader,
    private readonly sender: StepSender,
    private readonly report: StagingUpkeepReport,
    private readonly deps: StagingUpkeepDeps,
    private readonly now: bigint,
    /** The account previews run from; null when the run has no key. */
    private readonly keeper: Address | null,
  ) {}

  /** The page's preview (eth_simulateV1), for the logs it would emit. Null
   *  when it could not be read, which leaves the subject for a later run:
   *  a page whose effect is unknown is not sent. */
  private async preview(subject: string, fn: string, args: readonly unknown[]): Promise<{ reverted: true } | { logs: Log[] } | null> {
    if (this.keeper === null) {
      this.sender.noteUnread(subject, `the preview of ${fn} (no keeper account to run it from)`);
      return null;
    }
    const account = this.keeper;
    let results: readonly { status: string; logs?: readonly unknown[] }[];
    try {
      ({ results } = await this.r.call(`the preview of ${fn}`, (c) =>
        c.simulateCalls({
          account,
          calls: [{ to: this.r.diamond, data: encodeFunctionData({ abi: ABI, functionName: fn, args } as never) }],
        }),
      ));
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread(subject, `the preview of ${fn} (eth_simulateV1: ${shortErr(err)})`);
      return null;
    }
    const res = results[0];
    // A reverted preview is the refusal the sender meets and names itself.
    if (res?.status === 'failure') return { reverted: true };
    if (res === undefined || res.status !== 'success' || res.logs === undefined) {
      this.sender.noteUnread(subject, `the preview of ${fn} reported no logs`);
      return null;
    }
    return { logs: res.logs as Log[] };
  }

  private wait(subject: string, what: string) {
    this.report.waiting.push({ subject, what });
  }

  private landed(fn: string) {
    this.report.landed.set(fn, (this.report.landed.get(fn) ?? 0) + 1);
  }

  /** The subjects of one kind this run works, rotating when there are more. */
  private batch<T>(items: readonly T[]): T[] {
    const { picked, deferred } = pickBatch(items, this.deps.visit, SUBJECTS_PER_RUN);
    this.report.deferred += deferred.length;
    return picked;
  }

  /** The idle markers of the subjects a step is about to work, read at once. */
  private idleMarks = new Map<string, string>();

  private async loadIdle(subjects: readonly string[]): Promise<void> {
    const got = await this.deps.cursors.get(subjects.map(idleItem));
    for (const [k, v] of got) this.idleMarks.set(k, v);
  }

  /** Whether `subject` is recorded idle at the state `digest` and its retry
   *  cadence has not passed. */
  private isIdle(subject: string, digest: string): boolean {
    const got = this.idleMarks.get(idleItem(subject));
    if (got === undefined || got === '') return false;
    const [d, at] = got.split('@');
    return d === digest && at !== undefined && /^[0-9]+$/.test(at) && this.now < BigInt(at) + STAGING_RETRY_CADENCE;
  }

  private async markIdle(subject: string, digest: string) {
    this.report.idle.push(subject);
    const mark = `${digest}@${this.now}`;
    this.idleMarks.set(idleItem(subject), mark);
    await this.deps.cursors.put(idleItem(subject), mark);
  }

  /** One page through the sender, counted when it lands. */
  private async page(step: string, subject: string, fn: string, args: readonly unknown[], worth?: (s: unknown) => boolean): Promise<CallResult> {
    const res = await this.sender.call(step, subject, fn, args, 0n, worth);
    if (res === 'landed') this.landed(fn);
    return res;
  }

  /** An unwind that is due: sent when the step is armed, reported otherwise. */
  private async unwindDue(
    subject: string,
    why: string,
    fn: 'unwindStagedDayPage' | 'unwindDomainPage' | 'reserveDomainPage',
    key: string,
  ): Promise<CallResult | 'held'> {
    if (this.deps.unwind !== true) {
      this.report.unwindsHeld.push({ subject, what: why });
      return 'held';
    }
    return this.page('unwind', subject, fn, [key]);
  }

  // ─── Claim domains ───────────────────────────────────────────────────────

  async domains(domains: readonly OpenStaging[]): Promise<void> {
    const picked = this.batch(domains);
    // A domain is read by its owner and side; the side is the one whose key
    // the ledger named.
    const keyed = picked.flatMap((d) => [0, 1].filter((side) => domainKey(d.user as Address, side) === d.key).map((side) => ({ ...d, side })));
    let views: unknown[];
    try {
      views = await this.r.many(keyed.map((d) => ({ functionName: 'getStagingDomain', args: [d.user, d.side] })), 'domains');
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread('domains', `the claim domains (${shortErr(err)})`);
      return;
    }
    await this.loadIdle(keyed.map((d) => `domain ${short(d.key)}`));
    for (let i = 0; i < keyed.length; i += 1) {
      const v = views[i] as StagingDomainView | undefined;
      const subject = `domain ${short(keyed[i].key)}`;
      if (v === undefined) {
        this.sender.noteUnread(subject, 'its state');
        continue;
      }
      const view = toDomainView(v);
      if (view.phase === DOMAIN_PHASE.none || view.domainKey.toLowerCase() !== keyed[i].key) continue;
      const d = { key: keyed[i].key, user: keyed[i].user as Address, side: keyed[i].side, view };
      // eslint-disable-next-line no-await-in-loop
      await this.domain(d, subject);
    }
  }

  private async readDomain(d: OpenDomain): Promise<StagingDomainView> {
    return toDomainView(await this.r.one<unknown>('getStagingDomain', [d.user, d.side]));
  }

  private async domain(d: OpenDomain, subject: string): Promise<void> {
    let view = d.view;
    const digestOf = async (v: StagingDomainView) => stateDigest(v, await this.cursorRecord(d, v));
    let digest = await digestOf(view);
    if (this.isIdle(subject, digest)) {
      this.wait(subject, 'recorded idle at this state');
      return;
    }
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_SUBJECT; pageNo += 1) {
      const pastDeadline = view.deadline !== 0n && this.now >= view.deadline;
      let res: CallResult | 'held';
      let fn: string;
      if (view.phase === DOMAIN_PHASE.none) {
        this.report.closed.push(subject);
        return;
      }
      if (view.phase === DOMAIN_PHASE.unwinding) {
        fn = 'unwindDomainPage';
        res = await this.unwindDue(subject, 'its unwind is under way', 'unwindDomainPage', d.key);
      } else if (view.phase === DOMAIN_PHASE.resolving) {
        // A payout the sanctions screen would hold is the sanctions-hold
        // pass's page: it observes the screen there.
        const cur = await this.cursorRecord(d, view);
        if (cur !== null && (await this.payoutHeld(cur))) {
          this.report.left.push({ subject, what: "its next day's payout is to a claimant the sanctions screen flags (left to rewardSanctionsHold)" });
          return;
        }
        fn = 'resolveDomainPage';
        res = await this.page('advance', subject, fn, [d.key]);
      } else if (view.phase === DOMAIN_PHASE.staging && view.preparedThrough < view.lastDay) {
        // Only the claimant's own claims prepare a claim domain's days.
        if (!pastDeadline) {
          this.wait(subject, `its claimant's claims have prepared it through day ${view.preparedThrough} of ${view.lastDay}; deadline ${view.deadline}`);
          return;
        }
        fn = 'unwindDomainPage';
        res = await this.unwindDue(subject, 'past its deadline with its days not all prepared', 'unwindDomainPage', d.key);
      } else {
        fn = 'reserveDomainPage';
        const p = await this.preview(subject, fn, [d.key]);
        if (p === null) return;
        const effect = 'logs' in p ? pageEffect(this.r.diamond, p.logs, d.key) : null;
        // Where the reservation stands before the page: a domain still in
        // Staging starts at its first day.
        const from = view.phase === DOMAIN_PHASE.staging ? view.firstDay : view.reserveCursor;
        if (effect?.unwinds) {
          // Its revalidation finds a day record stale and sends the whole
          // domain to Unwinding in this same call: an unwind, behind its flag.
          res = await this.unwindDue(subject, 'the contract finds a day record stale', 'reserveDomainPage', d.key);
        } else if (effect !== null && effect.reserveStoppedAt !== null && effect.reserveStoppedAt <= from) {
          // The contract's own stop on a day not covered, with nothing
          // reserved before it: the page would change nothing that matters.
          if (!pastDeadline) {
            this.wait(subject, `day ${effect.reserveStoppedAt} is not covered yet; deadline ${view.deadline}`);
            return;
          }
          fn = 'unwindDomainPage';
          res = await this.unwindDue(subject, `past its deadline with day ${effect.reserveStoppedAt} not covered`, 'unwindDomainPage', d.key);
        } else {
          // It reserves, revalidates, or (a reverted preview) meets the
          // refusal the sender names.
          res = await this.page('advance', subject, fn, [d.key]);
        }
        if (res === 'StagingScanIncomplete') {
          // The page names the day record whose scan it needs.
          const recordKey = this.sender.refusal?.args[0];
          if (typeof recordKey !== 'string') return;
          const prep = await this.page('advance', `record ${short(recordKey)}`, 'prepareStagedDay', [recordKey]);
          if (prep !== 'landed') {
            if (WAITS.has(prep) && pastDeadline) {
              fn = 'unwindDomainPage';
              res = await this.unwindDue(subject, `past its deadline; ${WAITS.get(prep)}`, 'unwindDomainPage', d.key);
            } else {
              if (WAITS.has(prep)) this.wait(subject, WAITS.get(prep)!);
              return;
            }
          } else continue; // the record moved: the reservation is tried again
        }
      }
      if (res === 'held') return;
      if (res !== 'landed') {
        if (WAITS.has(res)) this.wait(subject, WAITS.get(res)!);
        return;
      }
      try {
        view = await this.readDomain(d);
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        this.sender.noteUnread(subject, `its state after ${fn} (${shortErr(err)})`);
        return;
      }
      const after = await digestOf(view);
      // A reservation page the preview showed doing work is never idle: a
      // revalidation page moves a cursor the domain's view does not carry.
      if (after === digest && fn !== 'reserveDomainPage') {
        await this.markIdle(subject, after);
        return;
      }
      digest = after;
    }
  }

  /** The day record at the cursor a resolving domain works next. */
  private async cursorRecord(d: OpenDomain, v: StagingDomainView): Promise<StagingRecordView | null> {
    if (v.phase !== DOMAIN_PHASE.resolving || v.resolveCursor > v.lastDay) return null;
    return this.r.one<StagingRecordView>('getStagingRecord', [stagingKey(d.user, d.side, v.resolveCursor)]);
  }

  /** Whether the record's next page is a claim payout the sanctions screen
   *  would hold: only its payout is left, it carries a claimant share, and the
   *  claimant is flagged. */
  private async payoutHeld(rec: StagingRecordView): Promise<boolean> {
    if (Number(rec.phase) !== PHASE.resolving || BigInt(rec.resolveCursor) < BigInt(rec.batchCount)) return false;
    if (Number(rec.op) !== OP.claim) return false;
    return this.r.one<boolean>('isSanctionedAddress', [rec.user]);
  }

  // ─── Standalone records ──────────────────────────────────────────────────

  async records(records: readonly OpenStaging[]): Promise<void> {
    // A record inside a claim domain is refused by the standalone entries by
    // name (`StagingRecordInDomain`) and left to the domain; its own
    // preparation is open to anyone, as the domain's reservation asks.
    const picked = this.batch(records);
    let views: unknown[];
    try {
      views = await this.r.many(picked.map((o) => ({ functionName: 'getStagingRecord', args: [o.key] })), 'records');
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread('records', `the staging records (${shortErr(err)})`);
      return;
    }
    await this.loadIdle(picked.map((o) => `record ${short(o.key)}`));
    for (let i = 0; i < picked.length; i += 1) {
      const subject = `record ${short(picked[i].key)}`;
      const v = views[i] as StagingRecordView | undefined;
      if (v === undefined) {
        this.sender.noteUnread(subject, 'its state');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.record(picked[i].key, subject, v);
    }
  }

  private async record(key: string, subject: string, first: StagingRecordView): Promise<void> {
    let rec = first;
    let digest = stateDigest(rec);
    if (this.isIdle(subject, digest)) {
      this.wait(subject, 'recorded idle at this state');
      return;
    }
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_SUBJECT; pageNo += 1) {
      const move = recordMove(rec);
      const pastDeadline = this.now >= BigInt(rec.deadline);
      let fn: string;
      let res: CallResult | 'held';
      switch (move.kind) {
        case 'gone':
          if (pageNo > 0) this.report.closed.push(subject);
          return;
        case 'in-domain':
          return;
        case 'unwind':
          fn = 'unwindStagedDayPage';
          if (Number(rec.phase) !== PHASE.unwinding && !pastDeadline) {
            this.wait(subject, `${move.why}; its deadline ${rec.deadline} has not passed`);
            return;
          }
          res = await this.unwindDue(subject, move.why, 'unwindStagedDayPage', key);
          break;
        case 'resolve':
          if (move.payoutOnly && (await this.payoutHeld(rec))) {
            this.report.left.push({ subject, what: 'its payout is to a claimant the sanctions screen flags (left to rewardSanctionsHold)' });
            return;
          }
          fn = 'resolveStagedDayPage';
          if (Number(rec.phase) === PHASE.reserved) {
            // The first resolution page revalidates the record and unwinds a
            // stale one in the same call: the preview says which it will do.
            const p = await this.preview(subject, fn, [key]);
            if (p === null) return;
            if ('logs' in p && pageEffect(this.r.diamond, p.logs, key).unwinds) {
              fn = 'unwindStagedDayPage';
              res = await this.unwindDue(subject, 'the contract finds it stale', 'unwindStagedDayPage', key);
              break;
            }
          }
          res = await this.page('advance', subject, fn, [key]);
          break;
        case 'prepare':
        case 'reserve': {
          fn = move.kind === 'prepare' ? 'prepareStagedDay' : 'reserveStagedDay';
          res = await this.page('advance', subject, fn, [key]);
          if (res === 'StagingScanIncomplete') {
            fn = 'prepareStagedDay';
            res = await this.page('advance', subject, fn, [key]);
          }
          if (res === 'RewardEntrySetMismatch') {
            // The contract's own finding that the record is stale: anyone may
            // unwind it at once.
            fn = 'unwindStagedDayPage';
            res = await this.unwindDue(subject, 'the contract finds it stale', 'unwindStagedDayPage', key);
          } else if ((res === 'StagingNotCovered' || res === 'StagingPendingOverflow') && pastDeadline) {
            const why = res === 'StagingNotCovered' ? 'past its deadline with its day not covered' : 'past its deadline with its pending work overflowed';
            fn = 'unwindStagedDayPage';
            res = await this.unwindDue(subject, why, 'unwindStagedDayPage', key);
          } else if (res === 'StagingNotCovered') {
            this.wait(subject, `${WAITS.get(res)}; deadline ${rec.deadline}`);
            return;
          }
          break;
        }
      }
      if (res === 'held') return;
      if (res !== 'landed') {
        if (res === 'StagingRecordInDomain') {
          // The contract's own word that the domain carries it; not asked
          // again until the record moves or a day has passed.
          this.report.left.push({ subject, what: 'it belongs to a claim domain, whose pages carry it' });
          await this.markIdle(subject, digest);
        } else if (WAITS.has(res)) this.wait(subject, WAITS.get(res)!);
        return;
      }
      try {
        rec = await this.r.one<StagingRecordView>('getStagingRecord', [key]);
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        this.sender.noteUnread(subject, `its state after ${fn} (${shortErr(err)})`);
        return;
      }
      if (Number(rec.phase) === PHASE.none) {
        this.report.closed.push(subject);
        return;
      }
      const after = stateDigest(rec);
      if (after === digest) {
        await this.markIdle(subject, after);
        return;
      }
      digest = after;
    }
  }

  // ─── Priority windows ────────────────────────────────────────────────────

  async contests(contests: readonly BatchContest[], records: readonly OpenStaging[]): Promise<void> {
    // A finding counts only after the record's latest opening: an earlier one
    // belongs to a closed record under the same key.
    const opened = new Map(records.map((o) => [o.key, o.pos]));
    const live = this.batch(contests.filter((c) => (opened.get(c.key) ?? Number.POSITIVE_INFINITY) < c.pos));
    for (const c of live) {
      const subject = `window ${short(c.batchId)}/${short(c.key)}`;
      let w: readonly unknown[];
      let used: boolean;
      let rec: StagingRecordView;
      try {
        // eslint-disable-next-line no-await-in-loop
        [w, used, rec] = await Promise.all([
          this.r.one<readonly unknown[]>('getTransportBatchWindow', [c.batchId]),
          this.r.one<boolean>('isTransportBatchPriorityUsed', [c.batchId, c.key]),
          this.r.one<StagingRecordView>('getStagingRecord', [c.key]),
        ]);
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        this.sender.noteUnread(subject, `the window and the record (${shortErr(err)})`);
        continue;
      }
      if (used || Number(rec.phase) !== PHASE.staging) continue;
      const closesAt = BigInt(w[0] as bigint);
      const oldestKey = String(w[2]).toLowerCase();
      const oldestOpenedAt = BigInt(w[3] as bigint);
      if (closesAt === 0n) continue;
      if (this.now < closesAt) {
        // Registering changes the window only when it makes this record the
        // oldest registrant; otherwise it would change nothing.
        const none = /^0x0{64}$/.test(oldestKey);
        if (!none && (oldestKey === c.key || BigInt(rec.openedAt) >= oldestOpenedAt)) continue;
        // eslint-disable-next-line no-await-in-loop
        const res = await this.page('register', subject, 'registerForBatchWindow', [c.key, c.batchId]);
        if (res !== 'landed' && WAITS.has(res)) this.wait(subject, WAITS.get(res)!);
      } else if (this.now < closesAt + STAGING_RETRY_CADENCE && oldestKey === c.key) {
        // The oldest registrant's priority right: taken by its next
        // preparation, and only worth sending when that stages something.
        // eslint-disable-next-line no-await-in-loop
        const res = await this.page('register', subject, 'prepareStagedDay', [c.key], (s) => {
          const [fresh, recycled] = s as readonly bigint[];
          return BigInt(fresh) + BigInt(recycled) > 0n;
        });
        if (res === 'idle') this.wait(subject, 'its priority take would stage nothing at the current block');
        else if (res !== 'landed' && WAITS.has(res)) this.wait(subject, WAITS.get(res)!);
      }
    }
  }

  // ─── Legacy slices ───────────────────────────────────────────────────────

  async slices(slices: readonly bigint[]): Promise<void> {
    const picked = this.batch(slices);
    let views: unknown[];
    try {
      views = await this.r.many(picked.map((id) => ({ functionName: 'getLegacySliceDomain', args: [id] })), 'legacy slices');
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread('slices', `the legacy slices (${shortErr(err)})`);
      return;
    }
    await this.loadIdle(picked.map((id) => `slice ${id}`));
    for (let i = 0; i < picked.length; i += 1) {
      const subject = `slice ${picked[i]}`;
      const v = views[i];
      if (v === undefined) {
        this.sender.noteUnread(subject, 'its state');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.slice(picked[i], subject, toSliceView(v));
    }
  }

  /** The record a consuming slice works next: a wide day's record can take
   *  further preparation pages that move no field of the slice itself. */
  private async sliceRecord(v: LegacySliceView): Promise<StagingRecordView | null> {
    if (v.preparedThrough < v.lastDay || v.consumeCursor > v.lastDay) return null;
    return this.r.one<StagingRecordView>('getStagingRecord', [legacyRecordKey(v.domainKey, v.consumeCursor)]);
  }

  private async slice(entryId: bigint, subject: string, first: LegacySliceView): Promise<void> {
    let view = first;
    const digestOf = async (v: LegacySliceView) => stateDigest(v, await this.sliceRecord(v));
    let digest: string;
    try {
      digest = await digestOf(view);
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      this.sender.noteUnread(subject, `the record it consumes (${shortErr(err)})`);
      return;
    }
    if (this.isIdle(subject, digest)) {
      this.wait(subject, 'recorded idle at this state');
      return;
    }
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_SUBJECT; pageNo += 1) {
      // Phase Staging is the slice preparing and then consuming; anything
      // else is consumed or settled, which its own settlement finishes.
      if (view.phase !== DOMAIN_PHASE.staging) return;
      const res = await this.page('advance', subject, 'stepLegacySlice', [entryId]);
      if (res !== 'landed') {
        if (WAITS.has(res)) this.wait(subject, WAITS.get(res)!);
        return;
      }
      let after: string;
      try {
        view = toSliceView(await this.r.one<unknown>('getLegacySliceDomain', [entryId]));
        if (view.phase !== DOMAIN_PHASE.staging) {
          this.report.closed.push(subject);
          return;
        }
        after = await digestOf(view);
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        this.sender.noteUnread(subject, `its state after stepLegacySlice (${shortErr(err)})`);
        return;
      }
      if (after === digest) {
        await this.markIdle(subject, after);
        return;
      }
      digest = after;
    }
  }
}

/** A tuple or named result as the domain view. Exported for tests. */
export function toDomainView(v: unknown): StagingDomainView {
  const a = v as readonly unknown[];
  const at = (i: number, name: keyof StagingDomainView) => (Array.isArray(a) ? a[i] : (v as Record<string, unknown>)[name]);
  return {
    domainKey: String(at(0, 'domainKey')).toLowerCase(),
    phase: Number(at(1, 'phase')),
    firstDay: BigInt(at(2, 'firstDay') as bigint),
    lastDay: BigInt(at(3, 'lastDay') as bigint),
    preparedThrough: BigInt(at(4, 'preparedThrough') as bigint),
    reserveCursor: BigInt(at(5, 'reserveCursor') as bigint),
    resolveCursor: BigInt(at(6, 'resolveCursor') as bigint),
    unwindCursor: BigInt(at(7, 'unwindCursor') as bigint),
    liveRecords: Number(at(8, 'liveRecords')),
    openedAt: BigInt(at(9, 'openedAt') as bigint),
    deadline: BigInt(at(10, 'deadline') as bigint),
    chunks: BigInt(at(11, 'chunks') as bigint),
    entryCount: BigInt(at(12, 'entryCount') as bigint),
  };
}

/** A tuple or named result as the legacy slice view. Exported for tests. */
export function toSliceView(v: unknown): LegacySliceView {
  const a = v as readonly unknown[];
  const at = (i: number, name: keyof LegacySliceView) => (Array.isArray(a) ? a[i] : (v as Record<string, unknown>)[name]);
  return {
    domainKey: String(at(0, 'domainKey')).toLowerCase(),
    phase: Number(at(1, 'phase')),
    firstDay: BigInt(at(2, 'firstDay') as bigint),
    lastDay: BigInt(at(3, 'lastDay') as bigint),
    preparedThrough: BigInt(at(4, 'preparedThrough') as bigint),
    consumeCursor: BigInt(at(5, 'consumeCursor') as bigint),
    liveRecords: Number(at(6, 'liveRecords')),
    epochFresh: BigInt(at(7, 'epochFresh') as bigint),
  };
}
