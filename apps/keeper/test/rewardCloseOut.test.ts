/**
 * #2984 — the reward close-out pass. Pinned in two layers:
 *
 *   - the PURE rules: the days a run may try to prove closed, which entries
 *     cover a day, the conservation check that gates a walk, paging, when a
 *     retired era may be finalized, and when a day's transport cursor has an
 *     exhausted epoch to pass;
 *   - whole RUNS against a fake Diamond that applies the contract's own
 *     admission rules to each call: what is sent, in what order, what is left
 *     and why, and that nothing is sent for a walk that could not close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Address, type PublicClient } from 'viem';
import {
  ABI,
  DEFAULT_WINDOW_DAYS,
  MAX_SENDS_PER_RUN,
  PAGE_IDS,
  SIDE_BORROWER,
  SIDE_LENDER,
  closeOutOnce,
  provableThrough,
  CLOSURE_FLOOR_ITEM,
  CLOSURE_NEXT_ITEM,
  conservationGap,
  coveringEntries,
  covers,
  describeReport,
  epochPrunable,
  eraReadiness,
  pagesAfter,
  ENTRY_FLOOR_ITEM,
  ERA_FLOOR_ITEM,
  MAX_ERAS,
  MAX_BATCHES_PER_DAY,
  MAX_ENTRY_PAGES,
  parkCursorItem,
  QUEUE_STEPS,
  RELEASE_DAYS,
  RELEASE_FLOOR_ITEM,
  type ScannedEntry,
} from '../src/rewardCloseOut';
import { PastRunDeadline } from '../src/batchRead';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { decodeEntryFloor, encodeEntryFloor, ENTRY_PAGE, scanEntries, type EntryRow } from '../src/rewardEntries';
import { advanceFloor, memoryScanCursors, rotatingWindow } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 421614;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const OTHER: Address = '0x00000000000000000000000000000000000000ab';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'0'.repeat(64)}` as const;
const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;
const ROLE_DETACHED = 3;

const e = (id: number, side: number, first: number, endDay: number, perDay: bigint): ScannedEntry => ({ id: BigInt(id), side, first, endDay, perDayNumeraire18: perDay });
const batchId = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;

describe('the pure rules', () => {
  it('provableThrough: elapsed days reached by both frontiers', () => {
    expect(provableThrough(0, 5, 5), 'nothing has elapsed').toBe(-1);
    expect(provableThrough(5, 10, 10)).toBe(4);
    expect(provableThrough(5, 10, 3), 'the slower frontier bounds it').toBe(3);
    expect(provableThrough(5, -1, 10), 'a frontier before day 0').toBe(-1);
  });

  it('rotatingWindow: bounded per run, every item visited across runs', () => {
    expect(rotatingWindow(3, 2, 5, null), 'an empty range').toBeNull();
    expect(rotatingWindow(0, 4, 10, 7), 'a range that fits is read whole').toEqual({ from: 0, to: 4, next: 0 });
    expect(rotatingWindow(0, 9, 4, null)).toEqual({ from: 0, to: 3, next: 4 });
    expect(rotatingWindow(0, 9, 4, 4)).toEqual({ from: 4, to: 7, next: 8 });
    expect(rotatingWindow(0, 9, 4, 8), 'the last window wraps to the floor').toEqual({ from: 8, to: 9, next: 0 });
    expect(rotatingWindow(5, 20, 4, 2), 'a cursor below the floor restarts at the floor').toEqual({ from: 5, to: 8, next: 9 });
    expect(advanceFloor(2, [2, 3, 5], () => true), 'only a contiguous run from the floor').toBe(4);
    expect(advanceFloor(2, [3, 4], () => true), 'a window not starting at the floor').toBe(2);
    expect(advanceFloor(2, [2, 3], (i) => i !== 2)).toBe(2);
  });

  it('covers: from the first day, the end day exclusive', () => {
    const x = e(1, SIDE_LENDER, 2, 5, 1n);
    expect([1, 2, 4, 5].map((d) => covers(x, d))).toEqual([false, true, true, false]);
  });

  it('coveringEntries: per side, ascending by id, whatever the scan order', () => {
    const list = [e(9, SIDE_LENDER, 1, 4, 1n), e(3, SIDE_LENDER, 1, 4, 1n), e(5, SIDE_BORROWER, 1, 4, 1n), e(7, SIDE_LENDER, 5, 9, 1n), e(8, 2, 1, 4, 1n)];
    const c = coveringEntries(list, 2);
    expect(c.lender.map((x) => x.id)).toEqual([3n, 9n]);
    expect(c.borrower.map((x) => x.id)).toEqual([5n]);
  });

  it('conservationGap: null only when each side sums to its total exactly', () => {
    const cover = { lender: [e(1, SIDE_LENDER, 1, 3, 4n), e(2, SIDE_LENDER, 1, 3, 6n)], borrower: [e(3, SIDE_BORROWER, 1, 3, 5n)] };
    expect(conservationGap(cover, { lender: 10n, borrower: 5n })).toBeNull();
    expect(conservationGap(cover, { lender: 11n, borrower: 5n })).toMatch(/lender entries sum to 10 of a 11 total/);
    expect(conservationGap(cover, { lender: 10n, borrower: 4n })).toMatch(/borrower entries sum to 5 of a 4 total/);
    expect(conservationGap({ lender: [], borrower: [] }, { lender: 0n, borrower: 0n })).toBeNull();
  });

  it('pagesAfter: the ids past the cursor, in pages', () => {
    const ids = [1n, 2n, 3n, 4n, 5n];
    expect(pagesAfter(ids, 0n, 2)).toEqual([[1n, 2n], [3n, 4n], [5n]]);
    expect(pagesAfter(ids, 3n, 2)).toEqual([[4n, 5n]]);
    expect(pagesAfter(ids, 5n, 2)).toEqual([]);
  });

  it('eraReadiness: every day of its span closed and no staging hold, or why not', () => {
    const era = { daysClosed: 4n, boundaryDay: 10n, terminal: false, stagedFresh: 0n };
    expect(eraReadiness(era, 14n)).toBe('ready');
    expect(eraReadiness(era, 15n)).toBe('4 of its 5 days proven closed');
    expect(eraReadiness({ ...era, stagedFresh: 7n }, 14n)).toBe('7 of its row held by staging');
    expect(eraReadiness({ ...era, terminal: true }, 15n), 'finalized already').toBeNull();
  });

  it('epochPrunable: only the plainly exhausted case', () => {
    const ep = { exists: true, balance: 0n, dayCount: 2, indexedDays: 2, references: 0n };
    expect(epochPrunable(ep)).toBe(true);
    expect(epochPrunable({ ...ep, exists: false })).toBe(false);
    expect(epochPrunable({ ...ep, balance: 1n }), 'exhausted only by its caps is not detected').toBe(false);
    expect(epochPrunable({ ...ep, indexedDays: 1 })).toBe(false);
    expect(epochPrunable({ ...ep, references: 1n })).toBe(false);
  });
});

// ─── The fake Diamond ───────────────────────────────────────────────────────

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

interface Entry {
  user: Address;
  startDay: number;
  endDay: number;
  side: number;
  perDay: bigint;
  open: boolean;
}

interface Walk {
  starter: Address;
  day: bigint;
  nonce: bigint;
  lenderComplete: boolean;
  borrowerComplete: boolean;
  completed: boolean;
  lenderCursor: bigint;
  borrowerCursor: bigint;
  lenderConservation: bigint;
  borrowerConservation: bigint;
}

interface Era {
  holderRow: bigint;
  daysClosed: bigint;
  boundaryDay: bigint;
  terminal: boolean;
  stagedFresh: bigint;
}

interface Batch {
  balance: bigint;
  dayCount: number;
  indexedDays: number;
  references: bigint;
  days: number[];
  parked: bigint | null;
}

/** A Diamond whose calls are admitted by the contract's own rules. */
class FakeDiamond {
  chainNamed = CHAIN;
  role = ROLE_MIRROR;
  today = 5;
  active = true;
  paused = false;
  frontiers: [number, number] = [10, 10];
  entries: Entry[] = [];
  /** Folded totals that differ from what the entries sum to (a scan gap). */
  totalsOverride = new Map<number, [bigint, bigint]>();
  closed = new Set<number>();
  nonces = new Map<string, bigint>();
  walks = new Map<string, Walk>();
  eras: Era[] = [{ holderRow: 0n, daysClosed: 0n, boundaryDay: 0n, terminal: false, stagedFresh: 0n }];
  pendingSurplus = 0n;
  baseline = 0n;
  batches = new Map<string, Batch>();
  dayIndex = new Map<number, string[]>();
  dayCursor = new Map<number, number>();
  /** Another caller closes this day after the run reads it, before its send. */
  closedByOtherBeforeSend: number | null = null;
  sent: { fn: string; args: readonly unknown[] }[] = [];
  /** Base's release record per removed destination, and the days it has
   *  finalized (the walk stops at the first that is not). */
  releases = new Map<number, { bound: number; cursor: number }>();
  globalFinalized = new Set<number>();
  /** Per function, the head reads that succeed before every later one throws
   *  `error` (a failed read, or the run deadline passing). */
  failAfter = new Map<string, { left: number; error: () => Error }>();
  /** The reconciliation queues; a walk writes `perWalk` of what is pending. */
  queues: Record<'fresh' | 'recycled', { pending: bigint; frontier: bigint; perWalk: bigint; addedAfterWalk?: bigint }> = {
    fresh: { pending: 0n, frontier: 0n, perWalk: 50n },
    recycled: { pending: 0n, frontier: 0n, perWalk: 50n },
  };
  /** What the finalized block shows, when it lags the head: null reads the
   *  head's state there too. `finalized: 'none'` is an RPC without the tag. */
  final: { closed: Set<number>; eras: Era[]; releases?: Map<number, { bound: number; cursor: number }> } | 'none' | null = null;
  readonly finalNumber = 100n;

  addEntry(x: Partial<Entry> & { side: number; startDay: number; endDay: number; perDay: bigint }): number {
    this.entries.push({ user: OTHER, open: false, ...x });
    return this.entries.length;
  }

  addBatch(id: string, b: Partial<Batch> & { days: number[] }): void {
    this.batches.set(id, { balance: 0n, dayCount: b.days.length, indexedDays: b.days.length, references: 0n, parked: null, ...b });
    for (const d of b.days) this.dayIndex.set(d, [...(this.dayIndex.get(d) ?? []), id]);
  }

  private covering(day: number, side: number): number[] {
    const out: number[] = [];
    this.entries.forEach((x, i) => {
      const first = x.startDay === 0 ? 1 : x.startDay;
      if (x.side === side && day >= first && day < x.endDay) out.push(i + 1);
    });
    return out;
  }

  totals(day: number): [bigint, bigint] {
    const o = this.totalsOverride.get(day);
    if (o) return o;
    const sum = (side: number) => this.covering(day, side).reduce((a, id) => a + this.entries[id - 1].perDay, 0n);
    return [sum(SIDE_LENDER), sum(SIDE_BORROWER)];
  }

  private walkKey(day: bigint, starter: string, nonce: bigint): string {
    return `${day}:${starter.toLowerCase()}:${nonce}`;
  }

  private zeroWalk(): Walk {
    return { starter: ZERO, day: 0n, nonce: 0n, lenderComplete: false, borrowerComplete: false, completed: false, lenderCursor: 0n, borrowerCursor: 0n, lenderConservation: 0n, borrowerConservation: 0n };
  }

  private nextNode(day: number, i: number): string | undefined {
    return this.dayIndex.get(day)?.[i];
  }

  readContract = async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    const fail = blockNumber === undefined ? this.failAfter.get(functionName) : undefined;
    if (fail !== undefined && fail.left-- <= 0) throw fail.error();
    if (blockNumber !== undefined) {
      if (blockNumber !== this.finalNumber) throw new Error(`read at unexpected block ${blockNumber}`);
      const f = this.final;
      if (f !== null && f !== 'none') {
        if (functionName === 'isDayObligationsClosed') return f.closed.has(Number(a[0]));
        if (functionName === 'getCustodyEra') return f.eras[Number(a[0])];
        if (functionName === 'getRemitDestinationRelease') {
          const x = (f.releases ?? this.releases).get(Number(a[0]));
          return [BigInt(x?.bound ?? 0), BigInt(x?.cursor ?? 0)];
        }
        throw new Error(`unexpected finalized read ${functionName}`);
      }
    }
    switch (functionName) {
      case 'getRewardReporterConfig':
        return [ZERO, this.chainNamed, 84532, false, 3600n];
      case 'getRewardRole':
        return this.role;
      case 'getInteractionCurrentDay':
        return [BigInt(this.today), this.active];
      case 'paused':
        return this.paused;
      case 'getInterestFrontiers':
        return [BigInt(this.frontiers[0]), BigInt(this.frontiers[1])];
      case 'getCustodyEraCurrent':
        return BigInt(this.eras.length - 1);
      case 'getCustodyEra': {
        const r = this.eras[Number(a[0])];
        return r ?? { holderRow: 0n, daysClosed: 0n, boundaryDay: 0n, terminal: false, stagedFresh: 0n };
      }
      case 'rewardCustodyLedger':
        return [true, this.baseline, 0n, 0n, 0n, this.pendingSurplus, 0n, 0n, 0n, 0n];
      case 'isDayObligationsClosed':
        return this.closed.has(Number(a[0]));
      case 'getRewardEntriesRange': {
        const from = Number(a[0]);
        const n = Number(a[1]);
        return this.entries.slice(from - 1, from - 1 + n).map((x) => ({ user: x.user, loanId: 1n, startDay: x.startDay, endDay: x.endDay, side: x.side, processed: false, forfeited: false, closed: !x.open, perDayNumeraire18: x.perDay, expiryBegun: false }));
      }
      case 'getInteractionDayEntry': {
        const [l, b] = this.totals(Number(a[0]));
        return [0n, 0n, l, b];
      }
      case 'isEntryTerminatedOn':
        return !this.entries[Number(a[0]) - 1].open;
      case 'getClosureWalkNonce':
        return this.nonces.get((a[0] as string).toLowerCase()) ?? 0n;
      case 'getClosureWalk':
        return this.walks.get(this.walkKey(a[0], a[1], a[2])) ?? this.zeroWalk();
      case 'getTransportDayBatches': {
        const ids = this.dayIndex.get(Number(a[0])) ?? [];
        const page = ids.slice(Number(a[1]), Number(a[1]) + Number(a[2]));
        return [page, page.map(() => 1n), BigInt(ids.length), BigInt(this.dayCursor.get(Number(a[0])) ?? 0)];
      }
      case 'getTransportDayIndex': {
        const d = Number(a[0]);
        const c = this.dayCursor.get(d) ?? 0;
        return [BigInt(this.dayIndex.get(d)?.length ?? 0), c === 0 ? ZERO32 : this.dayIndex.get(d)![c - 1]];
      }
      case 'getTransportDayBatchesFrom': {
        const ids = this.dayIndex.get(Number(a[0])) ?? [];
        const start = a[1] === ZERO32 ? 0 : ids.indexOf(a[1]);
        const page = start < 0 ? [] : ids.slice(start, start + Number(a[2]));
        return [page, page.map(() => 1n), ids[start + page.length] ?? ZERO32];
      }
      case 'getTransportBatch': {
        const b = this.batches.get(a[0]);
        return b ? [`0x${'aa'.repeat(32)}`, b.balance, 0n, b.dayCount, b.indexedDays, false] : [ZERO32, 0n, 0n, 0, 0, false];
      }
      case 'getTransportRemainder': {
        const b = this.batches.get(a[0]);
        if (!b) throw revert('TransportBatchUnknown', [a[0]]);
        return b.parked === null ? [0n, 0, false, 0n] : [b.parked, b.dayCount, false, 0n];
      }
      case 'getTransportBatchStaged':
        return [0n, 0n, this.batches.get(a[0])?.references ?? 0n];
      case 'getTransportBatchDays':
        return (this.batches.get(a[0])?.days ?? []).map(BigInt);
      case 'getRemitDestinationRelease': {
        const x = this.releases.get(Number(a[0]));
        return [BigInt(x?.bound ?? 0), BigInt(x?.cursor ?? 0)];
      }
      case 'getFreshQueueState': {
        if (a[0] !== 0n) throw revert('CustodyEraUnknown', [a[0]]);
        const q = this.queues.fresh;
        return [q.frontier, 0n, 0n, 0n, q.pending, 0n, 0n, 0n, 0n, 0n];
      }
      case 'getRecycledQueueState': {
        const q = this.queues.recycled;
        return [q.frontier, 0n, 0n, 0n, q.pending, 0n];
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts, blockNumber }: { contracts: { functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract({ ...c, blockNumber }) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  /** Where a release walk from the stored cursor would stop. */
  private releaseWalk(chain: number, maxDays: number): { bound: number; cursor: number } {
    const x = this.releases.get(chain)!;
    const end = Math.min(x.bound, x.cursor + maxDays);
    let c = x.cursor;
    while (c < end && this.globalFinalized.has(c)) c += 1;
    return { bound: x.bound, cursor: c };
  }

  /** The contract's admission rules; throws its refusal, or returns the change. */
  private admit(functionName: string, a: readonly any[]): () => void {
    switch (functionName) {
      case 'continueRemitDestinationRelease': {
        if (this.paused) throw revert('EnforcedPause');
        if (this.role !== ROLE_CANONICAL) throw revert('NotCanonicalRewardChain');
        const x = this.releases.get(Number(a[0]));
        if (x === undefined || x.cursor >= x.bound) throw revert('RemitDestinationReleaseDone', [a[0]]);
        const w = this.releaseWalk(Number(a[0]), Number(a[1]));
        return () => this.releases.set(Number(a[0]), w);
      }
      case 'advanceReconciliationQueue': {
        const q = a[0] === 0 ? this.queues.fresh : a[0] === 1 ? this.queues.recycled : undefined;
        if (q === undefined) throw revert('ReconciliationUnknownSide', [a[0]]);
        return () => {
          const take = q.pending < q.perWalk ? q.pending : q.perWalk;
          q.pending -= take;
          if (take > 0n) q.frontier += 1n;
          // Another caller's outflow, between this walk and the next read.
          q.pending += q.addedAfterWalk ?? 0n;
        };
      }
      case 'startDayClosure': {
        const day = Number(a[0]);
        if (this.paused) throw revert('EnforcedPause');
        if (day >= this.today) throw revert('ClosureDayNotElapsed', [a[0]]);
        if (day > Math.min(...this.frontiers)) throw revert('ClosureFrontierShort', [a[0], BigInt(this.frontiers[0]), BigInt(this.frontiers[1])]);
        if (this.closed.has(day)) throw revert('ClosureDayAlreadyClosed', [a[0]]);
        return () => {
          const nonce = (this.nonces.get(KEEPER) ?? 0n) + 1n;
          this.nonces.set(KEEPER, nonce);
          const [l, b] = this.totals(day);
          const w: Walk = { ...this.zeroWalk(), starter: KEEPER, day: a[0], nonce, lenderComplete: l === 0n, borrowerComplete: b === 0n };
          w.completed = w.lenderComplete && w.borrowerComplete;
          if (w.completed) this.closed.add(day);
          this.walks.set(this.walkKey(a[0], KEEPER, nonce), w);
        };
      }
      case 'proveDayClosurePage': {
        const day = Number(a[0]);
        if (this.paused) throw revert('EnforcedPause');
        const key = this.walkKey(a[0], KEEPER, a[1]);
        const w = this.walks.get(key);
        if (!w) throw revert('ClosureWalkUnknown', [ZERO32]);
        if (this.closed.has(day)) throw revert('ClosureDayAlreadyClosed', [a[0]]);
        const side = Number(a[2]);
        const ids = (a[3] as bigint[]).map(Number);
        let cursor = side === SIDE_LENDER ? w.lenderCursor : w.borrowerCursor;
        let sum = 0n;
        const cover = new Set(this.covering(day, side));
        for (const id of ids) {
          if (BigInt(id) <= cursor) throw revert('ClosureEntriesNotAscending', [BigInt(id)]);
          if (!cover.has(id)) throw revert('ClosureEntryNotCovering', [BigInt(id), a[0]]);
          if (this.entries[id - 1].open) throw revert('ClosureEntryOpen', [BigInt(id), a[0]]);
          cursor = BigInt(id);
          sum += this.entries[id - 1].perDay;
        }
        const [l, b] = this.totals(day);
        const total = side === SIDE_LENDER ? l : b;
        const had = side === SIDE_LENDER ? w.lenderConservation : w.borrowerConservation;
        if (had + sum > total) throw revert('ClosureConservationExceeded', [a[0], side, had + sum, total]);
        return () => {
          if (side === SIDE_LENDER) Object.assign(w, { lenderCursor: cursor, lenderConservation: had + sum, lenderComplete: had + sum === total });
          else Object.assign(w, { borrowerCursor: cursor, borrowerConservation: had + sum, borrowerComplete: had + sum === total });
          if (w.lenderComplete && w.borrowerComplete) {
            w.completed = true;
            this.closed.add(day);
          }
        };
      }
      case 'finalizeCustodyEra': {
        const id = Number(a[0]);
        const era = this.eras[id];
        if (!era) throw revert('CustodyEraUnknown', [a[0]]);
        if (id === this.eras.length - 1) throw revert('CustodyEraLive', [a[0]]);
        if (era.terminal) throw revert('CustodyEraAlreadyFinalized', [a[0]]);
        const span = this.eras[id + 1].boundaryDay - era.boundaryDay;
        if (era.daysClosed < span || era.stagedFresh !== 0n) throw revert('CustodyEraNotTerminal', [a[0], era.daysClosed, span, era.stagedFresh]);
        return () => {
          era.terminal = true;
          if (this.role === ROLE_DETACHED) this.pendingSurplus += era.holderRow;
          else this.baseline += era.holderRow;
          era.holderRow = 0n;
        };
      }
      case 'drainPendingSurplus': {
        if (this.role !== ROLE_CANONICAL && this.role !== ROLE_MIRROR) throw revert('CustodyPendingSurplusNeedsActiveRole', [this.role]);
        const amount = a[0] as bigint;
        return () => {
          this.pendingSurplus -= amount;
          this.baseline += amount;
        };
      }
      case 'parkTransportBatchRemainder': {
        const b = this.batches.get(a[0]);
        if (!b) throw revert('TransportBatchUnknown', [a[0]]);
        if (b.parked !== null) throw revert('TransportRemainderAlreadyParked', [a[0]]);
        if (b.indexedDays < b.dayCount) throw revert('TransportBatchNotFullyIndexed', [a[0], b.indexedDays, b.dayCount]);
        if (b.references !== 0n) throw revert('TransportBatchReferenced', [a[0], b.references]);
        const open = b.days.find((d) => !this.closed.has(d));
        if (open !== undefined) throw revert('TransportDayNotClosed', [a[0], BigInt(open)]);
        return () => {
          b.parked = b.balance;
          b.balance = 0n;
        };
      }
      case 'epochPruneTransportDayCursor': {
        const day = Number(a[0]);
        return () => {
          let c = this.dayCursor.get(day) ?? 0;
          for (let node = this.nextNode(day, c); node !== undefined; node = this.nextNode(day, c)) {
            const b = this.batches.get(node)!;
            if (b.balance !== 0n || b.references !== 0n || b.indexedDays < b.dayCount) break;
            c += 1;
          }
          this.dayCursor.set(day, c);
        };
      }
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    if (functionName === 'startDayClosure' && this.closedByOtherBeforeSend === Number(args[0] as bigint)) this.closed.add(this.closedByOtherBeforeSend);
    this.admit(functionName, args);
    if (functionName === 'continueRemitDestinationRelease') {
      const w = this.releaseWalk(Number(args[0]), Number(args[1]));
      return { result: [BigInt(w.cursor), BigInt(w.bound)] };
    }
    return { result: undefined };
  };

  getBlock = async ({ blockTag }: { blockTag: string }) => {
    if (blockTag !== 'finalized' || this.final === 'none') throw new Error('finalized block not available');
    return { number: this.finalNumber, timestamp: 1_000n };
  };

  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: [], blockNumber: 1n });

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
          this.admit(functionName, args)();
          this.sent.push({ fn: functionName, args });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

/** The indexer's ledger of Base's removed destinations. */
class FakeLedger implements EventLedger {
  rows: LedgerRow[] = [];
  fail = false;
  pages: (LedgerPos | null)[] = [];

  add(dstChainId: unknown, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'RemitDestinationRemoved', args: { dstChainId, bound: 0, cursor: 0 }, blockAt: n, block: n, log: 0 });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    if (this.fail) return null;
    expect(kinds).toEqual(['RemitDestinationRemoved']);
    this.pages.push(after);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('scanEntries', () => {
  const row = (startDay: number, endDay: number): EntryRow => ({ user: OTHER, startDay, endDay, side: SIDE_LENDER, perDayNumeraire18: 1n });
  const reader = (rows: EntryRow[]) => async (from: bigint, n: bigint) => rows.slice(Number(from) - 1, Number(from) - 1 + Number(n));

  it('starts at a floor recorded for the same or an earlier first day, and from id 1 otherwise', async () => {
    const rows = [row(0, 1), row(0, 2), row(3, 9), row(4, 9)];
    const fromFloor = await scanEntries(reader(rows), 3, 4, 1, { id: 3n, day: 2 });
    expect(fromFloor.entries.map((e) => e.id)).toEqual([3n, 4n]);
    expect(fromFloor.completeThrough).toBe(4);
    expect(fromFloor.floor).toEqual({ id: 3n, day: 3 });
    const later = await scanEntries(reader(rows), 1, 4, 1, { id: 3n, day: 2 + 5 });
    expect(later.entries.map((e) => e.id), 'a floor for a later day is not used').toEqual([2n, 3n, 4n]);
    expect(later.floor).toEqual({ id: 2n, day: 1 });
  });

  it('says which days a page budget still covers whole when it runs out', async () => {
    const rows = Array.from({ length: Number(ENTRY_PAGE) + 5 }, (_, i) => row(i < Number(ENTRY_PAGE) - 1 ? 2 : 6, 9));
    const s = await scanEntries(reader(rows), 2, 8, 1, null);
    expect(s.completeThrough, 'an unread entry may still start on day 6').toBe(5);
    expect(s.floor).toEqual({ id: 1n, day: 2 });
  });

  it('round-trips a floor, and reads a malformed one as none', () => {
    expect(decodeEntryFloor(encodeEntryFloor({ id: 12n, day: 4 }))).toEqual({ id: 12n, day: 4 });
    expect(decodeEntryFloor('x')).toBeNull();
    expect(decodeEntryFloor(undefined)).toBeNull();
  });
});

describe('a run', () => {
  let d: FakeDiamond;
  let logged: string[];
  let cursors: ReturnType<typeof memoryScanCursors>;
  let ledger: FakeLedger;

  beforeEach(() => {
    d = new FakeDiamond();
    cursors = memoryScanCursors();
    ledger = new FakeLedger();
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.push('ERR ' + a.map(String).join(' ')));
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { keeper?: Address | null; windowDays?: number; context?: () => KeeperContext | null } = {}) =>
    closeOutOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: opts.context ?? (() => d.ctx()),
      keeper: opts.keeper === undefined ? KEEPER : opts.keeper,
      sendDeadline: Number.POSITIVE_INFINITY,
      windowDays: opts.windowDays ?? DEFAULT_WINDOW_DAYS,
      cursors,
      ledger,
    });
  const fns = () => d.sent.map((s) => s.fn);
  const closeAllButDay = (day: number) => {
    for (let x = 0; x < d.today; x++) if (x !== day) d.closed.add(x);
  };

  describe('closure', () => {
    it(`resumes the entry scan from its stored floor, so a history longer than ${MAX_ENTRY_PAGES} pages does not stop closure`, async () => {
      closeAllButDay(4);
      // A long history whose entries all ended before day 1.
      const history = MAX_ENTRY_PAGES * Number(ENTRY_PAGE) + 1;
      for (let i = 0; i < history; i++) d.addEntry({ side: SIDE_LENDER, startDay: 0, endDay: 1, perDay: 1n });
      const live = d.addEntry({ side: SIDE_LENDER, startDay: 4, endDay: 6, perDay: 5n });
      let r = await run();
      expect(r.daysClosed).toEqual([]);
      expect(r.unread.get('closure')).toMatch(/reached only the entries starting by day 0; days 4 are not walked this run/);
      expect(cursors.rows.get(ENTRY_FLOOR_ITEM), 'the floor moves past the history read').toBe(`${MAX_ENTRY_PAGES * Number(ENTRY_PAGE) + 1}:4`);
      r = await run();
      expect(r.daysClosed).toEqual([4]);
      expect(r.unread.has('closure')).toBe(false);
      expect(cursors.rows.get(ENTRY_FLOOR_ITEM), 'the first entry live on day 4').toBe(`${live}:4`);
    });

    it('proves a day closed once every covering entry has terminated: a start, then a page a side', async () => {
      closeAllButDay(2);
      d.addEntry({ side: SIDE_LENDER, startDay: 0, endDay: 4, perDay: 10n }); // id 1, covers days 1..3
      d.addEntry({ side: SIDE_BORROWER, startDay: 2, endDay: 3, perDay: 4n }); // id 2
      d.addEntry({ side: SIDE_LENDER, startDay: 2, endDay: 9, perDay: 6n }); // id 3
      d.addEntry({ side: SIDE_LENDER, startDay: 3, endDay: 9, perDay: 99n }); // id 4, not on day 2
      const r = await run();
      expect(r.daysClosed).toEqual([2]);
      expect(d.closed.has(2)).toBe(true);
      expect(fns()).toEqual(['startDayClosure', 'proveDayClosurePage', 'proveDayClosurePage']);
      expect(d.sent[1].args).toEqual([2n, 1n, SIDE_LENDER, [1n, 3n]]);
      expect(d.sent[2].args).toEqual([2n, 1n, SIDE_BORROWER, [2n]]);
      expect(r.refused.size).toBe(0);
      expect(r.unread.size).toBe(0);
    });

    it('a day with nothing on either side closes at its start', async () => {
      closeAllButDay(1);
      const r = await run();
      expect(r.daysClosed).toEqual([1]);
      expect(fns()).toEqual(['startDayClosure']);
    });

    it('leaves a day with a covering entry still open, and sends nothing for it', async () => {
      closeAllButDay(2);
      d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 4, perDay: 10n, open: true });
      const r = await run();
      expect(r.daysWaitingOnEntries).toEqual([2]);
      expect(r.daysClosed).toEqual([]);
      expect(d.sent).toEqual([]);
    });

    it('never opens a walk on a scan that does not account for the day\'s totals', async () => {
      closeAllButDay(2);
      d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 4, perDay: 10n });
      d.totalsOverride.set(2, [11n, 0n]);
      const r = await run();
      expect(r.daysScanGap).toEqual([2]);
      expect(r.unread.get('closure:2')).toMatch(/lender entries sum to 10 of a 11 total/);
      expect(d.sent).toEqual([]);
      expect(describeReport(r)).toMatch(/days-scan-short=2/);
    });

    it(`pages a side ${PAGE_IDS} ids at a time`, async () => {
      closeAllButDay(1);
      for (let i = 0; i < PAGE_IDS + 30; i++) d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 2, perDay: 1n });
      const r = await run();
      expect(r.daysClosed).toEqual([1]);
      expect(fns()).toEqual(['startDayClosure', 'proveDayClosurePage', 'proveDayClosurePage']);
      expect((d.sent[1].args[3] as bigint[]).length).toBe(PAGE_IDS);
      expect((d.sent[2].args[3] as bigint[])[0]).toBe(BigInt(PAGE_IDS + 1));
    });

    it('continues its own unfinished walk for the day rather than opening another', async () => {
      closeAllButDay(2);
      d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 4, perDay: 10n }); // 1
      d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 4, perDay: 5n }); // 2
      // An earlier run started the walk and paged id 1 before it stopped.
      d.nonces.set(KEEPER, 4n);
      d.walks.set(`2:${KEEPER}:4`, { starter: KEEPER, day: 2n, nonce: 4n, lenderComplete: false, borrowerComplete: true, completed: false, lenderCursor: 1n, borrowerCursor: 0n, lenderConservation: 10n, borrowerConservation: 0n });
      const r = await run();
      expect(r.daysClosed).toEqual([2]);
      expect(fns()).toEqual(['proveDayClosurePage']);
      expect(d.sent[0].args).toEqual([2n, 4n, SIDE_LENDER, [2n]]);
    });

    it('opens a fresh walk when its latest one is another day\'s', async () => {
      closeAllButDay(2);
      d.nonces.set(KEEPER, 3n);
      d.walks.set(`1:${KEEPER}:3`, { starter: KEEPER, day: 1n, nonce: 3n, lenderComplete: false, borrowerComplete: false, completed: false, lenderCursor: 0n, borrowerCursor: 0n, lenderConservation: 0n, borrowerConservation: 0n });
      const r = await run();
      expect(r.daysClosed).toEqual([2]);
      expect(fns()).toEqual(['startDayClosure']);
      expect(d.nonces.get(KEEPER)).toBe(4n);
    });

    it('works only elapsed days both frontiers reach, a window a run above its closure floor', async () => {
      d.today = 8;
      d.frontiers = [6, 4];
      let r = await run({ windowDays: 3 });
      expect(r.daysClosed).toEqual([0, 1, 2]);
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM)).toBe('3');
      r = await run({ windowDays: 3 });
      expect(r.daysClosed, 'the next run starts at the floor').toEqual([3, 4]);
      expect(d.closed.has(5), 'past the slower frontier').toBe(false);
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM)).toBe('5');
    });

    it('rotates past a day that stays open, so a later day is not left out for good', async () => {
      d.today = 11;
      d.frontiers = [20, 20];
      d.addEntry({ side: SIDE_LENDER, startDay: 1, endDay: 2, perDay: 1n, open: true }); // day 1 waits on it
      let r = await run({ windowDays: 4 });
      expect(r.daysClosed).toEqual([0, 2, 3]);
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM), 'the floor stops at the open day').toBe('1');
      r = await run({ windowDays: 4 });
      expect(r.daysClosed, 'the next window, not the same one again').toEqual([4, 5, 6, 7]);
      r = await run({ windowDays: 4 });
      expect(r.daysClosed).toEqual([8, 9, 10]);
      expect(cursors.rows.get(CLOSURE_NEXT_ITEM), 'then back to the floor').toBe('1');
    });

    it('moves its closure floor only on what the finalized block shows, so a reorged closure is walked again (Codex #2993 r4)', async () => {
      d.today = 4;
      d.final = { closed: new Set(), eras: d.eras };
      let r = await run();
      expect(r.daysClosed).toEqual([0, 1, 2, 3]);
      expect(cursors.rows.has(CLOSURE_FLOOR_ITEM), 'closed at the head, not yet final').toBe(false);
      // Finality reaches days 0 and 1; then a reorg drops day 2's closure.
      d.final = { closed: new Set([0, 1]), eras: d.eras };
      d.closed.delete(2);
      d.sent = [];
      r = await run();
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM)).toBe('2');
      expect(r.daysClosed, 'the reorged day is above the floor and walked again').toEqual([2]);
      d.final = null;
      await run();
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM), 'then the floor passes every final day').toBe('4');
    });

    it('holds its floors where they are on an RPC that gives no finalized block', async () => {
      d.today = 3;
      d.final = 'none';
      const r = await run();
      expect(r.daysClosed).toEqual([0, 1, 2]);
      expect(cursors.rows.has(CLOSURE_FLOOR_ITEM)).toBe(false);
      expect(cursors.rows.get(CLOSURE_NEXT_ITEM), 'the rotation still moves').toBe('0');
    });

    it('continues each day\'s own unfinished walk when the window rotates between days', async () => {
      closeAllButDay(-1);
      d.closed.delete(1);
      d.closed.delete(2);
      // Each day needs a start and 12 pages: more than one run's 12 sends.
      for (const day of [1, 2]) {
        for (let i = 0; i < 6 * PAGE_IDS; i++) {
          d.addEntry({ side: SIDE_LENDER, startDay: day, endDay: day + 1, perDay: 1n });
          d.addEntry({ side: SIDE_BORROWER, startDay: day, endDay: day + 1, perDay: 1n });
        }
      }
      for (let i = 0; i < 10 && !(d.closed.has(1) && d.closed.has(2)); i++) await run({ windowDays: 1 });
      expect(d.closed.has(1) && d.closed.has(2), 'both days close').toBe(true);
      expect(fns().filter((f) => f === 'startDayClosure'), 'one walk each, never reopened').toHaveLength(2);
    });

    it('a day another caller closed first is a race, not a refusal', async () => {
      closeAllButDay(2);
      d.closedByOtherBeforeSend = 2;
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.refused.size).toBe(0);
      expect(r.daysClosed).toEqual([]);
    });

    it('stops at its send budget, and the next run carries on', async () => {
      d.today = MAX_SENDS_PER_RUN + 6;
      d.frontiers = [100, 100];
      const r = await run();
      expect(d.sent.length).toBe(MAX_SENDS_PER_RUN);
      expect(r.stopped).toBe('send-budget');
      const again = await run();
      expect(again.daysClosed.length).toBe(d.today - MAX_SENDS_PER_RUN);
      expect([...Array(d.today).keys()].every((x) => d.closed.has(x))).toBe(true);
    });

    it('starts nothing while paused, and says why', async () => {
      d.paused = true;
      closeAllButDay(2);
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.unread.get('closure')).toMatch(/paused/);
    });

    it('starts nothing without a signing key, and says so', async () => {
      closeAllButDay(2);
      const r = await run({ keeper: null });
      expect(d.sent).toEqual([]);
      expect(r.unread.get('closure')).toMatch(/no signing key/);
    });
  });

  it('does not work a chain whose Diamond names itself another chain', async () => {
    d.chainNamed = 84532;
    closeAllButDay(2);
    const r = await run();
    expect(r.skipped).toMatch(/names itself chain 84532/);
    expect(d.sent).toEqual([]);
    expect(describeReport(r)).toMatch(/not worked this run/);
  });

  describe('eras and surplus', () => {
    beforeEach(() => {
      for (let x = 0; x < d.today; x++) d.closed.add(x);
    });

    it('finalizes a retired era whose span is closed, and names one that waits; never the live era', async () => {
      d.eras = [
        { holderRow: 50n, daysClosed: 2n, boundaryDay: 0n, terminal: false, stagedFresh: 0n },
        { holderRow: 30n, daysClosed: 1n, boundaryDay: 2n, terminal: false, stagedFresh: 0n },
        { holderRow: 0n, daysClosed: 0n, boundaryDay: 4n, terminal: false, stagedFresh: 0n },
      ];
      const r = await run();
      expect(r.erasFinalized).toEqual([0]);
      expect(r.erasWaiting).toEqual(['1: 1 of its 2 days proven closed']);
      expect(fns()).toEqual(['finalizeCustodyEra']);
      expect(d.eras[0].terminal).toBe(true);
      expect(d.baseline).toBe(50n);
    });

    it('moves its era floor only on what the finalized block shows, so a reorged finalization is sent again (Codex #2993 r4)', async () => {
      d.eras = [
        { holderRow: 50n, daysClosed: 2n, boundaryDay: 0n, terminal: false, stagedFresh: 0n },
        { holderRow: 0n, daysClosed: 0n, boundaryDay: 2n, terminal: false, stagedFresh: 0n },
      ];
      d.final = { closed: d.closed, eras: d.eras.map((e) => ({ ...e })) };
      let r = await run();
      expect(r.erasFinalized).toEqual([0]);
      expect(cursors.rows.has(ERA_FLOOR_ITEM), 'finalized at the head, not yet final').toBe(false);
      d.eras[0].terminal = false; // the finalization is reorged out
      r = await run();
      expect(r.erasFinalized, 'still above the floor, so finalized again').toEqual([0]);
      d.final = null;
      await run();
      expect(cursors.rows.get(ERA_FLOOR_ITEM)).toBe('1');
    });

    it(`reaches an era more than ${MAX_ERAS} role changes back, rotating above a floor of finalized ones`, async () => {
      // Era 0 waits on a day; eras 1..(MAX_ERAS + 1) are ready; then a live era.
      d.eras = [{ holderRow: 5n, daysClosed: 0n, boundaryDay: 0n, terminal: false, stagedFresh: 0n }];
      for (let i = 1; i <= MAX_ERAS + 1; i++) d.eras.push({ holderRow: 1n, daysClosed: 1n, boundaryDay: BigInt(i), terminal: false, stagedFresh: 0n });
      d.eras.push({ holderRow: 0n, daysClosed: 0n, boundaryDay: BigInt(MAX_ERAS + 2), terminal: false, stagedFresh: 0n });
      const r = await run();
      expect(r.erasWaiting).toEqual(['0: 0 of its 1 days proven closed']);
      expect(r.erasFinalized).toEqual(Array.from({ length: MAX_ERAS - 1 }, (_, i) => i + 1).slice(0, MAX_SENDS_PER_RUN));
      expect(cursors.rows.get(ERA_FLOOR_ITEM), 'the floor stays below the era that waits').toBeUndefined();
      // Runs continue the rotation until every ready era is finalized.
      for (let i = 0; i < 10 && d.eras.slice(1, -1).some((x) => !x.terminal); i++) await run();
      expect(d.eras.slice(1, -1).every((x) => x.terminal), 'every ready era, the oldest included').toBe(true);
      d.eras[0].daysClosed = 1n;
      const finalized: number[] = [];
      for (let i = 0; i < 3 && !d.eras[0].terminal; i++) finalized.push(...(await run()).erasFinalized);
      expect(finalized, 'the era that waited, once its day closes, when the rotation is back at the floor').toEqual([0]);
      for (let i = 0; i < 3; i++) await run();
      expect(cursors.rows.get(ERA_FLOOR_ITEM), 'then the floor passes every finalized era').toBe(String(MAX_ERAS + 2));
    });

    it('drains pending surplus on an active chain', async () => {
      d.pendingSurplus = 70n;
      const r = await run();
      expect(r.drained).toBe(70n);
      expect(d.pendingSurplus).toBe(0n);
      expect(d.sent).toEqual([{ fn: 'drainPendingSurplus', args: [70n] }]);
    });

    it('on a Detached chain leaves pending surplus for the return transport, naming it', async () => {
      d.role = ROLE_DETACHED;
      d.eras = [
        { holderRow: 50n, daysClosed: 2n, boundaryDay: 0n, terminal: false, stagedFresh: 0n },
        { holderRow: 0n, daysClosed: 0n, boundaryDay: 2n, terminal: false, stagedFresh: 0n },
      ];
      const r = await run();
      expect(r.erasFinalized).toEqual([0]);
      expect(fns()).toEqual(['finalizeCustodyEra']);
      expect(r.surplusForReturn).toBe(50n);
      expect(r.drained).toBe(0n);
      expect(describeReport(r)).toMatch(/surplus-awaiting-return-transport=50/);
    });
  });

  describe('park and prune', () => {
    it('parks an epoch once every day it lists is closed, its membership whole and nothing references it', async () => {
      closeAllButDay(3);
      d.addBatch(batchId(1), { days: [1, 2], balance: 9n });
      d.addBatch(batchId(2), { days: [2, 3], balance: 8n }); // lists day 3, closed only this run
      d.addBatch(batchId(3), { days: [1], balance: 7n, references: 1n });
      d.addBatch(batchId(4), { days: [2], dayCount: 2, indexedDays: 1, balance: 6n });
      const r = await run();
      expect(r.daysClosed).toEqual([3]);
      expect(r.parked).toEqual([
        { batchId: batchId(1), pages: 1, state: 'parked', amount: 9n },
        { batchId: batchId(2), pages: 1, state: 'parked', amount: 8n },
      ]);
      expect(fns()).toEqual(['startDayClosure', 'parkTransportBatchRemainder', 'parkTransportBatchRemainder']);
      expect(describeReport(r)).toMatch(/release is the administrator's acknowledgment/);
      // Already parked: the next run sends nothing.
      d.sent = [];
      expect((await run()).parked).toEqual([]);
      expect(d.sent).toEqual([]);
    });

    it('reports a landed park page whose outcome it could not read, instead of failing the run (Codex #3010)', async () => {
      closeAllButDay(-1);
      d.addBatch(batchId(1), { days: [1, 2], balance: 9n });
      // The admission read succeeds; the read after the landed page fails.
      d.failAfter.set('getTransportRemainder', { left: 1, error: () => new Error('remainder read failed') });
      const r = await run();
      expect(fns()).toEqual(['parkTransportBatchRemainder']);
      expect(r.parked).toEqual([{ batchId: batchId(1), pages: 1, state: 'unread', amount: null }]);
      expect(describeReport(r)).toContain(`parked=${batchId(1).slice(0, 10)}(1 page(s), outcome unread)`);
      expect(describeReport(r)).not.toMatch(/administrator's acknowledgment/);
      expect(r.unread.has(`park:${batchId(1).slice(0, 10)}`)).toBe(true);
    });

    it('parks on a closed day below the closure floor and outside any one window, by rotating over every provable day', async () => {
      d.today = 30;
      d.frontiers = [100, 100];
      for (let x = 0; x < d.today; x++) d.closed.add(x);
      d.addBatch(batchId(1), { days: [2], balance: 9n });
      d.addBatch(batchId(2), { days: [25], balance: 4n });
      const parked: string[] = [];
      for (let i = 0; i < 3; i++) for (const p of (await run({ windowDays: 10 })).parked) parked.push(p.batchId);
      expect(parked.sort()).toEqual([batchId(1), batchId(2)].sort());
      expect(cursors.rows.get(CLOSURE_FLOOR_ITEM), 'every day below the floor is closed').toBe('30');
    });

    it(`discovers a day's epochs ${MAX_BATCHES_PER_DAY} a run from where the last run stopped, so one past the first page is parked`, async () => {
      closeAllButDay(99);
      for (let i = 1; i <= MAX_BATCHES_PER_DAY + 1; i++) d.addBatch(batchId(i), { days: [2], balance: BigInt(i) });
      const parked = new Set<string>();
      let runs = 0;
      while (parked.size < MAX_BATCHES_PER_DAY + 1 && runs < 10) {
        // eslint-disable-next-line no-await-in-loop
        for (const p of (await run()).parked) parked.add(p.batchId);
        runs += 1;
        if (runs === 2) expect(parked.has(batchId(MAX_BATCHES_PER_DAY + 1)), 'the epoch past the first page, on the second run').toBe(true);
      }
      expect(parked.size).toBe(MAX_BATCHES_PER_DAY + 1);
      // A stored node no longer in the day's list starts the next run at the head.
      cursors.rows.set(parkCursorItem(2), `0x${'ee'.repeat(32)}`);
      await run();
      expect(cursors.rows.get(parkCursorItem(2))).toBe(ZERO32);
    });

    it('does not park an epoch listing a day still open', async () => {
      closeAllButDay(3);
      d.addEntry({ side: SIDE_LENDER, startDay: 3, endDay: 4, perDay: 1n, open: true });
      d.addBatch(batchId(1), { days: [2, 3], balance: 9n });
      const r = await run();
      expect(r.parked).toEqual([]);
      expect(d.sent).toEqual([]);
    });

    it('prunes an open day\'s cursor past a plainly exhausted epoch, and only that', async () => {
      closeAllButDay(3);
      d.addEntry({ side: SIDE_LENDER, startDay: 3, endDay: 4, perDay: 1n, open: true });
      d.addBatch(batchId(1), { days: [3], balance: 0n });
      d.addBatch(batchId(2), { days: [3], balance: 5n });
      const r = await run();
      expect(r.pruned).toEqual([3]);
      expect(d.dayCursor.get(3)).toBe(1);
      expect(fns()).toEqual(['epochPruneTransportDayCursor']);
      // The next epoch holds value: nothing more to prune.
      d.sent = [];
      expect((await run()).pruned).toEqual([]);
      expect(d.sent).toEqual([]);
    });
  });

  describe('removed destinations (Base)', () => {
    const DST = 97;
    beforeEach(() => {
      d.role = ROLE_CANONICAL;
      closeAllButDay(-1);
    });
    const finalizeThrough = (n: number) => {
      for (let x = 0; x < n; x++) d.globalFinalized.add(x);
    };

    it(`continues a removed chain's release ${RELEASE_DAYS} days a call until it is done, and moves the floor past its row`, async () => {
      ledger.add(DST);
      d.releases.set(DST, { bound: 300, cursor: 0 });
      finalizeThrough(300);
      const r = await run();
      expect(fns()).toEqual(['continueRemitDestinationRelease', 'continueRemitDestinationRelease', 'continueRemitDestinationRelease']);
      expect(d.sent[0].args).toEqual([DST, BigInt(RELEASE_DAYS)]);
      expect(d.releases.get(DST)).toEqual({ bound: 300, cursor: 300 });
      expect(r.released).toEqual([{ chain: DST, from: 0, walks: 3, to: 300, bound: 300 }]);
      expect(describeReport(r)).toContain(`released=chain ${DST} days 0..299 in 3 walk(s) (done)`);
      expect(cursors.rows.get(RELEASE_FLOOR_ITEM), 'every row below the floor is released').toBe(encodePos(ledger.rows[0]));
      // Nothing is left: the next run sends nothing and reads from the floor.
      d.sent = [];
      await run();
      expect(d.sent).toEqual([]);
      expect(ledger.pages[ledger.pages.length - 1], 'the next run reads after the floor').toEqual({ block: 1, log: 0 });
    });

    it('sends nothing while the release waits on a day that is not finalized, and keeps the row above the floor', async () => {
      ledger.add(DST);
      d.releases.set(DST, { bound: 40, cursor: 12 });
      finalizeThrough(12);
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.releaseWaiting).toEqual([`${DST}: day 12 of 40 is not finalized yet`]);
      expect(r.refused.size).toBe(0);
      expect(cursors.rows.has(RELEASE_FLOOR_ITEM)).toBe(false);
      // Once the days finalize, the walk goes out.
      finalizeThrough(40);
      expect((await run()).released).toEqual([{ chain: DST, from: 12, walks: 1, to: 40, bound: 40 }]);
    });

    it('keeps the walks that landed, and says where they left the release is unread, when the read after one fails (Codex #3010)', async () => {
      ledger.add(DST);
      d.releases.set(DST, { bound: 256, cursor: 0 });
      finalizeThrough(256);
      // The gate's read, the step's first read and the read after the first
      // walk succeed; the read after the second fails.
      d.failAfter.set('getRemitDestinationRelease', { left: 2, error: () => new Error('release read failed') });
      const r = await run();
      expect(fns()).toEqual(['continueRemitDestinationRelease', 'continueRemitDestinationRelease']);
      expect(d.releases.get(DST)).toEqual({ bound: 256, cursor: 256 });
      expect(r.released).toEqual([{ chain: DST, from: 0, walks: 2, to: null, bound: null }]);
      expect(describeReport(r)).toContain(`released=chain ${DST} 2 walk(s) from day 0, where they left it unread`);
      expect(r.unread.get(`release:chain ${DST}`)).toMatch(/after a walk/);
      expect(cursors.rows.has(RELEASE_FLOOR_ITEM), 'an unread outcome is not done').toBe(false);
    });

    it('keeps a landed walk when the read after it is the first to fail', async () => {
      ledger.add(DST);
      d.releases.set(DST, { bound: 256, cursor: 0 });
      finalizeThrough(256);
      d.failAfter.set('getRemitDestinationRelease', { left: 1, error: () => new Error('release read failed') });
      const r = await run();
      expect(fns()).toEqual(['continueRemitDestinationRelease']);
      expect(r.released).toEqual([{ chain: DST, from: 0, walks: 1, to: null, bound: null }]);
    });

    it('moves its floor only on what the finalized block shows', async () => {
      ledger.add(DST);
      ledger.add(11155420);
      d.releases.set(DST, { bound: 10, cursor: 0 });
      finalizeThrough(10);
      // The walk landed at the head, but the finalized block still shows the
      // release unfinished: the floor stays below the row, so a reorg that
      // drops the walk leaves it to be walked again.
      d.final = { closed: new Set(), eras: d.eras, releases: new Map([[DST, { bound: 10, cursor: 0 }]]) };
      const r = await run();
      expect(r.released).toEqual([{ chain: DST, from: 0, walks: 1, to: 10, bound: 10 }]);
      expect(cursors.rows.has(RELEASE_FLOOR_ITEM)).toBe(false);
      d.final = { closed: new Set(), eras: d.eras, releases: new Map([[DST, { bound: 10, cursor: 10 }]]) };
      await run();
      expect(cursors.rows.get(RELEASE_FLOOR_ITEM), 'past both rows: the second chain was never removed for real').toBe(encodePos(ledger.rows[1]));
      d.final = 'none';
      cursors.rows.delete(RELEASE_FLOOR_ITEM);
      await run();
      expect(cursors.rows.has(RELEASE_FLOOR_ITEM), 'no finalized block, no floor move').toBe(false);
    });

    it('moves its floor past a removal only once the removal itself is finalized', async () => {
      // Removed and released at the head, in a block above the finalized one:
      // the finalized record is empty, which must not read as a finished
      // release (Codex #3010).
      ledger.add(DST, Number(d.finalNumber) + 5);
      d.releases.set(DST, { bound: 10, cursor: 10 });
      d.final = { closed: new Set(), eras: d.eras, releases: new Map() };
      await run();
      expect(cursors.rows.has(RELEASE_FLOOR_ITEM)).toBe(false);
      ledger.rows[0] = { ...ledger.rows[0], block: Number(d.finalNumber), blockAt: Number(d.finalNumber) };
      d.final = { closed: new Set(), eras: d.eras, releases: new Map([[DST, { bound: 10, cursor: 10 }]]) };
      await run();
      expect(cursors.rows.get(RELEASE_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('passes a row that names no chain, and says so when the ledger cannot be read', async () => {
      ledger.add('not a chain');
      await run();
      expect(d.sent).toEqual([]);
      expect(cursors.rows.get(RELEASE_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
      ledger.fail = true;
      const r = await run();
      expect(r.unread.get('release')).toMatch(/event ledger/);
    });

    it('leaves the release while the protocol is paused, and is Base\'s step only', async () => {
      ledger.add(DST);
      d.releases.set(DST, { bound: 5, cursor: 0 });
      finalizeThrough(5);
      d.paused = true;
      let r = await run();
      expect(d.sent).toEqual([]);
      expect(r.unread.get(`release:chain ${DST}`)).toMatch(/paused/);
      d.paused = false;
      d.role = ROLE_MIRROR;
      r = await run();
      expect(d.sent).toEqual([]);
      expect(ledger.pages, 'a mirror never reads the removals').toHaveLength(1);
    });
  });

  describe('reconciliation queues', () => {
    beforeEach(() => closeAllButDay(-1));

    it(`writes a queue's pending takes ${QUEUE_STEPS} records a call while it holds any, and leaves an empty one alone`, async () => {
      d.queues.fresh.pending = 120n;
      const r = await run();
      expect(fns()).toEqual(['advanceReconciliationQueue', 'advanceReconciliationQueue', 'advanceReconciliationQueue']);
      expect(d.sent[0].args).toEqual([0, BigInt(QUEUE_STEPS)]);
      expect(d.queues.fresh.pending).toBe(0n);
      expect(r.queues).toEqual([{ side: 'fresh', walks: 3, before: 120n, after: 0n }]);
      expect(describeReport(r)).toContain('queue-fresh=3 walk(s), pending 120 before, 0 after (net of other callers)');
    });

    it('reports the walks that landed and the pending figures it read, never their difference as its own writes', async () => {
      // Other outflows add more than each walk writes: the backlog grows
      // while every walk lands and moves the frontier.
      d.queues.fresh.pending = 120n;
      d.queues.fresh.addedAfterWalk = 100n;
      const r = await run();
      expect(r.queues).toEqual([{ side: 'fresh', walks: MAX_SENDS_PER_RUN, before: 120n, after: 120n + BigInt(MAX_SENDS_PER_RUN) * 50n }]);
      expect(r.refused.has('queue:fresh'), 'a walk that moved the frontier is progress').toBe(false);
    });

    it('reports the pending figure after a landed walk as unread when its read fails, not the one before it', async () => {
      d.queues.fresh.pending = 120n;
      d.failAfter.set('getFreshQueueState', { left: 1, error: () => new Error('queue read failed') });
      const r = await run();
      expect(fns()).toEqual(['advanceReconciliationQueue']);
      expect(r.queues).toEqual([{ side: 'fresh', walks: 1, before: 120n, after: null }]);
      expect(r.unread.has('queue:fresh')).toBe(true);
      expect(describeReport(r)).toContain('queue-fresh=1 walk(s), pending 120 before, unread after (net of other callers)');
    });

    it('keeps the landed walks of a queue when the run deadline passes as it is re-read (Codex #3010)', async () => {
      d.queues.fresh.pending = 120n;
      // The first read succeeds; the read after the first walk is past the deadline.
      d.failAfter.set('getFreshQueueState', { left: 1, error: () => new PastRunDeadline('past the deadline') });
      const r = await run();
      expect(fns()).toEqual(['advanceReconciliationQueue']);
      expect(r.queues).toEqual([{ side: 'fresh', walks: 1, before: 120n, after: null }]);
      expect(r.unread.get('run')).toMatch(/deadline/);
    });

    it('stops on a walk that moves nothing, and works while the protocol is paused', async () => {
      d.paused = true;
      d.queues.recycled.pending = 30n;
      d.queues.recycled.perWalk = 0n;
      const r = await run();
      expect(fns()).toEqual(['advanceReconciliationQueue']);
      expect(d.sent[0].args).toEqual([1, BigInt(QUEUE_STEPS)]);
      expect(r.refused.get('queue:recycled')).toMatch(/moved neither/);
      expect(r.queues).toEqual([{ side: 'recycled', walks: 1, before: 30n, after: 30n }]);
    });

    it(`shares the run's ${MAX_SENDS_PER_RUN} sends`, async () => {
      d.queues.fresh.pending = 10_000n;
      const r = await run();
      expect(d.sent).toHaveLength(MAX_SENDS_PER_RUN);
      expect(r.stopped).toBe('send-budget');
    });
  });

  it('the run\'s line names what it did', async () => {
    closeAllButDay(2);
    const r = await run();
    expect(describeReport(r)).toBe(`[keeper] rewardCloseOut chain=${CHAIN} eras-finalized=none days-closed=2 parked=none pruned=none`);
  });
});
