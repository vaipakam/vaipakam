/**
 * #3097 — the expired-teardown pass: the permissionless teardowns of a prepay
 * listing past grace, a stale lender-sale listing and an intent past its
 * cancel grace, and (#3336) of any of those, or a vehicle offer, whose
 * position moved, run against a fake Diamond that applies the contract's own
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
import { SEND_RESERVE_MS, STAGE_RESERVE_MS } from '../src/runWindow';
import {
  ABI,
  ATTEMPTS_PER_STEP,
  describeReport,
  intentDue,
  prepayDue,
  runExpiredTeardown,
  saleDue,
  teardownEvent,
  teardownOnce,
} from '../src/expiredTeardown';
import type { Env } from '../src/env';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const NOW = 1_000_000n;
const GRACE_SEC = 86_400n;
const HASH = `0x${'ab'.repeat(32)}` as Hex;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

/** A view's own revert, as viem reports it: the error names the function. */
function viewRevert(functionName: string): Error {
  return Object.assign(new Error(`${functionName} reverted`), { functionName });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

interface Loan {
  status: number;
  maturity: bigint;
  graceEnd: bigint;
  /** The prepay listing's order hash; zero with none. */
  listing: Hex;
  /** The intent's order deadline, or null with no commit. */
  intentDeadline: bigint | null;
  /** #3336 — the borrower position moved since its listing or intent was posted. */
  moved?: boolean;
}

interface Offer {
  offerType: number;
  accepted: boolean;
  expiresAt: bigint;
  linkedLoanId: bigint;
  /** #3336 — the Diamond reads its route as dead (`isOfferRouteDead`). */
  dead?: boolean;
}

const loan = (over: Partial<Loan> = {}): Loan => ({
  status: 0,
  maturity: NOW + 3600n,
  graceEnd: NOW + 7200n,
  listing: ZERO_HASH,
  intentDeadline: null,
  ...over,
});
/** A loan whose grace ended before the scan's block. */
const pastGrace = (over: Partial<Loan> = {}) => loan({ maturity: NOW - 7200n, graceEnd: NOW - 60n, ...over });
/** A lender-sale listing (a borrower-side offer) on `linkedLoanId`. */
const sale = (linkedLoanId: bigint, over: Partial<Offer> = {}): Offer => ({ offerType: 1, accepted: false, expiresAt: NOW - 1n, linkedLoanId, ...over });

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  graceSec = GRACE_SEC;
  loans = new Map<bigint, Loan>();
  offers = new Map<bigint, Offer>();
  /** Sends that landed: `function:loanId`. */
  sent: string[] = [];
  simulated: string[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  /** Emit nothing on the next landed call, as a receipt read without its logs. */
  dropLogs = false;
  failing = new Set<string>();

  readContract = async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    if (this.failing.has(functionName)) throw new Error(`${functionName} unavailable`);
    const a = args as readonly any[];
    const active = () => [...this.loans].filter(([, l]) => l.status === 0).map(([id]) => id);
    switch (functionName) {
      case 'getIntentCancelGraceSeconds':
        return Number(this.graceSec);
      case 'getActiveLoansCount':
        return BigInt(active().length);
      case 'getActiveLoansPaginated':
        return active().slice(Number(a[0]), Number(a[0]) + Number(a[1]));
      case 'getLoanDeadlines': {
        const l = this.loans.get(a[0])!;
        return [l.maturity, 0n, l.maturity, l.graceEnd];
      }
      case 'getPrepayListingOrderHash':
        return this.loans.get(a[0])!.listing;
      case 'getIntentCommit': {
        const l = this.loans.get(a[0])!;
        if (l.intentDeadline === null) throw viewRevert('getIntentCommit');
        return { deadline: l.intentDeadline, makerAmount: 1n };
      }
      case 'getLoanDetails':
        return { status: this.loans.get(a[0])!.status, borrowerTokenId: BigInt(a[0]) * 2n };
      case 'isPositionRouteDead': {
        // The borrower position of loan N is token 2N.
        const l = this.loans.get(BigInt(a[0]) / 2n)!;
        return l.moved === true;
      }
      case 'isOfferRouteDead':
        return this.offers.get(a[0])?.dead === true;
      case 'getActiveOffersCount':
        return BigInt(this.liveOffers().length);
      case 'getActiveOffersPaginated':
        return this.liveOffers().slice(Number(a[0]), Number(a[0]) + Number(a[1]));
      case 'getOfferLinkedLoanId':
        return this.offers.get(a[0])!.linkedLoanId;
      case 'getOffer': {
        const o = this.offers.get(a[0])!;
        return { offerType: o.offerType, accepted: o.accepted, expiresAt: o.expiresAt };
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };

  private liveOffers(): bigint[] {
    return [...this.offers.keys()];
  }

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

  private saleOf(loanId: bigint): [bigint, Offer] | undefined {
    return [...this.offers].find(([, o]) => o.linkedLoanId === loanId && o.offerType === 1);
  }

  /** The contract's checks for each teardown, in the parts the pass can meet. */
  private admit(functionName: string, loanId: bigint, caller: Address): () => void {
    if (functionName === 'cancelOffer') return this.admitCancelOffer(loanId);
    const l = this.loans.get(loanId)!;
    switch (functionName) {
      case 'cancelExpiredPrepayListing':
        if (BigInt(l.listing) === 0n) throw revert('PrepayListingNotFound', [loanId]);
        if (!l.moved && this.now <= l.graceEnd) throw revert('GraceNotExpired', [loanId, this.now, l.graceEnd]);
        return () => {
          this.lastLogs = [logOf('PrepayListingCanceled', { loanId, caller, orderHash: l.listing, reason: 1 })];
          l.listing = ZERO_HASH;
        };
      case 'teardownStaleSaleListing': {
        const s = this.saleOf(loanId);
        if (s === undefined || s[1].accepted) throw revert('NoStaleSaleListing');
        const live = l.status === 0 || l.status === 4;
        if (live && s[1].expiresAt !== 0n && this.now < s[1].expiresAt) throw revert('SaleListingLoanStillLive');
        return () => {
          this.lastLogs = [logOf('LoanSaleListingTornDown', { loanId, saleOfferId: s[0] }), logOf('OfferCanceled', { offerId: s[0], creator: KEEPER })];
          this.offers.delete(s[0]);
        };
      }
      case 'cancelExpiredIntent':
        if (this.paused) throw revert('EnforcedPause');
        if (l.intentDeadline === null) throw revert('IntentNoCommit', [loanId]);
        if (!l.moved && this.now < l.intentDeadline + this.graceSec) throw revert('IntentNotPastCancelGrace');
        return () => {
          this.lastLogs = [logOf('SwapToRepayIntentCancelled', { loanId, orderHash: HASH, cancelledBy: caller })];
          l.intentDeadline = null;
        };
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  /** `cancelOffer` by a stranger: refused while paused, and unless the offer
   *  is expired or its route is dead. */
  private admitCancelOffer(offerId: bigint): () => void {
    if (this.paused) throw revert('EnforcedPause');
    const o = this.offers.get(offerId);
    if (o === undefined) throw revert('NotCreatorOrNotExpired', [`0x${'0'.repeat(40)}`, 0n]);
    const expired = o.expiresAt !== 0n && this.now >= o.expiresAt;
    if (!o.dead && !expired) throw revert('NotCreatorOrNotExpired', [KEEPER, o.expiresAt]);
    if (o.accepted) throw revert('OfferAlreadyAccepted');
    return () => {
      this.lastLogs = [logOf('OfferCanceled', { offerId, creator: KEEPER })];
      this.offers.delete(offerId);
    };
  }

  simulateContract = async ({ functionName, args, account }: { functionName: string; args: readonly unknown[]; account: { address: Address } }) => {
    this.simulated.push(`${functionName}:${args[0]}`);
    this.admit(functionName, args[0] as bigint, account.address);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;
  getBlockNumber = async () => 120n;
  getBlock = async () => ({ number: 120n, timestamp: this.now });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => {
    const logs = this.dropLogs ? [] : this.lastLogs;
    return { status: 'success', logs, blockNumber: 121n };
  };

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
          this.admit(functionName, args[0] as bigint, KEEPER)();
          this.sent.push(`${functionName}:${args[0]}`);
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

const ok = (result: unknown) => ({ status: 'success' as const, result });

describe('what is due', () => {
  it('a prepay listing only once the block is past the grace end, the contract\'s strict rule', () => {
    const deadlines = ok([0n, 0n, 100n, 200n]);
    expect(prepayDue(deadlines, ok(HASH), 201n)).toBe(true);
    expect(prepayDue(deadlines, ok(HASH), 200n), 'the grace end itself is not past it').toBe(false);
    expect(prepayDue(deadlines, ok(HASH), 150n), 'in grace: the auto-list pass\'s window').toBe(false);
    expect(prepayDue(deadlines, ok(ZERO_HASH), 999n), 'no listing').toBe(false);
    expect(prepayDue(undefined, ok(HASH), 999n), 'deadlines unread').toBeUndefined();
    expect(prepayDue(deadlines, { status: 'failure', error: new Error('x') }, 999n)).toBeUndefined();
  });

  it('an intent at its deadline plus the cancel grace, and no commit only on the view\'s own revert', () => {
    expect(intentDue(ok({ deadline: 100n }), 50n, 150n)).toBe(true);
    expect(intentDue(ok({ deadline: 100n }), 50n, 149n)).toBe(false);
    expect(intentDue({ status: 'failure', error: viewRevert('getIntentCommit') }, 50n, 999n), 'no commit').toBe(false);
    expect(intentDue({ status: 'failure', error: viewRevert('aggregate3') }, 50n, 999n), 'an unread value is not "none"').toBeUndefined();
    expect(intentDue(undefined, 50n, 999n)).toBeUndefined();
  });

  it('a sale listing past its expiry or on a closed loan, never an offset or an accepted sale', () => {
    const o = { offerType: 1, accepted: false, expiresAt: 100n };
    expect(saleDue(o, 0, 100n)).toBe('expired');
    expect(saleDue(o, 0, 99n)).toBeNull();
    expect(saleDue(o, 4, 99n), 'FallbackPending is live').toBeNull();
    expect(saleDue(o, 1, 99n)).toBe('its loan has closed');
    expect(saleDue({ ...o, expiresAt: 0n }, 0, 1n)).toBe('a listing from before expiries, with none');
    expect(saleDue({ ...o, offerType: 0 }, 1, 999n), 'a preclose offset is a lender-side offer').toBeNull();
    expect(saleDue({ ...o, accepted: true }, 1, 999n), 'mid-completion').toBeNull();
  });
});

describe('teardownEvent', () => {
  it('names a teardown from the Diamond\'s own event for this loan only', () => {
    const intent = logOf('SwapToRepayIntentCancelled', { loanId: 1n, orderHash: HASH, cancelledBy: KEEPER });
    expect(teardownEvent('intent', DIAMOND, 1n, [intent])).toBe('loan 1 order 0xabababab');
    expect(teardownEvent('intent', DIAMOND, 2n, [intent]), 'another loan').toBeNull();
    expect(teardownEvent('intent', DIAMOND, 1n, [{ ...intent, address: KEEPER }]), 'another contract').toBeNull();
    expect(teardownEvent('sale', DIAMOND, 3n, [logOf('LoanSaleListingTornDown', { loanId: 3n, saleOfferId: 9n })])).toBe('loan 3 offer 9');
    expect(teardownEvent('prepay', DIAMOND, 1n, [intent]), 'another step\'s event').toBeNull();
  });

  it('names a vehicle cancel from the OfferCanceled event for that offer only', () => {
    const cancelled = logOf('OfferCanceled', { offerId: 9n, creator: KEEPER });
    expect(teardownEvent('vehicle', DIAMOND, 9n, [cancelled])).toBe('offer 9');
    expect(teardownEvent('vehicle', DIAMOND, 8n, [cancelled]), 'another offer').toBeNull();
    expect(teardownEvent('sale', DIAMOND, 9n, [cancelled]), 'a sale teardown is its own event').toBeNull();
  });
});

describe('a run', () => {
  let d: FakeDiamond;

  beforeEach(() => {
    d = new FakeDiamond();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (opts: { visit?: number; sendDeadline?: number } = {}) =>
    teardownOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      sendDeadline: opts.sendDeadline ?? Number.POSITIVE_INFINITY,
      visit: opts.visit ?? 0,
    });

  it('tears down only what is past its expiry or stale, and simulates nothing else', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH })); // listing past grace: due
    d.loans.set(2n, loan({ maturity: NOW - 60n, graceEnd: NOW + 3600n, listing: HASH })); // in grace: the auto-list's
    d.loans.set(3n, loan({ listing: HASH })); // before maturity
    d.loans.set(4n, loan({ intentDeadline: NOW - GRACE_SEC - 1n })); // past the cancel grace: due
    d.loans.set(5n, loan({ intentDeadline: NOW - 60n })); // inside the borrower's cancel grace
    d.loans.set(6n, loan()); // live loan, sale expired: due
    d.loans.set(7n, loan()); // live loan, sale not expired
    d.loans.set(8n, loan({ status: 1 })); // closed loan, sale left standing: due
    d.loans.set(9n, loan({ status: 1 })); // closed loan with an offset offer only
    d.loans.set(10n, loan({ status: 1 })); // accepted sale, mid-completion
    d.offers.set(20n, sale(6n));
    d.offers.set(21n, sale(7n, { expiresAt: NOW + 3600n }));
    d.offers.set(22n, sale(8n, { expiresAt: NOW + 3600n }));
    d.offers.set(23n, sale(9n, { offerType: 0 }));
    d.offers.set(24n, sale(10n, { accepted: true }));
    d.offers.set(25n, { offerType: 0, accepted: false, expiresAt: 0n, linkedLoanId: 0n }); // an ordinary offer

    const r = await run();
    const expected = ['cancelExpiredPrepayListing:1', 'teardownStaleSaleListing:6', 'teardownStaleSaleListing:8', 'cancelExpiredIntent:4'];
    expect(d.sent).toEqual(expected);
    expect(d.simulated, 'nothing that is not due reaches the contract').toEqual(expected);
    expect(r.steps.prepay).toMatchObject({ due: 1, torndown: ['loan 1 order 0xabababab'] });
    expect(r.steps.sale).toMatchObject({ due: 2, torndown: ['loan 6 offer 20', 'loan 8 offer 22'] });
    expect(r.steps.intent).toMatchObject({ due: 1, torndown: ['loan 4 order 0xabababab'] });
    expect(r.offers).toEqual({ read: 6, total: 6 });
    expect(r.refused.size).toBe(0);
    const line = describeReport(r);
    expect(line).toContain('sale[due=2 torn-down=loan 6 offer 20,loan 8 offer 22]');
    expect(line).toContain('intent[due=1 torn-down=loan 4 order 0xabababab]');
  });

  it('#3336: tears down a listing or intent whose position moved at once, and leaves the unmoved ones', async () => {
    d.loans.set(1n, loan({ maturity: NOW - 60n, graceEnd: NOW + 3600n, listing: HASH, moved: true })); // in grace, moved: due
    d.loans.set(2n, loan({ maturity: NOW - 60n, graceEnd: NOW + 3600n, listing: HASH })); // in grace, unmoved: the auto-list's
    d.loans.set(3n, loan({ intentDeadline: NOW + 3600n, moved: true })); // before its deadline, moved: due
    d.loans.set(4n, loan({ intentDeadline: NOW + 3600n })); // before its deadline, unmoved
    d.loans.set(5n, loan({ moved: true })); // moved, but nothing to tear down
    const r = await run();
    const expected = ['cancelExpiredPrepayListing:1', 'cancelExpiredIntent:3'];
    expect(d.sent).toEqual(expected);
    expect(d.simulated, 'no simulation for a live route').toEqual(expected);
    expect(r.steps.prepay).toMatchObject({ due: 1, torndown: ['loan 1 order 0xabababab'] });
    expect(r.steps.intent).toMatchObject({ due: 1, torndown: ['loan 3 order 0xabababab'] });
  });

  it('#3336: cancels a vehicle offer whose route is dead, after the sale teardowns', async () => {
    d.loans.set(1n, loan()); // live loan
    d.loans.set(2n, loan()); // live loan, its sale listing expired and dead
    d.offers.set(20n, sale(1n, { expiresAt: NOW + 3600n, dead: true })); // a sale inside its expiry, moved: a vehicle cancel
    d.offers.set(21n, sale(1n, { offerType: 0, expiresAt: NOW + 3600n, dead: true })); // a preclose offset, moved
    d.offers.set(22n, { offerType: 1, accepted: false, expiresAt: NOW + 3600n, linkedLoanId: 0n, dead: true }); // a refinance request, moved
    d.offers.set(23n, sale(2n, { dead: true })); // expired and dead: the sale step's
    d.offers.set(24n, sale(1n, { offerType: 0, expiresAt: NOW + 3600n })); // an offset whose route is live
    const r = await run();
    expect(d.sent).toEqual(['teardownStaleSaleListing:2', 'cancelOffer:20', 'cancelOffer:21', 'cancelOffer:22']);
    expect(d.simulated.filter((x) => x === 'cancelOffer:24'), 'a live vehicle reaches no simulation').toEqual([]);
    expect(r.steps.sale).toMatchObject({ due: 1, torndown: ['loan 2 offer 23'] });
    expect(r.steps.vehicle).toMatchObject({ due: 3, torndown: ['offer 20', 'offer 21', 'offer 22'] });
    expect(describeReport(r)).toContain('vehicle[due=3 torn-down=offer 20,offer 21,offer 22]');
  });

  it('#3336: a vehicle the contract no longer reads as dead is named as not yet, not refused', async () => {
    d.loans.set(1n, loan());
    d.offers.set(20n, sale(1n, { offerType: 0, expiresAt: NOW + 3600n, dead: true }));
    const simulate = d.simulateContract;
    vi.spyOn(d, 'simulateContract').mockImplementation(async (p) => {
      if (p.functionName === 'cancelOffer') throw revert('NotCreatorOrNotExpired', [KEEPER, NOW + 3600n]);
      return simulate(p);
    });
    const r = await run();
    expect(d.sent).toEqual([]);
    expect(r.steps.vehicle.notYet).toEqual([
      'offer 20 (its position moved): the contract no longer reads its route as dead at the current block (or it is already gone)',
    ]);
    expect(r.refused.size).toBe(0);
  });

  it('#3336: says what it could not read of a moved route, and still works the rest', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.loans.set(2n, loan({ intentDeadline: NOW + 3600n, moved: true }));
    d.failing.add('isPositionRouteDead');
    const r = await run();
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1']);
    expect(r.unread.get('moved')).toContain('1 listing(s) or intent(s)');
  });

  it('sends nothing when the simulation reverts, and says why', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.loans.set(2n, loan({ intentDeadline: NOW - GRACE_SEC }));
    d.loans.set(3n, loan());
    d.offers.set(20n, sale(3n));
    // The head is a little behind the scan's block for the listing, a
    // deployment fault refuses the sale, and the intent is gone by the time
    // the call is simulated.
    const simulate = d.simulateContract;
    vi.spyOn(d, 'simulateContract').mockImplementation(async (p) => {
      if (p.functionName === 'cancelExpiredPrepayListing') throw revert('GraceNotExpired', [1n, NOW, NOW + 1n]);
      if (p.functionName === 'teardownStaleSaleListing') throw revert('ExecutorNotSet');
      if (p.functionName === 'cancelExpiredIntent') throw revert('IntentNoCommit', [2n]);
      return simulate(p);
    });
    const r = await run();
    expect(d.sent).toEqual([]);
    expect(r.steps.prepay.notYet).toEqual(['loan 1: its grace window has not ended at the current block']);
    expect(r.steps.sale.torndown).toEqual([]);
    expect(r.refused.get('sale:loan 3')).toBe('ExecutorNotSet');
    expect(r.steps.intent.gone).toEqual(['loan 2']);
    expect(r.refused.has('intent:loan 2'), 'a teardown someone else made is not a refusal').toBe(false);
  });

  it('a pause stops the vehicle and intent steps, which go last: the other two are allowed while paused', async () => {
    d.paused = true;
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.loans.set(2n, loan({ intentDeadline: 0n }));
    d.loans.set(3n, loan({ intentDeadline: 0n }));
    d.loans.set(4n, loan({ status: 2 }));
    d.offers.set(20n, sale(4n));
    d.offers.set(21n, { offerType: 1, accepted: false, expiresAt: NOW + 3600n, linkedLoanId: 0n, dead: true });
    const r = await run();
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1', 'teardownStaleSaleListing:4']);
    expect(d.simulated.filter((s) => s.startsWith('cancelOffer')), 'one refusal stops the run').toHaveLength(1);
    expect(d.simulated.filter((s) => s.startsWith('cancelExpiredIntent')), 'nothing after the pause').toHaveLength(0);
    expect(r.stopped).toBe('EnforcedPause');
  });

  it('reports a landed call whose event it could not read apart from a teardown', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.dropLogs = true;
    const r = await run();
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1']);
    expect(r.steps.prepay.torndown).toEqual([]);
    expect(r.steps.prepay.landedUnread).toEqual(['loan 1']);
    expect(describeReport(r)).toContain('landed-event-unread=loan 1');
  });

  it('takes at most its share a step a run, and the next run takes the rest', async () => {
    const n = ATTEMPTS_PER_STEP.prepay + 2;
    for (let i = 1; i <= n; i += 1) d.loans.set(BigInt(i), pastGrace({ listing: HASH }));
    const first = await run({ visit: 0 });
    expect(d.sent).toHaveLength(ATTEMPTS_PER_STEP.prepay);
    expect(first.steps.prepay.deferred).toBe(2);
    await run({ visit: 1 });
    expect(new Set(d.sent).size, 'every listing torn down across the two runs').toBe(n);
  });

  it('stops its reads early enough to leave the sends their reserve', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    // Inside the send reserve plus the five stage reserves: no read starts.
    const r = await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 5 * STAGE_RESERVE_MS - 1_000 });
    expect(d.sent).toEqual([]);
    expect(d.simulated).toEqual([]);
    expect(r.unread.get('run')).toContain('run deadline');
    // With the reserves clear, the same listing is torn down.
    await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 5 * STAGE_RESERVE_MS + 60_000 });
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1']);
  });

  it('#3336: loan details that run to their cutoff still leave the dead-route reads their time', async () => {
    d.loans.set(1n, loan({ intentDeadline: NOW + 3600n, moved: true }));
    const deadline = Date.now() + 600_000;
    // The details stage stops a stage reserve before the route reads', which
    // stop a stage reserve before the offer list's.
    const detailsCutoff = deadline - SEND_RESERVE_MS - 3 * STAGE_RESERVE_MS;
    const read = d.readContract;
    d.readContract = async (p) => {
      // The details answer just inside their own cutoff, past the one the
      // per-loan reads had.
      if (p.functionName === 'getLoanDetails') vi.spyOn(Date, 'now').mockReturnValue(detailsCutoff - 500);
      return read(p);
    };
    const r = await run({ sendDeadline: deadline });
    expect(d.sent).toEqual(['cancelExpiredIntent:1']);
    expect(r.unread.has('moved')).toBe(false);
  });

  it('sends nothing once the run\'s deadline passes, and leaves the rest for the next run', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.loans.set(2n, pastGrace({ listing: HASH }));
    const start = Date.now();
    const deadline = start + 600_000;
    const wait = d.waitForTransactionReceipt;
    // The first send's receipt arrives after the deadline.
    d.waitForTransactionReceipt = async () => {
      vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      return wait();
    };
    const r = await run({ sendDeadline: deadline });
    expect(d.sent).toHaveLength(1);
    expect(r.stopped).toBe('deadline');
    expect(r.steps.prepay.torndown).toHaveLength(1);
  });

  it('states what it could not read, and still works the rest', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.loans.set(2n, loan({ intentDeadline: 0n }));
    d.failing.add('getIntentCancelGraceSeconds');
    const r = await run();
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1']);
    expect(r.unread.get('intent')).toContain('the intent cancel grace');
  });

  it('a stage whose list cannot be read leaves the other stage\'s work going', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.failing.add('getActiveOffersCount');
    const r = await run();
    expect(d.sent).toEqual(['cancelExpiredPrepayListing:1']);
    expect(r.unread.get('sales')).toContain('the active-offer reads');
  });

  it('works a chain only when the RPC answers for it', async () => {
    d.loans.set(1n, pastGrace({ listing: HASH }));
    d.chainServed = 1;
    const r = await run();
    expect(r.skipped).toContain('serves chain 1');
    expect(d.sent).toEqual([]);
  });
});

describe('the gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips the whole pass while EXPIRED_TEARDOWN_ENABLED is unset, without touching a chain', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = {
      KEEPER_ENABLED: 'true',
      KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
      RPC_BASE_SEPOLIA: 'https://rpc.invalid',
    } as unknown as Env;
    await runExpiredTeardown(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toEqual(['[keeper] expiredTeardown skipped: EXPIRED_TEARDOWN_ENABLED unset']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips while the keeper itself is disarmed, even with the pass flag on', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const env = { KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`, EXPIRED_TEARDOWN_ENABLED: 'true' } as unknown as Env;
    await runExpiredTeardown(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[keeper\] expiredTeardown skipped: KEEPER_ENABLED/);
  });
});
