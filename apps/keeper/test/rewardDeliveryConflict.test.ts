/**
 * #2961 option B — the delivery-conflict pass: how a mirror day whose
 * delivered parts disagree on its whole is found in the shared ledger, and
 * what one run does with it — alert at once, skip once the contract allows,
 * recycle what landed until nothing is left, and treat a side that is no
 * longer held as an incident that is never retried. The sends go through a
 * fake with the `StepSender`'s contract; every refusal is the contract's own
 * error name and arguments.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex, type Log, type TransactionReceipt } from 'viem';
import {
  ABI,
  conflictKey,
  heldKey,
  recordAndPost,
  refusedKey,
  workConflictedDay,
  workQueue,
  type ConflictCaller,
  type ConflictDeps,
  type DayParts,
} from '../src/rewardDeliveryConflict';
import { discoverConflictedDayParts, enqueueWork, listOpenWork } from '../src/db';
import type { Env } from '../src/env';
import { disarmEpochFence } from '../src/epochFence';
import type { CallResult } from '../src/stepSender';
import { armHeldFence } from './helpers/epochFence';
import { bindings, createKeeperD1, createSharedD1 } from './helpers/schemas';

const CHAIN = 421614;
const DIAMOND = '0x00000000000000000000000000000000000000d1';
const DAY = 12n;
const E18 = 10n ** 18n;
const TX = `0x${'a'.repeat(64)}` as Hex;

const conflicted = (over: Partial<DayParts> = {}): DayParts => ({
  wholeFresh: 10n * E18,
  wholeRecycled: 2n * E18,
  landedFresh: 7n * E18,
  landedRecycled: 0n,
  landedAt: 0n,
  parts: 2,
  wholeConflict: true,
  conflictAt: 1_800_000_000n,
  skippedAt: 0n,
  ...over,
});

function eventLog(eventName: string, values: Record<string, unknown>): Log {
  const ev = ABI.find((x) => x.type === 'event' && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: values } as never);
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => values[i.name!]));
  return { address: DIAMOND, topics, data, transactionHash: TX, blockNumber: 1n, logIndex: 0, blockHash: TX, transactionIndex: 0, removed: false } as unknown as Log;
}

/** What one call does: the contract refuses it (by name, with arguments),
 *  its simulation returns `result` and it lands with `logs`, or the sender
 *  stops before simulating (`stall` null: the send budget or deadline). */
type Step = { refuse: string; args?: readonly unknown[] } | { result?: unknown; logs?: Log[] } | { stop: string | null };

/** A fake with the `StepSender`'s contract: refusals return their name and
 *  set `refusal`; a call `worth` judges idle is not sent; a stop is sticky. */
class FakeCaller implements ConflictCaller {
  receipt: TransactionReceipt | null = null;
  refusal: { name: string; args: readonly unknown[] } | null = null;
  stopped = false;
  stall: string | null = null;
  readonly sent: string[] = [];
  constructor(
    private readonly steps: Record<string, Step[]>,
    private writes = 4,
  ) {}

  async call(_step: string, _subject: number | string, fn: string, _args: readonly unknown[], _value = 0n, worth?: (s: unknown) => boolean): Promise<CallResult> {
    this.receipt = null;
    this.refusal = null;
    if (this.stopped) return 'skipped';
    if (this.writes <= 0) {
      this.stopped = true;
      return 'skipped';
    }
    const q = this.steps[fn];
    if (!q || q.length === 0) throw new Error(`unexpected call ${fn}`);
    const s = q.length > 1 ? q.shift()! : q[0];
    if ('stop' in s) {
      this.stopped = true;
      this.stall = s.stop;
      return 'skipped';
    }
    if ('refuse' in s) {
      this.refusal = { name: s.refuse, args: s.args ?? [] };
      return s.refuse;
    }
    if (worth !== undefined && !worth(s.result)) return 'idle';
    this.writes -= 1;
    this.sent.push(fn);
    this.receipt = { logs: s.logs ?? [] } as unknown as TransactionReceipt;
    return 'landed';
  }
}

function fake(parts: DayParts[], steps: Record<string, Step[]>, writes = 4) {
  const queue = [...parts];
  const sender = new FakeCaller(steps, writes);
  const deps: ConflictDeps = {
    chainId: CHAIN,
    diamond: DIAMOND,
    abi: ABI,
    readParts: async () => (queue.length > 1 ? queue.shift()! : queue[0]),
    sender,
  };
  return { deps, sender };
}

describe('workConflictedDay', () => {
  it('alerts at once while the skip delay runs, naming when the skip becomes allowed (from the refusal), and sends nothing', async () => {
    const readyAt = 1_800_086_400n;
    const { deps, sender } = fake([conflicted()], { skipConflictedDay: [{ refuse: 'DayDeliverySkipTooEarly', args: [DAY, readyAt] }] });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out.finished).toBe(false);
    expect(out.conditions.map((c) => c.key)).toEqual([conflictKey(CHAIN, DAY)]);
    expect(out.conditions[0].detail).toContain(new Date(Number(readyAt) * 1000).toISOString());
    expect(out.conditions[0].detail).toContain('2 parts landed (fresh 7 VPFI, recycled 0 VPFI)');
  });

  it("waits for Base's broadcast, alerted, without sending", async () => {
    const { deps, sender } = fake([conflicted()], { skipConflictedDay: [{ refuse: 'DayDeliverySkipAwaitsBroadcast', args: [DAY] }] });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out.finished).toBe(false);
    expect(out.conditions[0].detail).toContain("waits for Base's broadcast");
  });

  it('a side no longer held is an incident: alerted, never retried (the day leaves the queue), nothing sent', async () => {
    const { deps, sender } = fake([conflicted()], { skipConflictedDay: [{ refuse: 'DayDeliverySkipSideNotHeld', args: [DAY, 1] }] });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out).toMatchObject({ finished: true, awaitsAlert: true });
    expect(out.conditions.map((c) => [c.key, c.group])).toEqual([[heldKey(CHAIN, DAY), 'incident']]);
    expect(out.conditions[0].detail).toContain('borrower side');
    expect(out.cleared).toContain(conflictKey(CHAIN, DAY));
  });

  it('skips once allowed, then recycles until the contract reports nothing left, reporting both from their own events', async () => {
    const skipped = eventLog('DayDeliveryConflictSkipped', {
      dayId: DAY,
      conflictAt: 1_800_000_000n,
      freshLenderHalf: 3n * E18,
      freshBorrowerHalf: 4n * E18,
      lenderHalfEquiv: 1n * E18,
      borrowerHalfEquiv: 0n,
      recycleConsume: 1n * E18,
    });
    const moved = eventLog('DayDeliveryConflictValueRecycled', { dayId: DAY, fresh: 7n * E18, recycled: 0n });
    const { deps, sender } = fake([conflicted()], {
      skipConflictedDay: [{ logs: [skipped] }],
      recycleSkippedDayValue: [{ result: 7n * E18, logs: [moved] }, { result: 0n }],
    });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual(['skipConflictedDay', 'recycleSkippedDayValue']);
    expect(out.finished).toBe(true);
    expect(out.conditions).toEqual([]);
    expect(out.cleared).toEqual(expect.arrayContaining([conflictKey(CHAIN, DAY), refusedKey(CHAIN, DAY)]));
    expect(out.notices[0]).toContain('fresh lender half 3 VPFI');
    expect(out.notices[0]).toContain('recycled commitment released: 1 VPFI');
    expect(out.notices[1]).toContain('7 VPFI fresh and 0 VPFI recycled value moved');
    expect(out.notices[1]).toContain('nothing is left for the day');
  });

  it('a day another caller skipped is recycled, and stays queued when the sends run out first', async () => {
    const moved = eventLog('DayDeliveryConflictValueRecycled', { dayId: DAY, fresh: 1n * E18, recycled: 1n * E18 });
    const { deps, sender } = fake([conflicted({ skippedAt: 1_800_090_000n })], { recycleSkippedDayValue: [{ result: 2n * E18, logs: [moved] }] }, 1);
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual(['recycleSkippedDayValue']);
    expect(out.finished).toBe(false);
    expect(out.notices[0]).toContain('more may be left, moved next run');
  });

  it('a skip refused because another caller already skipped goes on to recycle, on a fresh read', async () => {
    const { deps, sender } = fake([conflicted(), conflicted({ skippedAt: 1_800_090_000n })], {
      skipConflictedDay: [{ refuse: 'DayDeliveryAlreadySkipped', args: [DAY] }],
      recycleSkippedDayValue: [{ result: 0n }],
    });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out.finished).toBe(true);
  });

  it('a day that opened before its parts conflicted stays paid: alerted as the source fault, and left', async () => {
    const { deps, sender } = fake([conflicted({ landedAt: 1_799_990_000n })], {});
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out).toMatchObject({ finished: true, awaitsAlert: true });
    expect(out.conditions[0].detail).toContain('stays paid and cannot be skipped');
  });

  it('a day whose record no longer conflicts leaves the queue and clears its alerts', async () => {
    const { deps } = fake([conflicted({ wholeConflict: false })], {});
    const out = await workConflictedDay(deps, DAY);
    expect(out).toMatchObject({ finished: true, awaitsAlert: false, conditions: [] });
    expect(out.cleared).toEqual([conflictKey(CHAIN, DAY), refusedKey(CHAIN, DAY)]);
  });

  it('with no key, the skip is alerted as unsent, saying why, rather than silently waiting', async () => {
    const { deps } = fake([conflicted()], { skipConflictedDay: [{ stop: 'it has no signing key for this chain, so it sent nothing' }] });
    const out = await workConflictedDay(deps, DAY);
    expect(out.finished).toBe(false);
    expect(out.conditions.map((c) => c.key)).toEqual([conflictKey(CHAIN, DAY)]);
    expect(out.conditions[0].detail).toContain('The skip was not sent: it has no signing key');
  });

  it('any other refusal is named, beside the standing conflict', async () => {
    const { deps, sender } = fake([conflicted()], { skipConflictedDay: [{ refuse: 'OnlyMirrorRewardChain' }] });
    const out = await workConflictedDay(deps, DAY);
    expect(sender.sent).toEqual([]);
    expect(out.conditions.map((c) => c.key)).toEqual([refusedKey(CHAIN, DAY), conflictKey(CHAIN, DAY)]);
    expect(out.conditions[0].detail).toContain('OnlyMirrorRewardChain');
  });

  it('a refused recycle is named and the day stays queued', async () => {
    const { deps } = fake([conflicted({ skippedAt: 1_800_090_000n })], { recycleSkippedDayValue: [{ refuse: 'SomeRecycleRefusal' }] });
    const out = await workConflictedDay(deps, DAY);
    expect(out.finished).toBe(false);
    expect(out.conditions.map((c) => [c.key, c.group])).toEqual([[refusedKey(CHAIN, DAY), 'refused']]);
  });
});

describe('workQueue', () => {
  it('stops working days once the sender has stopped, leaving the rest their turn', async () => {
    const { deps } = fake([conflicted()], { skipConflictedDay: [{ stop: null }] });
    const run = await workQueue(deps, [{ item: '12' }, { item: '13' }], Date.now() + 60_000);
    expect(run.examined).toEqual(['12']);
  });

  it("keeps a day whose record cannot be read in the queue, and works the next", async () => {
    const { deps } = fake([conflicted({ wholeConflict: false })], {});
    const real = deps.readParts;
    deps.readParts = async (d) => (d === 12n ? Promise.reject(new Error('rpc down')) : real(d));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await workQueue(deps, [{ item: '12' }, { item: '13' }], Date.now() + 60_000);
    expect(run.examined).toEqual(['12', '13']);
    expect(run.finished).toEqual(['13']);
    vi.restoreAllMocks();
  });
});

describe('recordAndPost: a day only a person can act on', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    disarmEpochFence();
  });

  for (const [what, parts, steps] of [
    ['a side no longer held', conflicted(), { skipConflictedDay: [{ refuse: 'DayDeliverySkipSideNotHeld', args: [DAY, 0] }] }],
    ['a day that opened before its parts conflicted', conflicted({ landedAt: 1_799_990_000n }), {}],
  ] as const) {
    it(`${what}: the day stays queued until its alert is delivered, then leaves (Codex #2999)`, async () => {
      const keeper = createKeeperD1();
      const env = { ...bindings(createSharedD1(), keeper), TG_OPS_BOT_TOKEN: 't', TG_OPS_CHAT_ID: 'c' } as unknown as Env;
      armHeldFence([{ id: CHAIN, diamond: DIAMOND }]);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await enqueueWork(keeper.d1 as never, CHAIN, DIAMOND, 'delivery_conflict', [{ item: DAY.toString(), block: 1, payload: { dayId: DAY.toString(), block: 1 } }]);
      const posts: string[] = [];
      let ok = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
        posts.push(String((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? ''));
        return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500 });
      }) as typeof fetch);
      const once = async () => {
        const { deps } = fake([parts], steps as Record<string, Step[]>);
        const run = await workQueue(deps, [{ item: DAY.toString() }], Date.now() + 60_000);
        await recordAndPost(env, CHAIN, DIAMOND, run, Date.now() + 60_000, Math.floor(Date.now() / 1000));
        return (await listOpenWork(keeper.d1 as never, CHAIN, DIAMOND, 'delivery_conflict', 10)).map((w) => w.item);
      };
      expect(await once(), 'a failed post keeps the day queued').toEqual([DAY.toString()]);
      expect(posts).toHaveLength(1);
      ok = true;
      expect(await once(), 'the delivered post retires it').toEqual([]);
      expect(posts).toHaveLength(2);
      expect(posts[1]).toContain(`day ${DAY}`);
    });
  }
});

describe('discoverConflictedDayParts (real schema)', () => {
  it('finds the parts of conflicted days only — at the conflict and at every later part — and no other chain or day', async () => {
    const h = createSharedD1();
    let log = 0;
    const seed = (chain: number, block: number, kind: string, dayId: string) =>
      h.db
        .prepare(`INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at) VALUES (?, ?, ?, ?, ?, ?, 0)`)
        .run(chain, block, log++, `0xt${log}`, kind, JSON.stringify({ dayId }));
    seed(CHAIN, 10, 'DayDeliveryPartLanded', '5'); // day 5 never conflicts
    seed(CHAIN, 11, 'DayDeliveryPartLanded', '7'); // day 7's first part
    seed(CHAIN, 12, 'DayDeliveryWholeConflict', '7'); // its second part conflicts…
    seed(CHAIN, 12, 'DayDeliveryPartLanded', '7'); // …and is counted, in the same call
    seed(CHAIN, 20, 'DayDeliveryPartLanded', '7'); // a later part
    seed(CHAIN, 21, 'DayDeliveryPartLanded', '5');
    seed(97, 22, 'DayDeliveryWholeConflict', '5'); // another chain's conflict on day 5
    const all = await discoverConflictedDayParts(h.d1 as never, CHAIN, 0, 100, 50);
    expect(all.rows).toEqual([
      { dayId: '7', block: 11 },
      { dayId: '7', block: 12 },
      { dayId: '7', block: 20 },
    ]);
    expect(all.next).toBe(101);
    // A conflict recorded past what is read is not yet known.
    expect((await discoverConflictedDayParts(h.d1 as never, CHAIN, 0, 11, 50)).rows).toEqual([]);
  });
});
