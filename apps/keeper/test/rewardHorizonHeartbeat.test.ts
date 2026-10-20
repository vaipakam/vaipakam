/**
 * #2517 — the reward claim-horizon heartbeat. Pinned in two layers:
 *
 *   - the PURE rules: which entries are settled, which a heartbeat touches
 *     (everything live while the horizon is armed; while it is dark, only an
 *     entry whose removal has begun), and how a paused clock is read from the
 *     contract's removal estimate across two landed touches;
 *   - whole RUNS against a fake chain and the real private-DB migrations:
 *     discovery from the global entry sequence, the heartbeat spacing, the
 *     split of a batch that would revert, a chain-wide refusal, and every
 *     alert the issue asks for, raised AND cleared on a measurement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Abi, type Address, type PublicClient } from 'viem';
import { RewardHorizonSweepFacetABI } from '@vaipakam/contracts/abis';
import {
  DUE_AFTER_SEC,
  HEARTBEAT_SEC,
  MAX_WRITES_PER_RUN,
  PAUSED_ALERT_RUNS,
  SWEEP_BATCH,
  DUE_SLICE,
  OVERDUE_AFTER_SEC,
  heartbeatOnce,
  isSettled,
  isTouchable,
  isUnallocated,
  pausedRunsAfter,
  planHeartbeat,
  type RewardEntryView,
} from '../src/rewardHorizonHeartbeat';
import type { HorizonEntryRow } from '../src/db';
import type { Env } from '../src/env';
import type { KeeperContext } from '../src/keeper';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { SqliteD1 } from './helpers/sqliteD1';

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as Address;
const OWNER = '0x00000000000000000000000000000000000000a1' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const T0 = Date.UTC(2026, 9, 20, 0, 44, 0);

function entry(over: Partial<RewardEntryView> = {}): RewardEntryView {
  return {
    user: OWNER,
    loanId: 1n,
    startDay: 10,
    endDay: 20,
    side: 0,
    processed: false,
    forfeited: false,
    closed: true,
    perDayNumeraire18: 10n ** 18n,
    expiryBegun: false,
    ...over,
  };
}
const unallocated = (): RewardEntryView => entry({ user: ZERO, loanId: 0n, startDay: 0, endDay: 0, closed: false, perDayNumeraire18: 0n });

function row(over: Partial<HorizonEntryRow> = {}): HorizonEntryRow {
  return { entryId: 1, checkedAt: 0, touchedAt: 0, expiresAt: 0, pausedRuns: 0, addedAt: 0, ...over };
}

describe('the pure rules', () => {
  it('a zeroed struct is past the end of the sequence; a real one is not', () => {
    expect(isUnallocated(unallocated())).toBe(true);
    expect(isUnallocated(entry())).toBe(false);
  });

  it('settled = processed or forfeited; a removed entry is still live', () => {
    expect(isSettled(entry({ processed: true }))).toBe(true);
    expect(isSettled(entry({ forfeited: true }))).toBe(true);
    expect(isSettled(entry({ expiryBegun: true }))).toBe(false);
    expect(isSettled(entry({ closed: false }))).toBe(false);
  });

  it('armed: every live entry is touched; dark: only one whose removal has begun', () => {
    expect(isTouchable(entry(), 365)).toBe(true);
    expect(isTouchable(entry({ closed: false }), 365)).toBe(true);
    expect(isTouchable(entry(), 0)).toBe(false);
    expect(isTouchable(entry({ expiryBegun: true }), 0)).toBe(true);
    expect(isTouchable(entry({ processed: true, expiryBegun: true }), 0)).toBe(false);
  });

  describe('pausedRunsAfter — the removal estimate across two landed touches', () => {
    const prev = { touchedAt: 1_000, expiresAt: 50_000_000, pausedRuns: 1 };
    const now = 1_000 + HEARTBEAT_SEC;
    it('an estimate that held still means the clock advanced: the count resets', () => {
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_000 }, now)).toBe(0);
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_010 }, now)).toBe(0);
    });
    it('an estimate that moved forward by the time between the reads means it paused: the count grows', () => {
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_000 + HEARTBEAT_SEC }, now)).toBe(2);
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_000 + HEARTBEAT_SEC - 600 }, now), 'within the tolerance').toBe(2);
    });
    it('a horizon retune moves the estimate by days, not by the interval: never a pause (Codex #2596 r1)', () => {
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_000 + 30 * 86_400 }, now)).toBe(0);
      expect(pausedRunsAfter(prev, { firstClaimableAt: 500, expiresAt: 50_000_000 - 30 * 86_400 }, now)).toBe(0);
    });
    it('is not comparable without a previous landed touch, a previous countdown, or a started clock', () => {
      const later = { firstClaimableAt: 500, expiresAt: 50_000_000 + HEARTBEAT_SEC };
      expect(pausedRunsAfter({ ...prev, touchedAt: 0 }, later, now)).toBe(0);
      expect(pausedRunsAfter({ ...prev, expiresAt: 0 }, later, now)).toBe(0);
      expect(pausedRunsAfter(prev, { ...later, firstClaimableAt: 0 }, now)).toBe(0);
      expect(pausedRunsAfter(prev, { ...later, expiresAt: 0 }, now)).toBe(0);
    });
  });

  it('planHeartbeat sorts each read into settled, idle, touch or unread', () => {
    const rows = [1, 2, 3, 4].map((entryId) => row({ entryId }));
    const exp = { firstClaimableAt: 0, expiresAt: 0 };
    const reads = new Map([
      [1, { entry: entry({ processed: true }), expiry: exp }],
      [2, { entry: entry(), expiry: { firstClaimableAt: 5, expiresAt: 99 } }],
      [3, null],
    ]);
    expect(planHeartbeat(rows, reads, 365, 10_000)).toEqual({
      settled: [1],
      idle: [],
      touch: [{ entryId: 2, expiresAt: 99, pausedRuns: 0 }],
      unread: [3, 4],
    });
    expect(planHeartbeat(rows, reads, 0, 10_000).idle).toEqual([2]);
  });
});

// ─── whole runs against a fake chain ────────────────────────────────────────

const SWEEP_ABI = RewardHorizonSweepFacetABI as Abi;

function revert(errorName: string): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: SWEEP_ABI,
    data: encodeErrorResult({ abi: SWEEP_ABI, errorName } as never),
    functionName: 'sweepExpiredInteractionRewards',
  });
}

/** A fake Diamond holding reward entries, a horizon knob and a sweep. */
class FakeChain {
  entries = new Map<number, RewardEntryView>();
  expiry = new Map<number, { firstClaimableAt: number; expiresAt: number }>();
  horizonDays = 365;
  /** Entry ids whose sweep reverts (a plain error, undecoded). */
  failing = new Set<number>();
  /** A chain-wide refusal every sweep reverts with. */
  refuse: string | null = null;
  /** Make every receipt revert. */
  receiptReverts = false;
  /** A batch of more than this many entries reverts as a WHOLE (a pool limit
   *  on the batch's total), though each entry goes through alone. */
  maxTogether = Number.POSITIVE_INFINITY;
  sent: number[][] = [];

  readContract = async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    if (functionName === 'getRewardClaimHorizonDays') return this.horizonDays;
    if (functionName === 'getRewardEntriesRange') {
      const [from, count] = args as [bigint, bigint];
      return Array.from({ length: Number(count) }, (_, i) => this.entries.get(Number(from) + i) ?? unallocated());
    }
    if (functionName === 'getRewardEntryExpiry') {
      const x = this.expiry.get(Number((args as [bigint])[0])) ?? { firstClaimableAt: 0, expiresAt: 0 };
      return [BigInt(x.firstClaimableAt), BigInt(x.expiresAt)];
    }
    throw new Error(`unexpected read ${functionName}`);
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

  simulateContract = async ({ args }: { args: readonly unknown[] }) => {
    if (this.refuse) throw revert(this.refuse);
    const ids = (args[0] as bigint[]).map(Number);
    const bad = ids.find((id) => this.failing.has(id));
    if (bad !== undefined) throw Object.assign(new Error('raw message, never printed'), { shortMessage: `entry ${bad} boom` });
    if (ids.length > this.maxTogether) throw revert('InteractionPoolReservedShortfall');
    return { result: 0n };
  };

  waitForTransactionReceipt = async () => ({ status: this.receiptReverts ? 'reverted' : 'success' });

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
        account: { address: '0x00000000000000000000000000000000000000ee' },
        writeContract: async ({ args }: { args: readonly unknown[] }) => {
          this.sent.push((args[0] as bigint[]).map(Number));
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

describe('a run', () => {
  let keeper: SqliteD1;
  let env: Env;
  let chain: FakeChain;
  let warned: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    keeper = createKeeperD1();
    env = { DB: createSharedD1().d1, KEEPER_DB: keeper.d1 } as unknown as Env;
    chain = new FakeChain();
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const run = () =>
    heartbeatOnce(env, CHAIN, DIAMOND, {
      client: chain.client(),
      readClient: chain.client(),
      context: () => chain.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      runDeadline: Number.POSITIVE_INFINITY,
    });
  const queued = () =>
    (keeper.db.prepare('SELECT entry_id FROM keeper_horizon_entry ORDER BY entry_id').all() as { entry_id: number }[]).map((r) => r.entry_id);
  const cursor = () => (keeper.db.prepare('SELECT next_entry_id FROM keeper_horizon_cursor').get() as { next_entry_id: number } | undefined)?.next_entry_id;
  const alerts = (re: RegExp) => warned.filter((w) => re.test(w));
  const later = (sec: number) => vi.setSystemTime(Date.now() + sec * 1000);

  it('discovers the live entries, touches them, and leaves them until the next heartbeat', async () => {
    chain.entries.set(1, entry({ processed: true }));
    chain.entries.set(2, entry());
    chain.entries.set(3, entry({ forfeited: true }));
    chain.entries.set(4, entry({ closed: false }));
    await run();
    expect(queued(), 'settled entries are never queued').toEqual([2, 4]);
    expect(cursor(), 'past the last allocated id').toBe(5);
    expect(chain.sent).toEqual([[2, 4]]);

    await run();
    expect(chain.sent, 'nothing is due again within the heartbeat').toHaveLength(1);
    later(DUE_AFTER_SEC);
    chain.entries.set(5, entry());
    await run();
    expect(chain.sent[1], 'a heartbeat later: the new entry (never checked) first, then the old ones').toEqual([5, 2, 4]);
  });

  it('retires an entry once it settles on chain', async () => {
    chain.entries.set(1, entry());
    await run();
    chain.entries.set(1, entry({ processed: true }));
    later(DUE_AFTER_SEC);
    await run();
    expect(queued()).toEqual([]);
    expect(chain.sent).toHaveLength(1);
  });

  it('while the horizon is dark, touches only an entry whose removal has begun', async () => {
    chain.horizonDays = 0;
    chain.entries.set(1, entry());
    chain.entries.set(2, entry({ expiryBegun: true }));
    await run();
    expect(chain.sent).toEqual([[2]]);
    const checked = keeper.db.prepare('SELECT entry_id, checked_at, touched_at FROM keeper_horizon_entry ORDER BY entry_id').all();
    const now = Math.floor(T0 / 1000);
    expect(checked, 'the idle entry is checked, not touched').toEqual([
      { entry_id: 1, checked_at: now, touched_at: 0 },
      { entry_id: 2, checked_at: now, touched_at: now },
    ]);
  });

  it('sends in batches of SWEEP_BATCH, at most MAX_WRITES_PER_RUN a run', async () => {
    const n = SWEEP_BATCH * 2 + 3;
    for (let id = 1; id <= n; id++) chain.entries.set(id, entry());
    await run();
    expect(chain.sent.map((b) => b.length)).toEqual([SWEEP_BATCH, SWEEP_BATCH, 3]);
    expect(MAX_WRITES_PER_RUN * SWEEP_BATCH).toBeGreaterThanOrEqual(n);
  });

  it('splits a batch that would revert: the rest still lands, the bad entry is named, and its alert clears once it lands', async () => {
    for (let id = 1; id <= 3; id++) chain.entries.set(id, entry());
    chain.failing.add(2);
    await run();
    expect(chain.sent, 'halved until the bad entry is alone').toEqual([[1], [3]]);
    expect(alerts(/touch of reward entry 2 reverts \(entry 2 boom\)/)).toHaveLength(1);

    // The alert as the ops bot would have recorded it.
    keeper.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)`).run(`horizon-revert:${CHAIN}:2`, 1, 1, CHAIN);
    chain.failing.clear();
    await run();
    expect(chain.sent.at(-1), 'the failed entry stayed due and is retried next run').toEqual([2]);
    expect(keeper.db.prepare('SELECT COUNT(*) AS n FROM keeper_ops_alert').get()).toEqual({ n: 0 });
  });

  it('a pause stops the sends without an alert; any other chain-wide refusal is said', async () => {
    chain.entries.set(1, entry());
    chain.refuse = 'EnforcedPause';
    await run();
    expect(chain.sent).toEqual([]);
    expect(alerts(/every touch on this chain is refused/)).toHaveLength(0);
    chain.refuse = 'VPFITokenNotSet';
    await run();
    expect(alerts(/every touch on this chain is refused \(VPFITokenNotSet\)/)).toHaveLength(1);
  });

  it('never resends a combination that fails together: the group is halved and each part re-simulated (Codex #2596 r1)', async () => {
    for (let id = 1; id <= 4; id++) chain.entries.set(id, entry());
    chain.maxTogether = 2;
    await run();
    expect(chain.sent).toEqual([[1, 2], [3, 4]]);
    expect(alerts(/reverts/), 'no entry is at fault').toHaveLength(0);
  });

  it('says when entries have not been reached for two heartbeats, with the capacity', async () => {
    chain.entries.set(1, entry());
    await run();
    chain.receiptReverts = true;
    later(DUE_AFTER_SEC);
    await run();
    expect(alerts(/not been reached/), 'one failed heartbeat is not yet two').toHaveLength(0);
    later(OVERDUE_AFTER_SEC);
    await run();
    const [line] = alerts(/not been reached/);
    expect(line).toMatch(/1 of 1 queued reward entry has not been reached for more than 24h \(id 1\)/);
    expect(line).toContain(`at most ${DUE_SLICE} an hour`);
  });

  it('counts an entry never reached at all, not only one whose touch failed', async () => {
    chain.entries.set(1, entry());
    await run();
    // Queued but never finished with (here: more live entries than reached).
    keeper.db.prepare('UPDATE keeper_horizon_entry SET checked_at = 0, added_at = 0').run();
    chain.entries.set(1, entry());
    chain.refuse = 'VPFITokenNotSet';
    await run();
    expect(alerts(/1 of 1 queued reward entry has not been reached/)).toHaveLength(1);
  });

  it('a deliberate pause raises no overdue alert, and clears none', async () => {
    chain.entries.set(1, entry());
    await run();
    keeper.db.prepare(`INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)`).run(`horizon-overdue:${CHAIN}:all`, 1, 1, CHAIN);
    chain.refuse = 'EnforcedPause';
    later(OVERDUE_AFTER_SEC + DUE_AFTER_SEC);
    await run();
    expect(alerts(/not been reached/)).toHaveLength(0);
    expect(keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert').all()).toEqual([{ alert_key: `horizon-overdue:${CHAIN}:all` }]);
  });

  it('reports a clock that did not advance across two landed touches, and not one that did', async () => {
    chain.entries.set(1, entry());
    chain.entries.set(2, entry());
    const base = Math.floor(T0 / 1000) + 400 * 86_400;
    chain.expiry.set(1, { firstClaimableAt: 1, expiresAt: base });
    chain.expiry.set(2, { firstClaimableAt: 1, expiresAt: base });
    await run();
    for (let k = 1; k <= PAUSED_ALERT_RUNS; k++) {
      later(DUE_AFTER_SEC);
      // Entry 1 accrues (its estimate holds still); entry 2 is not claimable
      // (its estimate moves forward with the clock).
      chain.expiry.set(2, { firstClaimableAt: 1, expiresAt: base + k * DUE_AFTER_SEC });
      // eslint-disable-next-line no-await-in-loop
      await run();
    }
    const paused = alerts(/did not advance/);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/the horizon clock of 1 reward entry did not advance .* \(id 2\)/);
  });
});
