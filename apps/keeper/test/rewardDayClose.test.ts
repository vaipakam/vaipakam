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
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Abi, type Address, type Log, type PublicClient } from 'viem';
import { RewardAggregatorFacetABI, RewardReporterFacetABI } from '@vaipakam/contracts/abis';
import {
  BROADCAST_LATE_AFTER_SEC,
  BROADCAST_RESEND_AFTER_SEC,
  GRACE_WARNING_SEC,
  LOOKBACK_DAYS,
  ROLE_CANONICAL,
  ROLE_MIRROR,
  dayCloseOnce,
  dayWindow,
  graceWarningSec,
  planBroadcast,
  planFinalize,
  type DestinationState,
  type FinalizeInput,
  type PeerReader,
} from '../src/rewardDayClose';
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
const NOW = Math.floor(T0 / 1000);

describe('the pure rules', () => {
  it('works the elapsed days of the last LOOKBACK_DAYS, oldest first, and nothing on day 0', () => {
    expect(dayWindow(0)).toEqual([]);
    expect(dayWindow(1)).toEqual([0]);
    expect(dayWindow(3)).toEqual([0, 1, 2]);
    expect(dayWindow(LOOKBACK_DAYS + 5)).toEqual(Array.from({ length: LOOKBACK_DAYS }, (_, i) => i + 5));
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
    it('never finalizes against the contract, before its own report, or against an empty list', () => {
      expect(planFinalize({ ...base, contractReady: false }, GRACE, NOW).kind).toBe('wait');
      expect(planFinalize({ ...base, ownReported: false }, GRACE, NOW)).toEqual({ kind: 'own-report-first' });
      expect(planFinalize({ ...base, expected: [], firstReportAt: NOW - GRACE }, GRACE, NOW)).toEqual({ kind: 'no-expected' });
      expect(planFinalize({ ...base, finalized: true }, GRACE, NOW)).toEqual({ kind: 'done' });
    });
  });

  describe('planBroadcast', () => {
    const d = (...s: [number, DestinationState][]) => new Map(s);
    it('sends a day never sent, unless every served destination already has it', () => {
      expect(planBroadcast(d([MIRROR, 'missing']), null, NOW)).toEqual({ kind: 'send', resend: false });
      expect(planBroadcast(d([MIRROR, 'unserved']), null, NOW)).toEqual({ kind: 'send', resend: false });
      expect(planBroadcast(d([MIRROR, 'received']), null, NOW)).toEqual({ kind: 'done' });
      expect(planBroadcast(d([MIRROR, 'received'], [OTHER, 'unserved']), null, NOW), 'an unserved one still needs the send').toEqual({ kind: 'send', resend: false });
    });
    it('once sent: done when no served destination lacks it; late, then re-sent, while one does', () => {
      expect(planBroadcast(d([MIRROR, 'received'], [OTHER, 'unserved']), NOW, NOW)).toEqual({ kind: 'done' });
      expect(planBroadcast(d([MIRROR, 'missing']), NOW, NOW)).toEqual({ kind: 'wait', late: false });
      expect(planBroadcast(d([MIRROR, 'missing']), NOW - BROADCAST_LATE_AFTER_SEC, NOW)).toEqual({ kind: 'wait', late: true });
      expect(planBroadcast(d([MIRROR, 'missing']), NOW - BROADCAST_RESEND_AFTER_SEC, NOW)).toEqual({ kind: 'send', resend: true });
      expect(planBroadcast(d([MIRROR, 'unread']), NOW - BROADCAST_RESEND_AFTER_SEC, NOW), 'an unread destination is judged next run').toEqual({ kind: 'wait', late: false });
      expect(planBroadcast(d([MIRROR, 'missing'], [OTHER, 'unread']), NOW - BROADCAST_RESEND_AFTER_SEC, NOW), 'an unread peer does not hold back a known-missing lane').toEqual({ kind: 'send', resend: true });
      expect(planBroadcast(d([MIRROR, 'missing'], [OTHER, 'unread']), NOW - BROADCAST_LATE_AFTER_SEC, NOW)).toEqual({ kind: 'wait', late: true });
      expect(planBroadcast(d(), null, NOW), 'no destinations').toEqual({ kind: 'done' });
    });
  });
});

// ─── whole runs against fake chains ─────────────────────────────────────────

const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
const ERRORS_ABI = [...REPORTER_ABI, ...(AGGREGATOR_ABI as Abi), { type: 'error', name: 'MessengerPredatesV3', inputs: [] }] as Abi;
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
  paused = false;
  sentAt = new Map<number, number>();
  finalized = new Set<number>();
  reported = new Map<number, Set<number>>();
  firstAt = new Map<number, number>();
  expected: number[] = [];
  known = new Set<number>();
  destinations: number[] = [];
  /** `fn:day` → error name a simulation reverts with. */
  refuse = new Map<string, string>();
  /** `quoteSendChainReport` arities the messenger has (the rest are unknown selectors). */
  quoteShapes = new Set([8, 7, 5, 3]);
  /** Single-destination quotes refuse with this, when set. */
  refuseTo: string | null = null;
  /** Reports that land between the pass's reads and its finalization, by day. */
  landsAtFinalize = new Map<number, number>();
  /** The messenger's destination list cannot be read. */
  destinationsUnreadable = false;
  /** Chains whose `isChainReported` read fails. */
  unreadable = new Set<number>();
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

  readContract = async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const d = args && args.length > 0 ? Number(args[0] as bigint) : -1;
    if (address === this.messenger) {
      if (functionName === 'quoteSendChainReport') {
        if (!this.quoteShapes.has(args?.length ?? 0)) throw new Error('execution reverted');
        return LANE_FEE;
      }
      if (functionName === 'getBroadcastDestinations') {
        if (this.destinationsUnreadable) throw new Error('execution reverted');
        return this.destinations.map(BigInt);
      }
      throw new Error(`unexpected messenger read ${functionName}`);
    }
    switch (functionName) {
      case 'getRewardRole':
        return this.role;
      case 'getInteractionCurrentDay':
        return [BigInt(this.today), this.active];
      case 'paused':
        return this.paused;
      case 'getRewardReporterConfig':
        return [this.messenger, this.chainId, BASE, this.role === ROLE_CANONICAL, BigInt(GRACE)];
      case 'getChainReportSentAt':
        return BigInt(this.sentAt.get(d) ?? 0);
      case 'isDayReadyToFinalize':
        return this.ready(d);
      case 'getDailyFirstReportAt':
        return BigInt(this.firstAt.get(d) ?? 0);
      case 'getExpectedSourceChainIds':
        return this.expected;
      case 'isChainReported':
        if (this.unreadable.has(Number(args![1]))) throw new Error('rpc down');
        return this.reported.get(d)?.has(Number(args![1])) ?? false;
      case 'getKnownGlobalInterestNumeraire18':
        return [0n, 0n, this.known.has(d)];
      case 'quoteBroadcastGlobal':
        return BROADCAST_FEE;
      case 'quoteBroadcastGlobalTo':
        if (this.refuseTo) throw revert(this.refuseTo, this.refuseTo === 'DestinationHasNoDayStanding' ? [BigInt(d), args![1]] : []);
        return BROADCAST_TO_FEE;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract(c) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    const day = Number(args[0] as bigint);
    const why = this.refuse.get(`${functionName}:${day}`);
    if (why === 'ChainReportFrontierShort') throw revert(why, [BigInt(day), 0n, 0n]);
    if (why) throw revert(why);
    return { result: undefined };
  };

  waitForTransactionReceipt = async () => {
    const logs = this.logs;
    this.logs = [];
    return { status: 'success', logs };
  };

  /** The state change a landed call makes. */
  apply(fn: string, day: number): void {
    if (fn === 'closeDay') {
      this.sentAt.set(day, NOW);
      if (this.role === ROLE_CANONICAL) {
        if (!this.reported.has(day)) this.reported.set(day, new Set());
        this.reported.get(day)!.add(this.chainId);
        if (!this.firstAt.has(day)) this.firstAt.set(day, NOW);
      }
    }
    if (fn === 'advanceInterestFrontiers') this.refuse.delete(`closeDay:${day}`);
    if (fn === 'finalizeDay') {
      const late = this.landsAtFinalize.get(day);
      if (late !== undefined) this.reported.get(day)?.add(late);
      this.finalized.add(day);
      for (const c of this.expected) {
        if (this.reported.get(day)?.has(c)) continue;
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
          this.sent.push(functionName === 'broadcastGlobalTo' ? { fn: functionName, day, value, to: Number(args[1] as bigint) } : { fn: functionName, day, value });
          this.apply(functionName, day);
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(logged.filter((l) => /notice: reward day 0: finalized at grace without chain\(s\) 421614/.test(l))).toHaveLength(1);
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
    expect(alerts(/broadcast of reward day 0 has not reached chain\(s\) 421614/)).toHaveLength(1);

    later(BROADCAST_RESEND_AFTER_SEC - BROADCAST_LATE_AFTER_SEC);
    openAlert(`dayclose-broadcast:${BASE}:0`);
    await run(base);
    expect(openKeys(), 'a re-send landing is not a delivery').toEqual([`dayclose-broadcast:${BASE}:0`]);
    expect(base.sent[1], 're-sent to the missing destination only').toEqual({ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR });

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
    await run(base);
    expect(alerts(/not on its own expected-source list/)).toHaveLength(1);
    openAlert(`dayclose-selfmissing:${BASE}:all`);
    base.expected = [BASE, MIRROR];
    await run(base);
    expect(openKeys()).toEqual([]);
  });

  it('names a refused call and clears the alert once it lands', async () => {
    mirror.refuse.set('closeDay:0', 'RewardMessengerNotSet');
    await run(mirror);
    expect(alerts(/closing the day \(closeDay\) for reward day 0 is refused \(RewardMessengerNotSet\)/)).toHaveLength(1);
    openAlert(`dayclose-refused:${MIRROR}:close:0`);
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
    openAlert(`dayclose-refused:${MIRROR}:advance:0`);
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
    expect(alerts(/broadcast destinations could not be read/)).toHaveLength(1);
    openAlert(`dayclose-destunread:${BASE}:all`);
    base.destinationsUnreadable = false;
    await run(base);
    expect(base.sent.map((s) => s.fn).slice(2), 'broadcast once the list reads').toEqual(['broadcastGlobal']);
    expect(openKeys()).toEqual([]);
  });

  it('keeps checking and re-sending to a destination taken off the list after a send that never reached it', async () => {
    finalizedDayZero();
    await run(base);
    base.destinations = []; // the mirror is taken off the messenger's list
    later(BROADCAST_LATE_AFTER_SEC);
    await run(base);
    expect(alerts(/broadcast of reward day 0 has not reached chain\(s\) 421614/), 'still lacking it, still late').toHaveLength(1);
    later(BROADCAST_RESEND_AFTER_SEC - BROADCAST_LATE_AFTER_SEC);
    await run(base);
    expect(base.sent.slice(1), 'healed alone, the way the contract admits').toEqual([{ fn: 'broadcastGlobalTo', day: 0, value: BROADCAST_TO_FEE, to: MIRROR }]);
  });

  it('says a destination taken off the list cannot be reached when the Diamond will not send to it alone', async () => {
    finalizedDayZero();
    await run(base);
    base.destinations = [];
    base.refuseTo = 'DestinationHasNoDayStanding';
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'no send to every destination: it would not reach this one').toEqual(['broadcastGlobal']);
    expect(alerts(/chain 421614 is no longer a broadcast destination and the Diamond will not send the day to it alone \(DestinationHasNoDayStanding\)/)).toHaveLength(1);
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

  it('sends a day once when no destination can be confirmed, keeping its marker for the window', async () => {
    finalizedDayZero();
    base.destinations = [OTHER]; // not served by this keeper
    base.expected = [BASE, OTHER];
    await run(base);
    await run(base);
    later(BROADCAST_RESEND_AFTER_SEC);
    await run(base);
    expect(base.sent.map((s) => s.fn), 'sent once, never again').toEqual(['broadcastGlobal']);
    expect(logged.some((l) => /broadcast-unconfirmed\(unserved destinations\)=0/.test(l))).toBe(true);
  });

  it('drops send markers whose day has left the window, so a backlog cannot hide a current one', async () => {
    finalizedDayZero();
    base.today = 61;
    for (let d = 0; d < 60; d++) {
      keeper.db
        .prepare(`INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, 'day_broadcast', ?, ?, ?, 0, 0)`)
        .run(BASE, base.diamond, String(d), d, JSON.stringify({ sentAt: NOW }));
    }
    // A current day already sent: its marker must still be seen.
    base.finalized.add(60);
    base.reported.set(60, new Set([BASE, MIRROR]));
    base.sentAt.set(60, NOW - 60);
    base.firstAt.set(60, NOW - 60);
    keeper.db
      .prepare(`INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, 'day_broadcast', '60', 60, ?, 9, 0)`)
      .run(BASE, base.diamond, JSON.stringify({ sentAt: NOW }));
    for (let d = 47; d < 60; d++) base.sentAt.set(d, NOW);
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
    openAlert(`dayclose-topology:${BASE}:all`);
    base.destinations = [MIRROR];
    await run(base);
    expect(openKeys()).toEqual([]);
  });

  it('reads the topology even when it cannot send, and keeps its alerts open', async () => {
    base.today = 1;
    base.expected = [MIRROR];
    openAlert(`dayclose-selfmissing:${BASE}:all`);
    await dayCloseOnce(env, base.chainId, base.diamond, {
      client: base.client(),
      readClient: base.client(),
      context: () => null, // no signing key: the first send stops the run
      peer: peers,
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
    expect(openKeys(), 'not cleared on a run that sent nothing').toEqual([`dayclose-selfmissing:${BASE}:all`]);
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
    expect(logged.some((l) => /notice: reward day 0: finalized at grace without chain\(s\) 421614/.test(l)), 'journaled at once').toBe(true);
    expect(alerts(/finalized with expected reports missing/), 'not posted').toEqual([]);
    const queued = () => keeper.db.prepare(`SELECT COUNT(*) AS n FROM keeper_work_open WHERE kind = 'day_zeroed'`).get();
    expect(queued()).toEqual({ n: 1 });
    await run(base);
    expect(alerts(/finalized with expected reports missing/), 'posted on the next run').toHaveLength(1);
    expect(queued()).toEqual({ n: 0 });
  });
});
