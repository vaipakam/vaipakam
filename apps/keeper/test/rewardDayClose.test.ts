/**
 * #2612 — the reward day-close pass. Pinned in two layers:
 *
 *   - the PURE rules: the window of elapsed days, when a day finalizes
 *     (every expected chain in, or grace elapsed, and the contract agreeing —
 *     coverage judged per chain, never by report count), and when a finalized
 *     day is broadcast, confirmed, reported late or re-sent;
 *   - whole RUNS against a fake Base and a fake mirror and the real
 *     private-DB migrations: what each chain sends and with what fee, the
 *     cross-chain reads that stop a wasted report or confirm a broadcast, and
 *     the alerts, raised AND cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, pad, toEventSelector, toHex, type Abi, type Address, type Log, type PublicClient } from 'viem';
import { RewardAggregatorFacetABI, RewardReporterFacetABI, VaipakamDiamondABI } from '@vaipakam/contracts/abis';
import {
  BROADCAST_LATE_AFTER_SEC,
  BROADCAST_RESEND_AFTER_SEC,
  GRACE_WARNING_SEC,
  LOOKBACK_DAYS,
  MAX_SENDS_PER_RUN,
  READ_CHUNK,
  ROLE_CANONICAL,
  ROLE_MIRROR,
  dayCloseOnce,
  dayWindow,
  BACKLOG_PER_RUN,
  graceWarningSec,
  planBroadcast,
  planFinalize,
  type DestinationState,
  type FinalizeInput,
  type PeerReader,
} from '../src/rewardDayClose';
import { retireUnworkedAlerts } from '../src/rewardDayClose/alerts';
import type { Env } from '../src/env';
import type { KeeperContext } from '../src/keeper';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';

const BASE = 84532;
const MIRROR = 421614;
const OTHER = 97;
const GRACE = 4 * 3600;
const LANE_FEE = 123n;
const BROADCAST_FEE = 456n;
const BROADCAST_TO_FEE = 78n;
const T0 = Date.UTC(2026, 9, 23, 0, 10, 0);
/** Each chain's reward messenger and its CCIP transport, as the fakes are
 *  wired by default: every report channel link reads as wired. */
const MESSENGER_OF: Record<number, Address> = {
  [BASE]: '0x00000000000000000000000000000000000000b2',
  [MIRROR]: '0x00000000000000000000000000000000000000c2',
  [OTHER]: '0x00000000000000000000000000000000000000d2',
};
const TRANSPORT_OF: Record<number, Address> = {
  [BASE]: '0x00000000000000000000000000000000000000b3',
  [MIRROR]: '0x00000000000000000000000000000000000000c3',
  [OTHER]: '0x00000000000000000000000000000000000000d3',
};
const REWARD_CHANNEL = `0x${'ab'.repeat(32)}` as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const NOW = Math.floor(T0 / 1000);

describe('the pure rules', () => {
  it('works the last LOOKBACK_DAYS, then a page of older owed days, each oldest first', () => {
    expect(dayWindow(0)).toEqual([]);
    expect(dayWindow(1)).toEqual([0]);
    expect(dayWindow(3)).toEqual([0, 1, 2]);
    expect(dayWindow(LOOKBACK_DAYS + 5)).toEqual(Array.from({ length: LOOKBACK_DAYS }, (_, i) => i + 5));
    expect(dayWindow(LOOKBACK_DAYS + 5, [3, 1, 7, 3]), 'owed days follow the recent ones, once').toEqual([...Array.from({ length: LOOKBACK_DAYS }, (_, i) => i + 5), 1, 3]);
    expect(dayWindow(3, [5, -1]), 'never a day not yet elapsed').toEqual([0, 1, 2]);
  });

  it('warns in the last hour of grace, or the last quarter of a shorter one', () => {
    expect(graceWarningSec(4 * 3600)).toBe(GRACE_WARNING_SEC);
    expect(graceWarningSec(24 * 3600)).toBe(GRACE_WARNING_SEC);
    expect(graceWarningSec(3600)).toBe(900);
    expect(graceWarningSec(0)).toBe(0);
  });

  describe('planFinalize', () => {
    const base: FinalizeInput = {
      day: 3,
      finalized: false,
      ownReported: true,
      selfChainId: BASE,
      contractReady: true,
      firstReportAt: NOW - 600,
      expected: [BASE, MIRROR],
      reported: new Set([BASE, MIRROR]),
    };
    it('finalizes once every expected chain has reported', () => {
      expect(planFinalize(base, GRACE, NOW)).toEqual({ kind: 'finalize', missing: [] });
    });
    it('waits for a missing chain inside grace, even when the contract would accept (a report COUNT is not coverage)', () => {
      const x = { ...base, reported: new Set([BASE, OTHER]) };
      expect(planFinalize(x, GRACE, NOW)).toEqual({ kind: 'wait', missing: [MIRROR], unknown: [], graceEndsAt: NOW - 600 + GRACE });
    });
    it('an unread chain is neither reported nor missing, and never completes coverage', () => {
      const x = { ...base, reported: new Set([BASE]), unknown: new Set([MIRROR]) };
      expect(planFinalize(x, GRACE, NOW)).toEqual({ kind: 'wait', missing: [], unknown: [MIRROR], graceEndsAt: NOW - 600 + GRACE });
      expect(planFinalize({ ...x, firstReportAt: NOW - GRACE }, GRACE, NOW).kind, 'grace still finalizes').toBe('finalize');
    });
    it('finalizes at grace with the missing chains named', () => {
      const x = { ...base, reported: new Set([BASE]), firstReportAt: NOW - GRACE };
      expect(planFinalize(x, GRACE, NOW)).toEqual({ kind: 'finalize', missing: [MIRROR] });
    });
    it('never finalizes against the contract, before its own report, or against an empty list or one without Base', () => {
      expect(planFinalize({ ...base, contractReady: false }, GRACE, NOW).kind).toBe('wait');
      expect(planFinalize({ ...base, ownReported: false }, GRACE, NOW)).toEqual({ kind: 'own-report-first' });
      expect(planFinalize({ ...base, expected: [], firstReportAt: NOW - GRACE }, GRACE, NOW)).toEqual({ kind: 'no-expected' });
      expect(planFinalize({ ...base, expected: [MIRROR], reported: new Set([MIRROR]), firstReportAt: NOW - GRACE }, GRACE, NOW), 'never against a list without Base').toEqual({ kind: 'self-not-expected' });
      expect(planFinalize({ ...base, finalized: true }, GRACE, NOW)).toEqual({ kind: 'done' });
    });
  });

  describe('planBroadcast', () => {
    const d = (...s: [number, DestinationState][]) => new Map(s);
    /** Last sends, each shown by its receipt to have left (`proven`). */
    const at = (...s: [number, number | null][]) => new Map(s.map(([c, t]) => [c, t === null ? null : { at: t, proven: true }] as const));
    const LATE = NOW - BROADCAST_LATE_AFTER_SEC;
    const RESEND = NOW - BROADCAST_RESEND_AFTER_SEC;
    it('sends to every destination never sent the day, whatever its read', () => {
      expect(planBroadcast(d([MIRROR, 'missing'], [OTHER, 'unserved']), at(), NOW)).toMatchObject({ send: [MIRROR, OTHER], resend: [], done: false });
      expect(planBroadcast(d([MIRROR, 'unread']), at([MIRROR, null]), NOW)).toMatchObject({ send: [MIRROR], done: false });
      expect(planBroadcast(d([MIRROR, 'received']), at(), NOW), 'a destination already holding it needs none').toMatchObject({ send: [], done: true });
      expect(planBroadcast(d(), at(), NOW), 'no destinations').toMatchObject({ send: [], done: true });
    });
    it('sends to a destination added after the day was sent, though every other one is served', () => {
      const plan = planBroadcast(d([MIRROR, 'received'], [OTHER, 'unserved']), at([MIRROR, NOW - 60]), NOW);
      expect(plan).toMatchObject({ send: [OTHER], resend: [], done: false });
    });
    it('once sent to: late, then re-sent, while read as lacking it; an unserved one is unconfirmed', () => {
      expect(planBroadcast(d([MIRROR, 'received'], [OTHER, 'unserved']), at([MIRROR, NOW], [OTHER, NOW]), NOW)).toMatchObject({ send: [], unconfirmed: [OTHER], done: true });
      expect(planBroadcast(d([MIRROR, 'missing']), at([MIRROR, NOW]), NOW)).toMatchObject({ send: [], late: [], done: false });
      expect(planBroadcast(d([MIRROR, 'missing']), at([MIRROR, LATE]), NOW)).toMatchObject({ send: [], late: [{ chain: MIRROR, state: 'missing', sentAt: LATE }] });
      expect(planBroadcast(d([MIRROR, 'missing']), at([MIRROR, RESEND]), NOW), 'late in the run that re-sends, too').toMatchObject({
        send: [MIRROR],
        resend: [MIRROR],
        late: [{ chain: MIRROR, state: 'missing', sentAt: RESEND }],
      });
    });
    it('re-sends to an unserved destination whose last send no receipt showed leaving, once the re-send interval has passed', () => {
      const unproven = (t: number) => new Map([[OTHER, { at: t, proven: false }]]);
      expect(planBroadcast(d([OTHER, 'unserved']), unproven(NOW - 60), NOW)).toMatchObject({ send: [], unproven: [OTHER], unconfirmed: [], done: false });
      expect(planBroadcast(d([OTHER, 'unserved']), unproven(RESEND), NOW)).toMatchObject({ send: [OTHER], resend: [OTHER], unproven: [], done: false });
      expect(planBroadcast(d([OTHER, 'unserved']), at([OTHER, RESEND]), NOW), 'one shown leaving is done').toMatchObject({ send: [], unconfirmed: [OTHER], done: true });
    });
    it('never re-sends blind to a destination it cannot read, and reports it as unknown past the late mark', () => {
      expect(planBroadcast(d([MIRROR, 'unread']), at([MIRROR, NOW - 60]), NOW)).toMatchObject({ send: [], late: [], done: false });
      expect(planBroadcast(d([MIRROR, 'unread']), at([MIRROR, RESEND]), NOW)).toMatchObject({ send: [], late: [{ chain: MIRROR, state: 'unread' }], done: false });
      expect(planBroadcast(d([MIRROR, 'missing'], [OTHER, 'unread']), at([MIRROR, RESEND], [OTHER, RESEND]), NOW), 'nor holds back a known-missing lane').toMatchObject({ send: [MIRROR], resend: [MIRROR] });
    });
    it('judges each destination against its own last send', () => {
      const plan = planBroadcast(d([MIRROR, 'missing'], [OTHER, 'missing']), at([MIRROR, RESEND], [OTHER, NOW - 60]), NOW);
      expect(plan).toMatchObject({ send: [MIRROR], resend: [MIRROR], late: [{ chain: MIRROR }] });
    });
  });
});

// ─── whole runs against fake chains ─────────────────────────────────────────

const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
const ERRORS_ABI = [...REPORTER_ABI, ...(AGGREGATOR_ABI as Abi), ...(VaipakamDiamondABI as Abi).filter((x) => x.type === 'error'), { type: 'error', name: 'MessengerPredatesV3', inputs: [] }] as Abi;
function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: ERRORS_ABI,
    data: encodeErrorResult({ abi: ERRORS_ABI, errorName, args } as never),
    functionName: 'closeDay',
  });
}

/** A fake Diamond (and, on Base, its messenger), keyed by its own address. */
class FakeDiamond {
  role = ROLE_MIRROR;
  today = 3;
  active = true;
  launch = 1_792_540_800;
  paused = false;
  sentAt = new Map<number, number>();
  finalized = new Set<number>();
  reported = new Map<number, Set<number>>();
  firstAt = new Map<number, number>();
  expected: number[] = [];
  known = new Set<number>();
  destinations: number[] = [];
  /** The messenger's list when a broadcast runs, if it changed after the run
   *  read it (null = as read). */
  listAtSend: number[] | null = null;
  /** Governance rotates the reward messenger to this address just before a
   *  broadcast runs (null = no rotation); `messengerNow` is the result. */
  rotateTo: Address | null = null;
  messengerNow: Address | null = null;
  /** Where the messenger sends reports, when not Base ('unread' = the read fails). */
  routeTo: number | 'unread' | null = null;
  /** A read of the reporter config at a past block fails. */
  reporterConfigUnreadAtBlock = false;
  /** A mirror's close is delivered to this Base at once (null = left in flight). */
  deliverTo: FakeDiamond | null = null;
  /** `fn:day` → error name a simulation reverts with. */
  refuse = new Map<string, string>();
  /** `quoteSendChainReport` arities the messenger has (the rest are unknown selectors). */
  quoteShapes = new Set([8, 7, 5, 3]);
  /** Single-destination quotes refuse with this, when set. */
  refuseTo: string | null = null;
  /** Single-destination quotes refuse with this error, by destination. */
  refuseToChain = new Map<number, string>();
  /** Destinations the contract gives no standing in any day. */
  noStanding = new Set<number>();
  /** What the node answers a send with instead of taking it, when set. */
  writeError: Error | null = null;
  /** The largest aggregate read asked of this chain. */
  largestRead = 0;
  /** The days simulations were asked for, in order. */
  simulated: number[] = [];
  /** Reports that land between the pass's reads and its finalization, by day. */
  landsAtFinalize = new Map<number, number>();
  /** Receipts are never seen (the send may still have landed). */
  receiptLost = false;
  /** Simulations get no answer from the RPC. */
  rpcDown = false;
  /** This chain's known-global read fails. */
  knownUnreadable = false;
  /** The messenger's destination list cannot be read. */
  destinationsUnreadable = false;
  /** Chains with standing in every day though not reported in it. */
  standing = new Set<number>();
  /** Destinations whose single-destination broadcast quote cannot be read. */
  quoteUnreadTo = new Set<number>();
  /** This chain's own report-sent reads fail. */
  sentAtUnreadable = false;
  /** The expected-source list cannot be read. */
  expectedUnreadable = false;
  /** Chains whose `isChainReported` read fails. */
  unreadable = new Set<number>();
  /** The reward clock's launch read fails. */
  launchUnread = false;
  /** The reward role read fails. */
  roleUnread = false;
  /** The chain this Diamond names as Base. */
  baseChain = BASE;
  /** The Diamond routes no single-destination broadcast (a partial upgrade). */
  noSingleSend = false;
  /** Governance changes the destination list to this right after the run
   *  first reads it (null = no change). */
  destinationsChangeTo: number[] | null = null;
  /** The current reporter config read fails. */
  reporterConfigUnread = false;
  /** Report-channel reads answered otherwise than wired, by function name, on
   *  this chain's reward messenger or its transport ('unread' = the read fails). */
  wire = new Map<string, unknown>();
  /** The chain the Diamond names itself in its reporter config, when not its
   *  own (an RPC pointed at another chain's same-address Diamond). */
  namesItself: number | null = null;
  private logs: Log[] = [];
  sent: { fn: string; day: number; value: bigint; to?: number }[] = [];

  constructor(
    readonly chainId: number,
    readonly diamond: Address,
    readonly messenger: Address,
  ) {}

  private ready(d: number): [boolean, number] {
    if (this.finalized.has(d)) return [false, 1];
    const n = this.reported.get(d)?.size ?? 0;
    if (n === 0) return [false, 2];
    if (n >= this.expected.length && this.expected.length > 0) return [true, 0];
    return NOW >= (this.firstAt.get(d) ?? 0) + GRACE ? [true, 0] : [false, 3];
  }

  readContract = async ({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const d = args && args.length > 0 ? Number(args[0] as bigint) : -1;
    const reward = this.messengerNow ?? this.messenger;
    const wired = (): unknown => {
      const o = this.wire.get(functionName);
      if (o === 'unread') throw new Error('fetch failed');
      return o;
    };
    if (address === TRANSPORT_OF[this.chainId]) {
      const o = wired();
      if (o !== undefined) return o;
      switch (functionName) {
        case 'channelOf':
          return args![0] === reward ? REWARD_CHANNEL : `0x${'00'.repeat(32)}`;
        case 'remoteMessengerOf':
          return TRANSPORT_OF[Number(args![0] as bigint)] ?? ZERO;
        case 'handlerOf':
          return args![0] === REWARD_CHANNEL ? reward : ZERO;
        case 'channelPeerOf':
          return args![0] === REWARD_CHANNEL ? (MESSENGER_OF[Number(args![1] as bigint)] ?? ZERO) : ZERO;
        default:
          throw new Error(`unexpected transport read ${functionName}`);
      }
    }
    if (address === this.messenger || address === this.messengerNow) {
      if (['messenger', 'isCanonical', 'diamond'].includes(functionName)) {
        const o = wired();
        if (o !== undefined) return o;
        return functionName === 'messenger' ? TRANSPORT_OF[this.chainId] : functionName === 'isCanonical' ? this.role === ROLE_CANONICAL : this.diamond;
      }
      if (functionName === 'quoteSendChainReport') {
        // A shape the messenger lacks: the contract answers with an unnamed revert.
        if (!this.quoteShapes.has(args?.length ?? 0)) throw new ContractFunctionRevertedError({ abi: ERRORS_ABI, functionName: 'quoteSendChainReport' });
        return LANE_FEE;
      }
      if (functionName === 'baseChainId') {
        if (this.routeTo === 'unread') throw new Error('fetch failed');
        return BigInt(this.role === ROLE_CANONICAL ? 0 : (this.routeTo ?? BASE));
      }
      if (functionName === 'getBroadcastDestinations') {
        if (this.destinationsUnreadable) throw new Error('execution reverted');
        const read = this.destinations.map(BigInt);
        if (this.destinationsChangeTo !== null) {
          this.destinations = this.destinationsChangeTo;
          this.destinationsChangeTo = null;
        }
        return read;
      }
      throw new Error(`unexpected messenger read ${functionName}`);
    }
    switch (functionName) {
      case 'getRewardRole':
        if (this.roleUnread) throw new Error('rpc down');
        return this.role;
      case 'getInteractionCurrentDay':
        return [BigInt(this.today), this.active];
      case 'getInteractionLaunchTimestamp':
        if (this.launchUnread) throw new Error('rpc down');
        return BigInt(this.launch);
      case 'paused':
        return this.paused;
      case 'getRewardReporterConfig':
        if (blockNumber !== undefined && this.reporterConfigUnreadAtBlock) throw new Error('fetch failed');
        if (blockNumber === undefined && this.reporterConfigUnread) throw new Error('rpc down');
        return [this.messengerNow ?? this.messenger, this.namesItself ?? this.chainId, this.baseChain, this.role === ROLE_CANONICAL, BigInt(GRACE)];
      case 'getChainReportSentAt':
        if (this.sentAtUnreadable) throw new Error('rpc down');
        return BigInt(this.sentAt.get(d) ?? 0);
      case 'isDayReadyToFinalize':
        return this.ready(d);
      case 'getDailyFirstReportAt':
        return BigInt(this.firstAt.get(d) ?? 0);
      case 'getExpectedSourceChainIds':
        if (this.expectedUnreadable) throw new Error('rpc down');
        return this.expected;
      case 'isChainReported':
        if (this.unreadable.has(Number(args![1]))) throw new Error('rpc down');
        return this.reported.get(d)?.has(Number(args![1])) ?? false;
      case 'getKnownGlobalInterestNumeraire18':
        if (this.knownUnreadable) throw new Error('rpc down');
        return [0n, 0n, this.known.has(d)];
      case 'quoteBroadcastGlobal':
        return BROADCAST_FEE;
      case 'quoteBroadcastGlobalTo':
        if (this.noSingleSend) throw revert('FunctionDoesNotExist');
        if (this.quoteUnreadTo.has(Number(args![1]))) throw new Error('rpc down');
        // Day standing, as the contract keeps it: included in the day's
        // finalization (it reported in time), or marked otherwise.
        if (this.noStanding.has(Number(args![1])) || (!this.destinations.includes(Number(args![1])) && !this.reported.get(d)?.has(Number(args![1])) && !this.standing.has(Number(args![1]))))
          throw revert('DestinationHasNoDayStanding', [BigInt(d), args![1]]);
        if (this.refuseToChain.has(Number(args![1]))) throw revert(this.refuseToChain.get(Number(args![1]))!);
        if (this.refuseTo) throw revert(this.refuseTo, this.refuseTo === 'DestinationHasNoDayStanding' ? [BigInt(d), args![1]] : []);
        return BROADCAST_TO_FEE;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) => {
    this.largestRead = Math.max(this.largestRead, contracts.length);
    return Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract(c) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );
  };

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    if (this.rpcDown) throw new Error('fetch failed');
    const day = Number(args[0] as bigint);
    this.simulated.push(day);
    const why = this.refuse.get(`${functionName}:${day}`);
    if (why === 'ChainReportFrontierShort') throw revert(why, [BigInt(day), 0n, 0n]);
    if (why) throw revert(why);
    return { result: undefined };
  };

  /** The chain's head, advanced by every landed call. */
  blockNo = 100n;
  /** Every finalization event, with the block it is in. */
  history: { block: bigint; name: 'DailyGlobalInterestFinalized' | 'ChainContributionZeroed'; dayId: number; sourceChainId?: number }[] = [];
  getBlockNumber = async () => this.blockNo;
  /** Log queries fail. */
  logsUnread = false;
  getLogs = async ({ event, args, fromBlock, toBlock }: { event: { name: string }; args: { dayId: bigint }; fromBlock: bigint; toBlock: bigint }) => {
    if (this.logsUnread) throw new Error('fetch failed');
    return this.history
      .filter((h) => h.name === event.name && h.dayId === Number(args.dayId) && h.block >= fromBlock && h.block <= toBlock)
      .map((h) => ({ args: { dayId: BigInt(h.dayId), sourceChainId: h.sourceChainId } }));
  };
  /** Another caller finalizes `day`. */
  finalizeByOther(day: number): void {
    this.blockNo += 1n;
    this.apply('finalizeDay', day);
    this.logs = [];
  }

  /** Transactions of the keeper's still unmined. */
  pendingTxs = 0;
  getTransactionCount = async ({ blockTag }: { blockTag: string }) => (blockTag === 'pending' ? 5 + this.pendingTxs : 5);

  waitForTransactionReceipt = async () => {
    if (this.receiptLost) throw new Error('timed out');
    const logs = this.logs;
    this.logs = [];
    return { status: 'success', logs, blockNumber: 100n };
  };

  /** The state change a landed call makes. */
  apply(fn: string, day: number, to?: number): void {
    if (fn === 'broadcastGlobal' || fn === 'broadcastGlobalTo') {
      if (this.rotateTo !== null) {
        this.messengerNow = this.rotateTo;
        this.rotateTo = null;
      }
      // The messenger's own record of each message that left, as a receipt
      // carries it: to its list as it stands when the transaction runs.
      for (const c of fn === 'broadcastGlobalTo' ? [to!] : (this.listAtSend ?? this.destinations)) {
        this.logs.push({
          address: this.messengerNow ?? this.messenger,
          topics: [toEventSelector('BroadcastV3Sent(bytes32,uint256,uint256)'), pad('0x01'), pad(toHex(c)), pad(toHex(day))],
          data: '0x',
        } as unknown as Log);
      }
    }
    if (fn === 'closeDay') {
      this.sentAt.set(day, NOW);
      if (this.role !== ROLE_CANONICAL) {
        if (this.rotateTo !== null) {
          this.messengerNow = this.rotateTo;
          this.rotateTo = null;
        }
        // The report leaves through the messenger the Diamond holds now.
        this.logs.push({
          address: this.messengerNow ?? this.messenger,
          topics: [toEventSelector('ReportSent(bytes32,uint256,uint256,uint256)'), pad('0x01'), pad(toHex(day))],
          data: '0x',
        } as unknown as Log);
      }
      if (this.role === ROLE_CANONICAL) {
        if (!this.reported.has(day)) this.reported.set(day, new Set());
        this.reported.get(day)!.add(this.chainId);
        if (!this.firstAt.has(day)) this.firstAt.set(day, NOW);
      } else if (this.deliverTo && !this.deliverTo.finalized.has(day)) {
        // A report reaching a day Base already finalized counts for nothing.
        const on = this.deliverTo;
        if (!on.reported.has(day)) on.reported.set(day, new Set());
        on.reported.get(day)!.add(this.chainId);
      }
    }
    if (fn === 'advanceInterestFrontiers') this.refuse.delete(`closeDay:${day}`);
    if (fn === 'finalizeDay') {
      const late = this.landsAtFinalize.get(day);
      if (late !== undefined) this.reported.get(day)?.add(late);
      this.finalized.add(day);
      this.history.push({ block: this.blockNo, name: 'DailyGlobalInterestFinalized', dayId: day });
      for (const c of this.expected) {
        if (this.reported.get(day)?.has(c)) continue;
        this.history.push({ block: this.blockNo, name: 'ChainContributionZeroed', dayId: day, sourceChainId: c });
        this.logs.push({
          address: this.diamond,
          topics: encodeEventTopics({ abi: AGGREGATOR_ABI, eventName: 'ChainContributionZeroed', args: { dayId: BigInt(day), sourceChainId: c } } as never),
          data: encodeAbiParameters([{ type: 'bool' }], [true]),
        } as unknown as Log);
      }
    }
  }

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: this.diamond,
      chainId: this.chainId,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: '0x00000000000000000000000000000000000000ee' },
        writeContract: async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value: bigint }) => {
          const day = Number(args[0] as bigint);
          if (this.writeError) throw this.writeError;
          this.blockNo += 1n;
          this.sent.push(functionName === 'broadcastGlobalTo' ? { fn: functionName, day, value, to: Number(args[1] as bigint) } : { fn: functionName, day, value });
          this.apply(functionName, day, functionName === 'broadcastGlobalTo' ? Number(args[1] as bigint) : undefined);
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }

  peer(): PeerReader {
    return { diamond: this.diamond, client: this.client() };
  }
}

describe('a run', () => {
  let keeper: SqliteD1;
  let env: Env;
  let base: FakeDiamond;
  let mirror: FakeDiamond;
  let warned: string[];
  let logged: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    keeper = createKeeperD1();
    env = { DB: createSharedD1().d1, KEEPER_DB: keeper.d1 } as unknown as Env;
    base = new FakeDiamond(BASE, '0x00000000000000000000000000000000000000b1', '0x00000000000000000000000000000000000000b2');
    base.role = ROLE_CANONICAL;
    base.expected = [BASE, MIRROR];
    base.destinations = [MIRROR];
    mirror = new FakeDiamond(MIRROR, '0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2');
    warned = [];
    logged = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push('ERR ' + a.map(String).join(' ')));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const peers = (id: number): PeerReader | null => (id === BASE ? base.peer() : id === MIRROR ? mirror.peer() : null);
  const run = (c: FakeDiamond) =>
    dayCloseOnce(env, c.chainId, c.diamond, {
      client: c.client(),
      readClient: c.client(),
      context: () => c.ctx(),
      peer: peers,
      served: [BASE, MIRROR],
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
  const alerts = (re: RegExp) => warned.filter((w) => re.test(w));
  const openAlert = (key: string) =>
    keeper.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)`).run(key, 1, 1, 0);
  const openKeys = () => (keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[]).map((r) => r.alert_key);
  const later = (sec: number) => vi.setSystemTime(Date.now() + sec * 1000);

  it('a mirror closes every unreported elapsed day, oldest first, paying the quoted lane fee', async () => {
    mirror.sentAt.set(1, NOW - 86_400);
    await run(mirror);
    expect(mirror.sent).toEqual([
      { fn: 'closeDay', day: 0, value: LANE_FEE },
      { fn: 'closeDay', day: 2, value: LANE_FEE },
    ]);
    await run(mirror);
    expect(mirror.sent, 'nothing left to close').toHaveLength(2);
  });

  it('closes no day while its messenger sends reports somewhere other than Base, says so, and clears once they agree', async () => {
    mirror.routeTo = 999;
    await run(mirror);
    expect(mirror.sent, 'a report sent now would never reach Base').toEqual([]);
    expect(alerts(/would not be accepted on Base .*sends its reports to chain 999, but this Diamond names chain 84532 as Base/)).toHaveLength(1);
    expect(owed(), 'and every day stays owed').toEqual([0, 1, 2]);
    openAlert(`dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`); // as a delivered alert leaves it
    await run(mirror);
    expect(openKeys(), 'stands while the route still differs').toContain(`dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    mirror.routeTo = null;
    await run(mirror);
    expect(mirror.sent.map((s) => s.day), 'closed once the route reads as Base').toEqual([0, 1, 2]);
    expect(openKeys()).not.toContain(`dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('says when a close sent its report through a messenger rotated in after the checks, until Base records the day', async () => {
    mirror.today = 1;
    mirror.rotateTo = '0x0000000000000000000000000000000000000099';
    const said = () => alerts(/close of reward day 0 sent its report through messenger 0x0000000000000000000000000000000000000099, not the reward messenger this run checked/);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day), 'the close lands: the rotation is seen only in its receipt').toEqual([0]);
    expect(said()).toHaveLength(1);
    openAlert(`dayclose-dispatch:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:0`); // as a delivered alert leaves it
    later(60);
    await run(mirror);
    expect(openKeys(), 'stands while Base has no outcome for the day').toContain(`dayclose-dispatch:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:0`);
    expect(said(), 'and is said again from its record, however its first delivery went').toHaveLength(2);
    base.reported.set(0, new Set([MIRROR]));
    later(60);
    await run(mirror);
    expect(openKeys(), 'counted is not final: the chain can still be left out before finalization').toContain(`dayclose-dispatch:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:0`);
    base.finalized.add(0);
    later(60);
    await run(mirror);
    expect(openKeys(), 'and clears once Base finalizes the day').not.toContain(`dayclose-dispatch:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:0`);
    expect(said(), 'said while it stands (this journal is unconfigured, so every run), and not once cleared').toHaveLength(3);
    expect(mirror.sent, 'nothing is sent again').toHaveLength(1);
  });

  it('does not say so when the report left through the messenger it checked', async () => {
    await run(mirror);
    expect(alerts(/not the reward messenger this run checked/)).toEqual([]);
  });

  it('keeps a closed day owed while Base has finalized it but whether it counted this chain is unread', async () => {
    mirror.today = 1;
    base.finalized.add(0);
    base.unreadable.add(MIRROR);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day)).toEqual([0]);
    expect(owed(), 'the outcome for this chain is not known').toEqual([0]);
    base.unreadable.clear();
    later(60);
    await run(mirror);
    expect(alerts(/Base finalized reward day 0 without this chain's report/)).toHaveLength(1);
    expect(owed(), 'said, then gone').toEqual([]);
  });

  it("holds every close when Base's Diamond has changed since its clock was read, until the new clock reads", async () => {
    const NEW_BASE = '0x00000000000000000000000000000000000000b9' as Address;
    await run(mirror); // Base's clock read and recorded; days 0..2 closed
    mirror.today += 1;
    base.launchUnread = true;
    const moved = (id: number): PeerReader | null => (id === BASE ? { diamond: NEW_BASE, client: base.client() } : peers(id));
    base.wire.set('diamond', NEW_BASE); // Base's reward messenger forwards to the new Diamond
    const runMoved = () =>
      dayCloseOnce(env, mirror.chainId, mirror.diamond, {
        client: mirror.client(),
        readClient: mirror.client(),
        context: () => mirror.ctx(),
        peer: moved,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Number.POSITIVE_INFINITY,
      });
    await runMoved();
    expect(mirror.sent.map((s) => s.day), 'the old record says nothing about the new Diamond').toEqual([0, 1, 2]);
    expect(alerts(/the reward clock of chain 84532 \(it now names Diamond 0x0+b9, not the one whose clock this keeper last read, and the new clock has not been read\) is not known/)).toHaveLength(1);
    openAlert(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`); // as a delivered alert leaves it
    base.launchUnread = false;
    later(60);
    await runMoved();
    expect(mirror.sent.map((s) => s.day), 'closed once the new clock reads as the same').toEqual([0, 1, 2, 3]);
    expect(openKeys()).not.toContain(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('keeps holding on a moved peer Diamond after the keeper stops serving that peer', async () => {
    const NEW_BASE = '0x00000000000000000000000000000000000000b9' as Address;
    await run(mirror); // Base's clock read and recorded at its old Diamond
    mirror.today += 1;
    base.launchUnread = true;
    const runWith = (peer: (id: number) => PeerReader | null) =>
      dayCloseOnce(env, mirror.chainId, mirror.diamond, {
        client: mirror.client(),
        readClient: mirror.client(),
        context: () => mirror.ctx(),
        peer,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Number.POSITIVE_INFINITY,
      });
    await runWith((id) => (id === BASE ? { diamond: NEW_BASE, client: base.client() } : peers(id)));
    openAlert(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    later(60);
    await runWith((id) => (id === BASE ? null : peers(id))); // Base no longer served
    expect(mirror.sent.map((s) => s.day), 'the old Diamond\'s clock is not trusted again').toEqual([0, 1, 2]);
    expect(openKeys()).toContain(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('closes no day while its messenger route cannot be read', async () => {
    mirror.routeTo = 'unread';
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/is unknown: where this chain's reward messenger sends reports \(its baseChainId\) could not be read/)).toHaveLength(1);
  });

  describe('closes no day while the report channel would refuse the report on Base, naming the link', () => {
    const wireKey = `dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`;
    const cases: [string, () => void, RegExp][] = [
      ["Base's transport takes the channel from an old reward messenger", () => base.wire.set('channelPeerOf', '0x00000000000000000000000000000000000000c9'), /accepts the reward channel from this chain only from 0x0+c9, not from this chain's reward messenger 0x0+c2 \(setChannelPeer on Base; delivery reverts UnauthorizedChannelPeer\)/],
      ["Base's transport names no sender for this chain", () => base.wire.set('channelPeerOf', ZERO), /names no sender on the reward channel for this chain \(setChannelPeer on Base; delivery reverts NoChannelPeer\)/],
      ["Base's transport has no handler for the channel", () => base.wire.set('handlerOf', ZERO), /has no handler for the reward channel \(registerChannel on Base; delivery reverts UnknownChannel\)/],
      ["Base's transport delivers the channel elsewhere", () => base.wire.set('handlerOf', '0x00000000000000000000000000000000000000b9'), /delivers the reward channel to 0x0+b9, not to Base's reward messenger 0x0+b2/],
      ["Base's transport accepts this chain's messages from another transport", () => base.wire.set('remoteMessengerOf', '0x00000000000000000000000000000000000000c9'), /accepts this chain's messages only from 0x0+c9, not from this chain's transport 0x0+c3 \(setRemoteMessenger on Base; delivery reverts UnauthorizedSourceMessenger\)/],
      ["Base's reward messenger takes messages from another transport", () => base.wire.set('messenger', '0x00000000000000000000000000000000000000b9'), /takes messages only from transport 0x0+b9, not from 0x0+b3, the one this chain's transport sends to \(delivery reverts NotMessenger\)/],
      ["Base's reward messenger is not the canonical instance", () => base.wire.set('isCanonical', false), /is not set as the canonical instance, so it refuses every report \(ReportOnMirror\)/],
      ["Base's reward messenger forwards to another Diamond", () => base.wire.set('diamond', '0x00000000000000000000000000000000000000b9'), /forwards reports to 0x0+b9, not to Base's Diamond 0x0+b1/],
      ["this chain's transport has no channel for the reward messenger", () => mirror.wire.set('channelOf', `0x${'00'.repeat(32)}`), /has no channel registered for the reward messenger 0x0+c2 \(registerChannel\)/],
      ["this chain's reward messenger has no transport", () => mirror.wire.set('messenger', ZERO), /reward messenger 0x0+c2 has no transport set/],
    ];
    for (const [what, wireIt, said] of cases) {
      it(what, async () => {
        wireIt();
        await run(mirror);
        expect(mirror.sent, 'a report the receiving end refuses is still stamped sent here').toEqual([]);
        expect(alerts(new RegExp(`would not be accepted on Base \\(chain 84532, as this Diamond names it\\): .*(${said.source})`))).toHaveLength(1);
        expect(owed()).toEqual([0, 1, 2]);
        openAlert(wireKey);
        base.wire.clear();
        mirror.wire.clear();
        await run(mirror);
        expect(mirror.sent.map((s) => s.day), 'closed once every link reads as wired').toEqual([0, 1, 2]);
        expect(openKeys()).not.toContain(wireKey);
      });
    }

    it("holds when this chain's transport names, as Base's, a contract that is not the one Base's reward messenger takes messages from", async () => {
      mirror.wire.set('remoteMessengerOf', '0x00000000000000000000000000000000000000b9'); // answers none of a transport's reads
      await run(mirror);
      expect(mirror.sent).toEqual([]);
      expect(alerts(/would not be accepted on Base .*takes messages only from transport 0x0+b3, not from 0x0+b9, the one this chain's transport sends to/)).toHaveLength(1);
      expect(alerts(/the transport Base's transport accepts this chain's messages from could not be read/), 'the links it could not read are not a fault stated').toHaveLength(0);
    });

    it("holds when a link on Base cannot be read, and says which", async () => {
      base.wire.set('channelPeerOf', 'unread');
      await run(mirror);
      expect(mirror.sent).toEqual([]);
      expect(alerts(/is unknown: the sender Base's transport accepts on the reward channel from this chain could not be read/)).toHaveLength(1);
    });

    it('states a known fault even while another link is unread', async () => {
      base.wire.set('channelPeerOf', 'unread');
      base.wire.set('isCanonical', false);
      await run(mirror);
      expect(alerts(/would not be accepted on Base .*ReportOnMirror/)).toHaveLength(1);
    });
  });

  it('says a run stopped sending on a fault that repeats, until a run sends without it', async () => {
    mirror.writeError = Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 });
    const held = `dayclose-held:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`;
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/stopped sending this run: the node refused its send of closeDay for day 0 \(Error, rpc code -32000\), so nothing went out; a refusal like insufficient funds for the gas and CCIP fee repeats every run until it is fixed/)).toHaveLength(1);
    expect(owed()).toEqual([0, 1, 2]);
    openAlert(held);
    mirror.writeError = null;
    later(60);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1, 2]);
    expect(openKeys(), 'cleared once a run sends without it').not.toContain(held);
  });

  it('says a run with no signing key sent nothing', async () => {
    await dayCloseOnce(env, mirror.chainId, mirror.diamond, {
      client: mirror.client(),
      readClient: mirror.client(),
      context: () => null,
      peer: peers,
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(mirror.sent).toEqual([]);
    expect(alerts(/stopped sending this run: it has no signing key for this chain, so it sent nothing/)).toHaveLength(1);
  });

  it('keeps a closed day owed until Base finalizes it, counted or not: a counted report can still be left out before then', async () => {
    await run(mirror);
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1, 2]);
    expect(owed(), 'sent, not yet seen on Base').toEqual([0, 1, 2]);
    base.reported.set(0, new Set([MIRROR]));
    base.finalized.add(1); // without it: the exclusion alert is what the day waits for
    later(60);
    await run(mirror);
    expect(alerts(/Base finalized reward day 1 without this chain's report/)).toHaveLength(1);
    expect(owed(), 'the day finalized without it goes; counted is not final, and in flight stays').toEqual([0, 2]);
    base.finalized.add(0);
    later(60);
    await run(mirror);
    expect(owed(), 'finalized with its report: final').toEqual([2]);
    expect(alerts(/Base finalized reward day 0 without this chain's report/), 'and never said excluded: whether it was counted in is not readable on Base').toEqual([]);
    expect(mirror.sent, 'and nothing is sent twice').toHaveLength(3);
  });

  it('does nothing on day 0, with the clock stopped, or while paused', async () => {
    mirror.today = 0;
    await run(mirror);
    mirror.today = 3;
    mirror.active = false;
    await run(mirror);
    mirror.active = true;
    mirror.paused = true;
    await run(mirror);
    expect(mirror.sent).toEqual([]);
  });

  it('a mirror still closes a day Base already finalized (its chain-wide figures still apply), and says the day excluded it', async () => {
    base.finalized.add(0);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1, 2]);
    expect(alerts(/Base finalized reward day 0 without this chain's report/)).toHaveLength(1);
  });

  it('advances the interest fold first when the close says it is short', async () => {
    mirror.refuse.set('closeDay:0', 'ChainReportFrontierShort');
    await run(mirror);
    expect(mirror.sent.slice(0, 2).map((s) => s.fn)).toEqual(['advanceInterestFrontiers', 'closeDay']);
    expect(alerts(/refused/)).toEqual([]);
  });

  it('Base closes its own days, then finalizes on full coverage and broadcasts with the quoted fee', async () => {
    base.today = 1;
    base.reported.set(0, new Set([MIRROR]));
    base.firstAt.set(0, NOW - 60);
    await run(base);
    expect(base.sent).toEqual([
      { fn: 'closeDay', day: 0, value: 0n },
      { fn: 'finalizeDay', day: 0, value: 0n },
      { fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE },
    ]);
    expect(warned).toEqual([]);
  });

  it('Base waits for a missing mirror inside grace, warns near its end naming what the mirror shows, then finalizes at grace with a notice', async () => {
    base.today = 1;
    mirror.sentAt.set(0, NOW - 300);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'its own close only').toEqual(['closeDay']);
    expect(alerts(/missing/)).toEqual([]);

    later(GRACE - GRACE_WARNING_SEC);
    await run(base);
    expect(alerts(/reward day 0 is still missing 1 expected report\(s\): chain 421614 \(sent at .*not yet landed on Base\)/)).toHaveLength(1);

    later(GRACE_WARNING_SEC);
    vi.setSystemTime((NOW + GRACE) * 1000);
    base.firstAt.set(0, NOW - GRACE); // the fake's clock is fixed: grace has elapsed for it too
    await run(base);
    expect(base.sent.map((s) => s.fn)).toEqual(['closeDay', 'finalizeDay', 'broadcastGlobal']);
    expect(logged.filter((l) => /notice: reward day 0: finalized without chain\(s\) 421614/.test(l))).toHaveLength(1);
    expect(alerts(/finalized with expected reports missing/), 'and posted as one notice').toHaveLength(1);
  });

  it('confirms a broadcast on the mirror, reports it late, and re-sends it', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE, MIRROR]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    base.finalized.add(0);
    await run(base);
    expect(base.sent).toEqual([{ fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE }]);

    later(BROADCAST_LATE_AFTER_SEC);
    await run(base);
    expect(base.sent, 'late, not yet re-sent').toHaveLength(1);
    expect(alerts(/broadcast of reward day 0 has not reached chain 421614 \(last sent \S+, or sent then with no receipt seen\)/)).toHaveLength(1);

    later(BROADCAST_RESEND_AFTER_SEC - BROADCAST_LATE_AFTER_SEC);
    openAlert(`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`);
    await run(base);
    expect(openKeys(), 'a re-send landing is not a delivery').toEqual([`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`]);
    expect(base.sent[1], 'every listed destination lacks it: re-sent to all').toEqual({ fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE });

    mirror.known.add(0);
    await run(base);
    expect(base.sent, 'delivered: nothing more').toHaveLength(2);
    expect(openKeys(), 'the late alert cleared').toEqual([]);
    expect(keeper.db.prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE kind = 'day_broadcast'`).get(), 'the send marker stays with the window').toEqual({ n: 1 });
  });

  it('never finalizes against an empty expected-source list, and says so', async () => {
    base.today = 1;
    base.expected = [];
    base.firstAt.set(0, NOW - GRACE);
    await run(base);
    expect(base.sent.map((s) => s.fn)).toEqual(['closeDay']);
    expect(alerts(/expected-source list is empty/)).toHaveLength(1);
  });

  it('says when Base is not on its own expected-source list, and clears it once it is', async () => {
    base.today = 1;
    base.expected = [MIRROR];
    base.reported.set(0, new Set([MIRROR]));
    base.firstAt.set(0, NOW - GRACE);
    await run(base);
    expect(alerts(/not on its own expected-source list/)).toHaveLength(1);
    expect(base.sent.some((s) => s.fn === 'finalizeDay'), 'no day finalized against a list without Base').toBe(false);
    openAlert(`dayclose-selfmissing:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    base.expected = [BASE, MIRROR];
    await run(base);
    expect(openKeys()).toEqual([]);
  });

  it('names a refused call and clears the alert once it lands', async () => {
    mirror.refuse.set('closeDay:0', 'RewardMessengerNotSet');
    await run(mirror);
    expect(alerts(/closing the day \(closeDay\) for reward day 0 is refused \(RewardMessengerNotSet\)/)).toHaveLength(1);
    openAlert(`dayclose-refused:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:close:0`);
    mirror.refuse.clear();
    await run(mirror);
    expect(mirror.sent.some((s) => s.day === 0)).toBe(true);
    expect(openKeys()).toEqual([]);
  });

  it('clears a refused fold advance once the close it served lands, whoever advanced it', async () => {
    mirror.refuse.set('closeDay:0', 'ChainReportFrontierShort');
    mirror.refuse.set('advanceInterestFrontiers:0', 'RewardMessengerNotSet');
    await run(mirror);
    expect(alerts(/advancing the interest fold \(advanceInterestFrontiers\) for reward day 0 is refused/)).toHaveLength(1);
    openAlert(`dayclose-refused:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:advance:0`);
    mirror.refuse.clear(); // another caller advanced the fold
    await run(mirror);
    expect(mirror.sent.some((s) => s.fn === 'closeDay' && s.day === 0)).toBe(true);
    expect(openKeys()).toEqual([]);
  });

  it('finalizes when the broadcast destinations cannot be read, broadcasts nothing, and says so until they can', async () => {
    base.today = 1;
    base.reported.set(0, new Set([MIRROR]));
    base.firstAt.set(0, NOW - 60);
    base.destinationsUnreadable = true;
    await run(base);
    expect(base.sent.map((s) => s.fn), 'closed and finalized, not broadcast').toEqual(['closeDay', 'finalizeDay']);
    expect(alerts(/broadcasts no finalized day while the reward messenger's broadcast destinations could not be read/)).toHaveLength(1);
    openAlert(`dayclose-held:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    base.destinationsUnreadable = false;
    await run(base);
    expect(base.sent.map((s) => s.fn).slice(2), 'broadcast once the list reads').toEqual(['broadcastGlobal']);
    expect(openKeys()).toEqual([]);
  });

  it('says it finalizes and broadcasts nothing while the expected-source list cannot be read, until it can', async () => {
    base.today = 1;
    base.reported.set(0, new Set([MIRROR]));
    base.firstAt.set(0, NOW - 60);
    base.expectedUnreadable = true;
    await run(base);
    expect(base.sent.map((s) => s.fn), 'closed, not finalized').toEqual(['closeDay']);
    expect(
      alerts(/finalizes no reward day while Base's expected-source list could not be read .*; and it broadcasts no finalized day while Base's expected-source list could not be read/),
      'the hold is said though no other alert names its cause',
    ).toHaveLength(1);
    openAlert(`dayclose-held:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    base.expectedUnreadable = false;
    await run(base);
    expect(base.sent.map((s) => s.fn).slice(1), 'finalized and broadcast once the list reads').toEqual(['finalizeDay', 'broadcastGlobal']);
    expect(openKeys()).toEqual([]);
  });

  it('keeps checking and re-sending to a destination taken off the list after a send that never reached it', async () => {
    finalizedDayZero();
    await run(base);
    base.destinations = []; // the mirror is taken off the messenger's list
    later(BROADCAST_LATE_AFTER_SEC);
    await run(base);
    expect(alerts(/broadcast of reward day 0 has not reached chain 421614 \(last sent \S+, or sent then with no receipt seen\)/), 'still lacking it, still late').toHaveLength(1);
    later(BROADCAST_RESEND_AFTER_SEC - BROADCAST_LATE_AFTER_SEC);
    await run(base);
    expect(base.sent.slice(1), 'healed alone, the way the contract admits').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR }]);
  });

  it('says a destination taken off the list cannot be reached when the Diamond will not send to it alone', async () => {
    finalizedDayZero();
    await run(base);
    base.destinations = [];
    base.refuseTo = 'MessengerPredatesV3';
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'no send to every destination: it would not reach this one').toEqual(['broadcastGlobal']);
    expect(alerts(/chain 421614 is not a broadcast destination and the Diamond will not send the day to it alone \(MessengerPredatesV3\)/)).toHaveLength(1);
  });

  const owed = () => (keeper.db.prepare(`SELECT block FROM keeper_work_open WHERE kind = 'day_owed' ORDER BY block`).all() as { block: number }[]).map((r) => r.block);

  it('owes a day nothing to a destination off the list that has no standing in it', async () => {
    finalizedDayZero();
    await run(base);
    base.destinations = [];
    base.expected = [BASE];
    base.noStanding.add(MIRROR);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'nothing sent to a chain that had no part in the day').toEqual(['broadcastGlobal']);
    expect(alerts(/not a broadcast destination|has not reached/)).toEqual([]);
    expect(owed(), 'the day is worked through').toEqual([]);
  });

  it('keeps a day in view while an expected mirror is off the broadcast list, and sends it once the mirror is listed', async () => {
    finalizedDayZero();
    base.destinations = [];
    base.refuseTo = 'MessengerPredatesV3'; // the messenger cannot send to it alone either
    await run(base);
    expect(base.sent, 'no send could reach it').toEqual([]);
    expect(alerts(/chain 421614 is not a broadcast destination/)).toHaveLength(1);
    expect(owed(), 'the day is not worked through').toEqual([0]);

    later(LOOKBACK_DAYS * 86_400); // long enough for the day to have left a lookback-only window
    base.today = LOOKBACK_DAYS + 2;
    base.destinations = [MIRROR];
    base.refuseTo = null;
    for (let d = 1; d < base.today; d++) {
      base.reported.set(d, new Set([BASE, MIRROR]));
      base.sentAt.set(d, NOW - 60);
      base.finalized.add(d);
      mirror.known.add(d);
    }
    await run(base);
    expect(base.sent, 'day 0 reaches the mirror once it is listed').toEqual([{ fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE }]);
    mirror.known.add(0);
    await run(base);
    expect(owed()).toEqual([]);
  });

  it('treats a Base day finalized before its own close as worked through once broadcast', async () => {
    base.today = 1;
    base.finalized.add(0); // an admin force-finalized it before Base closed it
    base.refuse.set('closeDay:0', 'ReportAfterFinalization');
    mirror.known.add(0);
    await run(base);
    expect(base.sent, 'no close, and nothing owed to the mirror').toEqual([]);
    expect(owed(), 'the close it can never make does not hold the day').toEqual([]);
  });

  it("clears Base's refused-close alert once the day is finalized without it, so the alert does not hold the day", async () => {
    base.today = 1;
    base.refuse.set('closeDay:0', 'DayNotReadyToFinalize');
    await run(base);
    expect(alerts(/closing the day \(closeDay\) for reward day 0 is refused/)).toHaveLength(1);
    openAlert(`dayclose-refused:${BASE}:0x00000000000000000000000000000000000000b1:canonical:close:0`); // as a delivered alert leaves it
    base.finalized.add(0); // then an admin force-finalizes it
    base.refuse.set('closeDay:0', 'ReportAfterFinalization');
    mirror.known.add(0);
    later(60);
    await run(base);
    expect(openKeys(), 'a close no longer owed is no longer refused').not.toContain(`dayclose-refused:${BASE}:0x00000000000000000000000000000000000000b1:canonical:close:0`);
    expect(owed(), 'and the day goes').toEqual([]);
  });

  it('counts a send the node refused outright as not made, and one it did not answer as made', async () => {
    finalizedDayZero();
    base.writeError = Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 });
    await run(base);
    base.writeError = null;
    await run(base);
    expect(base.sent, 'refused outright: sent on the next run').toEqual([{ fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE }]);

    base.finalized.add(1);
    base.today = 2;
    base.reported.set(1, new Set([BASE, MIRROR]));
    base.sentAt.set(1, NOW - 60);
    base.writeError = new Error('fetch failed'); // no answer: it may have gone out
    await run(base);
    base.writeError = null;
    await run(base);
    expect(base.sent.filter((s) => s.day === 1), 'not repeated before the re-send interval').toEqual([]);
  });

  it('reads a long-open window in bounded aggregates', async () => {
    mirror.today = 3 * READ_CHUNK;
    await run(mirror);
    expect(mirror.largestRead).toBeLessThanOrEqual(READ_CHUNK);
    expect(mirror.sent.map((s) => s.day), 'the recent days are closed first, and the read starved none of them').toEqual(Array.from({ length: MAX_SENDS_PER_RUN }, (_, i) => mirror.today - LOOKBACK_DAYS + i));
  });

  it('names the chains a day was finalized without when another caller finalized it', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    base.finalized.add(0); // by someone else
    await run(base);
    expect(base.sent.some((s) => s.fn === 'finalizeDay'), 'not finalized by this keeper').toBe(false);
    expect(logged.some((l) => /notice: reward day 0: finalized without chain\(s\) 421614/.test(l)), 'journaled').toBe(true);
    expect(alerts(/finalized with expected reports missing/), 'and posted').toHaveLength(1);
  });

  it('never repeats a broadcast whose receipt was not seen before the re-send interval', async () => {
    finalizedDayZero();
    base.receiptLost = true;
    await run(base);
    base.receiptLost = false;
    later(15 * 60);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'sent once: it may have landed').toEqual(['broadcastGlobal']);
  });

  it('sends a day alone to a destination taken off the list before any send landed', async () => {
    finalizedDayZero();
    base.refuse.set('broadcastGlobal:0', 'RewardMessengerNotSet');
    await run(base); // the first send is refused; the day's destinations are recorded
    base.refuse.clear();
    base.destinations = [];
    await run(base);
    expect(base.sent, 'reached alone, not by a send to the list').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR }]);
  });

  it('reports a destination it cannot read as unknown past the late mark, and never re-sends to it blind', async () => {
    finalizedDayZero();
    await run(base);
    mirror.knownUnreadable = true;
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent, 'no re-send').toHaveLength(1);
    expect(alerts(/could not be confirmed on chain 421614 \(last sent \S+, or sent then with no receipt seen\), whose state this keeper could not read/)).toHaveLength(1);
  });

  it('sends nothing while a transaction of the keeper is still unmined, so a pending close is never sent twice', async () => {
    mirror.pendingTxs = 1; // an earlier run's close, its receipt not seen; the state still reads before it
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(logged.some((l) => /stopped=keeper-tx-pending \(1 unmined\)/.test(l))).toBe(true);
    mirror.pendingTxs = 0;
    await run(mirror);
    expect(mirror.sent.map((s) => s.fn)).toContain('closeDay');
  });

  it('closes no day when the chain its Diamond names as Base is not the canonical reward chain, and says so', async () => {
    base.role = ROLE_MIRROR; // the route and the Diamond agree on a chain that would refuse the report
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/closes no reward day while chain 84532, which this Diamond names as Base, is not the canonical reward chain \(its role reads 1\)/)).toHaveLength(1);
    base.role = ROLE_CANONICAL;
    await run(mirror);
    expect(mirror.sent.map((s) => s.fn)).toContain('closeDay');
    expect(openKeys()).toEqual([]);
  });

  it('says which days a failed read kept from being worked, and clears it once the read succeeds', async () => {
    mirror.sentAtUnreadable = true;
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/did not try closing the day \(closeDay\) this run for day 0 \(whether this chain has reported the day could not be read\)/)).toHaveLength(1);
    mirror.sentAtUnreadable = false;
    await run(mirror);
    expect(mirror.sent.map((s) => s.fn)).toContain('closeDay');
    expect(openKeys()).toEqual([]);
  });

  it('closes, with a notice, the alerts of a chain this keeper no longer serves', async () => {
    openAlert(`dayclose-route:999:0x00000000000000000000000000000000000000c1:all`);
    openAlert(`dayclose-refused:999:0x00000000000000000000000000000000000000c1:close:3`);
    openAlert(`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`); // a served chain's: untouched
    await retireUnworkedAlerts(env, new Map([[BASE, '0x00000000000000000000000000000000000000b1'], [MIRROR, '0x00000000000000000000000000000000000000c1']]), Date.now() + 60_000);
    expect(logged.filter((l) => /unserved, closed: dayclose-[a-z]+:999:\S+ \(this keeper no longer serves the chain\)/.test(l))).toHaveLength(2);
    expect(openKeys()).toEqual([`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`]);
  });

  it('never takes Base as canonical on a recorded role once a fresh read says otherwise, though its clock read fails', async () => {
    await run(mirror); // Base's clock and role recorded
    mirror.sent = [];
    mirror.today += 1;
    base.launchUnread = true; // the clock read fails this run...
    base.role = ROLE_MIRROR; // ...while the role read says Base is no longer canonical
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/is not the canonical reward chain \(its role reads 1\)/)).toHaveLength(1);
  });

  it('says a call whose simulation got no answer was not tried', async () => {
    mirror.rpcDown = true;
    await run(mirror);
    expect(alerts(/did not try closing the day \(closeDay\) this run for day 0 \(the simulation of the call \(the RPC did not answer\) could not be read\)/)).toHaveLength(1);
  });

  it('broadcasts a finalized day to a mirror that had part in it though both lists dropped it before the keeper first saw the day', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE, MIRROR])); // the mirror is in the day
    base.firstAt.set(0, NOW - 60);
    base.finalizeByOther(0);
    base.expected = [BASE]; // then taken off both lists
    base.destinations = [];
    await run(base);
    expect(base.sent.filter((s) => s.fn !== 'closeDay'), 'the contract says it has standing: it is owed the day').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR }]);
  });

  it('does not call an RPC that gives no answer a refusal', async () => {
    mirror.rpcDown = true;
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/refused/)).toEqual([]);
    expect(logged.some((l) => /stopped=rpc-unavailable/.test(l))).toBe(true);
  });

  it('says when Base or a repeated mirror is among the broadcast destinations', async () => {
    base.today = 1;
    base.destinations = [MIRROR, MIRROR, BASE];
    await run(base);
    expect(alerts(/Base itself \(84532\) is a broadcast destination/)).toHaveLength(1);
    expect(alerts(/chain\(s\) 421614 appear more than once among the broadcast destinations/)).toHaveLength(1);
  });

  it('a race with another caller is not a refusal', async () => {
    mirror.refuse.set('closeDay:0', 'ChainDayAlreadyReported');
    await run(mirror);
    expect(alerts(/refused/)).toEqual([]);
  });
  /** Base with day 0 finalized and its own report recorded: ready to broadcast. */
  const finalizedDayZero = () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE, MIRROR]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    base.finalized.add(0);
  };

  it('keeps a day owed when the lists change while the run works, so a destination added then is still sent it', async () => {
    finalizedDayZero();
    await run(base);
    mirror.known.add(0);
    base.destinationsChangeTo = [MIRROR, OTHER]; // added after this run reads the list
    base.standing.add(OTHER);
    later(60);
    await run(base);
    expect(owed(), 'judged done against the old list, but that list no longer stands').toEqual([0]);
    later(60);
    await run(base);
    expect(base.sent.map((s) => [s.fn, s.to]), 'the next run sends it to the added destination').toEqual([['broadcastGlobal', undefined], ['broadcastGlobalTo', OTHER]]);
  });

  it('sends to every destination when the Diamond routes no single-destination broadcast at all', async () => {
    finalizedDayZero();
    base.noSingleSend = true;
    await run(base);
    mirror.known.add(0);
    base.destinations = [MIRROR, OTHER]; // OTHER added: only it needs the day
    base.expected = [BASE, MIRROR, OTHER];
    later(60);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'the send to all, which re-sends idempotently to the mirror that has it').toEqual(['broadcastGlobal', 'broadcastGlobal']);
    expect(alerts(/refused/), 'a missing selector is a fallback, not a refusal').toEqual([]);
  });

  it('re-sends to every destination when the single-destination send is not available', async () => {
    finalizedDayZero();
    await run(base);
    later(BROADCAST_RESEND_AFTER_SEC);
    base.refuseTo = 'MessengerPredatesV3';
    await run(base);
    expect(base.sent.map((s) => s.fn)).toEqual(['broadcastGlobal', 'broadcastGlobal']);
    expect(alerts(/refused/), 'a fallback is not a refusal').toEqual([]);
  });

  it('a re-send leaves a destination that already has the day alone', async () => {
    finalizedDayZero();
    base.expected = [BASE, MIRROR, OTHER];
    base.destinations = [MIRROR, OTHER];
    const other = new FakeDiamond(OTHER, '0x00000000000000000000000000000000000000d1', '0x00000000000000000000000000000000000000d2');
    other.known.add(0);
    const peers3 = (id: number): PeerReader | null => (id === OTHER ? other.peer() : peers(id));
    const run3 = () =>
      dayCloseOnce(env, base.chainId, base.diamond, {
        client: base.client(),
        readClient: base.client(),
        context: () => base.ctx(),
        peer: peers3,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Number.POSITIVE_INFINITY,
      });
    await run3();
    later(BROADCAST_RESEND_AFTER_SEC);
    await run3();
    expect(base.sent.slice(1)).toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR }]);
  });

  it('sends the day alone to a destination added to the list after the day was sent', async () => {
    finalizedDayZero();
    await run(base);
    mirror.known.add(0);
    base.destinations = [MIRROR, OTHER]; // OTHER is added, and is not served by this keeper
    base.expected = [BASE, MIRROR, OTHER];
    later(60);
    await run(base);
    expect(base.sent.slice(1), 'never sent to OTHER, so it is sent the day').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: OTHER }]);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent, 'sent once there, and unconfirmable: nothing more').toHaveLength(2);
  });

  it('reports a late broadcast in the run that re-sends it, and keeps the alert until it is read delivered', async () => {
    finalizedDayZero();
    await run(base);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn)).toEqual(['broadcastGlobal', 'broadcastGlobal']);
    expect(alerts(/broadcast of reward day 0 has not reached chain 421614/), 'raised though a re-send followed').toHaveLength(1);
    openAlert(`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`);
    later(60);
    await run(base);
    expect(openKeys(), 'still lacking it: the alert stands').toEqual([`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`]);
    mirror.known.add(0);
    await run(base);
    expect(openKeys()).toEqual([]);
  });

  it('on a mirror, says when Base does not list this chain, still closing the day, and clears once it does', async () => {
    base.expected = [BASE];
    await run(mirror);
    expect(mirror.sent.map((s) => s.fn)).toContain('closeDay');
    expect(alerts(/this chain is not on Base's expected-source list, so Base refuses every report it sends \(SourceChainIdNotExpected\)/)).toHaveLength(1);
    openAlert(`dayclose-notexpected:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    await run(mirror);
    expect(openKeys(), 'still unlisted: the alert stands').toContain(`dayclose-notexpected:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    base.expected = [BASE, MIRROR];
    await run(mirror);
    expect(openKeys()).not.toContain(`dayclose-notexpected:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('keeps a late alert open while the destination cannot be read, and closes it, saying why, once the keeper stops serving it', async () => {
    finalizedDayZero();
    await run(base);
    later(BROADCAST_LATE_AFTER_SEC);
    await run(base);
    openAlert(`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`);
    mirror.knownUnreadable = true; // the mirror's read fails: unknown, not gone
    later(60);
    await run(base);
    expect(openKeys(), 'not read holding it: the alert stands').toEqual([`dayclose-broadcast:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`]);
    expect(owed(), 'and its day stays owed while the alert stands').toContain(0);
    // The keeper stops serving the mirror: whether the day arrived there can
    // never be read here again.
    later(60);
    await dayCloseOnce(env, base.chainId, base.diamond, {
      client: base.client(),
      readClient: base.client(),
      context: () => base.ctx(),
      peer: (id) => (id === MIRROR ? null : peers(id)),
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(logged.some((l) => /closed: dayclose-broadcast:84532:0x00000000000000000000000000000000000000b1:canonical:0 \(the day was sent to chain\(s\) 421614, which this keeper no longer serves/.test(l)), 'closed, and why').toBe(true);
    expect(openKeys(), 'not left standing for good').toEqual([]);
    expect(base.sent, 'and nothing is sent blind').toHaveLength(1);
    expect(owed(), 'so the day can go').not.toContain(0);
  });

  it('works a day older than the lookback that was never worked through, and keeps a day owed until it is', async () => {
    mirror.today = LOOKBACK_DAYS + 5; // armed late: days 0..4 are older than the lookback
    mirror.deliverTo = base;
    for (let d = 1; d < mirror.today; d++) {
      mirror.sentAt.set(d, NOW - 86_400);
      base.reported.set(d, new Set([MIRROR]));
      base.finalized.add(d);
    }
    await run(mirror);
    expect(mirror.sent.map((s) => [s.fn, s.day]), 'day 0 is closed, though older than the lookback').toEqual([['closeDay', 0]]);
    expect(owed(), 'day 0 is in flight: owed until Base has finalized it').toEqual([0]);

    mirror.today += 1; // day LOOKBACK+5 is refused from now on
    mirror.refuse.set(`closeDay:${LOOKBACK_DAYS + 5}`, 'DayNotReadyToFinalize');
    base.finalized.add(0);
    await run(mirror);
    expect(owed(), 'day 0 goes once Base finalizes it with its report; a day not closed stays owed').toEqual([LOOKBACK_DAYS + 5]);

    // Paused mid-run: no alert is raised, so no day leaves the ledger.
    mirror.today += 1;
    mirror.refuse.set(`closeDay:${LOOKBACK_DAYS + 6}`, 'EnforcedPause');
    await run(mirror);
    expect(owed(), 'every window day stays owed while paused').toEqual(Array.from({ length: LOOKBACK_DAYS }, (_, i) => i + 7));
  });

  it('works a long backlog of stuck days a page at a time, each in turn, without starving the newest', async () => {
    const stuck = 3 * BACKLOG_PER_RUN;
    mirror.today = stuck + LOOKBACK_DAYS;
    for (let d = 0; d < stuck; d++) mirror.refuse.set(`closeDay:${d}`, 'DayNotReadyToFinalize');
    const pages: number[][] = [];
    for (let i = 0; i < 4; i++) {
      mirror.simulated = [];
      // eslint-disable-next-line no-await-in-loop
      await run(mirror);
      pages.push(mirror.simulated.filter((d) => d < stuck));
      later(60);
    }
    const page = (k: number) => Array.from({ length: BACKLOG_PER_RUN }, (_, i) => k * BACKLOG_PER_RUN + i);
    // The first run's sends go to the newest days, which are still inside
    // Base's grace, and run out before the backlog: page 0's turn passes
    // with nothing tried, and the page comes round again after the others.
    expect(pages, 'one page of the backlog per run, the least recently worked first, after the newest days').toEqual([[], page(1), page(2), page(0)]);
    expect(mirror.sent.slice(0, MAX_SENDS_PER_RUN).map((s) => s.day), 'the newest days are closed from the first run').toEqual(Array.from({ length: MAX_SENDS_PER_RUN }, (_, i) => stuck + i));
    expect(mirror.sent.map((s) => s.day), 'and every one of them by the second').toEqual(Array.from({ length: LOOKBACK_DAYS }, (_, i) => stuck + i));
    expect(owed().filter((d) => d < stuck), 'every stuck day is still owed').toHaveLength(stuck);
  });

  it('a mirror whose reward clock differs from Base\'s closes no day, and says so until they match', async () => {
    mirror.launch = base.launch + 3600;
    await run(mirror);
    expect(mirror.sent, 'nothing closed').toEqual([]);
    expect(alerts(/this chain's reward clock \(day 0 starts .*\) differs from Base's/)).toHaveLength(1);
    openAlert(`dayclose-clock:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    mirror.launch = base.launch;
    await run(mirror);
    expect(mirror.sent.length).toBeGreaterThan(0);
    expect(openKeys()).not.toContain(`dayclose-clock:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('Base finalizes no day while a served expected mirror runs another reward clock', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE, MIRROR]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    mirror.launch = base.launch - 86_400;
    await run(base);
    expect(base.sent.map((s) => s.fn)).not.toContain('finalizeDay');
    expect(alerts(/chain 421614 \(day 0 starts .*\) run\(s\) a reward clock different from Base's/)).toHaveLength(1);
  });

  it('a mirror sends no pre-B4 report for a day Base has finalized, since Base would refuse it', async () => {
    base.finalized.add(1);
    mirror.sentAt.set(0, NOW - 86_400);
    mirror.sentAt.set(2, NOW - 86_400);
    mirror.quoteShapes = new Set([7, 5, 3]);
    await run(mirror);
    expect(mirror.sent, 'nothing sent for the finalized day').toEqual([]);
    expect(alerts(/closing the day \(closeDay\) for reward day 1 is refused \(Base has finalized this day or can finalize it now, and this chain's messenger cannot quote the B4 report/)).toHaveLength(1);
  });

  it('a mirror sends no pre-B4 report for a day Base can finalize now, though it has not', async () => {
    base.reported.set(0, new Set([BASE]));
    base.firstAt.set(0, NOW - GRACE); // grace has elapsed: anyone may finalize it before a report lands
    mirror.today = 1;
    mirror.quoteShapes = new Set([7, 5, 3]);
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(alerts(/reward day 0 is refused \(Base has finalized this day or can finalize it now/)).toHaveLength(1);
  });

  it('keeps a reward clock mismatch it has seen while the mirror cannot be read', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE, MIRROR]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    mirror.launch = base.launch - 86_400;
    await run(base);
    openAlert(`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    await dayCloseOnce(env, base.chainId, base.diamond, {
      client: base.client(),
      readClient: base.client(),
      context: () => base.ctx(),
      peer: (id) => (id === BASE ? base.peer() : null), // the mirror is no longer served
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(base.sent.map((s) => s.fn), 'still no finalization').not.toContain('finalizeDay');
    expect(openKeys(), 'the mismatch alert stands').toContain(`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    expect(alerts(/as last read; this run could not read it/)).toHaveLength(1);
  });

  it('a pre-B4 mirror does not close a day whose finalization on Base is unread, whatever else read', async () => {
    base.finalized.add(0);
    base.unreadable.add(MIRROR); // Base's record of this chain's report fails to read; its finalization reads
    mirror.today = 1;
    mirror.quoteShapes = new Set([7, 5, 3]);
    await run(mirror);
    expect(mirror.sent, 'Base finalized it, and that read stands on its own').toEqual([]);

    base.unreadable.clear();
    base.finalized.clear();
    await dayCloseOnce(env, mirror.chainId, mirror.diamond, {
      client: mirror.client(),
      readClient: mirror.client(),
      context: () => mirror.ctx(),
      peer: () => null, // this keeper does not serve Base
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(mirror.sent, 'unknown is not "not finalized"').toEqual([]);
    expect(alerts(/closes no reward day while the reward role of chain 84532, which this Diamond names as Base, is not known \(this keeper does not serve that chain/), 'a keeper that does not serve Base closes no day at all: its role cannot be read').toHaveLength(1);
  });

  it('holds a day whose broadcast landed for one destination while another it is owed was refused', async () => {
    finalizedDayZero();
    await run(base); // the day goes to the mirror
    base.expected = [BASE, MIRROR, OTHER, 56];
    base.destinations = [MIRROR, OTHER, 56]; // two more, each sent the day alone
    base.refuseToChain.set(56, 'DayNotReadyToFinalize');
    await run(base);
    expect(base.sent.slice(1), 'one destination landed').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: OTHER }]);
    expect(owed(), 'the refused destination still holds the day').toEqual([0]);
  });

  it('holds a day whose broadcast landed for one destination while another it is owed could not be quoted', async () => {
    finalizedDayZero();
    await run(base);
    base.expected = [BASE, MIRROR, OTHER, 56];
    base.destinations = [MIRROR, OTHER, 56];
    base.quoteUnreadTo.add(56); // unread, not refused: no refusal alert holds the day
    await run(base);
    expect(base.sent.slice(1), 'one destination landed').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: OTHER }]);
    expect(owed(), 'one send landing is not the broadcast done').toEqual([0]);
    expect(alerts(/did not try broadcasting the day \(broadcastGlobal\) this run for day 0 \(the fee of the send to chain 56 alone could not be read\)/), 'and the unread fee is said').toHaveLength(1);
  });

  const configured = () => new Map([[BASE, base.diamond as string], [MIRROR, mirror.diamond as string]]);

  it("closes, with a notice, an alert about a Diamond the chain no longer names, and does not judge it against the new one", async () => {
    const OLD = '0x00000000000000000000000000000000000000ee';
    openAlert(`dayclose-wire:${MIRROR}:${OLD}:all`);
    openAlert(`dayclose-dispatch:${MIRROR}:${OLD}:0`);
    openAlert(`dayclose-wire:${MIRROR}:all`); // names no Diamond
    await run(mirror);
    expect(openKeys(), "the chain's run judges only the Diamond it names").toHaveLength(3);
    await retireUnworkedAlerts(env, configured(), Date.now() + 60_000);
    expect(logged.some((l) => new RegExp(`old Diamond, closed: dayclose-dispatch:421614:${OLD}:0 \\(it is about Diamond ${OLD}, and this chain now names Diamond 0x0+c1`).test(l))).toBe(true);
    expect(logged.some((l) => /closed: dayclose-wire:421614:all \(it names no Diamond/.test(l))).toBe(true);
    expect(openKeys()).toEqual([]);
  });

  it("closes the old Diamond's alerts, its gate alert included, though the new Diamond's gate keeps failing", async () => {
    const OLD = '0x00000000000000000000000000000000000000ee';
    openAlert(`dayclose-gate:${MIRROR}:${OLD}:all`);
    openAlert(`dayclose-refused:${MIRROR}:${OLD}:mirror@84532:close:1`);
    mirror.roleUnread = true; // the new Diamond's gate fails every run
    await run(mirror);
    await retireUnworkedAlerts(env, configured(), Date.now() + 60_000);
    expect(logged.filter((l) => new RegExp(`old Diamond, closed: dayclose-[a-z]+:421614:${OLD}:`).test(l))).toHaveLength(2);
    expect(alerts(/is not working this chain's reward days: its reward role could not be read/), "the new Diamond's gate alert is raised").toHaveLength(1);
    expect(openKeys(), "none of the old Diamond's stands").toEqual([]);
  });

  it('clears a near-end grace warning once grace is lengthened', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.sentAt.set(0, NOW - 60);
    base.firstAt.set(0, NOW - 60);
    openAlert(`dayclose-waiting:${BASE}:0x00000000000000000000000000000000000000b1:canonical:0`);
    await run(base); // grace is far from its end: the old warning no longer holds
    expect(openKeys()).toEqual([]);
  });

  it('sends a day once when no destination can be confirmed, keeping its marker for the window', async () => {
    finalizedDayZero();
    base.destinations = [OTHER]; // not served by this keeper
    base.expected = [BASE, OTHER];
    base.reported.set(0, new Set([BASE, OTHER])); // as finalized: the mirror had no part in the day
    await run(base);
    await run(base);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'sent once, never again').toEqual(['broadcastGlobal']);
    expect(logged.some((l) => /broadcast-unconfirmed\(unserved destinations\)=0/.test(l))).toBe(true);
  });

  it('records a broadcast from its receipt, not from the list as read: a destination taken off before the send runs is still owed', async () => {
    finalizedDayZero();
    base.destinations = [MIRROR, OTHER]; // OTHER is not served by this keeper
    base.expected = [BASE, MIRROR, OTHER];
    base.reported.set(0, new Set([BASE, MIRROR, OTHER])); // all three in the day
    base.listAtSend = [MIRROR]; // OTHER leaves the list after the run reads it
    await run(base);
    expect(base.sent.map((s) => s.fn)).toEqual(['broadcastGlobal']);
    base.destinations = [MIRROR];
    base.listAtSend = null;
    await run(base);
    expect(base.sent.slice(1), 'OTHER never got the day, so it is sent it alone').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: OTHER }]);
  });

  it('re-sends to an unserved destination once the re-send interval has passed when no receipt showed the send leaving', async () => {
    finalizedDayZero();
    base.destinations = [OTHER]; // not served by this keeper
    base.expected = [BASE, OTHER];
    base.reported.set(0, new Set([BASE, OTHER])); // as finalized: the mirror had no part in the day
    base.receiptLost = true;
    await run(base);
    base.receiptLost = false;
    later(15 * 60);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'not repeated before the interval').toEqual(['broadcastGlobal']);
    expect(logged.some((l) => /broadcast-unproven\(unserved, no receipt seen\)=0:97/.test(l)), 'and said').toBe(true);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.slice(1), 're-sent (to the whole list, which is only OTHER), and this time its receipt shows it left').toEqual([{ fn: 'broadcastGlobal', day: 0, value: BROADCAST_FEE }]);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent, 'never again').toHaveLength(2);
  });

  it('recognizes a broadcast sent through a messenger governance rotated after the run read it', async () => {
    finalizedDayZero();
    base.destinations = [OTHER]; // not served by this keeper
    base.expected = [BASE, OTHER];
    base.reported.set(0, new Set([BASE, OTHER])); // as finalized: the mirror had no part in the day
    base.rotateTo = '0x0000000000000000000000000000000000000077';
    await run(base);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'the receipt shows it left: never sent again').toEqual(['broadcastGlobal']);
  });

  it('counts a broadcast as sent, unproven, when its receipt names a messenger this run cannot', async () => {
    finalizedDayZero();
    base.destinations = [OTHER];
    base.expected = [BASE, OTHER];
    base.reported.set(0, new Set([BASE, OTHER])); // as finalized: the mirror had no part in the day
    base.rotateTo = '0x0000000000000000000000000000000000000077';
    base.reporterConfigUnreadAtBlock = true;
    await run(base);
    base.reporterConfigUnreadAtBlock = false;
    later(15 * 60);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'not sent again at once: it may have reached every lane').toEqual(['broadcastGlobal']);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 're-sent after the interval, as unproven').toEqual(['broadcastGlobal', 'broadcastGlobal']);
  });

  it('keeps a day owed until its due alert is delivered, so a backlog day never takes an undelivered alert with it', async () => {
    mirror.today = LOOKBACK_DAYS + 3; // days 0..2 are older than the lookback
    mirror.deliverTo = base;
    for (let d = 3; d < mirror.today; d++) {
      mirror.sentAt.set(d, NOW - 86_400);
      base.reported.set(d, new Set([MIRROR]));
      base.finalized.add(d);
    }
    base.today = mirror.today;
    base.finalized.add(1); // without the mirror
    const late = () =>
      dayCloseOnce(env, mirror.chainId, mirror.diamond, {
        client: mirror.client(),
        readClient: mirror.client(),
        context: () => mirror.ctx(),
        peer: peers,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Date.now(), // the run's alert time is spent by the time it gets there
      });
    await late();
    expect(mirror.sent.map((s) => s.day), 'the backlog days are closed').toEqual([0, 1, 2]);
    expect(alerts(/Base finalized reward day 1 without this chain's report/), 'its alert not yet sent').toHaveLength(0);
    expect(owed(), 'day 1 stays owed for its alert; days 0 and 2 until Base finalizes them').toEqual([0, 1, 2]);
    base.finalized.add(0);
    base.finalized.add(2);
    later(60);
    await run(mirror);
    expect(alerts(/Base finalized reward day 1 without this chain's report/), 'raised in its next turn').toHaveLength(1);
    expect(owed(), 'and then it goes').toEqual([]);
  });

  it('closes its alerts for a chain that has left the reward set, and says so', async () => {
    openAlert(`dayclose-notexpected:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    openAlert(`dayclose-refused:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:close:3`);
    openAlert(`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`); // another chain's: untouched
    mirror.role = 2;
    await run(mirror);
    expect(mirror.sent).toEqual([]);
    expect(openKeys()).toEqual([`dayclose-clock:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`]);
    expect(logged.filter((l) => /reward role 2, closed: dayclose-/.test(l))).toHaveLength(2);
  });

  it('drops send markers whose day has left the window, so a backlog cannot hide a current one', async () => {
    finalizedDayZero();
    base.today = 61;
    for (let d = 0; d < 60; d++) {
      keeper.db
        .prepare(`INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, 'day_broadcast', ?, ?, ?, 0, 0)`)
        .run(BASE, `${base.diamond}:canonical`, String(d), d, JSON.stringify({ sentTo: { [MIRROR]: NOW } }));
    }
    // A current day already sent: its marker must still be seen.
    base.finalized.add(60);
    base.reported.set(60, new Set([BASE, MIRROR]));
    base.sentAt.set(60, NOW - 60);
    base.firstAt.set(60, NOW - 60);
    keeper.db
      .prepare(`INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, 'day_broadcast', '60', 60, ?, 9, 0)`)
      .run(BASE, `${base.diamond}:canonical`, JSON.stringify({ sentTo: { [MIRROR]: NOW } }));
    for (let d = 47; d < 60; d++) base.sentAt.set(d, NOW);
    // Every day before the lookback has been worked through.
    keeper.db
      .prepare(`INSERT INTO keeper_work_cursor (chain_id, diamond, kind, next_block, updated_at) VALUES (?, ?, 'day_close', 47, 0)`)
      .run(BASE, `${base.diamond.toLowerCase()}:canonical`);
    await run(base);
    expect(base.sent.filter((s) => s.day === 60), 'day 60 was already sent').toEqual([]);
    const left = keeper.db.prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE kind = 'day_broadcast' AND block < 47`).get();
    expect(left).toEqual({ n: 0 });
  });

  it('says when an expected mirror is not a broadcast destination, and clears it once it is', async () => {
    finalizedDayZero();
    base.destinations = [];
    await run(base);
    expect(alerts(/chain\(s\) 421614 are on Base's expected-source list but are not broadcast destinations/)).toHaveLength(1);
    openAlert(`dayclose-topology:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    base.destinations = [MIRROR];
    await run(base);
    expect(openKeys()).toEqual([]);
  });

  it('reads the topology even when it cannot send, and keeps its alerts open', async () => {
    base.today = 1;
    base.expected = [MIRROR];
    openAlert(`dayclose-selfmissing:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`);
    await dayCloseOnce(env, base.chainId, base.diamond, {
      client: base.client(),
      readClient: base.client(),
      context: () => null, // no signing key: the first send stops the run
      peer: peers,
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(openKeys(), 'not cleared on a run that sent nothing').toEqual([`dayclose-selfmissing:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`]);
  });

  it('names what the finalization zeroed from its own events, not from the read before it', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.sentAt.set(0, NOW - GRACE);
    base.firstAt.set(0, NOW - GRACE);
    base.landsAtFinalize.set(0, MIRROR); // the mirror's report lands just before finalization
    await run(base);
    expect(base.sent.map((s) => s.fn)).toContain('finalizeDay');
    expect(alerts(/finalized with expected reports missing/), 'nothing was zeroed').toEqual([]);
  });

  it('names the chains the finalization zeroed, though the expected-source list is replaced before the keeper sees it', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.firstAt.set(0, NOW - 60); // inside grace: the keeper waits, and sees the day open
    await run(base);
    expect(base.sent.map((s) => s.fn)).not.toContain('finalizeDay');
    base.finalizeByOther(0); // zeroes the mirror
    base.expected = [BASE, OTHER]; // the list is replaced afterwards
    await run(base);
    expect(logged.filter((l) => /notice: reward day 0: finalized without chain\(s\) 421614; their interest counts as zero for the day$/.test(l)), 'from the finalization itself').toHaveLength(1);
    expect(logged.filter((l) => /finalized without chain\(s\) 97/.test(l)), 'never the replacement').toEqual([]);
  });

  it("says a finalized day whose zeroed chains cannot be read is held, and clears once they are", async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.firstAt.set(0, NOW - 60); // inside grace: the keeper waits, and sees the day open
    await run(base);
    base.finalizeByOther(0); // zeroes the mirror
    base.logsUnread = true;
    const held = `dayclose-held:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`;
    await run(base);
    expect(alerts(/did not try recording and announcing the chains the day's finalization zeroed this run for day 0 \(the finalization's own events \(the log query failed\) could not be read\)/)).toHaveLength(1);
    expect(owed()).toContain(0);
    openAlert(held);
    base.logsUnread = false;
    later(60);
    await run(base);
    expect(logged.filter((l) => /notice: reward day 0: finalized without chain\(s\) 421614/.test(l))).toHaveLength(1);
    expect(openKeys()).not.toContain(held);
  });

  it('says a zeroed-day notice was judged against the list when the keeper never saw the day open', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.firstAt.set(0, NOW - 60);
    base.finalizeByOther(0); // before this keeper ever runs
    await run(base);
    expect(logged.filter((l) => /notice: reward day 0: finalized without chain\(s\) 421614; their interest counts as zero for the day \(judged against the expected-source list as read when first seen finalized/.test(l))).toHaveLength(1);
  });

  it('a mirror says Base finalized a day without it even when its report was sent', async () => {
    mirror.sentAt.set(0, NOW - GRACE);
    base.finalized.add(0);
    base.reported.set(0, new Set([BASE]));
    await run(mirror);
    expect(alerts(/Base finalized reward day 0 without this chain's report/)).toHaveLength(1);
  });

  it('prices the report on the newest shape the messenger has', async () => {
    mirror.quoteShapes = new Set([5, 3]); // a B1 messenger
    await run(mirror);
    expect(mirror.sent.map((s) => [s.fn, s.value])).toEqual([
      ['closeDay', LANE_FEE],
      ['closeDay', LANE_FEE],
      ['closeDay', LANE_FEE],
    ]);
    expect(alerts(/refused/)).toEqual([]);
  });
  it('says when a broadcast destination is not on the expected-source list', async () => {
    finalizedDayZero();
    base.destinations = [MIRROR, OTHER];
    await run(base);
    expect(alerts(/chain\(s\) 97 are broadcast destinations but not on Base's expected-source list, so Base refuses their reports/)).toHaveLength(1);
  });

  it('states an unread report as unread in the grace warning, never as missing', async () => {
    base.today = 1;
    base.expected = [BASE, MIRROR, OTHER];
    base.destinations = [MIRROR, OTHER];
    base.unreadable.add(MIRROR);
    later(GRACE - GRACE_WARNING_SEC);
    await run(base);
    const w = alerts(/reward day 0 /);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/is still missing 1 expected report\(s\): chain 97 /);
    expect(w[0]).toMatch(/could not be read this run for chain\(s\) 421614/);
  });

  it('keeps a zeroed-day notice queued until it is posted', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.sentAt.set(0, NOW - GRACE);
    base.firstAt.set(0, NOW - GRACE);
    await dayCloseOnce(env, base.chainId, base.diamond, {
      client: base.client(),
      readClient: base.client(),
      context: () => base.ctx(),
      peer: peers,
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: 0, // the alert window is already spent
    });
    expect(logged.some((l) => /notice: reward day 0: finalized without chain\(s\) 421614/.test(l)), 'journaled at once').toBe(true);
    expect(alerts(/finalized with expected reports missing/), 'not posted').toEqual([]);
    const queued = () => keeper.db.prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE kind = 'day_zeroed' AND payload LIKE '%"posted":false%'`).get();
    expect(queued()).toEqual({ n: 1 });
    await run(base);
    expect(alerts(/finalized with expected reports missing/), 'posted on the next run').toHaveLength(1);
    expect(queued()).toEqual({ n: 0 });
    await run(base);
    expect(alerts(/finalized with expected reports missing/), 'and never again').toHaveLength(1);
  });

  it('keeps an undelivered zeroed-day notice however old its day grows', async () => {
    base.today = 1;
    base.reported.set(0, new Set([BASE]));
    base.sentAt.set(0, NOW - GRACE);
    base.firstAt.set(0, NOW - GRACE);
    const spent = () =>
      dayCloseOnce(env, base.chainId, base.diamond, {
        client: base.client(),
        readClient: base.client(),
        context: () => base.ctx(),
        peer: peers,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: 0, // nothing can be posted
      });
    await spent();
    mirror.known.add(0); // everything else about the day is done
    base.today = LOOKBACK_DAYS + 5; // the day is now older than the lookback
    for (let d = 1; d < base.today; d++) {
      // and every later day is done too, so nothing else holds anything back
      base.sentAt.set(d, NOW);
      base.reported.set(d, new Set([BASE, MIRROR]));
      base.finalized.add(d);
      mirror.known.add(d);
    }
    later(LOOKBACK_DAYS * 86_400);
    await spent();
    const queued = () => keeper.db.prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE kind = 'day_zeroed' AND block = 0 AND payload LIKE '%"posted":false%'`).get();
    expect(queued(), 'its record outlives the lookback').toEqual({ n: 1 });
    await run(base);
    expect(alerts(/finalized with expected reports missing/), 'and is posted once the channel answers').toHaveLength(1);
    expect(queued()).toEqual({ n: 0 });
  });

  it("closes no day before Base's reward clock has ever been read, and says so until it is", async () => {
    base.launchUnread = true;
    await run(mirror);
    expect(mirror.sent, 'alignment is never assumed').toEqual([]);
    expect(alerts(/the reward clock of chain 84532 \(its clock has never been read \(the read failed\)\) is not known to this keeper/)).toHaveLength(1);
    expect(owed()).toEqual([0, 1, 2]);
    openAlert(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`); // as a delivered alert leaves it
    base.launchUnread = false;
    later(60);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day), 'closed once the clock reads as the same').toEqual([0, 1, 2]);
    expect(openKeys()).not.toContain(`dayclose-clockunknown:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });

  it('closes no day on a mirror whose keeper does not serve Base and has never read its clock', async () => {
    await dayCloseOnce(env, mirror.chainId, mirror.diamond, {
      client: mirror.client(),
      readClient: mirror.client(),
      context: () => mirror.ctx(),
      peer: (id) => (id === BASE ? null : peers(id)),
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(mirror.sent).toEqual([]);
    expect(alerts(/chain 84532 \(this keeper does not serve it and has never read its clock\)/)).toHaveLength(1);
  });

  it("finalizes no day while an expected mirror's reward clock is not known, and says so in the grace warning too", async () => {
    const other = new FakeDiamond(OTHER, '0x00000000000000000000000000000000000000d1', '0x00000000000000000000000000000000000000d2');
    base.today = 1;
    base.expected = [BASE, MIRROR, OTHER];
    base.destinations = [MIRROR, OTHER];
    base.sentAt.set(0, NOW - GRACE);
    base.reported.set(0, new Set([BASE, MIRROR]));
    base.firstAt.set(0, NOW - GRACE + GRACE_WARNING_SEC / 2);
    const runWith = (peer: (id: number) => PeerReader | null) =>
      dayCloseOnce(env, base.chainId, base.diamond, {
        client: base.client(),
        readClient: base.client(),
        context: () => base.ctx(),
        peer,
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Number.POSITIVE_INFINITY,
      });
    await runWith(peers); // chain 97 is not served: its clock has never been read
    expect(alerts(/the reward clock of chain 97 \(this keeper does not serve it and has never read its clock\) is not known/)).toHaveLength(1);
    expect(alerts(/reward day 0 is still missing 1 expected report\(s\): chain 97 .*This keeper finalizes no day while the reward clock of chain\(s\) 97 is not known; any other caller still can/)).toHaveLength(1);
    base.firstAt.set(0, NOW - GRACE); // grace has run out: the contract would finalize
    later(60);
    await runWith(peers);
    expect(base.sent.filter((s) => s.fn === 'finalizeDay'), 'an irreversible call waits for a known clock').toEqual([]);
    expect(owed()).toEqual([0]);
    later(60);
    await runWith((id) => (id === OTHER ? other.peer() : peers(id)));
    expect(base.sent.filter((s) => s.fn === 'finalizeDay').map((s) => s.day), 'finalized once every clock reads as Base\'s').toEqual([0]);
  });

  it('says once, and does not hold its day for, an unchecked dispatch whose outcome on Base cannot be learned here', async () => {
    mirror.today = 1;
    await run(mirror); // Base served: day 0 closed
    mirror.today = 2;
    mirror.rotateTo = '0x0000000000000000000000000000000000000099';
    later(60);
    await run(mirror); // day 1 closes through the rotated messenger, Base still served
    const unservedBase = () =>
      dayCloseOnce(env, mirror.chainId, mirror.diamond, {
        client: mirror.client(),
        readClient: mirror.client(),
        context: () => mirror.ctx(),
        peer: (id) => (id === BASE ? null : peers(id)),
        sendDeadline: Number.POSITIVE_INFINITY,
        runDeadline: Number.POSITIVE_INFINITY,
      });
    later(60);
    await unservedBase(); // Base no longer served: the dispatch's outcome cannot be learned
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1]);
    expect(alerts(/close of reward day 1 sent its report through messenger 0x0+99, .*This keeper does not serve Base, so the day's outcome cannot be learned here; this is said once and not followed/)).toHaveLength(1);
    expect(owed(), 'a statement, not a condition: it does not hold its day').not.toContain(1);
  });

  it('never takes Base as canonical from a record: a run that cannot read its role closes no day', async () => {
    mirror.today = 1;
    await run(mirror); // Base read as canonical; day 0 closed
    mirror.today = 2;
    base.roleUnread = true;
    later(60);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day), 'day 1 is held: Base could have been detached since').toEqual([0]);
    expect(alerts(/closes no reward day while the reward role of chain 84532, which this Diamond names as Base, is not known \(this run could not read it/)).toHaveLength(1);
    base.roleUnread = false;
    later(60);
    await run(mirror);
    expect(mirror.sent.map((s) => s.day), 'closed once read canonical again').toEqual([0, 1]);
  });

  it('works no day on a chain whose gate reads fail, says so in the gate alert, and leaves every other alert as it stands', async () => {
    const gate = `dayclose-gate:${MIRROR}:0x00000000000000000000000000000000000000c1:all`;
    const route = `dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`;
    openAlert(route);
    for (const fail of ['reporterConfigUnread', 'launchUnread', 'roleUnread'] as const) {
      mirror[fail] = true;
      warned.length = 0;
      // eslint-disable-next-line no-await-in-loop
      await run(mirror);
      expect(mirror.sent, `${fail}: nothing sent`).toEqual([]);
      expect(alerts(/reward day close: this keeper is not working this chain's reward days: .* could not be read/), `${fail}: said`).toHaveLength(1);
      expect(openKeys(), `${fail}: no other alert judged`).toContain(route);
      expect(owed(), `${fail}: no day entered or settled`).toEqual([]);
      mirror[fail] = false;
    }
    openAlert(gate); // as a delivered alert leaves it
    await run(mirror);
    expect(openKeys(), 'cleared on the first run that reads them all, and not taken for another role\'s alert').not.toContain(gate);
    expect(logged.some((l) => l.includes(`closed: ${gate}`)), 'nor closed with a notice').toBe(false);
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1, 2]);
  });

  it("works no day on a chain whose RPC answers for another chain, and reads such a peer as unreadable", async () => {
    mirror.namesItself = 1;
    await run(mirror);
    expect(mirror.sent, 'its own RPC: nothing sent').toEqual([]);
    expect(alerts(/names itself chain 1, so the RPC configured for chain 421614 answers for another chain/)).toHaveLength(1);
    mirror.namesItself = null;

    base.namesItself = 1;
    warned.length = 0;
    await run(mirror);
    expect(mirror.sent, "Base's RPC: every close is held, fail-closed").toEqual([]);
    expect(alerts(/read chain 84532 as unreadable this run, because the Diamond its RPC serves at 0x0+b1 names itself chain 1/)).toHaveLength(1);
    base.namesItself = null;

    finalizedDayZero();
    mirror.namesItself = 1;
    await run(base);
    expect(owed(), "and on Base a destination read through it is never confirmed holding the day").toContain(0);
    expect(alerts(/read chain 421614 as unreadable this run/)).toHaveLength(1);
  });

  it('works a Diamond moved between canonical and mirror afresh, closing the old role\'s alerts with a notice', async () => {
    const old = `dayclose-selfmissing:${BASE}:0x00000000000000000000000000000000000000b1:canonical:all`;
    openAlert(old);
    keeper.db
      .prepare(`INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, 'day_owed', '1', 1, 'null', 0, 0)`)
      .run(BASE, `${base.diamond}:canonical`);
    base.role = ROLE_MIRROR;
    await run(base);
    expect(
      logged.some((l) => l.includes(`closed: ${old} (it is about this Diamond's work as the canonical reward chain, and the Diamond now works as a mirror reporting to chain 84532 as its Base, whose days this keeper works afresh`)),
      'the old role\'s alert is not judged against the new role',
    ).toBe(true);
    expect(openKeys()).not.toContain(old);
    const rows = (scope: string) => (keeper.db.prepare(`SELECT item FROM keeper_work_open WHERE kind = 'day_owed' AND diamond = ? ORDER BY block`).all(scope) as { item: string }[]).map((r) => r.item);
    expect(rows(`${base.diamond}:canonical`), "the old role's ledger is left as it was").toEqual(['1']);
    expect(rows(`${base.diamond}:mirror@84532`), 'the new role enters its days afresh').toEqual(['0', '1', '2']);
  });

  it('works a mirror rebound to another Base afresh, and resumes the same work when it returns to the same Base', async () => {
    const route = (b: number) => `dayclose-wire:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@${b}:all`;
    openAlert(route(BASE));
    mirror.baseChain = OTHER; // rebound: its reports now go to another Base
    await run(mirror);
    expect(logged.some((l) => l.includes(`closed: ${route(BASE)} (it is about this Diamond's work as a mirror reporting to chain 84532 as its Base, and the Diamond now works as a mirror reporting to chain 97 as its Base`))).toBe(true);
    expect(mirror.sent, 'the new Base is not served: its role cannot be read, so nothing is closed').toEqual([]);
    mirror.baseChain = BASE;
    openAlert(route(BASE));
    await run(mirror);
    expect(openKeys(), 'back to the same Base: its alert is judged, not retired').not.toContain(route(BASE));
    expect(logged.filter((l) => l.includes(`closed: ${route(BASE)}`)), 'only the first was closed with a notice').toHaveLength(1);
    expect(mirror.sent.map((s) => s.day)).toEqual([0, 1, 2]);
  });

  it('closes, saying why, an open alert of a kind this pass no longer raises', async () => {
    openAlert(`dayclose-clockmoved:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
    await run(mirror);
    expect(logged.some((l) => /closed: dayclose-clockmoved:421614:0x00000000000000000000000000000000000000c1:mirror@84532:all \(this pass no longer raises this alert\)/.test(l))).toBe(true);
    expect(openKeys()).not.toContain(`dayclose-clockmoved:${MIRROR}:0x00000000000000000000000000000000000000c1:mirror@84532:all`);
  });
});
