/**
 * #2984 — the prepay-sale sanctions sync (protocol upkeep step 3), run
 * against a fake Diamond whose party views and syncs follow the contract's
 * rules: a sync re-reads its parties, commits only a flag the oracle
 * answers, and cancels only then.
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
import { describeSales, OFFER_FLOOR_ITEM, SALE_RACES, SALES_ABI, syncSaleListings } from '../src/prepaySaleSanctions';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { finalizedBlockOnce, memoryScanCursors } from '../src/scanCursors';
import { StepSender } from '../src/stepSender';
import { PastRunDeadline } from '../src/batchRead';
import { SEND_RESERVE_MS, STAGE_RESERVE_MS } from '../src/runWindow';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const ORACLE: Address = '0x00000000000000000000000000000000000000a0';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: SALES_ABI, data: encodeErrorResult({ abi: SALES_ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = SALES_ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

interface Listing {
  hash: Hex;
  parties: Address[];
}

class FakeDiamond {
  oracle: Address = ORACLE;
  /** The active-loan list, in order. */
  active: bigint[] = [];
  loanListings = new Map<bigint, Listing>();
  offerListings = new Map<bigint, Listing>();
  /** The finalized block's view of the offer listings, when it lags the head. */
  finalOffers: Map<bigint, Listing> | null = null;
  /** What `sanctionsStatus` reads as flagged now. */
  flagged = new Set<string>();
  /** Parties the oracle cannot answer for now (`sanctionsStatus` = unavailable). */
  unavailable = new Set<string>();
  /** What the sync's own authoritative read finds; defaults to `flagged`. */
  confirmed: Set<string> | null = null;
  sent: { fn: string; args: readonly unknown[] }[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  reads: string[] = [];

  readContract = async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    this.reads.push(functionName);
    const a = args as readonly any[];
    const view = (l: Listing | undefined) => (l === undefined ? [ZERO_HASH, []] : [l.hash, l.parties]);
    switch (functionName) {
      case 'getSanctionsOracle':
        return this.oracle;
      case 'getActiveLoansCount':
        return BigInt(this.active.length);
      case 'getActiveLoansPaginated':
        return this.active.slice(Number(a[0]), Number(a[0]) + Number(a[1]));
      case 'prepaySaleListingParties':
        return view(this.loanListings.get(a[0]));
      case 'prepaySaleOfferParties':
        return view(((blockNumber !== undefined ? this.finalOffers : null) ?? this.offerListings).get(a[0]));
      case 'sanctionsStatus': {
        const who = String(a[0]).toLowerCase();
        return this.flagged.has(who) ? 1 : this.unavailable.has(who) ? 2 : 0;
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

  private admit(functionName: string, a: readonly any[]): () => void {
    const confirmed = this.confirmed ?? this.flagged;
    const found = (l: Listing) => l.parties.some((p) => confirmed.has(p.toLowerCase()));
    switch (functionName) {
      case 'syncPrepaySaleListing': {
        const l = this.loanListings.get(a[0]);
        if (!l) throw revert('PrepayListingNotFound', [a[0]]);
        return () => {
          const f = found(l);
          if (f) this.loanListings.delete(a[0]);
          this.lastLogs = [logOf('PrepaySaleListingSynced', { loanId: a[0], caller: KEEPER, flaggedFound: f })];
        };
      }
      case 'syncPrepaySaleOffer': {
        const l = this.offerListings.get(a[0]);
        if (!l) throw revert('ParallelSaleListingNotFound', [a[0]]);
        return () => {
          const f = found(l);
          if (f) this.offerListings.delete(a[0]);
          this.lastLogs = [logOf('PrepaySaleOfferSynced', { offerId: a[0], caller: KEEPER, flaggedFound: f })];
        };
      }
      default:
        throw new Error(`unexpected call ${functionName}`);
    }
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.admit(functionName, args);
    return { result: undefined };
  };

  getBlockNumber = async () => 120n;
  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => (blockTag === 'finalized' ? { number: 100n, timestamp: 1n } : { number: 120n, timestamp: 1n });
  getTransactionCount = async () => 7;
  waitForTransactionReceipt = async () => ({ status: 'success', logs: this.lastLogs, blockNumber: 1n });

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

class FakeLedger implements EventLedger {
  rows: LedgerRow[] = [];

  add(offerId: bigint, orderHash: Hex, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'PostParallelSaleListing', args: { offerId: String(offerId), orderHash }, blockAt: n, block: n, log: 0, tx: hash(n) });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    expect(kinds).toEqual(['PostParallelSaleListing']);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('the prepay-sale sanctions sync', () => {
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

  const run = (sendDeadline = Number.POSITIVE_INFINITY) => {
    const sender = new StepSender(
      {
        pass: 'protocolUpkeep',
        abi: SALES_ABI,
        maxSends: 10,
        receiptTimeoutMs: 1_000,
        races: new Set(SALE_RACES),
        pausedRefusal: 'EnforcedPause',
        describe: (s) => String(s),
        spends: 'the gas',
      },
      { context: () => d.ctx(), sendDeadline },
    );
    return syncSaleListings(CHAIN, DIAMOND, sender, {
      readClient: d.client(),
      sendDeadline,
      visit: 0,
      cursors,
      ledger,
      finalized: finalizedBlockOnce(d.client()),
    }).then((report) => ({ report, sender }));
  };
  const fns = () => d.sent.map((s) => `${s.fn}(${s.args.join(',')})`);

  it('does nothing on a chain with no sanctions oracle, and says so', async () => {
    d.oracle = ZERO;
    d.active = [1n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1)] });
    d.flagged.add(addr(1));
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.off).toContain('no sanctions oracle');
    expect(d.reads).toEqual(['getSanctionsOracle']);
    expect(describeSales(report).join(' ')).toContain('not worked');
  });

  it('syncs a loan listing with a flagged party and reports it cancelled; leaves a clean one alone', async () => {
    d.active = [1n, 2n, 3n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1), addr(9)] });
    d.loanListings.set(2n, { hash: hash(2), parties: [addr(2)] });
    d.flagged.add(addr(9)); // loan 1's fee leg
    const { report } = await run();
    expect(fns()).toEqual(['syncPrepaySaleListing(1)']);
    expect(report.loanListings).toBe(2);
    expect(report.flagged).toEqual(['loan 1']);
    expect(report.cancelled).toEqual(['loan 1']);
    expect(d.loanListings.has(2n), 'the clean listing stays').toBe(true);
  });

  it('screens a burned position (address zero) as no party', async () => {
    d.active = [1n];
    d.loanListings.set(1n, { hash: hash(1), parties: [ZERO] });
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.loanListings).toBe(1);
    expect(d.reads.filter((r) => r === 'sanctionsStatus')).toEqual([]);
  });

  it('names a listing the oracle could not screen, rather than reporting it clean', async () => {
    d.active = [1n, 2n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1)] });
    d.loanListings.set(2n, { hash: hash(2), parties: [addr(2), addr(3)] });
    d.unavailable.add(addr(1));
    d.unavailable.add(addr(2));
    d.flagged.add(addr(3)); // a flagged party still makes its listing due
    const { report, sender } = await run();
    expect(fns()).toEqual(['syncPrepaySaleListing(2)']);
    expect(report.flagged).toEqual(['loan 2']);
    expect(report.unscreened).toEqual(['loan 1']);
    expect(describeSales(report).join(' ')).toContain('sale-unscreened=loan 1');
    expect([...sender.unread.keys()]).toContain('sales:loan:1');
  });

  it('stops the gate read at its stage cutoff, waiting or not', async () => {
    d.active = [1n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1)] });
    d.flagged.add(addr(1));
    const real = d.readContract;
    d.readContract = async (x) => (x.functionName === 'getSanctionsOracle' ? new Promise<never>(() => {}) : real(x));
    // The gate's cutoff falls 200 ms from now: the send reserve and two stage
    // reserves before the deadline.
    const t0 = Date.now();
    await expect(run(t0 + SEND_RESERVE_MS + 2 * STAGE_RESERVE_MS + 200)).rejects.toBeInstanceOf(PastRunDeadline);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(d.sent).toEqual([]);
  });

  it('reports a sync the contract left live when its own read confirms no flag', async () => {
    d.active = [1n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1)] });
    d.flagged.add(addr(1));
    d.confirmed = new Set(); // the oracle did not answer authoritatively at the sync's block
    const { report } = await run();
    expect(fns()).toEqual(['syncPrepaySaleListing(1)']);
    expect(report.cancelled).toEqual([]);
    expect(report.leftLive).toEqual(['loan 1']);
    expect(describeSales(report).join(' ')).toContain('sale-synced-left-live=loan 1');
  });

  it('syncs an offer listing the ledger names, and moves the floor past it once finality shows it gone', async () => {
    ledger.add(7n, hash(70));
    d.offerListings.set(7n, { hash: hash(70), parties: [addr(7)] });
    d.flagged.add(addr(7));
    const { report } = await run();
    expect(fns()).toEqual(['syncPrepaySaleOffer(7)']);
    expect(report.offerListings).toBe(1);
    expect(report.cancelled).toEqual(['offer 7']);
    // Cancelled at the head this run was read before the send: the floor
    // waits for a run that reads it gone at the head and at finality.
    expect(cursors.rows.get(OFFER_FLOOR_ITEM)).toBeUndefined();
    await run();
    expect(cursors.rows.get(OFFER_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
  });

  it('passes a row whose listing a later post replaced, and keeps the later one in the rotation', async () => {
    ledger.add(7n, hash(70)); // superseded
    ledger.add(7n, hash(71)); // live
    d.offerListings.set(7n, { hash: hash(71), parties: [addr(7)] });
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.offerListings).toBe(1);
    expect(cursors.rows.get(OFFER_FLOOR_ITEM), 'past the replaced row only').toBe(encodePos(ledger.rows[0]));
  });

  it('holds the floor where finality still shows the listing live', async () => {
    ledger.add(7n, hash(70));
    d.finalOffers = new Map([[7n, { hash: hash(70), parties: [addr(7)] }]]); // the head shows it gone
    await run();
    expect(cursors.rows.get(OFFER_FLOOR_ITEM)).toBeUndefined();
  });

  it('treats a listing gone before its send as another caller\'s, not as a refusal', async () => {
    d.active = [1n];
    d.loanListings.set(1n, { hash: hash(1), parties: [addr(1)] });
    d.flagged.add(addr(1));
    const real = d.simulateContract;
    d.simulateContract = async (x) => {
      d.loanListings.delete(1n);
      return real(x);
    };
    const { report, sender } = await run();
    expect(d.sent).toEqual([]);
    expect(report.cancelled).toEqual([]);
    expect(sender.refused.size).toBe(0);
  });
});
