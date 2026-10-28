/**
 * #2984 — the reward zeroed-day pass. Pinned in two layers:
 *
 *   - the PURE rules: which step a zeroed day calls for (quote, refine,
 *     lapse, short lapse, wait, done), and when a quote accumulation can no
 *     longer complete by paging;
 *   - whole RUNS against a fake mirror that applies the contract's own
 *     admission rules: the pages and the dispatch a quote takes, the fee and
 *     its ceiling, the lapses and their notices, and that nothing is sent
 *     for a day the pass cannot finish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Address, type PublicClient } from 'viem';
import {
  ABI,
  PAGE_IDS,
  accumulationWedge,
  describeReport,
  zeroedDayOnce,
  zeroedDayStep,
  DAY_FLOOR_ITEM,
  type ZeroedDayState,
} from '../src/rewardZeroedDay';
import { SIDE_BORROWER, SIDE_LENDER, type ScannedEntry } from '../src/rewardEntries';
import type { SendFeeCeiling } from '../src/stepSender';
import { memoryScanCursors, type ScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { OpsAlertOutcome } from '../src/opsAlert';

const CHAIN = 421614;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const MESSENGER: Address = '0x00000000000000000000000000000000000000c2';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const OTHER: Address = '0x00000000000000000000000000000000000000ab';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ROLE_CANONICAL = 0;
const ROLE_MIRROR = 1;
const NOW = 1_800_000_000n;
const WINDOW = 7n * 86_400n;
const FEE = 300n;
const CAP: SendFeeCeiling = { wei: 1_000n, from: 'the test' };
/** The fake's Δq: every entry quotes twice its per-day figure. */
const DELTA = 2n;

const state = (o: Partial<ZeroedDayState> = {}): ZeroedDayState => ({
  day: 3,
  closeSentAt: 1n,
  stamped: true,
  accum: { cursorLender: 0n, cursorBorrower: 0n, accumLender: 0n, accumBorrower: 0n, consLender: 0n, consBorrower: 0n, sentAt: 0n },
  clock: { finalizedAt: NOW - 86_400n, scheduleVersion: 1, lapseWindowSeconds: WINDOW },
  comp: { compensated: false, provisional: false, lenderPool: 0n, borrowerPool: 0n },
  resolvedZero: false,
  loss: { recorded: false, partialFigure: false },
  shortDeadline: null,
  ...o,
});

describe('the pure rules', () => {
  it('quotes a zeroed day once its close ran and its pool stamp is in', () => {
    expect(zeroedDayStep(state(), NOW)).toEqual({ kind: 'quote' });
    expect(zeroedDayStep(state({ closeSentAt: 0n }), NOW)).toMatchObject({ kind: 'wait', why: /local interest close/ });
    expect(zeroedDayStep(state({ stamped: false }), NOW)).toMatchObject({ kind: 'wait', why: /pool stamp/ });
  });

  it('waits once quoted, until compensation or its expiry', () => {
    const quoted = state({ accum: { ...state().accum, sentAt: 5n } });
    expect(zeroedDayStep(quoted, NOW)).toMatchObject({ kind: 'wait', why: /awaiting compensation/ });
  });

  it('lapses a never-compensated day past its expiry, quoted or not, but never before its close', () => {
    const expired = state({ clock: { finalizedAt: NOW - WINDOW - 1n, scheduleVersion: 1, lapseWindowSeconds: WINDOW } });
    expect(zeroedDayStep(expired, NOW)).toEqual({ kind: 'lapse', expiry: NOW - 1n });
    expect(zeroedDayStep({ ...expired, accum: { ...expired.accum, sentAt: 5n } }, NOW).kind).toBe('lapse');
    expect(zeroedDayStep({ ...expired, closeSentAt: 0n }, NOW).kind, 'no lapse before the local close').toBe('wait');
    expect(zeroedDayStep({ ...expired, clock: { ...expired.clock, scheduleVersion: 0 } }, NOW).kind, 'version 0 is not lapse-eligible').toBe('quote');
  });

  it('refines a lapsed day whose loss record is partial, and is done once it is exact', () => {
    expect(zeroedDayStep(state({ loss: { recorded: true, partialFigure: true } }), NOW)).toEqual({ kind: 'refine' });
    expect(zeroedDayStep(state({ loss: { recorded: true, partialFigure: false } }), NOW)).toEqual({ kind: 'done' });
    expect(zeroedDayStep(state({ resolvedZero: true }), NOW)).toEqual({ kind: 'done' });
  });

  it('short-lapses a confirmed day funded below its quote, only past its deadline', () => {
    const funded = state({
      accum: { ...state().accum, accumLender: 10n, accumBorrower: 4n, sentAt: 5n },
      comp: { compensated: true, provisional: false, lenderPool: 6n, borrowerPool: 4n },
      shortDeadline: NOW - 1n,
    });
    expect(zeroedDayStep(funded, NOW)).toEqual({ kind: 'short-lapse', deadline: NOW - 1n });
    expect(zeroedDayStep({ ...funded, shortDeadline: NOW }, NOW)).toMatchObject({ kind: 'wait', why: /short lapse after/ });
    expect(zeroedDayStep({ ...funded, comp: { ...funded.comp, lenderPool: 10n } }, NOW), 'fully funded').toEqual({ kind: 'done' });
    expect(zeroedDayStep({ ...funded, comp: { ...funded.comp, provisional: true } }, NOW)).toMatchObject({ kind: 'wait', why: /provisional/ });
    expect(zeroedDayStep({ ...funded, clock: { ...funded.clock, finalizedAt: NOW - WINDOW - 1n } }, NOW).kind, 'a compensated day never takes the full lapse').toBe('short-lapse');
  });

  it('accumulationWedge: a cursor past covering ids never submitted', () => {
    const cover: ScannedEntry[] = [3, 5, 9].map((id) => ({ id: BigInt(id), side: SIDE_LENDER, first: 1, endDay: 9, perDayNumeraire18: BigInt(id) }));
    expect(accumulationWedge(cover, 0n, 0n)).toBeNull();
    expect(accumulationWedge(cover, 5n, 8n)).toBeNull();
    expect(accumulationWedge(cover, 5n, 5n)).toMatch(/cursor sits at entry 5 with 5 conserved, where the covering entries up to it add up to 8/);
    expect(accumulationWedge(cover, 9n, 9n), 'a cursor parked past ids 3 and 5').not.toBeNull();
  });
});

// ─── The fake mirror ────────────────────────────────────────────────────────

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

interface Entry {
  startDay: number;
  endDay: number;
  side: number;
  perDay: bigint;
}

interface Day {
  zeroed: boolean;
  closeSentAt: bigint;
  stamped: boolean;
  cursor: [bigint, bigint];
  accum: [bigint, bigint];
  cons: [bigint, bigint];
  sentAt: bigint;
  finalizedAt: bigint;
  version: number;
  compensated: boolean;
  provisional: boolean;
  pools: [bigint, bigint];
  resolvedZero: boolean;
  lapsed: boolean;
  shortLapsed: boolean;
  loss: { lender18: bigint; borrower18: bigint; partialFigure: boolean; shortLapse: boolean; recorded: boolean };
  shortDeadline: bigint;
}

class FakeMirror {
  chainNamed = CHAIN;
  role = ROLE_MIRROR;
  today = 10;
  now = NOW;
  entries: Entry[] = [];
  days = new Map<number, Day>();
  /** Days up to this one, not zeroed, have their clock installed. */
  clockedThrough = -1;
  fee = FEE;
  paused = false;
  sent: { fn: string; args: readonly unknown[]; value: bigint }[] = [];

  zero(day: number, o: Partial<Day> = {}): Day {
    const d: Day = {
      zeroed: true,
      closeSentAt: 1n,
      stamped: true,
      cursor: [0n, 0n],
      accum: [0n, 0n],
      cons: [0n, 0n],
      sentAt: 0n,
      finalizedAt: NOW - 86_400n,
      version: 1,
      compensated: false,
      provisional: false,
      pools: [0n, 0n],
      resolvedZero: false,
      lapsed: false,
      shortLapsed: false,
      loss: { lender18: 0n, borrower18: 0n, partialFigure: false, shortLapse: false, recorded: false },
      shortDeadline: 0n,
      ...o,
    };
    this.days.set(day, d);
    return d;
  }

  addEntry(side: number, startDay: number, endDay: number, perDay: bigint): number {
    this.entries.push({ side, startDay, endDay, perDay });
    return this.entries.length;
  }

  private covering(day: number, side: number): number[] {
    const out: number[] = [];
    this.entries.forEach((x, i) => {
      const first = x.startDay === 0 ? 1 : x.startDay;
      if (x.side === side && day >= first && day < x.endDay) out.push(i + 1);
    });
    return out;
  }

  private totals(day: number): [bigint, bigint] {
    const sum = (side: number) => this.covering(day, side).reduce((a, id) => a + this.entries[id - 1].perDay, 0n);
    return [sum(SIDE_LENDER), sum(SIDE_BORROWER)];
  }

  private day(d: unknown): Day | undefined {
    return this.days.get(Number(d));
  }

  readContract = async ({ address, functionName, args = [], blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    if (address === MESSENGER) {
      if (functionName !== 'quoteSendCompQuote') throw new Error(`unexpected messenger read ${functionName}`);
      return this.fee;
    }
    if (blockNumber !== undefined && blockNumber !== this.finalNumber) throw new Error(`read at unexpected block ${blockNumber}`);
    const d = blockNumber !== undefined && this.finalDays !== null ? this.finalDays.get(Number(a[0])) : this.day(a[0]);
    switch (functionName) {
      case 'getRewardReporterConfig':
        return [MESSENGER, this.chainNamed, 84532, false, 3600n];
      case 'getRewardRole':
        return this.role;
      case 'paused':
        return this.paused;
      case 'getInteractionCurrentDay':
        return [BigInt(this.today), true];
      case 'getDayDeliberatelyZeroed':
        return d?.zeroed ?? false;
      case 'getChainReportSentAt':
        return d!.closeSentAt;
      case 'getDayPoolStamp':
        return [d!.stamped, 0n, 0n, 0n, 0n];
      case 'getCompQuoteAccum':
        return [d!.cursor[0], d!.cursor[1], d!.accum[0], d!.accum[1], d!.cons[0], d!.cons[1], d!.sentAt];
      case 'getDayLapseClock':
        return d ? [d.finalizedAt, d.version, WINDOW, 6n * 3600n] : [Number(a[0]) <= this.clockedThrough ? NOW - 86_400n : 0n, 0, 0n, 0n];
      case 'getDayCompensation':
        return { lenderPool18: d!.pools[0], borrowerPool18: d!.pools[1], armedFreshCounted: 0n, creditedAmount: 0n, compensated: d!.compensated, provisional: d!.provisional, provisionalEra: ZERO, remitId: 0n, provisionalHeld: 0n, provisionalHeldInCustody: false };
      case 'getDayResolvedZero':
        return d!.resolvedZero;
      case 'getLapsedDayLoss':
        return d!.loss;
      case 'getShortLapseDeadline':
        return [0n, 0n, d!.shortDeadline];
      case 'getInteractionDayEntry': {
        const [l, b] = this.totals(Number(a[0]));
        return [0n, 0n, l, b];
      }
      case 'getRewardEntriesRange': {
        const from = Number(a[0]);
        return this.entries.slice(from - 1, from - 1 + Number(a[1])).map((x) => ({ user: OTHER, loanId: 1n, startDay: x.startDay, endDay: x.endDay, side: x.side, processed: false, forfeited: false, closed: false, perDayNumeraire18: x.perDay, expiryBegun: false }));
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  multicall = async ({ contracts, blockNumber }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; blockNumber?: bigint }) =>
    Promise.all(
      contracts.map(async (c) => {
        try {
          return { status: 'success' as const, result: await this.readContract({ ...c, blockNumber }) };
        } catch (error) {
          return { status: 'failure' as const, error };
        }
      }),
    );

  /** The zeroed days as the finalized block shows them, when it lags the
   *  head; null reads the head's days there too. */
  finalDays: Map<number, Day> | null = null;
  readonly finalNumber = 100n;

  getBlock = async ({ blockTag }: { blockTag?: string } = {}) =>
    blockTag === 'finalized' ? { number: this.finalNumber, timestamp: this.now } : { timestamp: this.now };

  private admit(functionName: string, a: readonly any[], value: bigint): () => void {
    const d = this.day(a[0]);
    const dayId = a[0] as bigint;
    switch (functionName) {
      case 'accumulateCompQuoteBatch': {
        if (!d?.zeroed) throw revert('CompQuoteDayNotZeroed', [dayId]);
        if (d.sentAt !== 0n) throw revert('CompQuoteAlreadyDispatched', [dayId]);
        const side = Number(a[1]);
        let cursor = d.cursor[side];
        let add = 0n;
        const cover = new Set(this.covering(Number(dayId), side));
        for (const raw of a[2] as bigint[]) {
          if (raw <= cursor) throw revert('CommitmentEntriesNotAscending', [raw]);
          if (!cover.has(Number(raw))) throw revert('CommitmentEntryMismatch', [raw]);
          cursor = raw;
          add += this.entries[Number(raw) - 1].perDay;
        }
        return () => {
          d.cursor[side] = cursor;
          d.cons[side] += add;
          d.accum[side] += add * DELTA;
          if (d.lapsed && d.loss.partialFigure) {
            d.loss.lender18 = d.accum[0];
            d.loss.borrower18 = d.accum[1];
            const [l, b] = this.totals(Number(dayId));
            if (d.cons[0] === l && d.cons[1] === b) d.loss.partialFigure = false;
          }
        };
      }
      case 'quoteZeroedDayCompensation': {
        if (!d?.zeroed) throw revert('CompQuoteDayNotZeroed', [dayId]);
        if (d.lapsed || d.shortLapsed) throw revert('CompQuoteDayLapsed', [dayId]);
        const [l, b] = this.totals(Number(dayId));
        if (d.cons[0] !== l) throw revert('CompQuoteIncomplete', [dayId, 0, d.cons[0], l]);
        if (d.cons[1] !== b) throw revert('CompQuoteIncomplete', [dayId, 1, d.cons[1], b]);
        return () => {
          if (d.accum[0] === 0n && d.accum[1] === 0n) d.resolvedZero = true;
          if (d.sentAt === 0n) d.sentAt = this.now;
        };
      }
      case 'lapseZeroedDay': {
        if (!d?.zeroed) throw revert('LapseDayNotZeroed', [dayId]);
        if (d.lapsed || d.shortLapsed || d.resolvedZero) throw revert('LapseDayAlreadyTerminal', [dayId]);
        if (d.compensated) throw revert('LapseDayCompensated', [dayId]);
        const expiry = d.finalizedAt + WINDOW;
        if (this.now <= expiry) throw revert('LapseDayNotExpired', [dayId, expiry]);
        return () => {
          d.lapsed = true;
          const [l, b] = this.totals(Number(dayId));
          d.loss = { lender18: d.accum[0], borrower18: d.accum[1], partialFigure: !(d.cons[0] === l && d.cons[1] === b), shortLapse: false, recorded: true };
        };
      }
      case 'lapseShortCompensatedDay': {
        if (!d?.compensated || d.provisional) throw revert('ShortLapseNotCompensated', [dayId]);
        if (d.lapsed || d.shortLapsed || d.resolvedZero) throw revert('LapseDayAlreadyTerminal', [dayId]);
        if (this.now <= d.shortDeadline) throw revert('ShortLapseDeadlineNotReached', [dayId, d.shortDeadline]);
        return () => {
          d.shortLapsed = true;
          d.loss = { lender18: d.accum[0] - d.pools[0], borrower18: d.accum[1] > d.pools[1] ? d.accum[1] - d.pools[1] : 0n, partialFigure: false, shortLapse: true, recorded: true };
        };
      }
      default:
        void value;
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value: bigint }) => {
    this.admit(functionName, args, value);
    return { result: undefined };
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
        writeContract: async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value: bigint }) => {
          this.admit(functionName, args, value)();
          this.sent.push({ fn: functionName, args, value });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

describe('a run', () => {
  let m: FakeMirror;
  let alerts: { key: string; text: string }[];
  /** What the next alert posts resolve to. */
  let alertOutcome: OpsAlertOutcome;

  beforeEach(() => {
    m = new FakeMirror();
    alerts = [];
    alertOutcome = 'sent';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (o: { keeper?: Address | null; cap?: SendFeeCeiling; windowDays?: number; cursors?: ScanCursors } = {}) =>
    zeroedDayOnce(CHAIN, DIAMOND, {
      client: m.client(),
      readClient: m.client(),
      context: () => m.ctx(),
      keeper: o.keeper === undefined ? KEEPER : o.keeper,
      sendDeadline: Number.POSITIVE_INFINITY,
      windowDays: o.windowDays ?? 60,
      cursors: o.cursors ?? memoryScanCursors(),
      feeCeiling: o.cap ?? CAP,
      alert: async (key, text) => {
        alerts.push({ key, text });
        return alertOutcome;
      },
    });
  const fns = () => m.sent.map((s) => s.fn);

  it('does nothing on a chain with no zeroed day', async () => {
    const r = await run();
    expect(r.zeroed).toEqual([]);
    expect(m.sent).toEqual([]);
    expect(describeReport(r)).toBe(`[keeper] rewardZeroedDay chain=${CHAIN} zeroed=none quoted=none lapsed=none short-lapsed=none`);
  });

  it('accumulates a zeroed day\'s quote per side, ascending, then dispatches it paying the quoted fee', async () => {
    m.zero(3);
    m.addEntry(SIDE_LENDER, 1, 5, 10n); // 1
    m.addEntry(SIDE_BORROWER, 2, 4, 4n); // 2
    m.addEntry(SIDE_LENDER, 3, 9, 6n); // 3
    m.addEntry(SIDE_LENDER, 4, 9, 99n); // 4, not on day 3
    const r = await run();
    expect(fns()).toEqual(['accumulateCompQuoteBatch', 'accumulateCompQuoteBatch', 'quoteZeroedDayCompensation']);
    expect(m.sent[0].args).toEqual([3n, SIDE_LENDER, [1n, 3n]]);
    expect(m.sent[1].args).toEqual([3n, SIDE_BORROWER, [2n]]);
    expect(m.sent[2]).toEqual({ fn: 'quoteZeroedDayCompensation', args: [3n, KEEPER], value: FEE });
    expect(r.quoted).toEqual([3]);
    expect(r.pagesLanded).toBe(2);
    expect(m.days.get(3)!.sentAt).toBe(NOW);
    // Quoted: the next run waits.
    m.sent = [];
    const again = await run();
    expect(m.sent).toEqual([]);
    expect(again.waiting[0]).toMatch(/^3: quoted; awaiting compensation/);
  });

  it('a day with nothing owed dispatches (0, 0) at once, its resolved-zero terminal', async () => {
    m.zero(4);
    const r = await run();
    expect(fns()).toEqual(['quoteZeroedDayCompensation']);
    expect(r.quoted).toEqual([4]);
    expect(m.days.get(4)!.resolvedZero).toBe(true);
  });

  it(`pages ${PAGE_IDS} ids at a time`, async () => {
    m.zero(2);
    for (let i = 0; i < PAGE_IDS + 1; i++) m.addEntry(SIDE_LENDER, 1, 3, 1n);
    await run();
    expect(fns()).toEqual(['accumulateCompQuoteBatch', 'accumulateCompQuoteBatch', 'quoteZeroedDayCompensation']);
    expect((m.sent[1].args[2] as bigint[])).toEqual([BigInt(PAGE_IDS + 1)]);
  });

  it('pays no fee above its ceiling: the quote stays owed, the pages stand', async () => {
    m.zero(3);
    m.addEntry(SIDE_LENDER, 1, 5, 10n);
    m.fee = CAP.wei + 1n;
    const r = await run();
    expect(fns()).toEqual(['accumulateCompQuoteBatch']);
    expect(r.quoted).toEqual([]);
    expect(r.refused.get('quote:3')).toMatch(/above this keeper's ceiling/);
    m.fee = FEE;
    m.sent = [];
    await run();
    expect(fns(), 'the next run dispatches, with nothing left to page').toEqual(['quoteZeroedDayCompensation']);
  });

  it('starts nothing on a scan that does not account for the day\'s totals', async () => {
    m.zero(3);
    m.addEntry(SIDE_LENDER, 1, 5, 10n);
    const totals = m.readContract;
    m.readContract = async (q) => (q.functionName === 'getInteractionDayEntry' ? [0n, 0n, 11n, 0n] : totals(q));
    const r = await run();
    expect(m.sent).toEqual([]);
    expect(r.scanGap).toEqual([3]);
    expect(r.unread.get('quote:3')).toMatch(/lender entries sum to 10 of a 11 total/);
  });

  it('a cursor parked past covering entries is alerted for the administrator, and that side is not sent into', async () => {
    m.zero(3, { cursor: [3n, 0n] });
    m.addEntry(SIDE_LENDER, 1, 5, 10n);
    m.addEntry(SIDE_BORROWER, 1, 5, 4n);
    m.addEntry(SIDE_LENDER, 1, 5, 6n);
    const r = await run();
    expect(fns(), 'the borrower side still pages; nothing dispatches').toEqual(['accumulateCompQuoteBatch']);
    expect(m.sent[0].args[1]).toBe(SIDE_BORROWER);
    expect(r.wedged).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe(`zeroed-day-wedge:${CHAIN}:3:${SIDE_LENDER}`);
    expect(alerts[0].text).toMatch(/resetCompQuoteAccumulation\(3, 0\)/);
  });

  it('lapses a never-compensated day past its expiry, notices the loss, then refines a partial record to exact', async () => {
    m.zero(3, { finalizedAt: NOW - WINDOW - 1n });
    m.addEntry(SIDE_LENDER, 1, 5, 10n);
    const r = await run();
    expect(fns()).toEqual(['lapseZeroedDay']);
    expect(r.lapsed).toEqual([3]);
    expect(alerts.map((a) => a.key)).toEqual([`zeroed-day-lapse:${CHAIN}:3:partial`]);
    expect(alerts[0].text).toMatch(/never compensated .* recorded loss: lender side 0, borrower side 0 \(VPFI, 18 decimals\).*PARTIAL/);
    m.sent = [];
    const next = await run();
    expect(fns(), 'refined: accumulated, never dispatched after a lapse').toEqual(['accumulateCompQuoteBatch']);
    expect(next.refined).toEqual([3]);
    expect(m.days.get(3)!.loss).toMatchObject({ lender18: 20n, partialFigure: false });
    m.sent = [];
    alerts = [];
    await run();
    expect(m.sent).toEqual([]);
    expect(alerts.map((a) => a.key), 'the exact figure is noticed once it is exact').toEqual([`zeroed-day-lapse:${CHAIN}:3:exact`]);
    expect(alerts[0].text).toMatch(/lender side 20, borrower side 0 \(VPFI, 18 decimals\)\.$/);
  });

  it('reaches a zeroed day far older than one window, rotating above a floor of settled days', async () => {
    m.today = 100;
    m.clockedThrough = 99;
    m.zero(5, { finalizedAt: NOW - WINDOW - 1n });
    m.addEntry(SIDE_LENDER, 1, 7, 10n);
    const cursors = memoryScanCursors();
    const runs = async (n: number, until: () => boolean) => {
      for (let i = 0; i < n && !until(); i++) await run({ windowDays: 10, cursors });
    };
    await run({ windowDays: 10, cursors });
    expect(m.days.get(5)!.lapsed, 'the first window reaches it').toBe(true);
    expect(cursors.rows.get(DAY_FLOOR_ITEM), 'the floor stops at the zeroed day not yet at a terminal').toBe('5');
    await runs(12, () => !m.days.get(5)!.loss.partialFigure);
    expect(m.days.get(5)!.loss, 'refined once the rotation is back at it').toMatchObject({ partialFigure: false });
    await runs(30, () => cursors.rows.get(DAY_FLOOR_ITEM) === '100');
    expect(cursors.rows.get(DAY_FLOOR_ITEM), 'then the floor passes every settled day').toBe('100');
  });

  it('moves its day floor only on what the finalized block shows, so a reorged lapse is sent again (Codex #2993 r4)', async () => {
    m.today = 6;
    m.clockedThrough = 5;
    m.zero(3, { finalizedAt: NOW - WINDOW - 1n });
    const before = structuredClone(m.days.get(3)!);
    m.finalDays = new Map([[3, structuredClone(before)]]);
    const cursors = memoryScanCursors();
    await run({ cursors });
    expect(fns()).toEqual(['lapseZeroedDay']);
    await run({ cursors });
    expect(cursors.rows.get(DAY_FLOOR_ITEM), 'lapsed at the head, not yet final').toBe('3');
    m.days.set(3, structuredClone(before)); // the lapse is reorged out
    m.sent = [];
    await run({ cursors });
    expect(fns(), 'above the floor, so lapsed again').toEqual(['lapseZeroedDay']);
    m.finalDays = null;
    await run({ cursors });
    await run({ cursors });
    expect(cursors.rows.get(DAY_FLOOR_ITEM)).toBe('6');
  });

  it('short-lapses a compensated day funded below its quote once its deadline passed', async () => {
    m.zero(3, { sentAt: 5n, accum: [20n, 0n], compensated: true, pools: [12n, 0n], shortDeadline: NOW - 1n });
    const r = await run();
    expect(fns()).toEqual(['lapseShortCompensatedDay']);
    expect(r.shortLapsed).toEqual([3]);
    expect(alerts[0].text).toMatch(/funded below its quote past its deadline .* lender side 8/);
  });

  it('retries a lapse notice that did not go out, holding the day above its floor until it does (Codex #3000)', async () => {
    m.today = 6;
    m.clockedThrough = 5;
    m.zero(3, { finalizedAt: NOW - WINDOW - 1n });
    const cursors = memoryScanCursors();
    alertOutcome = 'failed';
    await run({ cursors });
    expect(fns()).toEqual(['lapseZeroedDay']);
    const held = await run({ cursors });
    expect(held.unread.get('notice:3')).toMatch(/did not go out \(failed\)/);
    expect(cursors.rows.get(DAY_FLOOR_ITEM), 'the lapse stands, its notice is still owed').toBe('3');
    expect(alerts.map((a) => a.key)).toEqual([`zeroed-day-lapse:${CHAIN}:3:exact`, `zeroed-day-lapse:${CHAIN}:3:exact`]);
    alertOutcome = 'sent';
    await run({ cursors });
    expect(cursors.rows.get(DAY_FLOOR_ITEM), 'delivered: the floor passes it').toBe('6');
    expect(m.sent.map((x) => x.fn), 'never lapsed twice').toEqual(['lapseZeroedDay']);
  });

  it('notices a lapse another caller made, from the chain\'s record', async () => {
    m.zero(3, { lapsed: true, loss: { lender18: 7n, borrower18: 2n, partialFigure: false, shortLapse: false, recorded: true } });
    await run();
    expect(m.sent).toEqual([]);
    expect(alerts.map((a) => a.key)).toEqual([`zeroed-day-lapse:${CHAIN}:3:exact`]);
    expect(alerts[0].text).toMatch(/never compensated .* lender side 7, borrower side 2 \(VPFI/);
  });

  it('works nothing while the Diamond is paused: none of its calls is pause-guarded on chain (Codex #3000)', async () => {
    m.zero(3, { finalizedAt: NOW - WINDOW - 1n });
    m.zero(4);
    m.paused = true;
    const r = await run();
    expect(m.sent).toEqual([]);
    expect(r.skipped).toMatch(/the Diamond is paused/);
    m.paused = false;
    await run();
    expect(fns()).toEqual(['lapseZeroedDay', 'quoteZeroedDayCompensation']);
  });

  it('leaves a compensated day funded below its quote before its deadline', async () => {
    m.zero(3, { sentAt: 5n, accum: [20n, 0n], compensated: true, pools: [12n, 0n], shortDeadline: NOW + 100n });
    const r = await run();
    expect(m.sent).toEqual([]);
    expect(r.waiting[0]).toMatch(/short lapse after/);
  });

  it('works only a mirror whose Diamond names this chain', async () => {
    m.zero(3);
    m.role = ROLE_CANONICAL;
    expect((await run()).skipped).toMatch(/not Mirror/);
    m.role = ROLE_MIRROR;
    m.chainNamed = 84532;
    expect((await run()).skipped).toMatch(/names itself chain 84532/);
    expect(m.sent).toEqual([]);
  });

  it('dispatches nothing without a signing key, and says so', async () => {
    m.zero(4);
    const r = await run({ keeper: null });
    expect(m.sent).toEqual([]);
    expect(r.unread.get('quote:4')).toMatch(/no signing key/);
  });
});
