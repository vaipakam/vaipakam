/**
 * #2984 — the protocol upkeep pass: buyback-intent expiry and the tier LTV
 * cache refresh, and (#3097) the tier-exclusion refresh, the reward-entry
 * index compaction and the sanctions-flag refresh, run against a fake Diamond
 * that applies the contract's own admission rules to each call.
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
import { TIER_EXCLUSION_NEXT_ITEM } from '../src/tierExclusionRefresh';
import { COMPACT_MAX_STEPS, REWARD_INDEX_AFTER_ITEM } from '../src/rewardIndexCompact';
import { SCREEN_FLOOR_ITEM, SCREEN_NEXT_ITEM } from '../src/sanctionsFlagRefresh';
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
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const ORACLE: Address = '0x00000000000000000000000000000000000000a1';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
/** `LibVaipakam.SanctionsRead`. */
const SANCTIONS = { Clean: 0, Flagged: 1, Unavailable: 2 } as const;

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

  // #3097 step 5 — loans by id; a stale one would change on a refresh.
  loans = new Map<bigint, { stale: boolean }>();
  exclusionPreviews = 0;
  /** The refresh reverts in simulation (preview and send alike). */
  exclusionReverts = false;
  // #3097 step 6 — each user's index: its length and how many of it are settled.
  indexes = new Map<string, { total: bigint; settled: bigint }>();
  /** What the send-time simulation of a compaction finds instead (a race). */
  compactAtSend: 'same' | 'nothing' | 'revert' = 'same';
  // #3097 step 7 — the oracle and the committed registry.
  oracle: Address = ORACLE;
  status = new Map<string, number>();
  registry = new Set<string>();
  /** What the oracle answers by the time the refresh is simulated. */
  statusAtSend: Map<string, number> | null = null;

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
      case 'getAllLoansPaginated': {
        const [cursor, maxScan] = [BigInt(a[0]), BigInt(a[1])];
        const top = BigInt(this.loans.size);
        const end = cursor + maxScan < top ? cursor + maxScan : top;
        const ids: bigint[] = [];
        for (let id = cursor + 1n; id <= end; id++) if (this.loans.has(id)) ids.push(id);
        return [ids, end < cursor ? cursor : end, top];
      }
      case 'getUserRewardEntryIdsPage':
        return [[], this.indexes.get(String(a[0]).toLowerCase())?.total ?? 0n];
      case 'compactRewardEntryIndex': {
        // The preview: the call on the current state, not sent.
        const ix = this.indexes.get(String(a[0]).toLowerCase());
        return this.compactResult(ix, BigInt(a[1]));
      }
      case 'getSanctionsOracle':
        return this.oracle;
      case 'sanctionsStatus':
        return this.status.get(String(a[0]).toLowerCase()) ?? SANCTIONS.Clean;
      case 'isSanctionsConfirmedFlagged':
        return this.registry.has(String(a[0]).toLowerCase());
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

  /** What `compactRewardEntryIndex` returns: settled entries are reached only
   *  while the index fits in the steps examined (the fake keeps them last). */
  compactResult(ix: { total: bigint; settled: bigint } | undefined, steps: bigint): [bigint, bigint] {
    if (ix === undefined) return [0n, 0n];
    const retired = ix.total <= steps ? ix.settled : 0n;
    return [retired, ix.total - retired];
  }

  /** The loans a refresh of `ids` would change. */
  private staleIn(ids: readonly bigint[]): bigint[] {
    return ids.filter((id) => this.loans.get(id)?.stale === true);
  }

  private exclusionLogs(ids: readonly bigint[]): ReturnType<typeof logOf>[] {
    return this.staleIn(ids).map((loanId) => logOf('TierExclusionUpdated', { loanId, lenderSide: true, vaultOwner: addr(0xaa), excludedVpfi: 5n }));
  }

  private admit(functionName: string, a: readonly any[]): () => void {
    switch (functionName) {
      case 'refreshTierExclusion': {
        if (this.exclusionReverts) throw revert('ReentrancyGuardReentrantCall');
        const ids = a[0] as bigint[];
        return () => {
          this.lastLogs = this.exclusionLogs(ids);
          for (const id of this.staleIn(ids)) this.loans.get(id)!.stale = false;
        };
      }
      case 'compactRewardEntryIndex': {
        if (this.compactAtSend === 'revert') throw revert('AlreadyLaunched');
        const user = String(a[0]).toLowerCase();
        return () => {
          const ix = this.indexes.get(user)!;
          const [retired, remaining] = this.compactResult(ix, BigInt(a[1]));
          this.lastLogs = retired > 0n ? [logOf('RewardEntryIndexCompacted', { user: a[0], retired, remaining })] : [];
          this.indexes.set(user, { total: remaining, settled: ix.settled - retired });
        };
      }
      case 'refreshSanctionsFlag': {
        const who = String(a[0]).toLowerCase();
        const st = (this.statusAtSend ?? this.status).get(who) ?? SANCTIONS.Clean;
        if (st === SANCTIONS.Unavailable) throw revert('SanctionsOracleUnavailable');
        return () => {
          if (st === SANCTIONS.Flagged) this.registry.add(who);
          else this.registry.delete(who);
          this.lastLogs = [logOf('SanctionsFlagRefreshed', { who: a[0], flagged: st === SANCTIONS.Flagged })];
        };
      }
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
    if (functionName === 'compactRewardEntryIndex') {
      const ix = this.indexes.get(String(args[0]).toLowerCase());
      return { result: this.compactAtSend === 'nothing' ? [0n, ix?.total ?? 0n] : this.compactResult(ix, BigInt(args[1] as bigint)) };
    }
    return { result: undefined };
  };

  simulateCalls = async ({ calls }: { calls: { data: Hex }[] }) => {
    const call = decodeFunctionData({ abi: ABI, data: calls[0].data });
    if (call.functionName === 'refreshTierExclusion') {
      this.exclusionPreviews += 1;
      if (this.exclusionReverts) return { results: [{ status: 'failure', logs: [] }] };
      return { results: [{ status: 'success', logs: this.exclusionLogs(call.args![0] as bigint[]) }] };
    }
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
    this.addRow('BuybackIntentCommitted', { orderHash, token: TOKEN }, block);
  }

  addRow(kind: string, args: Record<string, unknown>, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind, args, blockAt: n, block: n, log: 0, tx: hash(n) });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    if (this.fail) return null;
    const rest = this.rows.filter(
      (r) => kinds.includes(r.kind) && (after === null || r.block > after.block || (r.block === after.block && r.log > after.log)),
    );
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

  let parties: string[];
  beforeEach(() => {
    parties = [];
  });

  const run = (
    opts: {
      keeper?: Address | null;
      refreshAfterSec?: number;
      salesSync?: boolean;
      tierPush?: boolean;
      tierExclusion?: boolean;
      rewardIndex?: boolean;
      sanctionsFlags?: boolean;
      sendDeadline?: number;
    } = {},
  ) =>
    upkeepOnce(CHAIN, DIAMOND, {
      client: d.client(),
      readClient: d.client(),
      context: () => d.ctx(),
      keeper: opts.keeper === undefined ? KEEPER : opts.keeper,
      sendDeadline: opts.sendDeadline ?? Number.POSITIVE_INFINITY,
      refreshAfterSec: opts.refreshAfterSec ?? DEFAULT_REFRESH_AFTER_SEC,
      salesSync: opts.salesSync,
      tierPush: opts.tierPush,
      tierExclusion: opts.tierExclusion,
      rewardIndex: opts.rewardIndex,
      sanctionsFlags: opts.sanctionsFlags,
      loanParties: async (after, limit) => [...parties].sort().filter((p) => p > after).slice(0, limit),
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
      const r = await run({ salesSync: true, tierPush: true, tierExclusion: true, rewardIndex: true, sanctionsFlags: true });
      expect(d.sent).toEqual([]);
      const line = describeReport(r);
      expect(line).toContain('sale-sanctions-sync=not worked (not reached this run)');
      expect(line).toContain('tier-push-retry=not worked (not reached this run)');
      expect(line).toContain('tier-exclusion-refresh=not worked (not reached this run)');
      expect(line).toContain('reward-index-compact=not worked (not reached this run)');
      expect(line).toContain('sanctions-flag-refresh=not worked (not reached this run)');
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

  describe('step 5: tier-exclusion refresh', () => {
    const exclusionSends = () => d.sent.filter((s) => s.fn === 'refreshTierExclusion');
    beforeEach(() => {
      for (let id = 1n; id <= 5n; id++) d.loans.set(id, { stale: false });
    });

    it('previews and sends nothing while TIER_EXCLUSION_REFRESH_ENABLED is unset', async () => {
      d.loans.get(3n)!.stale = true;
      const r = await run();
      expect(d.exclusionPreviews).toBe(0);
      expect(exclusionSends()).toEqual([]);
      expect(r.tierExclusion).toBeNull();
      expect(describeReport(r)).toContain('tier-exclusion-refresh=off (TIER_EXCLUSION_REFRESH_ENABLED not armed)');
    });

    it('refreshes exactly the loans the preview shows would change, and wraps at the end of the range', async () => {
      d.loans.get(3n)!.stale = true;
      d.loans.get(5n)!.stale = true;
      const r = await run({ tierExclusion: true });
      expect(exclusionSends().map((s) => s.args)).toEqual([[[3n, 5n]]]);
      expect(r.tierExclusion!.due).toEqual([3n, 5n]);
      expect(r.tierExclusion!.refreshed).toEqual([`3 lender: ${addr(0xaa)} 5 wei`, `5 lender: ${addr(0xaa)} 5 wei`]);
      expect(describeReport(r)).toContain('tier-exclusion-due=3,5');
      // Five loans is less than a page: the next run starts at the first loan.
      expect(cursors.rows.get(TIER_EXCLUSION_NEXT_ITEM)).toBe('');
    });

    it('sends nothing when no loan is due, and moves on', async () => {
      const r = await run({ tierExclusion: true });
      expect(d.exclusionPreviews).toBe(1);
      expect(exclusionSends()).toEqual([]);
      expect(r.tierExclusion!.due).toEqual([]);
      expect(describeReport(r)).toContain('tier-exclusion-due=none');
    });

    it('pages through a range longer than one page', async () => {
      for (let id = 6n; id <= 150n; id++) d.loans.set(id, { stale: false });
      d.loans.get(120n)!.stale = true;
      let r = await run({ tierExclusion: true });
      expect(r.tierExclusion!.page).toEqual({ from: 1n, to: 100n, loans: 100 });
      expect(exclusionSends()).toEqual([]);
      expect(cursors.rows.get(TIER_EXCLUSION_NEXT_ITEM)).toBe('100');
      r = await run({ tierExclusion: true });
      expect(r.tierExclusion!.page).toEqual({ from: 101n, to: 150n, loans: 50 });
      expect(exclusionSends().map((s) => s.args)).toEqual([[[120n]]]);
      expect(cursors.rows.get(TIER_EXCLUSION_NEXT_ITEM)).toBe('');
    });

    it('sends nothing on a simulated revert, and reads the same page again next run', async () => {
      d.loans.get(2n)!.stale = true;
      d.exclusionReverts = true;
      const r = await run({ tierExclusion: true });
      expect(exclusionSends()).toEqual([]);
      expect(r.tierExclusion!.off).toBe('the refresh preview reverted');
      expect(cursors.rows.has(TIER_EXCLUSION_NEXT_ITEM), 'the page is not passed').toBe(false);
    });

    it('sends nothing when the send-time simulation reverts, and keeps the page', async () => {
      d.loans.get(2n)!.stale = true;
      cursors.rows.set(TIER_EXCLUSION_NEXT_ITEM, '0');
      // The preview passes; by the send the contract refuses.
      const preview = d.simulateCalls;
      d.simulateCalls = async (x) => {
        const before = d.exclusionPreviews;
        const out = await preview(x);
        if (d.exclusionPreviews > before) d.exclusionReverts = true;
        return out;
      };
      const r = await run({ tierExclusion: true });
      expect(exclusionSends()).toEqual([]);
      expect(r.refused.get('tier-exclusion:loans 2')).toBe('ReentrancyGuardReentrantCall');
      expect(cursors.rows.get(TIER_EXCLUSION_NEXT_ITEM)).toBe('0');
    });
  });

  describe('step 6: reward-entry index compaction', () => {
    const compactSends = () => d.sent.filter((s) => s.fn === 'compactRewardEntryIndex');
    const [A, B, C] = [addr(0xa1a), addr(0xb1b), addr(0xc1c)];
    beforeEach(() => {
      parties = [A, B, C];
      d.indexes.set(A, { total: 5n, settled: 2n });
      d.indexes.set(B, { total: 3n, settled: 0n });
    });

    it('reads and sends nothing while REWARD_INDEX_COMPACT_ENABLED is unset', async () => {
      const r = await run();
      expect(compactSends()).toEqual([]);
      expect(r.rewardIndex).toBeNull();
      expect(describeReport(r)).toContain('reward-index-compact=off (REWARD_INDEX_COMPACT_ENABLED not armed)');
    });

    it('compacts only a party whose preview retires something', async () => {
      const r = await run({ rewardIndex: true });
      expect(compactSends().map((s) => s.args)).toEqual([[A, 5n]]);
      expect(r.rewardIndex!.parties).toBe(3);
      expect(r.rewardIndex!.indexed).toBe(2);
      expect(r.rewardIndex!.due).toEqual([`${A}: 2 of 5`]);
      expect(r.rewardIndex!.compacted).toEqual([`${A}: 2 retired, 3 left`]);
      expect(d.indexes.get(A)).toEqual({ total: 3n, settled: 0n });
      // Every party finished and the slice was the last: the next run starts over.
      expect(cursors.rows.get(REWARD_INDEX_AFTER_ITEM)).toBe('');
      // A second run finds nothing due.
      d.sent = [];
      expect((await run({ rewardIndex: true })).rewardIndex!.due).toEqual([]);
      expect(compactSends()).toEqual([]);
    });

    it('sends nothing when the send-time simulation retires nothing (another caller got there first)', async () => {
      d.compactAtSend = 'nothing';
      const r = await run({ rewardIndex: true });
      expect(compactSends()).toEqual([]);
      expect(r.rewardIndex!.compacted).toEqual([]);
      expect(cursors.rows.get(REWARD_INDEX_AFTER_ITEM), 'the party is finished').toBe('');
    });

    it('sends nothing on a simulated revert, and waits at the party for the next run', async () => {
      d.compactAtSend = 'revert';
      const r = await run({ rewardIndex: true });
      expect(compactSends()).toEqual([]);
      expect(r.refused.get(`reward-index:${A}`)).toBe('AlreadyLaunched');
      // A is first in address order and unfinished, so the slice is read again.
      expect(cursors.rows.get(REWARD_INDEX_AFTER_ITEM)).toBe('');
      expect(r.rewardIndex!.due).toEqual([`${A}: 2 of 5`]);
    });

    it('names a party whose index is longer than one call can reach, never as clean', async () => {
      d.indexes.set(B, { total: BigInt(COMPACT_MAX_STEPS) + 10n, settled: 4n });
      const r = await run({ rewardIndex: true });
      expect(compactSends().map((s) => s.args[0])).toEqual([A]);
      expect(r.rewardIndex!.outOfReach).toEqual([B]);
      expect(describeReport(r)).toContain(`reward-index-out-of-reach=${B}`);
    });
  });

  describe('step 7: sanctions-flag refresh', () => {
    const refreshSends = () => d.sent.filter((s) => s.fn === 'refreshSanctionsFlag');
    const [V, H, P, K, R] = [addr(0x101), addr(0x102), addr(0x103), addr(0x104), addr(0x105)];
    beforeEach(() => {
      ledger.addRow('UserVaultCreated', { user: V, proxy: addr(0x999) });
      ledger.addRow('Transfer', { from: ZERO, to: H, tokenId: 1n });
      ledger.addRow('PayoutQueued', { account: V, id: 1n, asset: TOKEN, kind: 0, tokenId: 0n, amount: 1n, recipient: P, releaseAt: 0n });
      ledger.addRow('KeeperRewardPaid', { keeper: K, actionKind: hash(1), gasUsed: 1n, ethEquivalent: 1n, vpfiPaid: 1n });
      ledger.addRow('SanctionsFlagRefreshed', { who: R, flagged: true });
      ledger.addRow('Transfer', { from: H, to: ZERO, tokenId: 1n }); // a burn names no one
    });

    it('reads and sends nothing while SANCTIONS_FLAG_REFRESH_ENABLED is unset', async () => {
      d.status.set(V, SANCTIONS.Flagged);
      const r = await run();
      expect(refreshSends()).toEqual([]);
      expect(r.sanctionsFlags).toBeNull();
      expect(describeReport(r)).toContain('sanctions-flag-refresh=off (SANCTIONS_FLAG_REFRESH_ENABLED not armed)');
    });

    it('registers a flagged wallet nothing registered and clears a cleared one, and leaves the rest', async () => {
      d.status.set(V, SANCTIONS.Flagged); // flagged, unregistered: due
      d.status.set(H, SANCTIONS.Flagged);
      d.registry.add(H); // flagged, registered: in step
      d.registry.add(P); // clean, registered: due
      d.status.set(K, SANCTIONS.Unavailable); // the oracle cannot answer
      // R: clean, unregistered — in step.
      const r = await run({ sanctionsFlags: true });
      expect(refreshSends().map((s) => s.args[0]).sort()).toEqual([V, P].sort());
      expect(r.sanctionsFlags!.wallets).toBe(5);
      expect(r.sanctionsFlags!.due).toBe(2);
      expect(r.sanctionsFlags!.registered).toEqual([V]);
      expect(r.sanctionsFlags!.cleared).toEqual([P]);
      expect(r.sanctionsFlags!.unscreened).toBe(1);
      expect([...d.registry].sort()).toEqual([V, H].sort());
      const line = describeReport(r);
      expect(line).toContain('sanctions-flag-screened=5 wallets from 6 rows, 2 out of step with the oracle');
      expect(line).toContain('sanctions-flag-unscreened=1');
      // A standing re-screen: no floor, and past the last page it starts over.
      expect(cursors.rows.has(SCREEN_FLOOR_ITEM)).toBe(false);
      expect(cursors.rows.get(SCREEN_NEXT_ITEM) ?? '').toBe('');
      // The next run is in step.
      d.sent = [];
      expect((await run({ sanctionsFlags: true })).sanctionsFlags!.due).toBe(0);
    });

    it('sends nothing on a simulated revert (the oracle stopped answering by the send)', async () => {
      d.status.set(V, SANCTIONS.Flagged);
      d.statusAtSend = new Map([[V, SANCTIONS.Unavailable]]);
      const r = await run({ sanctionsFlags: true });
      expect(refreshSends()).toEqual([]);
      expect(r.refused.get(`sanctions-flag:${V}`)).toBe('SanctionsOracleUnavailable');
      expect(d.registry.has(V)).toBe(false);
    });

    it('reads nothing past the gate on a chain with no sanctions oracle', async () => {
      d.oracle = ZERO;
      d.status.set(V, SANCTIONS.Flagged);
      const r = await run({ sanctionsFlags: true });
      expect(refreshSends()).toEqual([]);
      expect(r.sanctionsFlags!.off).toMatch(/no sanctions oracle is set/);
      expect(cursors.rows.has(SCREEN_NEXT_ITEM)).toBe(false);
    });
  });
});
