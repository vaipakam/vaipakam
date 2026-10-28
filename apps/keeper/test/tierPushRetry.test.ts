/**
 * #2984 — the tier-push retry (protocol upkeep step 4), run against a fake
 * Diamond whose `getTierPushStatus` and `deliverTierPush` follow the facet's
 * rules: a lane the budget may pay now, and whose fee the budget covers, is
 * delivered; any other owed lane stays owed and is deferred with its reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem';
import {
  DEFERRAL_FLOOR_ITEM,
  deferralDone,
  describeTierPush,
  retryTierPushes,
  TIER_PUSH_ABI,
} from '../src/tierPushRetry';
import { encodePos, type EventLedger, type LedgerPos, type LedgerRow } from '../src/eventLedger';
import { finalizedBlockOnce, memoryScanCursors } from '../src/scanCursors';
import { StepSender } from '../src/stepSender';
import type { KeeperContext } from '../src/keeper';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const MESSENGER: Address = '0x00000000000000000000000000000000000000d1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const NOW = 1_000_000n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const REASON = { Spacing: 0, Budget: 1 } as const;

function logOf(eventName: string, args: Record<string, unknown>): { address: Address; data: Hex; topics: Hex[] } {
  const ev = TIER_PUSH_ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address: DIAMOND, topics, data: encodeAbiParameters(plain, plain.map((i) => args[i.name!])) };
}

interface LaneState {
  owed: boolean;
  eligibleAt: bigint;
}

interface UserPush {
  nonce: bigint;
  tier: number;
  lanes: Map<bigint, LaneState>;
}

const push = (nonce: bigint, lanes: [number, LaneState][]): UserPush => ({ nonce, tier: 2, lanes: new Map(lanes.map(([d, l]) => [BigInt(d), l])) });
const owedNow = { owed: true, eligibleAt: 0n };
const spaced = { owed: true, eligibleAt: NOW + 3600n };
const settled = { owed: false, eligibleAt: 0n };

class FakeDiamond {
  budget = 10_000n;
  messenger: Address = MESSENGER;
  users = new Map<string, UserPush>();
  /** The finalized block's view of the pushes, when it lags the head. */
  finalUsers: Map<string, UserPush> | null = null;
  /** Each lane's quote; what the send charges, unless `sendFee` differs. */
  fee = new Map<bigint, bigint>();
  sendFee: Map<bigint, bigint> | null = null;
  sent: { fn: string; args: readonly unknown[] }[] = [];
  lastLogs: ReturnType<typeof logOf>[] = [];
  reads: string[] = [];

  private status(u: UserPush | undefined) {
    if (u === undefined) return [0n, 0, 0, 0, 0, []];
    const lanes = [...u.lanes].map(([dst, l]) => ({
      destChainId: dst,
      delivered: { nonce: 0n, tier: 0, bps: 0, tierExpirySec: 0, tierTableVersion: 0, sentAt: 0 },
      owed: l.owed,
      budgetEligibleAt: l.owed ? l.eligibleAt : 0n,
    }));
    return [u.nonce, u.tier, 500, 0, 1, lanes];
  }

  readContract = async ({ address, functionName, args = [], blockNumber }: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    this.reads.push(functionName);
    const a = args as readonly any[];
    if (functionName === 'quoteSendTierUpdateTo') {
      expect(address).toBe(MESSENGER);
      const f = this.fee.get(a[0]);
      if (f === undefined) throw new Error('NotBroadcastDestination');
      return f;
    }
    switch (functionName) {
      case 'getProtocolBroadcastBudget':
        return this.budget;
      case 'getRewardReporterConfig':
        return [this.messenger, CHAIN, CHAIN, true, 0n];
      case 'getTierPushStatus':
        return this.status(((blockNumber !== undefined ? this.finalUsers : null) ?? this.users).get(String(a[0]).toLowerCase()));
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

  private admit(functionName: string, a: readonly any[]): () => void {
    if (functionName !== 'deliverTierPush') throw new Error(`unexpected call ${functionName}`);
    const user = String(a[0]).toLowerCase();
    return () => {
      const u = this.users.get(user);
      this.lastLogs = [];
      if (u === undefined) return;
      for (const [dst, l] of u.lanes) {
        if (!l.owed) continue;
        if (NOW < l.eligibleAt) {
          this.lastLogs.push(logOf('TierPushDeferred', { user: a[0], destChainId: dst, nonce: u.nonce, reason: REASON.Spacing }));
          continue;
        }
        const fee = (this.sendFee ?? this.fee).get(dst) ?? 0n;
        if (fee > this.budget) {
          this.lastLogs.push(logOf('TierPushDeferred', { user: a[0], destChainId: dst, nonce: u.nonce, reason: REASON.Budget }));
          continue;
        }
        this.budget -= fee;
        l.owed = false;
        this.lastLogs.push(logOf('ProtocolTierBroadcastSent', { user: a[0], destChainId: dst, effectiveTier: u.tier, effectiveBps: 500, nonce: u.nonce, feePaid: fee, callerFunded: false }));
      }
    };
  }

  simulateContract = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    this.admit(functionName, args);
    return { result: undefined };
  };

  getBlockNumber = async () => 120n;
  getBlock = async ({ blockTag }: { blockTag?: string } = {}) => (blockTag === 'finalized' ? { number: 100n, timestamp: NOW - 100n } : { number: 120n, timestamp: NOW });
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

  add(user: Address, dst: number, nonce: bigint, block?: number): void {
    const n = block ?? this.rows.length + 1;
    this.rows.push({ kind: 'TierPushDeferred', args: { user, destChainId: String(dst), nonce: String(nonce), reason: '1' }, blockAt: n, block: n, log: 0, tx: hash(n) });
  }

  async matching(): Promise<LedgerRow[] | null> {
    throw new Error('unexpected ledger lookup');
  }

  async page(_chainId: number, kinds: readonly string[], after: LedgerPos | null, limit: number) {
    expect(kinds).toEqual(['TierPushDeferred']);
    const rest = this.rows.filter((r) => after === null || r.block > after.block || (r.block === after.block && r.log > after.log));
    return { rows: rest.slice(0, limit), more: rest.length > limit };
  }
}

describe('the tier-push retry', () => {
  let d: FakeDiamond;
  let ledger: FakeLedger;
  let cursors: ReturnType<typeof memoryScanCursors>;
  const U1 = addr(0x11);
  const U2 = addr(0x22);

  beforeEach(() => {
    d = new FakeDiamond();
    d.fee.set(10n, 300n);
    d.fee.set(42n, 400n);
    ledger = new FakeLedger();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = () => {
    const sender = new StepSender(
      {
        pass: 'protocolUpkeep',
        abi: TIER_PUSH_ABI,
        maxSends: 10,
        receiptTimeoutMs: 1_000,
        races: new Set(),
        pausedRefusal: 'EnforcedPause',
        describe: (s) => String(s),
        spends: 'the gas',
      },
      { context: () => d.ctx(), sendDeadline: Number.POSITIVE_INFINITY },
    );
    return retryTierPushes(CHAIN, DIAMOND, sender, {
      readClient: d.client(),
      sendDeadline: Number.POSITIVE_INFINITY,
      visit: 0,
      cursors,
      ledger,
      finalized: finalizedBlockOnce(d.client()),
    }).then((report) => ({ report, sender }));
  };
  const fns = () => d.sent.map((s) => `${s.fn}(${s.args.join(',')})`);
  const floor = () => cursors.rows.get(DEFERRAL_FLOOR_ITEM);

  it('reads nothing past the ledger when it names no one', async () => {
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.nominated).toBe(0);
    expect(d.reads).toEqual([]);
  });

  it('delivers the lane the budget can pay now and reports the spaced one still owed', async () => {
    d.users.set(U1, push(3n, [[10, { ...owedNow }], [42, { ...spaced }]]));
    ledger.add(U1, 10, 3n);
    ledger.add(U1, 42, 3n);
    const { report } = await run();
    expect(fns()).toEqual([`deliverTierPush(${U1})`]);
    expect(report.delivered).toEqual([`${U1}: lanes 10; still owed 42 (spacing)`]);
    expect(d.budget).toBe(10_000n - 300n);
    expect(describeTierPush(report).join(' ')).toContain('tier-push-delivered=');
  });

  it('sends nothing for a user whose every owed lane is still spaced', async () => {
    d.users.set(U1, push(3n, [[42, { ...spaced }]]));
    ledger.add(U1, 42, 3n);
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.owed).toEqual([U1]);
    expect(report.waiting[0]).toMatch(/spaced until/);
  });

  it('sends nothing when the budget cannot cover the fee, and spends the budget once across users', async () => {
    d.budget = 500n;
    d.users.set(U1, push(3n, [[42, { ...owedNow }]])); // 400: fits
    d.users.set(U2, push(1n, [[10, { ...owedNow }]])); // 300: not after U1
    ledger.add(U1, 42, 3n);
    ledger.add(U2, 10, 1n);
    const { report } = await run();
    expect(fns()).toEqual([`deliverTierPush(${U1})`]);
    expect(report.waiting).toEqual([`${U2}: 10 (fee 300 over the 100 the budget has left)`]);
  });

  it('says so when a delivery lands and the contract delivers no lane', async () => {
    d.users.set(U1, push(3n, [[10, { ...owedNow }]]));
    d.sendFee = new Map([[10n, 99_999n]]); // the fee rose between the quote and the send
    ledger.add(U1, 10, 3n);
    const { report } = await run();
    expect(fns()).toEqual([`deliverTierPush(${U1})`]);
    expect(report.deliveredNone).toEqual([U1]);
  });

  it('moves the floor past a delivered lane only once the finalized block shows it delivered', async () => {
    d.users.set(U1, push(3n, [[10, { ...owedNow }]]));
    ledger.add(U1, 10, 3n, 50);
    d.finalUsers = new Map([[U1, push(3n, [[10, { ...owedNow }]])]]);
    await run();
    expect(floor(), 'delivered at the head only').toBeUndefined();
    d.finalUsers = null;
    await run();
    expect(floor()).toBe(encodePos({ block: 50, log: 0 }));
    expect(d.sent).toHaveLength(1);
  });

  it('holds the floor at a row whose own event is not finalized yet', async () => {
    d.users.set(U1, push(3n, [[10, { ...settled }]]));
    ledger.add(U1, 10, 3n, 110); // the finalized block is 100
    await run();
    expect(floor()).toBeUndefined();
  });

  it('passes a superseded push and one whose lane left the destination list', async () => {
    d.users.set(U1, push(4n, [[10, { ...settled }]]));
    d.users.set(U2, push(1n, [[10, { ...settled }]]));
    ledger.add(U1, 10, 3n, 10); // nonce 3, now 4
    ledger.add(U2, 42, 1n, 11); // lane 42 no longer listed
    await run();
    expect(floor()).toBe(encodePos({ block: 11, log: 0 }));
  });

  it('reads no messenger quote and sends nothing on a chain with no reward messenger', async () => {
    d.messenger = ZERO;
    d.users.set(U1, push(3n, [[10, { ...owedNow }]]));
    ledger.add(U1, 10, 3n);
    const { report } = await run();
    expect(d.sent).toEqual([]);
    expect(report.off).toMatch(/no reward messenger/);
    expect(d.reads).not.toContain('quoteSendTierUpdateTo');
  });
});

describe('deferralDone', () => {
  const k = { user: addr(1), dst: 10n, nonce: 3n };
  const st = (nonce: bigint, lanes: { dst: bigint; owed: boolean }[]) => ({ nonce, tier: 1, bps: 1, expiry: 0, version: 1, lanes: lanes.map((l) => ({ ...l, eligibleAt: 0n })) });

  it('finishes nothing on an empty lane list unless the push was superseded', () => {
    expect(deferralDone(k, st(3n, []))).toBe(false);
    expect(deferralDone(k, st(4n, []))).toBe(true);
  });

  it('finishes a no-lane row only when no lane is owed', () => {
    const none = { ...k, dst: 0n };
    expect(deferralDone(none, st(3n, [{ dst: 10n, owed: true }]))).toBe(false);
    expect(deferralDone(none, st(3n, [{ dst: 10n, owed: false }]))).toBe(true);
  });

  it('finishes nothing it could not read', () => {
    expect(deferralDone(k, undefined)).toBe(false);
  });
});
