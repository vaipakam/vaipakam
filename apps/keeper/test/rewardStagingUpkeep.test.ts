/**
 * #3097 — the reward staging upkeep pass, against a fake Diamond that applies
 * the staging lifecycle's own admission rules to each call: records, claim
 * domains, legacy slices and priority windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type PublicClient,
} from 'viem';
import {
  ABI,
  MAX_PAGES_PER_SUBJECT,
  OP,
  PHASE,
  STAGING_RETRY_CADENCE,
  describeReport,
  domainKey,
  legacyRecordKey,
  pageEffect,
  recordMove,
  runRewardStagingUpkeep,
  stagingKey,
  stagingUpkeepOnce,
  type StagingRecordView,
  type StagingSource,
} from '../src/rewardStagingUpkeep';
import { listBatchContests, listOpenLegacySlices, listOpenStaging, type BatchContest, type OpenStaging } from '../src/db';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { Env } from '../src/env';
import { createSharedD1 } from './helpers/schemas';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const ALICE: Address = '0x00000000000000000000000000000000000000a1';
const BOB: Address = '0x00000000000000000000000000000000000000b2';
const NOW = 10_000_000n;
const ZERO32 = `0x${'0'.repeat(64)}`;

/** A log the Diamond would emit, encoded as a node returns it. */
function toLog(eventName: string, args: Record<string, unknown>, address: Address = DIAMOND) {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never);
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]));
  return { address, topics, data, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, blockHash: null, removed: false };
}

type Event = { name: string; args: Record<string, unknown> };

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

/** A fake record: its view, and how the fake moves it. */
interface Rec {
  view: StagingRecordView;
  /** Preparation pages still to scan. */
  scanLeft: number;
  /** Whether its day is covered at reservation. */
  covered: boolean;
  stale: boolean;
  /** The domain it belongs to, if any. */
  domain?: string;
  /** Pages its unwind takes. */
  unwindLeft: number;
  /** A priority take stages this much at the next preparation. */
  priority: bigint;
}

const recordView = (over: Partial<StagingRecordView> = {}): StagingRecordView => ({
  user: ALICE,
  side: 0,
  op: OP.claim,
  phase: PHASE.staging,
  day: 5n,
  openedAt: NOW - 3_600n,
  deadline: NOW + 2n * 86_400n,
  batchCount: 1n,
  resolveCursor: 0n,
  scanComplete: false,
  pendingOverflow: false,
  stagedFresh: 0n,
  ...over,
});

interface Dom {
  user: Address;
  side: number;
  phase: number;
  firstDay: bigint;
  lastDay: bigint;
  preparedThrough: bigint;
  reserveCursor: bigint;
  resolveCursor: bigint;
  deadline: bigint;
  covered: boolean;
  unwindLeft: number;
  /** Revalidation pages its reservation still takes (they move no field the
   *  view carries). */
  revalidateLeft?: number;
  /** Its revalidation finds a day record stale. */
  stale?: boolean;
}

interface Slice {
  phase: number;
  pagesLeft: number;
  consumeCursor: bigint;
  /** Further preparation pages its current wide day's record takes. */
  wideLeft?: number;
}

interface Window {
  closesAt: bigint;
  oldestKey: string;
  oldestOpenedAt: bigint;
  waiting: Set<string>;
}

class FakeDiamond {
  now = NOW;
  paused = false;
  records = new Map<string, Rec>();
  domains = new Map<string, Dom>();
  slices = new Map<bigint, Slice>();
  windows = new Map<string, Window>();
  priorityUsed = new Set<string>();
  sanctioned = new Set<string>();
  sent: string[] = [];
  /** Calls whose landed page changes nothing (a page the fake makes inert). */
  inert = new Set<string>();

  add(key: string, over: Partial<StagingRecordView> = {}, rec: Partial<Rec> = {}): string {
    this.records.set(key, { view: recordView(over), scanLeft: 1, covered: true, stale: false, unwindLeft: 1, priority: 0n, ...rec });
    return key;
  }

  private recordOf(key: string): Rec {
    const r = this.records.get(key);
    if (r === undefined || r.view.phase === PHASE.none) throw revert('StagingRecordUnknown', [key]);
    return r;
  }

  private stagingView(key: string): StagingRecordView {
    const r = this.records.get(key);
    return r === undefined ? recordView({ phase: PHASE.none, user: '0x0000000000000000000000000000000000000000', day: 0n, deadline: 0n, openedAt: 0n, batchCount: 0n }) : { ...r.view };
  }

  readContract = async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getStagingRecord':
        return this.stagingView(a[0]);
      case 'getStagingDomain': {
        const k = domainKey(a[0], Number(a[1]));
        const d = this.domains.get(k);
        if (d === undefined) return [ZERO32, 0, 0n, 0n, 0n, 0n, 0n, 0n, 0, 0n, 0n, 0n, 0n];
        return [k, d.phase, d.firstDay, d.lastDay, d.preparedThrough, d.reserveCursor, d.resolveCursor, 0n, 1, NOW - 100n, d.deadline, 1n, 1n];
      }
      case 'getLegacySliceDomain': {
        const s = this.slices.get(a[0]);
        if (s === undefined) return [ZERO32, 0, 0n, 0n, 0n, 0n, 0, 0n];
        return [`0x${'5'.repeat(64)}`, s.phase, 1n, 3n, 3n, s.consumeCursor, 1, 0n];
      }
      case 'getTransportBatchWindow': {
        const w = this.windows.get(a[0]);
        return w === undefined ? [0n, ZERO32, ZERO32, 0n, false, true] : [w.closesAt, ZERO32, w.oldestKey, w.oldestOpenedAt, false, false];
      }
      case 'isTransportBatchPriorityUsed':
        return this.priorityUsed.has(`${a[0]}/${a[1]}`);
      case 'isSanctionedAddress':
        return this.sanctioned.has(String(a[0]).toLowerCase());
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract(c) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  /** The contract's checks for `fn`; returns its effect and its result. */
  private admit(fn: string, args: readonly any[]): { apply: () => void; result: unknown; events?: Event[] } {
    const noop = { apply: () => {}, result: undefined };
    if (this.paused && fn !== 'unwindStagedDayPage') throw revert('EnforcedPause');
    if (this.inert.has(fn)) return { ...noop, result: fn === 'prepareStagedDay' ? [0n, 0n] : false };
    switch (fn) {
      case 'prepareStagedDay': {
        const key = args[0];
        const r = this.recordOf(key);
        if (r.view.phase !== PHASE.staging) throw revert('StagingPhaseInvalid', [key, r.view.phase]);
        if (r.view.pendingOverflow) throw revert('StagingPendingOverflow', [key]);
        if (r.stale) throw revert('RewardEntrySetMismatch', [7n]);
        const staged = r.priority;
        return {
          result: [staged, 0n],
          apply: () => {
            if (r.priority > 0n) {
              this.priorityUsed.add(`${[...this.windows.keys()][0]}/${key}`);
              r.priority = 0n;
              r.view.stagedFresh = BigInt(r.view.stagedFresh as bigint) + staged;
            }
            if (r.scanLeft > 0) r.scanLeft -= 1;
            r.view.scanComplete = r.scanLeft === 0;
            r.view.listCountSeen = BigInt((r.view.listCountSeen as bigint | undefined) ?? 0n) + 1n;
          },
        };
      }
      case 'reserveStagedDay': {
        const key = args[0];
        const r = this.recordOf(key);
        if (r.domain !== undefined) throw revert('StagingRecordInDomain', [key, r.domain]);
        if (r.view.phase !== PHASE.staging) throw revert('StagingPhaseInvalid', [key, r.view.phase]);
        if (!r.view.scanComplete) throw revert('StagingScanIncomplete', [key]);
        if (!r.covered) throw revert('StagingNotCovered', [key]);
        return { result: undefined, apply: () => void (r.view.phase = PHASE.reserved) };
      }
      case 'resolveStagedDayPage': {
        const key = args[0];
        const r = this.recordOf(key);
        if (r.domain !== undefined) throw revert('StagingRecordInDomain', [key, r.domain]);
        if (r.view.phase !== PHASE.reserved && r.view.phase !== PHASE.resolving) throw revert('StagingPhaseInvalid', [key, r.view.phase]);
        const v = r.view;
        if (v.phase === PHASE.reserved && r.stale) {
          // The first page revalidates and unwinds a stale record at once.
          return {
            result: r.unwindLeft <= 1,
            events: [{ name: 'StagingRecordStale', args: { key, entryId: 7n } }],
            apply: () => {
              r.unwindLeft -= 1;
              v.phase = r.unwindLeft <= 0 ? PHASE.none : PHASE.unwinding;
            },
          };
        }
        if (BigInt(v.resolveCursor) < BigInt(v.batchCount) || v.phase === PHASE.reserved) {
          return {
            result: false,
            apply: () => {
              v.phase = PHASE.resolving;
              v.resolveCursor = BigInt(v.resolveCursor) + 1n;
            },
          };
        }
        if (v.op === OP.claim && this.sanctioned.has(String(v.user).toLowerCase())) return { ...noop, result: false };
        return { result: true, apply: () => void (v.phase = PHASE.none) };
      }
      case 'unwindStagedDayPage': {
        const key = args[0];
        const r = this.recordOf(key);
        if (r.view.phase === PHASE.resolving) throw revert('StagingPhaseInvalid', [key, r.view.phase]);
        if (r.view.phase !== PHASE.unwinding && !r.stale && this.now < BigInt(r.view.deadline)) throw revert('StagingNotExpired', [key, r.view.deadline]);
        return {
          result: r.unwindLeft <= 1,
          apply: () => {
            r.unwindLeft -= 1;
            r.view.phase = r.unwindLeft <= 0 ? PHASE.none : PHASE.unwinding;
          },
        };
      }
      case 'registerForBatchWindow': {
        const [key, batchId] = args;
        const r = this.recordOf(key);
        if (r.view.phase !== PHASE.staging) throw revert('StagingPhaseInvalid', [key, r.view.phase]);
        if (this.priorityUsed.has(`${batchId}/${key}`)) throw revert('StagingPriorityUsed', [key, batchId]);
        const w = this.windows.get(batchId);
        if (w === undefined || !w.waiting.has(key)) throw revert('StagingNotWaiting', [key, batchId]);
        if (w.closesAt === 0n || this.now >= w.closesAt) throw revert('TransportBatchWindowNotOpen', [batchId]);
        return {
          result: undefined,
          apply: () => {
            if (w.oldestKey === ZERO32 || BigInt(r.view.openedAt) < w.oldestOpenedAt) {
              w.oldestKey = key;
              w.oldestOpenedAt = BigInt(r.view.openedAt);
            }
          },
        };
      }
      case 'reserveDomainPage': {
        const dk = args[0];
        const d = this.domains.get(dk)!;
        if (d.phase !== 1 && d.phase !== 2) throw revert('StagingDomainPhaseInvalid', [dk, d.phase]);
        if (d.preparedThrough < d.lastDay) throw revert('StagingDomainNotPrepared', [dk, d.preparedThrough, d.lastDay]);
        for (const [key, r] of this.records) {
          if (r.domain === dk && r.view.phase === PHASE.staging && !r.view.scanComplete) throw revert('StagingScanIncomplete', [key]);
        }
        if ((d.revalidateLeft ?? 0) > 0) {
          return {
            result: false,
            apply: () => {
              d.phase = 2;
              d.revalidateLeft! -= 1;
            },
          };
        }
        if (d.stale) {
          return { result: false, events: [{ name: 'StagingDomainPhase', args: { domainKey: dk, phase: 4 } }], apply: () => void (d.phase = 4) };
        }
        if (!d.covered) {
          const at = d.phase === 1 ? d.firstDay : d.reserveCursor;
          return {
            result: false,
            events: [{ name: 'StagingDomainReserveStopped', args: { domainKey: dk, day: at } }],
            apply: () => {
              d.phase = 2;
              d.reserveCursor = at;
            },
          };
        }
        return {
          result: true,
          apply: () => {
            d.phase = 3;
            d.reserveCursor = d.lastDay + 1n;
          },
        };
      }
      case 'resolveDomainPage': {
        const dk = args[0];
        const d = this.domains.get(dk)!;
        if (d.phase !== 3) throw revert('StagingDomainPhaseInvalid', [dk, d.phase]);
        return {
          result: d.resolveCursor >= d.lastDay,
          apply: () => {
            d.resolveCursor += 1n;
            if (d.resolveCursor > d.lastDay) this.domains.delete(dk);
          },
        };
      }
      case 'unwindDomainPage': {
        const dk = args[0];
        const d = this.domains.get(dk)!;
        if (d.phase === 3) throw revert('StagingDomainPhaseInvalid', [dk, d.phase]);
        if (d.phase !== 4 && this.now < d.deadline) throw revert('StagingDomainNotExpired', [dk, d.deadline]);
        return {
          result: d.unwindLeft <= 1,
          apply: () => {
            d.unwindLeft -= 1;
            if (d.unwindLeft <= 0) this.domains.delete(dk);
            else d.phase = 4;
          },
        };
      }
      case 'stepLegacySlice': {
        const id = args[0];
        const s = this.slices.get(id);
        if (s === undefined || s.phase !== 1) throw revert('LegacySliceNotPending', [id]);
        if ((s.wideLeft ?? 0) > 0) {
          // A wide day: one more preparation page of its record, and no field
          // of the slice moves.
          const rk = legacyRecordKey(`0x${'5'.repeat(64)}`, s.consumeCursor);
          return {
            result: false,
            apply: () => {
              s.wideLeft! -= 1;
              const r = this.records.get(rk) ?? this.records.get(this.add(rk, { op: OP.legacySlice }))!;
              r.view.listCountSeen = BigInt((r.view.listCountSeen as bigint | undefined) ?? 0n) + 1n;
            },
          };
        }
        return {
          result: s.pagesLeft <= 1,
          apply: () => {
            s.pagesLeft -= 1;
            s.consumeCursor += 1n;
            if (s.pagesLeft <= 0) s.phase = 3;
          },
        };
      }
      default:
        throw new Error(`unexpected call ${fn}`);
    }
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => ({ result: this.admit(functionName, args as any[]).result });

  /** eth_simulateV1, as the previews read it: the page's logs. */
  previews: string[] = [];
  simulateCalls = async ({ calls }: { calls: { data: `0x${string}` }[] }) => ({
    results: calls.map((c) => {
      const { functionName, args = [] } = decodeFunctionData({ abi: ABI, data: c.data });
      this.previews.push(functionName);
      try {
        const a = this.admit(functionName, args as any[]);
        return { status: 'success' as const, logs: (a.events ?? []).map((e) => toLog(e.name, e.args)) };
      } catch (error) {
        return { status: 'failure' as const, error };
      }
    }),
  });

  getChainId = async () => CHAIN;
  getBlockNumber = async () => 120n;
  getBlock = async () => ({ number: 120n, timestamp: this.now });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: [], blockNumber: 121n });

  client(): PublicClient {
    return this as unknown as PublicClient;
  }

  ctx(): KeeperContext {
    return {
      client: this.client(),
      diamond: DIAMOND,
      chainId: CHAIN,
      notAfterMs: Number.POSITIVE_INFINITY,
      wallet: {
        account: { address: KEEPER },
        writeContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
          this.admit(functionName, args as any[]).apply();
          this.sent.push(`${functionName}(${(args as unknown[]).map((x) => (typeof x === 'string' ? x.slice(0, 6) : String(x))).join(',')})`);
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

class FakeSource implements StagingSource {
  openRows: OpenStaging[] = [];
  sliceIds: bigint[] = [];
  contestRows: BatchContest[] = [];
  async open() {
    return this.openRows;
  }
  async legacySlices() {
    return this.sliceIds;
  }
  async contests() {
    return this.contestRows;
  }
  record(key: string, user: Address = ALICE, pos = 1): void {
    this.openRows.push({ what: 'record', key, user: user.toLowerCase(), pos });
  }
  domain(key: string, user: Address = ALICE, pos = 1): void {
    this.openRows.push({ what: 'domain', key, user: user.toLowerCase(), pos });
  }
}

const K1 = stagingKey(ALICE, 0, 5n);
const K2 = stagingKey(BOB, 0, 6n);

describe('recordMove', () => {
  it('reads the next step from the record alone', () => {
    expect(recordMove(recordView())).toEqual({ kind: 'prepare' });
    expect(recordMove(recordView({ scanComplete: true }))).toEqual({ kind: 'reserve' });
    expect(recordMove(recordView({ phase: PHASE.reserved }))).toEqual({ kind: 'resolve', payoutOnly: false });
    expect(recordMove(recordView({ phase: PHASE.resolving, resolveCursor: 1n }))).toEqual({ kind: 'resolve', payoutOnly: true });
    expect(recordMove(recordView({ phase: PHASE.unwinding })).kind).toBe('unwind');
    expect(recordMove(recordView({ pendingOverflow: true })).kind).toBe('unwind');
    expect(recordMove(recordView({ phase: PHASE.none }))).toEqual({ kind: 'gone' });
    expect(recordMove(recordView({ op: OP.legacySlice })), "a slice's record is the slice's").toEqual({ kind: 'in-domain' });
  });
});

describe('pageEffect', () => {
  const k = `0x${'1'.repeat(64)}`;
  it("reads an unwind and a reservation stop from the Diamond's own logs about the subject", () => {
    expect(pageEffect(DIAMOND, [toLog('StagingRecordStale', { key: k, entryId: 1n })] as never, k).unwinds).toBe(true);
    expect(pageEffect(DIAMOND, [toLog('StagingDomainPhase', { domainKey: k, phase: 4 })] as never, k).unwinds).toBe(true);
    expect(pageEffect(DIAMOND, [toLog('StagingDomainPhase', { domainKey: k, phase: 2 })] as never, k).unwinds, 'another phase').toBe(false);
    expect(pageEffect(DIAMOND, [toLog('StagingDomainReserveStopped', { domainKey: k, day: 9n })] as never, k).reserveStoppedAt).toBe(9n);
    expect(pageEffect(DIAMOND, [toLog('StagingRecordStale', { key: `0x${'2'.repeat(64)}`, entryId: 1n })] as never, k).unwinds, 'another subject').toBe(false);
    expect(pageEffect(DIAMOND, [toLog('StagingRecordStale', { key: k, entryId: 1n }, BOB)] as never, k).unwinds, 'another contract').toBe(false);
  });
});

describe('runRewardStagingUpkeep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing while disarmed, and says which flag is unset', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const env = { KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}` } as unknown as Env;
    await runRewardStagingUpkeep(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toEqual(['[keeper] rewardStagingUpkeep skipped: REWARD_STAGING_UPKEEP_ENABLED unset']);
  });
});

describe('a run', () => {
  let d: FakeDiamond;
  let src: FakeSource;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    d = new FakeDiamond();
    src = new FakeSource();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { unwind?: boolean } = {}) =>
    stagingUpkeepOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      source: src,
      cursors,
      visit: 0,
      unwind: opts.unwind,
    });

  describe('standalone records', () => {
    it('prepares, reserves and resolves a record in order, and closes it', async () => {
      d.add(K1, { batchCount: 0n });
      src.record(K1);
      const r = await run();
      expect(d.sent).toEqual([`prepareStagedDay(${K1.slice(0, 6)})`, `reserveStagedDay(${K1.slice(0, 6)})`, `resolveStagedDayPage(${K1.slice(0, 6)})`]);
      expect(r.landed.get('resolveStagedDayPage')).toBe(1);
      expect(d.records.get(K1)!.view.phase, 'not yet paid: one page per subject is left').toBe(PHASE.resolving);
      // The next run pays it.
      const r2 = await run();
      expect(d.records.get(K1)!.view.phase).toBe(PHASE.none);
      expect(r2.closed).toEqual([`record ${K1.slice(0, 10)}…`]);
      expect(describeReport(r2)).toContain('closed=record');
    });

    it('caps the pages one record may take in a run', async () => {
      d.add(K1, { batchCount: 5n, scanComplete: true, phase: PHASE.reserved });
      src.record(K1);
      await run();
      expect(d.sent).toHaveLength(MAX_PAGES_PER_SUBJECT);
    });

    it('waits on a day not covered before its deadline, and unwinds it after only with the unwinds armed', async () => {
      d.add(K1, { scanComplete: true }, { covered: false, unwindLeft: 2 });
      src.record(K1);
      let r = await run({ unwind: true });
      expect(d.sent).toEqual([]);
      expect(r.waiting[0].what).toMatch(/not covered yet/);
      d.now = NOW + 3n * 86_400n;
      r = await run();
      expect(d.sent, 'unwinds off: nothing sent').toEqual([]);
      expect(describeReport(r)).toMatch(/unwind-due=record .*past its deadline with its day not covered.*REWARD_STAGING_UNWIND_ENABLED not armed/);
      r = await run({ unwind: true });
      expect(d.sent).toEqual([`unwindStagedDayPage(${K1.slice(0, 6)})`, `unwindStagedDayPage(${K1.slice(0, 6)})`]);
      expect(r.closed).toEqual([`record ${K1.slice(0, 10)}…`]);
    });

    it("unwinds a record the contract finds stale at once, whatever its deadline", async () => {
      d.add(K1, {}, { stale: true });
      src.record(K1);
      await run({ unwind: true });
      expect(d.sent).toEqual([`unwindStagedDayPage(${K1.slice(0, 6)})`]);
      expect(d.records.get(K1)!.view.phase).toBe(PHASE.none);
    });

    it("routes a reserved record's stale first page to the unwind step, behind its flag (Codex #3145 r1)", async () => {
      d.add(K1, { phase: PHASE.reserved, scanComplete: true }, { stale: true });
      src.record(K1);
      let r = await run();
      expect(d.sent, 'its resolution page would unwind it: not sent with the unwinds off').toEqual([]);
      expect(r.unwindsHeld[0].what).toBe('the contract finds it stale');
      r = await run({ unwind: true });
      expect(d.sent).toEqual([`unwindStagedDayPage(${K1.slice(0, 6)})`]);
      expect(r.landed.get('unwindStagedDayPage')).toBe(1);
    });

    it('works a record on a gap day of a domain that does not hold it (Codex #3145 r1)', async () => {
      const DK = domainKey(ALICE, 0);
      d.domains.set(DK, { user: ALICE, side: 0, phase: 1, firstDay: 4n, lastDay: 6n, preparedThrough: 5n, reserveCursor: 0n, resolveCursor: 0n, deadline: NOW + 86_400n, covered: true, unwindLeft: 1 });
      d.add(K1, { day: 5n, batchCount: 0n });
      src.domain(DK);
      src.record(K1);
      await run();
      expect(d.sent).toEqual([`prepareStagedDay(${K1.slice(0, 6)})`, `reserveStagedDay(${K1.slice(0, 6)})`, `resolveStagedDayPage(${K1.slice(0, 6)})`]);
    });

    it("leaves a domain's own record to the domain on the contract's word, and asks again only when it moves", async () => {
      const DK = domainKey(ALICE, 0);
      d.add(K1, { day: 5n, scanComplete: true }, { domain: DK });
      src.record(K1);
      let r = await run();
      expect(d.sent).toEqual([]);
      expect(r.left[0].what).toMatch(/claim domain/);
      const before = d.previews.length;
      r = await run();
      expect(r.waiting[0].what).toBe('recorded idle at this state');
      expect(d.previews.length).toBe(before);
    });

    it('continues an unwind under way, and never unwinds a resolving record', async () => {
      d.add(K1, { phase: PHASE.unwinding }, { unwindLeft: 1 });
      d.add(K2, { phase: PHASE.resolving, resolveCursor: 0n, batchCount: 2n, user: BOB });
      src.record(K1);
      src.record(K2, BOB);
      d.now = NOW + 9n * 86_400n;
      await run({ unwind: true });
      expect(d.sent.filter((s) => s.startsWith('unwind'))).toEqual([`unwindStagedDayPage(${K1.slice(0, 6)})`]);
      // Two batch pages, then the completing page: the record resolves, never unwinds.
      expect(d.sent.filter((s) => s.startsWith('resolve'))).toHaveLength(3);
      expect(d.records.get(K2)!.view.phase).toBe(PHASE.none);
    });

    it("leaves a held claim payout to the sanctions-hold pass, and pays an unflagged one", async () => {
      d.add(K1, { phase: PHASE.resolving, resolveCursor: 1n, batchCount: 1n });
      d.add(K2, { phase: PHASE.resolving, resolveCursor: 1n, batchCount: 1n, user: BOB });
      d.sanctioned.add(ALICE.toLowerCase());
      src.record(K1);
      src.record(K2, BOB);
      const r = await run();
      expect(d.sent).toEqual([`resolveStagedDayPage(${K2.slice(0, 6)})`]);
      expect(r.left[0]).toEqual({ subject: `record ${K1.slice(0, 10)}…`, what: expect.stringMatching(/sanctions screen flags.*rewardSanctionsHold/) });
    });

    it('records a page that changed nothing idle, skips it while its state stands, and retries it after a day', async () => {
      d.add(K1);
      d.inert.add('prepareStagedDay');
      src.record(K1);
      let r = await run();
      expect(d.sent).toHaveLength(1);
      expect(r.idle).toEqual([`record ${K1.slice(0, 10)}…`]);
      r = await run();
      expect(d.sent, 'not tried again at the same state').toHaveLength(1);
      expect(r.waiting[0].what).toBe('recorded idle at this state');
      d.now = NOW + STAGING_RETRY_CADENCE;
      await run();
      expect(d.sent, 'retried after a day').toHaveLength(2);
    });

    it('stops the run on a pause, said apart', async () => {
      d.add(K1);
      d.paused = true;
      src.record(K1);
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.stopped).toBe('EnforcedPause');
    });
  });

  describe('claim domains', () => {
    const DK = domainKey(ALICE, 0);
    const day = (n: bigint) => stagingKey(ALICE, 0, n);

    const domain = (over: Partial<Dom> = {}) =>
      d.domains.set(DK, { user: ALICE, side: 0, phase: 1, firstDay: 5n, lastDay: 6n, preparedThrough: 6n, reserveCursor: 5n, resolveCursor: 5n, deadline: NOW + 86_400n, covered: true, unwindLeft: 1, ...over });

    it("prepares the day record the reservation asks for, reserves, then resolves, and never works the domain's records alone", async () => {
      domain();
      d.add(day(5n), { day: 5n }, { domain: DK, scanLeft: 1 });
      d.add(day(6n), { day: 6n, scanComplete: true }, { domain: DK, scanLeft: 0 });
      src.domain(DK);
      src.record(day(5n));
      src.record(day(6n));
      await run();
      expect(d.sent).toEqual([`prepareStagedDay(${day(5n).slice(0, 6)})`, `reserveDomainPage(${DK.slice(0, 6)})`, `resolveDomainPage(${DK.slice(0, 6)})`]);
    });

    it('waits on its claimant while its days are not prepared, then unwinds it past its deadline', async () => {
      domain({ preparedThrough: 5n });
      src.domain(DK);
      let r = await run({ unwind: true });
      expect(d.sent).toEqual([]);
      expect(r.waiting[0].what).toMatch(/prepared it through day 5 of 6/);
      d.now = NOW + 2n * 86_400n;
      r = await run({ unwind: true });
      expect(d.sent).toEqual([`unwindDomainPage(${DK.slice(0, 6)})`]);
      expect(r.closed).toEqual([`domain ${DK.slice(0, 10)}…`]);
    });

    it("sends no reservation the contract would stop on its first day, and unwinds past the deadline only on that stop", async () => {
      domain({ covered: false });
      src.domain(DK);
      let r = await run({ unwind: true });
      expect(d.sent).toEqual([]);
      expect(r.waiting[0].what).toMatch(/day 5 is not covered yet/);
      d.now = NOW + 2n * 86_400n;
      r = await run({ unwind: true });
      expect(d.sent).toEqual([`unwindDomainPage(${DK.slice(0, 6)})`]);
      expect(d.domains.has(DK)).toBe(false);
    });

    it('carries a revalidation through pages its view does not show, and never reads them as a stop (Codex #3145 r1)', async () => {
      domain({ phase: 2, revalidateLeft: 2, deadline: NOW - 1n });
      src.domain(DK);
      const r = await run({ unwind: true });
      expect(d.sent).toEqual([`reserveDomainPage(${DK.slice(0, 6)})`, `reserveDomainPage(${DK.slice(0, 6)})`, `reserveDomainPage(${DK.slice(0, 6)})`]);
      expect(d.domains.get(DK)!.phase, 'revalidated and reserved, not unwound').toBe(3);
      expect(r.idle).toEqual([]);
    });

    it("routes a reservation whose revalidation unwinds the domain to the unwind step, behind its flag", async () => {
      domain({ stale: true });
      src.domain(DK);
      let r = await run();
      expect(d.sent).toEqual([]);
      expect(r.unwindsHeld[0].what).toBe('the contract finds a day record stale');
      r = await run({ unwind: true });
      expect(d.sent[0]).toBe(`reserveDomainPage(${DK.slice(0, 6)})`);
      expect(d.domains.get(DK)?.phase ?? 0, 'unwinding or cleared').not.toBe(1);
    });

    it("leaves a resolving domain whose next payout is a flagged claimant's", async () => {
      domain({ phase: 3 });
      d.add(day(5n), { day: 5n, phase: PHASE.resolving, resolveCursor: 1n, batchCount: 1n }, { domain: DK });
      d.sanctioned.add(ALICE.toLowerCase());
      src.domain(DK);
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.left[0].what).toMatch(/rewardSanctionsHold/);
    });
  });

  describe('legacy slices', () => {
    it('steps a pending slice until it is consumed', async () => {
      d.slices.set(12n, { phase: 1, pagesLeft: 2, consumeCursor: 1n });
      d.slices.set(13n, { phase: 3, pagesLeft: 0, consumeCursor: 3n });
      src.sliceIds = [12n, 13n];
      const r = await run();
      expect(d.sent).toEqual(['stepLegacySlice(12)', 'stepLegacySlice(12)']);
      expect(r.closed).toEqual(['slice 12']);
    });

    it("counts a wide day's record moving as progress, though the slice's own fields stand (Codex #3145 r1)", async () => {
      d.slices.set(12n, { phase: 1, pagesLeft: 1, consumeCursor: 2n, wideLeft: 2 });
      src.sliceIds = [12n];
      const r = await run();
      expect(d.sent).toEqual(['stepLegacySlice(12)', 'stepLegacySlice(12)', 'stepLegacySlice(12)']);
      expect(r.idle).toEqual([]);
      expect(r.closed).toEqual(['slice 12']);
    });
  });

  describe('priority windows', () => {
    const B = `0x${'b'.repeat(64)}`;

    it('registers a waiting record when that makes it the oldest registrant, and not again', async () => {
      d.add(K1, { scanComplete: true }, { covered: false });
      d.windows.set(B, { closesAt: NOW + 3_600n, oldestKey: ZERO32, oldestOpenedAt: 0n, waiting: new Set([K1]) });
      src.record(K1, ALICE, 1);
      src.contestRows = [{ batchId: B, key: K1, pos: 2 }];
      await run();
      expect(d.sent).toEqual([`registerForBatchWindow(${K1.slice(0, 6)},${B.slice(0, 6)})`]);
      await run();
      expect(d.sent, 'already the oldest: a second registration would change nothing').toHaveLength(1);
    });

    it("ignores a finding from before the record's latest opening", async () => {
      d.add(K1, { scanComplete: true }, { covered: false });
      d.windows.set(B, { closesAt: NOW + 3_600n, oldestKey: ZERO32, oldestOpenedAt: 0n, waiting: new Set([K1]) });
      src.record(K1, ALICE, 5);
      src.contestRows = [{ batchId: B, key: K1, pos: 2 }];
      await run();
      expect(d.sent).toEqual([]);
    });

    it('takes the oldest registrant\'s priority right once the window closes, only when it stages something', async () => {
      d.add(K1, { scanComplete: true }, { covered: false, priority: 0n });
      d.windows.set(B, { closesAt: NOW - 60n, oldestKey: K1, oldestOpenedAt: NOW - 3_600n, waiting: new Set([K1]) });
      src.record(K1, ALICE, 1);
      src.contestRows = [{ batchId: B, key: K1, pos: 2 }];
      let r = await run();
      expect(d.sent).toEqual([]);
      expect(r.waiting.map((w) => w.what)).toContain('its priority take would stage nothing at the current block');
      d.records.get(K1)!.priority = 40n;
      r = await run();
      expect(d.sent).toEqual([`prepareStagedDay(${K1.slice(0, 6)})`]);
    });
  });
});

describe('the D1 reads, on the real schema', () => {
  const ev = (h: ReturnType<typeof createSharedD1>, kind: string, block: number, args: Record<string, unknown>) =>
    h.db
      .prepare(`INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at) VALUES (?, ?, 0, ?, ?, ?, 0)`)
      .run(CHAIN, block, `0x${block.toString(16).padStart(64, '0')}`, kind, JSON.stringify(args));

  it('lists open records and domains, open legacy slices, and contest findings', async () => {
    const h = createSharedD1();
    const a = ALICE.toLowerCase();
    const k1 = `0x${'1'.repeat(64)}`;
    const k2 = `0x${'2'.repeat(64)}`;
    const dk = `0x${'d'.repeat(64)}`;
    ev(h, 'StagingRecordOpened', 10, { key: k1, user: a });
    ev(h, 'StagingRecordOpened', 11, { key: k2, user: a });
    ev(h, 'StagingRecordClosed', 12, { key: k2, paid: true });
    ev(h, 'StagingDomainOpened', 13, { domainKey: dk, user: a });
    ev(h, 'LegacySliceDomainOpened', 14, { entryId: '7', domainKey: dk });
    ev(h, 'LegacySliceDomainOpened', 15, { entryId: '8', domainKey: dk });
    ev(h, 'LegacySliceConsumed', 16, { entryId: '8', epochFresh: '1' });
    ev(h, 'TransportBatchContested', 17, { batchId: `0x${'B'.repeat(64)}`, key: k1 });
    ev(h, 'TransportBatchContested', 18, { batchId: `0x${'B'.repeat(64)}`, key: k1 });
    const open = await listOpenStaging(h.d1 as D1Database, CHAIN, 0);
    expect(open.map((o) => [o.what, o.key, o.user])).toEqual([
      ['record', k1, a],
      ['domain', dk, a],
    ]);
    expect(await listOpenLegacySlices(h.d1 as D1Database, CHAIN, 0)).toEqual([7n]);
    expect(await listBatchContests(h.d1 as D1Database, CHAIN, 0)).toEqual([{ batchId: `0x${'b'.repeat(64)}`, key: k1, pos: 18_000_000 }]);
    expect(await listOpenStaging(h.d1 as D1Database, CHAIN + 1, 0), 'another chain').toEqual([]);
  });
});

