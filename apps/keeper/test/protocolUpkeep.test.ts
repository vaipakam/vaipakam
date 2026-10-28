/**
 * #2984 — the protocol upkeep pass: buyback-intent expiry and the tier LTV
 * cache refresh, run against a fake Diamond that applies the contract's own
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
  BUYBACK_FLOOR_ITEM,
  DEFAULT_REFRESH_AFTER_SEC,
  describeReport,
  readRefreshLogs,
  upkeepOnce,
} from '../src/protocolUpkeep';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { SEND_RESERVE_MS } from '../src/runWindow';
import { memoryScanCursors } from '../src/scanCursors';
import { PastRunDeadline } from '../src/batchRead';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const TOKEN: Address = '0x00000000000000000000000000000000000000d0';
const NOW = 1_000_000n;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

interface Order {
  expiresAt: bigint;
  status: number;
}

interface Tier {
  ltvBps: number;
  at: bigint;
  /** What the peers would give now; null rejects with `reason`. */
  candidate: number | null;
  reason?: string;
}

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  paused = false;
  peerPaused = false;
  orders = new Map<Hex, Order>();
  tiers = new Map<number, Tier>([
    [1, { ltvBps: 7000, at: NOW - 100n, candidate: 7000 }],
    [2, { ltvBps: 6000, at: NOW - 100n, candidate: 6000 }],
    [3, { ltvBps: 0, at: 0n, candidate: null, reason: 'no-reference-assets' }],
  ]);
  /** The finalized block's view of the orders, when it lags the head. */
  finalOrders: Map<Hex, Order> | null = null;
  simulateV1 = true;
  sent: { fn: string; args: readonly unknown[] }[] = [];
  previews = 0;
  lastLogs: ReturnType<typeof logOf>[] = [];

  readContract = async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getBuybackOrder': {
        const o = ((blockNumber !== undefined ? this.finalOrders : null) ?? this.orders).get(a[0]);
        return { token: TOKEN, amountIn: 100n, minVpfiOut: 1n, expiresAt: o?.expiresAt ?? 0n, status: o?.status ?? 0 };
      }
      case 'peerLtvReadsPaused':
        return this.peerPaused;
      case 'getTierLtvCacheEntry': {
        const t = this.tiers.get(Number(a[0]))!;
        return [t.ltvBps, t.at];
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

  private refreshLogs(): ReturnType<typeof logOf>[] {
    const logs: ReturnType<typeof logOf>[] = [];
    for (const [tier, t] of this.tiers) {
      if (t.candidate === null) logs.push(logOf('TierLtvCacheRefreshRejected', { tier, candidateLtvBps: 0, reason: t.reason ?? 'insufficient-readings' }));
      else logs.push(logOf('TierLtvCacheUpdated', { tier, newLtvBps: t.candidate, oldLtvBps: t.ltvBps, assetsContributing: 2 }));
    }
    return logs;
  }

  private admit(functionName: string, a: readonly any[]): () => void {
    switch (functionName) {
      case 'expireBuybackIntent': {
        if (this.paused) throw revert('EnforcedPause');
        const o = this.orders.get(a[0]);
        if (!o || o.status !== 1) throw revert('BuybackOrderNotPending', [a[0], o?.status ?? 0]);
        if (this.now < o.expiresAt) throw revert('BuybackNotYetExpired', [o.expiresAt, this.now]);
        return () => {
          o.status = 3;
        };
      }
      case 'refreshTierLtvCache': {
        if (this.peerPaused) throw revert('PeerLtvReadsPaused');
        return () => {
          this.lastLogs = this.refreshLogs();
          for (const t of this.tiers.values()) {
            if (t.candidate !== null) Object.assign(t, { ltvBps: t.candidate, at: this.now });
          }
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

  simulateCalls = async () => {
    this.previews += 1;
    if (!this.simulateV1) throw new Error('eth_simulateV1 not supported');
    if (this.peerPaused) return { results: [{ status: 'failure', logs: [] }] };
    return { results: [{ status: 'success', logs: this.refreshLogs() }] };
  };

  getChainId = async () => this.chainServed;

  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => {
    if (blockTag === 'finalized') return { number: 100n, timestamp: this.now };
    return { number: 120n, timestamp: this.now };
  };

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
  fail = false;

  add(orderHash: unknown, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'BuybackIntentCommitted', args: { orderHash, token: TOKEN }, blockAt: n, block: n, log: 0 });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    if (this.fail) return null;
    expect(kinds).toEqual(['BuybackIntentCommitted']);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('readRefreshLogs', () => {
  it('reads the tiers written and rejected, from the Diamond only', () => {
    const p = readRefreshLogs(DIAMOND, [
      logOf('TierLtvCacheUpdated', { tier: 1, newLtvBps: 7100, oldLtvBps: 7000, assetsContributing: 3 }),
      logOf('TierLtvCacheRefreshRejected', { tier: 3, candidateLtvBps: 9000, reason: 'out-of-band-high' }),
      { ...logOf('TierLtvCacheUpdated', { tier: 2, newLtvBps: 1, oldLtvBps: 2, assetsContributing: 1 }), address: KEEPER },
    ]);
    expect([...p.updated]).toEqual([[1, [7100, 7000]]]);
    expect([...p.rejected]).toEqual([[3, 'out-of-band-high (candidate 9000 bps)']]);
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

  const run = (opts: { keeper?: Address | null; refreshAfterSec?: number; salesSync?: boolean; tierPush?: boolean; sendDeadline?: number } = {}) =>
    upkeepOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      keeper: opts.keeper === undefined ? KEEPER : opts.keeper,
      sendDeadline: opts.sendDeadline ?? Number.POSITIVE_INFINITY,
      refreshAfterSec: opts.refreshAfterSec ?? DEFAULT_REFRESH_AFTER_SEC,
      salesSync: opts.salesSync,
      tierPush: opts.tierPush,
      cursors,
      ledger,
    });
  const fns = () => d.sent.map((s) => s.fn);

  it('stops a refresh preview still in flight at the read cutoff, before the send deadline', async () => {
    // The preview is a simulation, which the read guard does not name: it is
    // bounded through the pass's reader all the same (#2984 rule 3).
    d.simulateCalls = () => new Promise((resolve) => setTimeout(() => resolve({ results: [] }), 3_000));
    const t0 = Date.now();
    const r = await run({ sendDeadline: Date.now() + SEND_RESERVE_MS + 100 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(r.unread.get('run')).toMatch(/deadline/);
    expect(fns()).toEqual([]);
  });

  describe('buyback expiry', () => {
    it('rolls back each pending intent past its expiry, leaves one still live, and passes settled rows with the floor', async () => {
      ledger.add(hash(1)); // expired, pending
      ledger.add(hash(2)); // filled
      ledger.add(hash(3)); // pending, not yet expired
      d.orders.set(hash(1), { expiresAt: NOW - 1n, status: 1 });
      d.orders.set(hash(2), { expiresAt: NOW - 1n, status: 2 });
      d.orders.set(hash(3), { expiresAt: NOW + 60n, status: 1 });
      const r = await run();
      expect(fns()).toEqual(['expireBuybackIntent']);
      expect(d.sent[0].args).toEqual([hash(1)]);
      expect(r.expired).toEqual([hash(1)]);
      expect(cursors.rows.get(BUYBACK_FLOOR_ITEM), 'past the two settled rows, not the live one').toBe(encodePos(ledger.rows[1]));
      // Once it expires, the next run rolls it back too.
      d.now = NOW + 60n;
      d.sent = [];
      expect((await run()).expired).toEqual([hash(3)]);
      expect(cursors.rows.get(BUYBACK_FLOOR_ITEM)).toBe(encodePos(ledger.rows[2]));
    });

    it('moves its floor only on what the finalized block shows', async () => {
      ledger.add(hash(1));
      d.orders.set(hash(1), { expiresAt: NOW - 1n, status: 1 });
      d.finalOrders = new Map([[hash(1), { expiresAt: NOW - 1n, status: 1 }]]);
      const r = await run();
      expect(r.expired).toEqual([hash(1)]);
      expect(cursors.rows.has(BUYBACK_FLOOR_ITEM), 'the expiry is not final yet').toBe(false);
      d.finalOrders = null;
      await run();
      expect(cursors.rows.get(BUYBACK_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('passes a commit at finality only once the commit itself is finalized and its order ended', async () => {
      // Committed and filled at the head, above the finalized block: there the
      // order reads as never made (status 0), which is not an ended order.
      ledger.add(hash(1), 105);
      d.orders.set(hash(1), { expiresAt: NOW - 1n, status: 2 });
      d.finalOrders = new Map();
      await run();
      expect(cursors.rows.has(BUYBACK_FLOOR_ITEM), 'the commit is not final yet').toBe(false);
      // Finalized, but the order still reads as never made: not ended either.
      ledger.rows[0] = { ...ledger.rows[0], block: 100, blockAt: 100 };
      await run();
      expect(cursors.rows.has(BUYBACK_FLOOR_ITEM)).toBe(false);
      d.finalOrders = null;
      await run();
      expect(cursors.rows.get(BUYBACK_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
    });

    it('says so when the ledger cannot be read, and passes a row that names no order', async () => {
      ledger.add('not a hash');
      await run();
      expect(cursors.rows.get(BUYBACK_FLOOR_ITEM)).toBe(encodePos(ledger.rows[0]));
      ledger.fail = true;
      expect((await run()).unread.get('buyback')).toMatch(/event ledger/);
    });

    it('reports an armed step the run never reached as not worked, never as off', async () => {
      d.getChainId = async () => {
        throw new PastRunDeadline('getChainId: past the read cutoff — read next run');
      };
      const r = await run({ salesSync: true, tierPush: true });
      expect(d.sent).toEqual([]);
      const line = describeReport(r);
      expect(line).toContain('sale-sanctions-sync=not worked (not reached this run)');
      expect(line).toContain('tier-push-retry=not worked (not reached this run)');
      expect(line).not.toContain('not armed');
    });

    it('works nothing when the RPC serves another chain', async () => {
      d.chainServed = 1;
      const r = await run();
      expect(r.skipped).toMatch(/serves chain 1/);
      expect(d.sent).toEqual([]);
    });
  });

  describe('tier LTV refresh', () => {
    it('sends nothing while every tier it would write is unchanged and fresh, and names the rejected tier', async () => {
      const r = await run();
      expect(d.sent).toEqual([]);
      expect(r.refreshIdle).toMatch(/unchanged and cached under/);
      expect(r.tiersRejected).toEqual(['tier 3: no-reference-assets']);
      expect(describeReport(r)).toContain('tier-ltv-refreshed=no');
      // Step 3 ships disarmed: the run says so rather than omitting it.
      expect(r.sales).toBeNull();
      expect(describeReport(r)).toContain(
        'sale-sanctions-sync=off (PREPAY_SALE_SANCTIONS_SYNC_ENABLED not armed)',
      );
      expect(r.tierPush).toBeNull();
      expect(describeReport(r)).toContain('tier-push-retry=off (TIER_PUSH_RETRY_ENABLED not armed)');
    });

    it('refreshes when a tier would change, and reports what the receipt wrote', async () => {
      d.tiers.get(2)!.candidate = 6200;
      const r = await run();
      expect(fns()).toEqual(['refreshTierLtvCache']);
      expect(r.refreshed).toEqual([1, 2]);
      expect(r.tiersRejected).toEqual(['tier 3: no-reference-assets']);
      expect(d.tiers.get(2)!.ltvBps).toBe(6200);
      expect(describeReport(r)).toContain('tier-ltv-refreshed=tiers 1,2');
    });

    it(`refreshes a tier cached ${DEFAULT_REFRESH_AFTER_SEC} s ago even when its value is unchanged`, async () => {
      d.tiers.get(1)!.at = NOW - BigInt(DEFAULT_REFRESH_AFTER_SEC);
      expect((await run()).refreshed).toEqual([1, 2]);
    });

    it('sends nothing when no tier would be written, while peer reads are paused, or without a preview', async () => {
      for (const t of d.tiers.values()) t.candidate = null;
      d.tiers.get(1)!.at = 0n;
      let r = await run();
      expect(d.sent).toEqual([]);
      expect(r.refreshIdle).toBe('the refresh would write no tier');
      d.peerPaused = true;
      const before = d.previews;
      r = await run();
      expect(r.refreshIdle).toBe('peer LTV reads are paused');
      expect(d.previews, 'not even previewed').toBe(before);
      d.peerPaused = false;
      d.tiers.get(1)!.candidate = 7000;
      d.simulateV1 = false;
      r = await run();
      expect(d.sent).toEqual([]);
      expect(r.unread.get('tier-ltv')).toMatch(/eth_simulateV1/);
    });
  });
});
