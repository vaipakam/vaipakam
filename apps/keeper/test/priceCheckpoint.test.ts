/**
 * #3384 — the price checkpoint pass: the keeper's backing for the #3359
 * forced-sale floor's hourly checkpoints, run against a fake Diamond that
 * applies `checkpointHourlyPrices`' own rule (first caller per asset per
 * hour, an unreadable price skipped, filed under the including block's hour).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  ASSETS_PER_SEND,
  MAX_SENDS_PER_RUN,
  assetState,
  checkpointOnce,
  describeReport,
  price1e18,
  recordedBy,
  runPriceCheckpoint,
  trackedPairAssets,
  type CheckpointDeps,
} from '../src/priceCheckpoint';
import type { Env } from '../src/env';
import type { KeeperContext } from '../src/keeper';
import { createSharedD1 } from './helpers/schemas';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000c1';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const HOUR = 491_000;
const NOW = BigInt(HOUR * 3600 + 660); // :11 into the hour

const asset = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

function revert(errorName: string, args: readonly unknown[] = []): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({ abi: ABI, data: encodeErrorResult({ abi: ABI, errorName, args } as never), functionName: 'x' });
}

function checkpointLog(a: Address, hour: number, price: bigint): { address: Address; data: Hex; topics: Hex[] } {
  const ev = ABI.find((x) => x.type === 'event' && x.name === 'HourlyPriceCheckpointed') as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: 'HourlyPriceCheckpointed', args: { asset: a, hourIndex: BigInt(hour) } } as never) as Hex[];
  return { address: DIAMOND, topics, data: encodeAbiParameters([{ type: 'uint256' }], [price]) };
}

class FakeDiamond {
  chainServed = CHAIN;
  now = NOW;
  /** Seconds the next landed call's block is after `now` (a send mined later). */
  minedLaterSec = 0n;
  hasFloor = true;
  /** asset → [price, decimals]; absent = the oracle refuses it. */
  prices = new Map<Address, [bigint, number]>();
  /** `asset:hour` → stored 1e18 price. */
  book = new Map<string, bigint>();
  sent: Address[][] = [];
  lastLogs: ReturnType<typeof checkpointLog>[] = [];
  /** Run just before a send executes (another caller racing it). */
  beforeSend: (() => void) | null = null;

  readContract = async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const a = args as readonly any[];
    switch (functionName) {
      case 'getSaleFloorConfig':
        // The Diamond's fallback: FunctionDoesNotExist(), a selector no facet ABI names.
        if (!this.hasFloor) throw new ContractFunctionRevertedError({ abi: ABI, data: '0xa9ad62f8', functionName });
        return { tier1Bps: 450, tier2Bps: 350, tier3Bps: 250, calmMoveBps: 200, cushionBps: 11000 };
      case 'getHourlyPriceCheckpoint':
        return this.book.get(`${(a[0] as string).toLowerCase()}:${a[1]}`) ?? 0n;
      case 'getAssetPrice': {
        const p = this.prices.get((a[0] as string).toLowerCase() as Address);
        if (p === undefined) throw revert('NoPriceFeed');
        return p;
      }
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

  /** The contract's checkpoint rule, at `hour`. */
  private apply(assets: readonly Address[], hour: number): void {
    this.lastLogs = [];
    for (const raw of assets) {
      const a = raw.toLowerCase() as Address;
      if (this.book.has(`${a}:${hour}`)) continue;
      const p = this.prices.get(a);
      if (p === undefined) continue;
      const scaled = price1e18(p[0], p[1]);
      if (scaled === 0n) continue;
      this.book.set(`${a}:${hour}`, scaled);
      this.lastLogs.push(checkpointLog(a, hour, scaled));
    }
  }

  simulateContract = async ({ functionName }: { functionName: string }) => {
    if (functionName !== 'checkpointHourlyPrices') throw new Error(`unexpected call ${functionName}`);
    return { result: undefined };
  };

  getChainId = async () => this.chainServed;
  getBlock = async () => ({ number: 120n, timestamp: this.now });
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
        writeContract: async ({ args }: { args: readonly unknown[] }) => {
          this.beforeSend?.();
          const batch = args[0] as Address[];
          this.sent.push(batch);
          this.apply(batch, Number((this.now + this.minedLaterSec) / 3600n));
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

function deps(d: FakeDiamond, assets: readonly string[], over: Partial<CheckpointDeps> = {}): CheckpointDeps {
  return {
    client: d.client(),
    readClient: d.client(),
    context: () => d.ctx(),
    sendDeadline: Date.now() + 120_000,
    visit: 0,
    assets: async () => assets,
    ...over,
  };
}

const ok = (result: unknown) => ({ status: 'success' as const, result });
const fail = { status: 'failure' as const, error: new Error('x') };

afterEach(() => vi.restoreAllMocks());

describe('what is due', () => {
  it('scales the reading the way the contract does before storing it', () => {
    expect(price1e18(2_000_00000000n, 8)).toBe(2_000n * 10n ** 18n);
    expect(price1e18(5n * 10n ** 18n, 18)).toBe(5n * 10n ** 18n);
    expect(price1e18(10n ** 20n, 20)).toBe(10n ** 18n);
    expect(price1e18(99n, 20), 'scales to zero, which the contract treats as unreadable').toBe(0n);
    expect(price1e18(0n, 8)).toBe(0n);
  });

  it('an asset is due only with no checkpoint for the hour and a price that reads', () => {
    expect(assetState(ok(0n), ok([1n, 0]))).toBe('due');
    expect(assetState(ok(5n), ok([1n, 0]))).toBe('recorded');
    expect(assetState(ok(5n), fail), 'recorded wins whatever the price read').toBe('recorded');
    expect(assetState(ok(0n), fail), 'the contract would skip it too').toBe('unpriced');
    expect(assetState(ok(0n), ok([0n, 8]))).toBe('unpriced');
    expect(assetState(fail, ok([1n, 0])), 'an unread checkpoint is not "none"').toBeUndefined();
    expect(assetState(undefined, undefined)).toBeUndefined();
  });

  it('reads recorded assets and their hours from the Diamond\'s own events only', () => {
    const a = asset(1);
    const logs = [checkpointLog(a, HOUR, 1n), { ...checkpointLog(asset(2), HOUR, 1n), address: asset(99) }];
    expect(recordedBy(DIAMOND, logs as never)).toEqual([{ asset: a, hour: HOUR }]);
  });
});

describe('one chain\'s run', () => {
  it('checkpoints the due assets in one call, leaving recorded and unpriced ones alone', async () => {
    const d = new FakeDiamond();
    const [weth, usdc, gone, done] = [asset(1), asset(2), asset(3), asset(4)];
    d.prices.set(weth, [3_000_00000000n, 8]).set(usdc, [1_00000000n, 8]).set(done, [1n, 0]);
    d.book.set(`${done}:${HOUR}`, 1n);
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, [weth, usdc, gone, done]));
    expect(d.sent).toEqual([[weth, usdc]]);
    expect(r.hour).toBe(HOUR);
    expect(r).toMatchObject({ tracked: 4, alreadyRecorded: 1, due: 2, unpriced: [gone], deferred: 0, stopped: null });
    expect(r.recorded.sort()).toEqual([weth, usdc].sort());
    expect(d.book.get(`${weth}:${HOUR}`)).toBe(3_000n * 10n ** 18n);
    expect(describeReport(r)).toBe(
      `[keeper] priceCheckpoint chain=${CHAIN} hour=${HOUR} tracked=4 already=1 due=2 recorded=2 no-price=${gone}`,
    );
  });

  it('the second run in the hour sends nothing once the first recorded everything', async () => {
    const d = new FakeDiamond();
    d.prices.set(asset(1), [1n, 0]).set(asset(2), [1n, 0]);
    await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1), asset(2)]));
    d.now += 1800n;
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1), asset(2)]));
    expect(d.sent).toHaveLength(1);
    expect(r).toMatchObject({ alreadyRecorded: 2, due: 0, recorded: [] });
  });

  it('a new hour is a new checkpoint', async () => {
    const d = new FakeDiamond();
    d.prices.set(asset(1), [1n, 0]);
    await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1)]));
    d.now += 3600n;
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1)]));
    expect(d.sent).toHaveLength(2);
    expect(r.hour).toBe(HOUR + 1);
    expect(d.book.has(`${asset(1)}:${HOUR + 1}`)).toBe(true);
  });

  it('batches the due assets and leaves past the send budget for the next run, from a moved start', async () => {
    const d = new FakeDiamond();
    const n = ASSETS_PER_SEND * MAX_SENDS_PER_RUN + 7;
    const all = Array.from({ length: n }, (_, i) => asset(i + 1));
    for (const a of all) d.prices.set(a, [1n, 0]);
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, all));
    expect(d.sent).toHaveLength(MAX_SENDS_PER_RUN);
    expect(d.sent.every((b) => b.length === ASSETS_PER_SEND)).toBe(true);
    expect(r).toMatchObject({ due: n, deferred: 7 });
    expect(r.recorded).toHaveLength(ASSETS_PER_SEND * MAX_SENDS_PER_RUN);
    const r2 = await checkpointOnce(CHAIN, DIAMOND, deps(d, all, { visit: 1 }));
    expect(r2).toMatchObject({ due: 7, deferred: 0 });
    expect(r2.recorded).toHaveLength(7);
  });

  it('names an asset another caller wrote first, and one filed under the next hour', async () => {
    const d = new FakeDiamond();
    const [a, b] = [asset(1), asset(2)];
    d.prices.set(a, [1n, 0]).set(b, [1n, 0]);
    d.beforeSend = () => d.book.set(`${a}:${HOUR}`, 9n);
    const raced = await checkpointOnce(CHAIN, DIAMOND, deps(d, [a, b]));
    expect(raced.notRecorded).toEqual([a]);
    expect(raced.recorded).toEqual([b]);

    const late = new FakeDiamond();
    late.prices.set(a, [1n, 0]);
    late.minedLaterSec = 3600n;
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(late, [a]));
    expect(r.filedLater).toEqual([{ asset: a, hour: HOUR + 1 }]);
    expect(describeReport(r)).toContain(`filed-next-hour=${a}@${HOUR + 1}`);
  });

  it('sends nothing to a Diamond without the #3359 floor, and says so', async () => {
    const d = new FakeDiamond();
    d.hasFloor = false;
    d.prices.set(asset(1), [1n, 0]);
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1)]));
    expect(d.sent).toEqual([]);
    expect(r.skipped).toMatch(/does not carry the #3359 sale floor/);
  });

  it('works no chain whose RPC serves another chain, and no chain with nothing to checkpoint', async () => {
    const d = new FakeDiamond();
    d.chainServed = 1;
    expect((await checkpointOnce(CHAIN, DIAMOND, deps(d, [asset(1)]))).skipped).toBe(`the RPC configured for chain ${CHAIN} serves chain 1`);
    const e = new FakeDiamond();
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(e, ['0x', '0x0000000000000000000000000000000000000000']));
    expect(r.skipped).toMatch(/no active loan with two ERC-20 legs/);
    expect(e.sent).toEqual([]);
  });

  it('a failed indexer read skips the chain rather than guessing', async () => {
    const d = new FakeDiamond();
    const r = await checkpointOnce(CHAIN, DIAMOND, deps(d, [], { assets: async () => Promise.reject(new Error('D1 down')) }));
    expect(r.skipped).toMatch(/^the active loans' assets could not be read from the indexer \(/);
  });
});

describe('the asset list', () => {
  it('takes both legs of active loans whose two legs are ERC-20, and nothing else', async () => {
    const h = createSharedD1();
    const insert = (id: number, status: string, at: number, ct: number, lend: string, col: string, chain = CHAIN) =>
      h.db
        .prepare(
          `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower, principal, collateral_amount,
             asset_type, collateral_asset_type, lending_asset, collateral_asset, start_block, start_at, updated_at)
           VALUES (?, ?, ?, ?, '0xl', '0xb', '1', '1', ?, ?, ?, ?, 1, 1, 1)`,
        )
        .run(chain, id, id, status, at, ct, lend, col);
    insert(1, 'active', 0, 0, asset(1), asset(2));
    insert(2, 'active', 0, 0, asset(1).toUpperCase().replace('0X', '0x'), asset(3)); // same asset, other case
    insert(3, 'repaid', 0, 0, asset(4), asset(5)); // closed
    insert(4, 'active', 0, 1, asset(6), asset(7)); // NFT collateral
    insert(5, 'active', 1, 0, asset(8), asset(9)); // NFT rental
    insert(6, 'active', 0, 0, asset(10), asset(11), 1); // another chain
    insert(7, 'active', 0, 0, '0x', asset(12)); // stub placeholder
    const got = await trackedPairAssets({ DB: h.d1 } as unknown as Env, CHAIN);
    expect([...got].sort()).toEqual([asset(1), asset(2), asset(3), asset(12)].sort());
  });
});

describe('arming', () => {
  it('skips the whole pass while PRICE_CHECKPOINT_ENABLED is unset, without touching a chain', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = {
      KEEPER_ENABLED: 'true',
      KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
      RPC_BASE_SEPOLIA: 'https://rpc.invalid',
    } as unknown as Env;
    await runPriceCheckpoint(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toEqual(['[keeper] priceCheckpoint skipped: PRICE_CHECKPOINT_ENABLED unset']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips while the keeper itself is disarmed, even with the pass flag on', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const env = { KEEPER_PRIVATE_KEY: `0x${'a'.repeat(64)}`, PRICE_CHECKPOINT_ENABLED: 'true' } as unknown as Env;
    await runPriceCheckpoint(env, { scheduledTimeMs: 0, deadlineMs: Date.now() + 60_000 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[keeper\] priceCheckpoint skipped: KEEPER_ENABLED/);
  });
});
