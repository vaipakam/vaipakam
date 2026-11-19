/**
 * #3683 / #3437 — the rate record step of the price checkpoint, run against a
 * fake Diamond and price guard: discovery from the guard's own binding logs,
 * the due rule, the send, and the outcome read from the receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type PublicClient } from 'viem';
import {
  cursorItem,
  describeReport,
  GUARD_ABI,
  MAX_SENDS_PER_RUN,
  parseItem,
  recordOutcome,
  recordRatesOnce,
  RECORD_AFTER_SEC,
  registeredBindings,
  type BindingQueue,
} from '../src/rateRecord';
import { memoryScanCursors } from '../src/scanCursors';
import type { KeeperContext } from '../src/keeper';
import type { WorkItem } from '../src/db';

const CHAIN = 84532;
const DIAMOND: Address = '0x00000000000000000000000000000000000000d1';
const GUARD: Address = '0x00000000000000000000000000000000000000a9';
const KEEPER: Address = '0x00000000000000000000000000000000000000ee';
const TOKEN_A: Address = '0x000000000000000000000000000000000000000a';
const TOKEN_B: Address = '0x000000000000000000000000000000000000000b';
const HASH_1: Hex = `0x${'11'.repeat(32)}`;
const HASH_2: Hex = `0x${'22'.repeat(32)}`;
const NOW = 10_000_000;

function eventLog(name: 'RateRecorded' | 'RateDistrusted' | 'RateObserved', token: Address, hash: Hex) {
  const topics = encodeEventTopics({ abi: GUARD_ABI, eventName: name, args: { token, hash } as never }) as Hex[];
  const n = name === 'RateObserved' ? 3 : 2;
  const data = encodeAbiParameters(Array.from({ length: n }, () => ({ type: 'uint256' })), Array.from({ length: n }, () => 1n));
  return { address: GUARD, data, topics };
}

class Fake {
  guard: Address = GUARD;
  finalized = 120n;
  /** RateBindingRegistered logs, by block. */
  registered: { block: bigint; token: Address; hash: Hex }[] = [];
  /** `<token>:<hash>` → last record time (0 = never). */
  at = new Map<string, number>();
  /** What each recordRate emits. */
  outcome: 'RateRecorded' | 'RateDistrusted' | 'RateObserved' = 'RateRecorded';
  sent: { token: Address; hash: Hex }[] = [];
  getLogsCalls: { from: bigint; to: bigint }[] = [];
  last: { token: Address; hash: Hex } | null = null;

  readContract = async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getPriceGuard') return this.guard;
    throw new Error(`unexpected read ${functionName}`);
  };
  getBlock = async (a?: { blockTag?: string }) =>
    a?.blockTag === 'finalized' ? { number: this.finalized, timestamp: BigInt(NOW) } : { number: 130n, timestamp: BigInt(NOW) };
  getBlockNumber = async () => 130n;
  getTransactionCount = async () => 3;
  getLogs = async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    this.getLogsCalls.push({ from: fromBlock, to: toBlock });
    return this.registered
      .filter((r) => r.block >= fromBlock && r.block <= toBlock)
      .map((r) => ({ args: { token: r.token, hash: r.hash }, blockNumber: r.block }));
  };
  multicall = async ({ contracts }: { contracts: { functionName: string; args: [Address, Hex] }[] }) =>
    contracts.map((c) => {
      const at = this.at.get(`${c.args[0].toLowerCase()}:${c.args[1].toLowerCase()}`);
      return at === undefined ? { status: 'failure', error: new Error('no state') } : { status: 'success', result: { at: BigInt(at) } };
    });
  simulateContract = async ({ functionName, address, args }: { functionName: string; address: Address; args: [Address, Hex] }) => {
    expect(functionName).toBe('recordRate');
    expect(address.toLowerCase()).toBe(this.guard.toLowerCase());
    this.last = { token: args[0], hash: args[1] };
    return { result: undefined };
  };
  waitForTransactionReceipt = async () => ({
    status: 'success',
    blockNumber: 131n,
    logs: [eventLog(this.outcome, this.last!.token, this.last!.hash)],
  });

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
        writeContract: async ({ args }: { args: [Address, Hex] }) => {
          this.sent.push({ token: args[0], hash: args[1] });
          return `0x${'1'.repeat(64)}`;
        },
      },
    } as unknown as KeeperContext;
  }
}

function memoryQueue(): BindingQueue & { items: Map<string, number>; touched: string[][] } {
  const items = new Map<string, number>();
  const touched: string[][] = [];
  return {
    items,
    touched,
    async enqueue(list: readonly WorkItem<Record<string, never>>[]) {
      for (const w of list) if (!items.has(w.item)) items.set(w.item, w.block);
    },
    async open(limit: number) {
      return [...items.keys()].slice(0, limit);
    },
    async touch(list: readonly string[]) {
      touched.push([...list]);
    },
  };
}

const key = (token: Address, hash: Hex) => `${token.toLowerCase()}:${hash.toLowerCase()}`;

describe('the rate record step', () => {
  let f: Fake;
  let queue: ReturnType<typeof memoryQueue>;
  let cursors: ReturnType<typeof memoryScanCursors>;

  beforeEach(() => {
    f = new Fake();
    queue = memoryQueue();
    cursors = memoryScanCursors();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (floor = 100) =>
    recordRatesOnce(CHAIN, DIAMOND, {
      client: f.client(),
      readClient: f.client(),
      context: () => f.ctx(),
      sendDeadline: Number.POSITIVE_INFINITY,
      queue,
      cursors,
      floor,
      visit: 0,
    });

  it('finds bindings from the guard logs, queues them before the cursor moves, and records the due ones', async () => {
    f.registered = [
      { block: 105n, token: TOKEN_A, hash: HASH_1 },
      { block: 110n, token: TOKEN_A, hash: HASH_2 },
      { block: 112n, token: TOKEN_B, hash: HASH_1 },
    ];
    f.at.set(key(TOKEN_A, HASH_1), NOW - RECORD_AFTER_SEC); // due
    f.at.set(key(TOKEN_A, HASH_2), NOW - 60); // recorded a minute ago
    f.at.set(key(TOKEN_B, HASH_1), 0); // never recorded
    const r = await run();
    expect(r.discovery).toEqual({ from: 100, to: 120, queued: 3, caughtUp: true });
    expect(cursors.rows.get(cursorItem(GUARD))).toBe('121');
    expect(r.queued).toBe(3);
    expect(r.notDue).toBe(1);
    expect(r.unknown).toEqual([`${TOKEN_B.toLowerCase()}:${HASH_1.slice(0, 10)}`]);
    expect(f.sent).toEqual([{ token: TOKEN_A.toLowerCase(), hash: HASH_1 }]);
    expect(r.recorded).toEqual([`${TOKEN_A.toLowerCase()}:${HASH_1.slice(0, 10)}`]);
    expect(queue.touched).toHaveLength(1);
    expect(describeReport(r)).toMatch(/recorded=0x0+a:0x11111111 .*never-recorded=/);
  });

  it('reads on from its cursor, not from the floor, on the next run', async () => {
    await run();
    f.finalized = 140n;
    f.getLogsCalls = [];
    const r = await run();
    expect(f.getLogsCalls).toEqual([{ from: 121n, to: 140n }]);
    expect(r.discovery).toMatchObject({ from: 121, to: 140 });
  });

  it('keeps a cursor per guard, so a replacement guard is read from the floor', async () => {
    await cursors.put(cursorItem(GUARD), '500');
    f.guard = '0x00000000000000000000000000000000000000b7';
    const r = await run();
    expect(r.discovery).toMatchObject({ from: 100, to: 120 });
  });

  it('works only the bindings of the current guard', async () => {
    await queue.enqueue([{ item: `0x${'cd'.repeat(20)}:${TOKEN_A.toLowerCase()}:${HASH_1}`, block: 1, payload: {} }]);
    const r = await run();
    expect(r.queued).toBe(0);
    expect(f.sent).toEqual([]);
  });

  it('names a distrusted rate and one under observation from the receipt', async () => {
    f.registered = [{ block: 105n, token: TOKEN_A, hash: HASH_1 }];
    f.at.set(key(TOKEN_A, HASH_1), 1);
    f.outcome = 'RateDistrusted';
    expect((await run()).distrusted).toHaveLength(1);
    f.outcome = 'RateObserved';
    expect((await run()).observed).toHaveLength(1);
  });

  it('sends at most its per-run cap and counts the rest as deferred', async () => {
    const extra = MAX_SENDS_PER_RUN + 2;
    for (let i = 0; i < extra; i++) {
      const hash = `0x${i.toString(16).padStart(64, '0')}` as Hex;
      f.registered.push({ block: 105n, token: TOKEN_A, hash });
      f.at.set(key(TOKEN_A, hash), 1);
    }
    const r = await run();
    expect(f.sent).toHaveLength(MAX_SENDS_PER_RUN);
    expect(r.deferred).toBe(2);
  });

  it('names an unreadable binding state as unread and sends nothing for it', async () => {
    f.registered = [{ block: 105n, token: TOKEN_A, hash: HASH_1 }];
    const r = await run();
    expect(f.sent).toEqual([]);
    expect(r.unread.get('bindings')).toMatch(/the state of 1 binding/);
  });

  it('does nothing on a Diamond with no price guard, and says so', async () => {
    f.guard = '0x0000000000000000000000000000000000000000';
    const r = await run();
    expect(r.skipped).toMatch(/no price guard/);
    expect(describeReport(r)).toMatch(/not worked this run/);
  });

  it('parses its own items and refuses anything else', () => {
    const item = `${GUARD}:${TOKEN_A}:${HASH_1}`;
    expect(parseItem(item)).toEqual({ guard: GUARD, token: TOKEN_A, hash: HASH_1 });
    expect(parseItem(`${GUARD}:${TOKEN_A}`)).toBeNull();
    expect(registeredBindings(GUARD, [
      { args: { token: TOKEN_A, hash: HASH_1 }, blockNumber: 5n },
      { args: { token: TOKEN_A, hash: HASH_1 }, blockNumber: 6n },
      { args: {}, blockNumber: 7n },
    ])).toEqual([{ item, block: 5, payload: {} }]);
  });

  it('reads an outcome only from the guard', () => {
    const log = eventLog('RateRecorded', TOKEN_A, HASH_1);
    expect(recordOutcome(GUARD, [log])).toBe('recorded');
    expect(recordOutcome(GUARD, [{ ...log, address: DIAMOND }])).toBe('unknown');
  });
});
