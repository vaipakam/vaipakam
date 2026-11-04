/**
 * #3097 — the position upkeep pass: the daily NFT-rental deduction and the
 * backstop fill, run against a fake Diamond that applies the contract's own
 * admission rules to each call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  ABI,
  BACKSTOP_FLOOR_ITEM,
  MAX_DEDUCTIONS_PER_RUN,
  MAX_FILLS_PER_RUN,
  ONE_DAY,
  deductedFee,
  describeReport,
  filledEvent,
  offerDue,
  offerFinished,
  positionUpkeepOnce,
  rentalVerdict,
  runPositionUpkeep,
  type BackstopOffer,
  type RentalLoan,
} from '../src/positionUpkeep';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { SEND_RESERVE_MS } from '../src/runWindow';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { Env } from '../src/env';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const NOW = 10_000_000n;
const START = NOW - 3n * ONE_DAY - 60n;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

/** An NFT rental of 5 days at 100 a day, 3 days of which have elapsed and 2
 *  of them deducted: one day due. */
const rental = (over: Partial<RentalLoan> = {}): RentalLoan => ({
  status: 0,
  assetType: 1,
  principal: 100n,
  startTime: START,
  durationDays: 5n,
  prepayAmount: 300n,
  lastDeductTime: START + 2n * ONE_DAY,
  ...over,
});

/** A borrower offer opted into the backstop, past its eligibility time. */
const optedIn = (over: Partial<BackstopOffer> = {}): BackstopOffer => ({
  offerType: 1,
  accepted: false,
  amountMax: 1_000n,
  amountFilled: 0n,
  expiresAt: NOW + ONE_DAY,
  backstopEligibleAfter: NOW - 60n,
  ...over,
});

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  backstopOn = true;
  loans = new Map<bigint, RentalLoan>();
  offers = new Map<bigint, BackstopOffer>();
  /** The finalized block's view of the offers, when it lags the head. */
  finalOffers: Map<bigint, BackstopOffer> | null = null;
  /** Offers the contract refuses at fill for a reason past the offer's own
   *  record (an intent cap), by error name. */
  fillRefusal = new Map<bigint, string>();
  sent: { fn: string; id: bigint }[] = [];
  simulated: { fn: string; id: bigint }[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  nextLoanId = 900n;

  readContract = async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getActiveLoansCount':
        return BigInt([...this.loans.values()].filter((l) => l.status === 0).length);
      case 'getActiveLoansPaginated': {
        const ids = [...this.loans].filter(([, l]) => l.status === 0).map(([id]) => id);
        return ids.slice(Number(a[0]), Number(a[0]) + Number(a[1]));
      }
      case 'getLoanDetails':
        return { ...this.loans.get(a[0])! };
      case 'getOffer': {
        const book = blockNumber !== undefined && this.finalOffers !== null ? this.finalOffers : this.offers;
        return { ...(book.get(a[0]) ?? { offerType: 0, accepted: false, amountMax: 0n, amountFilled: 0n, expiresAt: 0n, backstopEligibleAfter: 0n }) };
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

  /** The contract's order of checks, in the parts the pass can meet. */
  private admit(fn: string, id: bigint): () => void {
    if (this.paused) throw revert('EnforcedPause');
    if (fn === 'autoDeductDaily') {
      const l = this.loans.get(id)!;
      if (l.status !== 0) throw revert('InvalidLoanStatus');
      if (l.assetType === 0) throw revert('NotNFTRental');
      if (this.now < l.lastDeductTime + ONE_DAY) throw revert('NotDailyYet');
      if (l.principal > l.prepayAmount) throw revert('InsufficientPrepay');
      return () => {
        l.prepayAmount -= l.principal;
        l.lastDeductTime += ONE_DAY;
        if ((l.lastDeductTime - l.startTime) / ONE_DAY >= l.durationDays) l.status = 1;
        this.lastLogs = [logOf('AutoDailyDeducted', { loanId: id, dayFeeDeducted: l.principal })];
      };
    }
    if (fn === 'backstopFill') {
      if (!this.backstopOn) throw revert('BackstopDisabled');
      const o = this.offers.get(id)!;
      if (o.offerType !== 1 || o.backstopEligibleAfter === 0n || this.now < o.backstopEligibleAfter || this.now >= o.expiresAt || o.accepted) {
        throw revert('OfferNotBackstopFillable');
      }
      const why = this.fillRefusal.get(id);
      if (why !== undefined) throw revert(why);
      return () => {
        o.accepted = true;
        o.amountFilled = o.amountMax;
        const loanId = this.nextLoanId++;
        this.lastLogs = [logOf('BackstopFilled', { offerId: id, loanId, fillAmount: o.amountMax })];
      };
    }
    throw new Error(`unexpected call ${fn}`);
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.simulated.push({ fn: functionName, id: args[0] as bigint });
    this.admit(functionName, args[0] as bigint);
    return { result: 0n };
  };

  getChainId = async () => this.chainServed;
  getBlockNumber = async () => 120n;
  getBlock = async ({ blockTag }: { blockTag?: string } = {}) =>
    blockTag === 'finalized' ? { number: 100n, timestamp: this.now } : { number: 120n, timestamp: this.now };
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.lastLogs, blockNumber: 121n });

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
          this.admit(functionName, args[0] as bigint)();
          this.sent.push({ fn: functionName, id: args[0] as bigint });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

class FakeLedger implements EventLedger {
  rows: LedgerRow[] = [];

  add(offerId: bigint, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'OfferBackstopEligibilitySet', args: { offerId: offerId.toString(), eligibleAfter: '1' }, blockAt: n, block: n, log: 0, tx: '0x' });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    expect(kinds).toEqual(['OfferBackstopEligibilitySet']);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('rentalVerdict', () => {
  it('finds a day due only on an active NFT rental with an unused agreed day, a whole day since its last deduction and the prepayment to cover it', () => {
    expect(rentalVerdict(rental(), NOW)).toEqual({ kind: 'due', lastDay: false });
    expect(rentalVerdict(rental({ lastDeductTime: START + 4n * ONE_DAY }), START + 5n * ONE_DAY), 'the fifth of five days').toEqual({ kind: 'due', lastDay: true });
    expect(rentalVerdict(rental({ assetType: 0 }), NOW), 'an ERC-20 loan').toEqual({ kind: 'none' });
    expect(rentalVerdict(rental({ status: 1 }), NOW), 'a closed rental').toEqual({ kind: 'none' });
    expect(rentalVerdict(rental({ assetType: 2 }), NOW), 'an ERC-1155 rental').toEqual({ kind: 'due', lastDay: false });
    expect(rentalVerdict(rental({ lastDeductTime: NOW - ONE_DAY + 1n }), NOW)).toEqual({ kind: 'not-due' });
  });

  it('never charges past the agreed term, behind a legacy clock, or beyond the prepayment', () => {
    const past = rentalVerdict(rental({ lastDeductTime: START + 5n * ONE_DAY }), START + 7n * ONE_DAY);
    expect(past.kind).toBe('held');
    expect(past.kind === 'held' && past.why).toMatch(/agreed day is already paid/);
    const legacy = rentalVerdict(rental({ lastDeductTime: 0n }), NOW);
    expect(legacy.kind === 'held' && legacy.why).toMatch(/behind its start/);
    const short = rentalVerdict(rental({ prepayAmount: 99n }), NOW);
    expect(short.kind === 'held' && short.why).toMatch(/prepayment no longer covers/);
  });
});

describe('offerDue / offerFinished', () => {
  it('reads an opted-in offer from its own record against the clock', () => {
    expect(offerDue(optedIn(), NOW)).toBe(true);
    expect(offerDue(optedIn({ backstopEligibleAfter: NOW + 1n }), NOW), 'before its eligibility time').toBe(false);
    expect(offerDue(optedIn({ offerType: 0 }), NOW), 'a lender offer').toBe(false);
    expect(offerDue(optedIn({ amountFilled: 1_000n }), NOW), 'nothing unfilled').toBe(false);
    expect(offerFinished(optedIn({ accepted: true }), NOW)).toBe(true);
    expect(offerFinished(optedIn({ backstopEligibleAfter: 0n }), NOW), 'opt-in cleared, or the offer deleted').toBe(true);
    expect(offerFinished(optedIn({ expiresAt: NOW }), NOW), 'expired').toBe(true);
    expect(offerFinished(optedIn({ backstopEligibleAfter: NOW + 1n }), NOW), 'waiting is not finished').toBe(false);
  });
});

describe('receipt events', () => {
  it('reads the outcome from the Diamond\'s own event for this loan or offer only', () => {
    expect(deductedFee(DIAMOND, 1n, [logOf('AutoDailyDeducted', { loanId: 1n, dayFeeDeducted: 100n })])).toBe(100n);
    expect(deductedFee(DIAMOND, 1n, [logOf('AutoDailyDeducted', { loanId: 2n, dayFeeDeducted: 100n })])).toBeNull();
    expect(deductedFee(DIAMOND, 1n, [{ ...logOf('AutoDailyDeducted', { loanId: 1n, dayFeeDeducted: 100n }), address: KEEPER }])).toBeNull();
    expect(filledEvent(DIAMOND, 3n, [logOf('BackstopFilled', { offerId: 3n, loanId: 9n, fillAmount: 5n })])).toEqual({ loanId: 9n, amount: 5n });
    expect(filledEvent(DIAMOND, 4n, [logOf('BackstopFilled', { offerId: 3n, loanId: 9n, fillAmount: 5n })])).toBeNull();
  });
});

describe('runPositionUpkeep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does nothing while disarmed, and says which flag is unset', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    // Any chain read would throw: there is no RPC and no database here.
    const env = { KEEPER_ENABLED: 'true', KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}` } as unknown as Env;
    await runPositionUpkeep(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toEqual(['[keeper] positionUpkeep skipped: POSITION_UPKEEP_ENABLED unset']);
  });
});

describe('a run', () => {
  let d: FakeDiamond;
  let ledger: FakeLedger;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    d = new FakeDiamond();
    ledger = new FakeLedger();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { backstopFill?: boolean; sendDeadline?: number; visit?: number } = {}) =>
    positionUpkeepOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: opts.sendDeadline ?? Number.POSITIVE_INFINITY,
      cursors,
      ledger,
      visit: opts.visit ?? 0,
      backstopFill: opts.backstopFill,
    });
  const sent = () => d.sent.map((s) => `${s.fn}(${s.id})`);

  describe('rental deduction', () => {
    it('deducts only the rentals with a day due, and reports the fee from the receipt', async () => {
      d.loans.set(1n, rental()); // due
      d.loans.set(2n, rental({ lastDeductTime: NOW - 60n })); // deducted a minute ago
      d.loans.set(3n, rental({ assetType: 0 })); // an ERC-20 loan
      d.loans.set(4n, rental({ lastDeductTime: 0n })); // a legacy clock
      d.loans.set(5n, rental({ lastDeductTime: START + 5n * ONE_DAY, prepayAmount: 0n })); // every day paid
      const r = await run();
      expect(sent()).toEqual(['autoDeductDaily(1)']);
      expect(d.simulated.map((s) => s.id), 'nothing else is even simulated').toEqual([1n]);
      expect(r.rentalsDue).toBe(1);
      expect(r.deducted).toEqual([{ loanId: 1n, fee: 100n, closed: null }]);
      expect(r.rentalsHeld).toHaveLength(2);
      expect(describeReport(r)).toContain('deducted=1(100)');
      expect(describeReport(r)).toContain('backstop-fill=off (BACKSTOP_FILL_ENABLED not armed)');
    });

    it('says from the loan\'s status after it that the last agreed day closed the rental', async () => {
      d.now = START + 5n * ONE_DAY;
      d.loans.set(1n, rental({ lastDeductTime: START + 4n * ONE_DAY, prepayAmount: 100n }));
      const r = await run();
      expect(r.deducted).toEqual([{ loanId: 1n, fee: 100n, closed: true }]);
      expect(describeReport(r)).toContain('deducted=1(100) closed');
    });

    it('sends nothing when the simulation refuses, and names the refusal', async () => {
      d.loans.set(1n, rental());
      // The window block shows a day due; the current state does not (the
      // renter repaid a day in between).
      d.simulateContract = async ({ functionName, args }) => {
        d.simulated.push({ fn: functionName, id: args[0] as bigint });
        throw revert('NotDailyYet');
      };
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.deducted).toEqual([]);
      expect(r.rentalsDeclined).toEqual(['loan 1: its next day has not elapsed at the current block']);
    });

    it('takes at most its share of sends a run, and later runs take the rest', async () => {
      const n = MAX_DEDUCTIONS_PER_RUN + 3;
      for (let i = 1; i <= n; i += 1) d.loans.set(BigInt(i), rental());
      const first = await run({ visit: 0 });
      expect(d.sent).toHaveLength(MAX_DEDUCTIONS_PER_RUN);
      expect(first.deferred).toBe(3);
      // A day later, the next window visit takes the next batch.
      d.now += ONE_DAY;
      await run({ visit: 1 });
      expect(new Set(d.sent.map((s) => s.id)).size, 'every rental deducted across the two runs').toBe(n);
    });

    it('stops the run on a pause', async () => {
      d.loans.set(1n, rental());
      d.loans.set(2n, rental());
      d.paused = true;
      const r = await run();
      expect(d.simulated).toHaveLength(1);
      expect(d.sent).toEqual([]);
      expect(r.stopped).toBe('EnforcedPause');
    });
  });

  describe('backstop fill', () => {
    it('fills an opted-in offer past its eligibility time and not one still waiting, and reads the loan from the receipt', async () => {
      d.offers.set(1n, optedIn());
      d.offers.set(2n, optedIn({ backstopEligibleAfter: NOW + 3600n }));
      ledger.add(1n);
      ledger.add(2n);
      const r = await run({ backstopFill: true });
      expect(sent()).toEqual(['backstopFill(1)']);
      expect(r.fills).toMatchObject({ off: null, named: 2, due: 1, filled: [{ offerId: 1n, loanId: 900n, amount: 1_000n }] });
      expect(describeReport(r)).toContain('backstop-filled=1->loan 900(1000)');
      // The filled row lifts the floor; the waiting one holds it.
      expect(cursors.rows.get(BACKSTOP_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('is off unless its own flag arms it', async () => {
      d.offers.set(1n, optedIn());
      ledger.add(1n);
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.fills).toBeNull();
    });

    it('sends nothing when the simulation refuses: an intent cap is the run\'s refusal, an offer no longer fillable is the offer\'s', async () => {
      d.offers.set(1n, optedIn());
      d.offers.set(2n, optedIn());
      ledger.add(1n);
      ledger.add(2n);
      d.fillRefusal.set(1n, 'LenderIntentExposureExceeded');
      d.fillRefusal.set(2n, 'OfferNotBackstopFillable');
      const r = await run({ backstopFill: true });
      expect(d.sent).toEqual([]);
      expect(r.refused.get('fill:1')).toBe('LenderIntentExposureExceeded');
      expect(r.fills?.declined).toEqual([expect.stringMatching(/^offer 2: not fillable/)]);
      expect(cursors.rows.has(BACKSTOP_FLOOR_ITEM), 'neither row is finished').toBe(false);
    });

    it('stops the step when the backstop is switched off on the chain', async () => {
      for (let i = 1n; i <= 3n; i += 1n) {
        d.offers.set(i, optedIn());
        ledger.add(i);
      }
      d.backstopOn = false;
      const r = await run({ backstopFill: true });
      expect(d.simulated.filter((s) => s.fn === 'backstopFill'), 'one try, not three').toHaveLength(1);
      expect(d.sent).toEqual([]);
      expect(r.fills?.off).toMatch(/switched off/);
    });

    it('moves its floor past expired, cancelled and cleared offers only on what the finalized block shows', async () => {
      d.offers.set(1n, optedIn({ expiresAt: NOW - 1n }));
      // Offer 2 was cancelled (deleted): it reads all zero.
      d.offers.set(3n, optedIn({ backstopEligibleAfter: 0n }));
      ledger.add(1n);
      ledger.add(2n);
      ledger.add(3n);
      d.finalOffers = new Map([[1n, optedIn({ expiresAt: NOW - 1n })], [3n, optedIn()]]);
      await run({ backstopFill: true });
      expect(d.sent).toEqual([]);
      expect(cursors.rows.get(BACKSTOP_FLOOR_ITEM), 'offer 3 is not cleared at the finalized block yet').toBe(encodePos(ledger.rows[1]));
      d.finalOffers = null;
      await run({ backstopFill: true });
      expect(cursors.rows.get(BACKSTOP_FLOOR_ITEM)).toBe(encodePos(ledger.rows[2]));
    });

    it('takes at most its share of sends a run, whatever the rental step found', async () => {
      for (let i = 1; i <= MAX_DEDUCTIONS_PER_RUN + 2; i += 1) d.loans.set(BigInt(i), rental());
      for (let i = 1n; i <= BigInt(MAX_FILLS_PER_RUN + 1); i += 1n) {
        d.offers.set(i, optedIn());
        ledger.add(i);
      }
      const r = await run({ backstopFill: true });
      expect(d.sent.filter((s) => s.fn === 'autoDeductDaily')).toHaveLength(MAX_DEDUCTIONS_PER_RUN);
      expect(d.sent.filter((s) => s.fn === 'backstopFill')).toHaveLength(MAX_FILLS_PER_RUN);
      expect(r.fills?.filled).toHaveLength(MAX_FILLS_PER_RUN);
    });
  });

  describe('the run deadline', () => {
    it('sends nothing once the deadline has passed', async () => {
      d.loans.set(1n, rental());
      d.offers.set(1n, optedIn());
      ledger.add(1n);
      const r = await run({ backstopFill: true, sendDeadline: Date.now() - 1 });
      expect(d.sent).toEqual([]);
      expect(d.simulated).toEqual([]);
      expect(r.unread.get('run')).toMatch(/deadline/);
    });

    it('abandons a read still in flight at the read cutoff, before the send deadline', async () => {
      d.loans.set(1n, rental());
      const slow = d.readContract;
      d.readContract = (args) =>
        args.functionName === 'getActiveLoansCount' ? new Promise((resolve) => setTimeout(() => resolve(slow(args)), 3_000)) : slow(args);
      // A read window of 22 s: the rental step may use half, and its window
      // read stops two stage reserves before that, about 1 s in.
      const t0 = Date.now();
      const r = await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 22_000 });
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(500);
      expect(took).toBeLessThan(2_500);
      expect(d.sent).toEqual([]);
      expect(r.unread.get('deduct')).toMatch(/read cutoff/);
    });

    it('leaves the backstop step time for its reads when the rental window is slow', async () => {
      d.loans.set(1n, rental());
      d.offers.set(1n, optedIn());
      ledger.add(1n);
      const slow = d.readContract;
      d.readContract = (args) =>
        args.functionName === 'getActiveLoansCount' ? new Promise((resolve) => setTimeout(() => resolve(slow(args)), 60_000)) : slow(args);
      // The rental step's window read is abandoned about 1 s in (above); the
      // backstop step's reads and its send still have their time.
      const r = await run({ backstopFill: true, sendDeadline: Date.now() + SEND_RESERVE_MS + 22_000 });
      expect(r.unread.get('deduct')).toMatch(/read cutoff/);
      expect(sent()).toEqual(['backstopFill(1)']);
    }, 15_000);
  });
});
