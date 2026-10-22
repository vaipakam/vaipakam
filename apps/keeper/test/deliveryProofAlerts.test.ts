/**
 * #2516 — the delivery-proof pass's operator alerts. Which refusals count as a
 * failure (never "the work is already done"), and how the two alerts are
 * raised and cleared: a revert alert per delivery, cleared once that delivery
 * finishes or its calls go through, and one "not yet whole" alert per mirror,
 * cleared only by a run that settled every open delivery. Runs on the real
 * keeper-private schema; the ops bot is unconfigured, so a raised alert is the
 * logged "NOT delivered" line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, encodeErrorResult, type Abi } from 'viem';
import { RewardEpochFacetABI } from '@vaipakam/contracts/abis';
import {
  ALREADY_DONE,
  AWAITING_ALERT_SEC,
  awaitingDeliveries,
  classifyRevert,
  actionScope,
  dayRuns,
  minedRevertOutcome,
  outcomeOf,
  receiptTimeoutMs,
  refusedBeforeBroadcast,
  raiseDeliveryAlerts,
  type DeliveryAlertInput,
} from '../src/deliveryProof';
import type { Env } from '../src/env';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';
import { listOpenWorkPage, type KeeperD1 } from '../src/db';
import type { SqliteD1 } from './helpers/sqliteD1';
import { digestText, sendOpsAlertDigest } from '../src/opsAlert';
import { disarmEpochFence } from '../src/epochFence';
import { armHeldFence } from './helpers/epochFence';
import { HttpRequestError } from 'viem';

const ABI = RewardEpochFacetABI as Abi;
const CHAIN = 421614;
const P1 = `0x${'1'.repeat(64)}`;
const P2 = `0x${'2'.repeat(64)}`;
const NOW = 1_800_000_000;

function revert(errorName: string, args: readonly unknown[]): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: ABI,
    data: encodeErrorResult({ abi: ABI, errorName, args } as never),
    functionName: 'proveDeliveryDayChunk',
  });
}

describe('classifyRevert', () => {
  it('reads "already done" as done, by the decoded error name', () => {
    expect(classifyRevert(revert('TransportChunkAlreadyIndexed', [P1, 2n]))).toEqual({ kind: 'done' });
    expect(classifyRevert(revert('TransportBatchFullyIndexed', [P1]))).toEqual({ kind: 'done' });
    expect(classifyRevert(revert('TransportBatchAlreadyAdmitted', [P1]))).toEqual({ kind: 'done' });
    expect(ALREADY_DONE.size).toBe(3);
  });

  it('names any other revert, and never prints a raw message', () => {
    expect(classifyRevert(revert('TransportChunkProofInvalid', [P1, 1n, P2]))).toEqual({ kind: 'failed', reason: 'TransportChunkProofInvalid' });
    const leaky = new Error('request to https://rpc.example/v2/SECRETKEY failed');
    const c = classifyRevert(leaky);
    expect(c.kind).toBe('failed');
    expect(JSON.stringify(c)).not.toContain('SECRETKEY');
  });
});

describe('raiseDeliveryAlerts', () => {
  let keeper: SqliteD1;
  let env: Env;
  let warned: string[];

  beforeEach(() => {
    keeper = createKeeperD1();
    env = { DB: createSharedD1().d1, KEEPER_DB: keeper.d1 } as unknown as Env;
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const input = (over: Partial<DeliveryAlertInput> = {}): DeliveryAlertInput => ({
    failures: new Map(),
    cleared: new Set(),
    openWork: async (ps) => new Set(ps),
    awaiting: [],
    awaitingMeasured: true,
    nowSec: NOW,
    deadline: Number.POSITIVE_INFINITY,
    ...over,
  });
  /** An alert as the ops bot would have recorded it. */
  const recorded = (key: string) =>
    keeper.db.prepare('INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)').run(key, 1, 1, CHAIN);
  const keys = () => (keeper.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[]).map((r) => r.alert_key);

  it('names a reverting delivery and why, and clears it once the delivery goes through', async () => {
    await raiseDeliveryAlerts(env, CHAIN, input({ failures: new Map([[P1, 'proveDeliveryDayChunk: TransportChunkProofInvalid']]) }));
    expect(warned.filter((w) => w.includes('refused by the contract') && w.includes(`${P1} — proveDeliveryDayChunk: TransportChunkProofInvalid`))).toHaveLength(1);

    recorded(`delivery-revert:${CHAIN}:${P1}`);
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    await raiseDeliveryAlerts(env, CHAIN, input({ cleared: new Set([P1]) }));
    expect(keys(), 'only the delivery this run disproved is cleared').toEqual([`delivery-revert:${CHAIN}:${P2}`]);
  });

  it('clears a revert alert whose delivery is no longer open work, even on an empty queue', async () => {
    recorded(`delivery-revert:${CHAIN}:${P1}`);
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    await raiseDeliveryAlerts(env, CHAIN, input({ openWork: async () => new Set([P2]) }));
    expect(keys(), 'P1 was retired by an earlier run whose clear never landed').toEqual([`delivery-revert:${CHAIN}:${P2}`]);
    await raiseDeliveryAlerts(env, CHAIN, input({ openWork: async () => new Set() }));
    expect(keys()).toEqual([]);
  });

  it('keeps undisproved revert alerts when the open work cannot be read', async () => {
    recorded(`delivery-revert:${CHAIN}:${P1}`);
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    await raiseDeliveryAlerts(
      env,
      CHAIN,
      input({
        cleared: new Set([P1]),
        openWork: async () => {
          throw new Error('d1 down');
        },
      }),
    );
    expect(keys()).toEqual([`delivery-revert:${CHAIN}:${P2}`]);
  });

  it('states a lower bound, not a count, when the run could not read every open delivery', async () => {
    await raiseDeliveryAlerts(env, CHAIN, input({ awaiting: [{ packetHash: P1, arrivedAt: NOW - 3600 }], awaitingMeasured: false }));
    const [line] = warned.filter((w) => w.includes('reward delivery proofs'));
    expect(line).toContain('at least 1 deliveries are not yet whole');
    expect(line).toContain('it could not look at every open delivery');
    expect(line).not.toContain('oldest first');
  });

  it('says how many deliveries are not whole, oldest first, with when each arrived', async () => {
    const awaiting = [
      { packetHash: P2, arrivedAt: NOW - 3600 },
      { packetHash: P1, arrivedAt: NOW - 7200 },
    ];
    await raiseDeliveryAlerts(env, CHAIN, input({ awaiting }));
    const [line] = warned.filter((w) => w.includes('reward delivery proofs'));
    expect(line).toContain(`2 deliveries are not yet whole more than ${AWAITING_ALERT_SEC / 60} min after arriving`);
    expect(line.indexOf(P1), 'oldest first').toBeLessThan(line.indexOf(P2));
    expect(line).toContain(new Date((NOW - 7200) * 1000).toISOString());
  });

  it('clears the "not whole" alert only on a run that measured every open delivery', async () => {
    recorded(`delivery-awaiting:${CHAIN}:all`);
    await raiseDeliveryAlerts(env, CHAIN, input({ awaitingMeasured: false }));
    expect(keys(), 'a partial run cannot clear it').toEqual([`delivery-awaiting:${CHAIN}:all`]);
    await raiseDeliveryAlerts(env, CHAIN, input());
    expect(keys()).toEqual([]);
  });

  it("never touches another chain's alerts", async () => {
    keeper.db
      .prepare('INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at, chain_id) VALUES (?, ?, ?, ?)')
      .run(`delivery-awaiting:84532:all`, 1, 1, 84532);
    await raiseDeliveryAlerts(env, CHAIN, input());
    expect(keys()).toEqual(['delivery-awaiting:84532:all']);
  });

  it('past the run deadline, still raises a refusal but leaves what the next run can measure', async () => {
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    await raiseDeliveryAlerts(
      env,
      CHAIN,
      input({ failures: new Map([[P1, 'x']]), cleared: new Set([P2]), awaiting: [{ packetHash: P1, arrivedAt: 0 }], deadline: 0 }),
    );
    expect(warned.filter((w) => w.includes('refused by the contract') && w.includes(`${P1} — x`)), 'a refusal is never dropped').toHaveLength(1);
    expect(warned.filter((w) => w.includes('not yet whole')), 'the "not whole" alert waits').toEqual([]);
    expect(keys(), 'no clear past the deadline').toContain(`delivery-revert:${CHAIN}:${P2}`);
  });

  it('still raises refusals when the open alerts cannot be read, and clears nothing', async () => {
    const failing = {
      ...keeper.d1,
      prepare: (sql: string) => {
        if (sql.includes('SELECT alert_key FROM keeper_ops_alert')) throw new Error('d1 down');
        return keeper.d1.prepare(sql);
      },
    };
    recorded(`delivery-revert:${CHAIN}:${P2}`);
    const e = { ...env, KEEPER_DB: failing } as unknown as Env;
    await raiseDeliveryAlerts(e, CHAIN, input({ failures: new Map([[P1, 'x']]), cleared: new Set([P2]) }));
    expect(warned.filter((w) => w.includes('refused by the contract') && w.includes(`${P1} — x`))).toHaveLength(1);
    expect(keys()).toContain(`delivery-revert:${CHAIN}:${P2}`);
  });
});

describe('awaitingDeliveries', () => {
  const old = NOW - AWAITING_ALERT_SEC - 1;
  const base = {
    rows: [{ packetHash: P1 }],
    packets: new Map([[P1, { arrivedAt: old }]]),
    finished: new Set<string>(),
    notWhole: new Set([P1]),
    moved: new Set<string>(),
    remeasured: new Set<string>(),
    nowSec: NOW,
  };

  it('counts a delivery its calls went through as awaiting while a fresh read still finds it not whole', () => {
    // e.g. a rollout admission: the call went through, but it only OPENS the
    // epoch its days are indexed into on a later run.
    expect(awaitingDeliveries({ ...base, moved: new Set([P1]), remeasured: new Set([P1]) })).toEqual({
      awaiting: [{ packetHash: P1, arrivedAt: old }],
      undetermined: 0,
    });
  });

  it('leaves a moved delivery undetermined when its re-read did not land', () => {
    expect(awaitingDeliveries({ ...base, moved: new Set([P1]) })).toEqual({ awaiting: [], undetermined: 1 });
  });

  it('counts a delivery the run never planned as undetermined, and a finished one as neither', () => {
    expect(awaitingDeliveries({ ...base, notWhole: new Set() })).toEqual({ awaiting: [], undetermined: 1 });
    expect(awaitingDeliveries({ ...base, finished: new Set([P1]) })).toEqual({ awaiting: [], undetermined: 0 });
  });

  it('does not report a delivery inside its first scan interval', () => {
    expect(awaitingDeliveries({ ...base, packets: new Map([[P1, { arrivedAt: NOW - 60 }]]) })).toEqual({ awaiting: [], undetermined: 0 });
  });
});

describe('minedRevertOutcome', () => {
  const call = { functionName: 'materializeTransportBatchChunk', args: [] as const };
  const TX = `0x${'a'.repeat(64)}` as const;

  it('reads a race lost to another caller as done, not a failure', async () => {
    const out = await minedRevertOutcome(async () => Promise.reject(revert('TransportChunkAlreadyIndexed', [P1, 2n])), call, TX);
    expect(out).toEqual({ kind: 'ok' });
  });

  it("names the contract's reason for any other refusal", async () => {
    const out = await minedRevertOutcome(async () => Promise.reject(revert('TransportChunkProofInvalid', [P1, 1n, P2])), call, TX);
    expect(out).toEqual({ kind: 'failed', reason: `materializeTransportBatchChunk: TransportChunkProofInvalid (tx ${TX})` });
  });

  it('names the transaction when the call would now go through, or the re-check fails without a reason', async () => {
    const generic = { kind: 'failed', reason: `materializeTransportBatchChunk reverted on chain (tx ${TX})` };
    expect(await minedRevertOutcome(async () => undefined, call, TX)).toEqual(generic);
    expect(await minedRevertOutcome(async () => Promise.reject(new Error('request to https://rpc.example/KEY failed')), call, TX)).toEqual(generic);
  });
});

describe('receiptTimeoutMs', () => {
  it("never waits past the run's send deadline, and never asks viem for an unbounded wait", () => {
    expect(receiptTimeoutMs(100_000, 0)).toBe(30_000);
    expect(receiptTimeoutMs(5_000, 0)).toBe(5_000);
    expect(receiptTimeoutMs(0, 5_000), 'a timeout of 0 would mean none at all').toBe(1);
  });
});

describe('refusedBeforeBroadcast', () => {
  it('classifies a contract refusal at gas estimation like any refused call', () => {
    expect(refusedBeforeBroadcast(revert('TransportChunkProofInvalid', [P1, 1n, P2]), 'proveDeliveryDayChunk')).toEqual({
      kind: 'failed',
      reason: 'proveDeliveryDayChunk: TransportChunkProofInvalid',
    });
    expect(refusedBeforeBroadcast(revert('TransportChunkAlreadyIndexed', [P1, 2n]), 'proveDeliveryDayChunk')).toEqual({ kind: 'ok' });
  });

  it('leaves a failure with no contract reason to stop the run', () => {
    expect(refusedBeforeBroadcast(new Error('nonce too low'), 'proveDeliveryDayChunk')).toBeNull();
  });
});

describe('listOpenWorkPage', () => {
  it('reports the rows it read beside the payloads it could parse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const k = createKeeperD1();
    const ins = k.db.prepare(
      'INSERT INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    );
    ins.run(CHAIN, '0xab', 'delivery_proof', 'a', 1, JSON.stringify({ packetHash: P1 }), 0);
    ins.run(CHAIN, '0xab', 'delivery_proof', 'b', 2, '{not json', 0);
    const page = await listOpenWorkPage(k.d1 as unknown as KeeperD1, CHAIN, '0xab', 'delivery_proof', 10);
    expect(page.items.map((i) => i.item)).toEqual(['a']);
    expect(page.rows, 'an unreadable row is counted, so the run knows it did not see it').toBe(2);
    vi.restoreAllMocks();
  });
});

describe('refusal digest (Codex #2599 r4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    disarmEpochFence();
  });
  const configured = (k: SqliteD1) =>
    ({ DB: createSharedD1().d1, KEEPER_DB: k.d1, TG_OPS_BOT_TOKEN: 'tok', TG_OPS_CHAT_ID: '-100' }) as unknown as Env;
  const sentKeys = (k: SqliteD1) =>
    (k.db.prepare('SELECT alert_key FROM keeper_ops_alert ORDER BY alert_key').all() as { alert_key: string }[]).map((r) => r.alert_key);

  it('raises every refusal of a run in ONE post, and records each under its own key', async () => {
    const k = createKeeperD1();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    armHeldFence();
    const failures = new Map(Array.from({ length: 200 }, (_, i) => [`0x${i.toString(16).padStart(64, '0')}`, 'chunk 0, 1 day (days 1–1): x'] as const));
    await raiseDeliveryAlerts(configured(k), CHAIN, {
      failures,
      cleared: new Set(),
      openWork: async (ps) => new Set(ps),
      awaiting: [],
      awaitingMeasured: false,
      nowSec: NOW,
      deadline: 0,
    });
    expect(fetchSpy, 'one post, however many refused').toHaveBeenCalledTimes(1);
    expect(sentKeys(k)).toHaveLength(200);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toContain('each named in the keeper journal');
  });

  it('posts only the refusals that are due, and nothing when none is', async () => {
    const k = createKeeperD1();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const e = configured(k);
    expect(await sendOpsAlertDigest(e, () => 'h', [{ key: 'a', id: 'A', detail: 'x' }], 'f', 600, NOW)).toBe('sent');
    expect(await sendOpsAlertDigest(e, () => 'h', [{ key: 'a', id: 'A', detail: 'x' }], 'f', 600, NOW + 1)).toBe('suppressed');
    expect(
      await sendOpsAlertDigest(e, (n) => `${n} refused:`, [{ key: 'a', id: 'A', detail: 'x' }, { key: 'b', id: 'B', detail: 'y' }], 'f', 600, NOW + 2),
    ).toBe('sent');
    const last = JSON.parse((fetchSpy.mock.calls[1] as unknown as [string, { body: string }])[1].body) as { text: string };
    expect(last.text, 'a key still inside its interval is not repeated, nor counted').toBe('1 refused:\nB — y\nf');
  });

  it('sends every entry when its sent-state cannot be read, and reports a post it could not record as sent (Codex #2599 r6)', async () => {
    const k = createKeeperD1();
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = { ...k.d1, prepare: () => { throw new Error('d1 down'); }, batch: () => { throw new Error('d1 down'); } };
    const e = { DB: createSharedD1().d1, KEEPER_DB: down, TG_OPS_BOT_TOKEN: 'tok', TG_OPS_CHAT_ID: '-100' } as unknown as Env;
    expect(await sendOpsAlertDigest(e, () => 'h', [{ key: 'a', id: 'A', detail: 'x' }], 'f', 600, NOW)).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the post fails, so the next run tries again', async () => {
    const k = createKeeperD1();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendOpsAlertDigest(configured(k), () => 'h', [{ key: 'a', id: 'A', detail: 'x' }], 'f', 600, NOW)).toBe('failed');
    expect(sentKeys(k)).toEqual([]);
  });

  it('fits one message and counts what it could not name', () => {
    const t = digestText('H', Array.from({ length: 100 }, () => 'x'.repeat(100)), 'F');
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t).toMatch(/…and \d+ more, each named in the keeper journal\./);
    expect(digestText('H', ['a', 'b'], 'F')).toBe('H\na\nb\nF');
  });

  it('fits the per-kind count of the rest and keeps the whole footer, however many kinds (#2565 r1)', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
    const groups = lines.map((_, i) => `condition kind number ${i % 40} with a long name`);
    const footer = 'Each line repeats every 6h while it holds, and stops once a fresh read shows it gone.';
    const t = digestText('H', lines, footer, groups);
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t.endsWith(`, each named in the keeper journal.\n${footer}`)).toBe(true);
    const shown = t.split('\n').filter((l) => l.startsWith('line ')).length;
    expect(shown).toBeGreaterThan(0);
    expect(t).toContain(`…and ${400 - shown} more (`);
  });

  it('keeps what an oversized line is about, cutting only its end (Codex #2599 r5)', () => {
    const t = digestText('H', [`${P1} — ${'chunk refused; '.repeat(500)}`], 'F');
    expect(t).toContain(P1);
    expect(t).not.toContain('more, each named');
    expect(t.length).toBeLessThanOrEqual(4096);
  });

  it('names every overdue delivery that fits, not a fixed few, and journals all of them', async () => {
    const k = createKeeperD1();
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.map(String).join(' ')));
    const awaiting = Array.from({ length: 8 }, (_, i) => ({ packetHash: `0x${i.toString(16).padStart(64, '0')}`, arrivedAt: NOW - 3600 - i }));
    await raiseDeliveryAlerts({ DB: createSharedD1().d1, KEEPER_DB: k.d1 } as unknown as Env, CHAIN, {
      failures: new Map(),
      cleared: new Set(),
      openWork: async (ps) => new Set(ps),
      awaiting,
      awaitingMeasured: true,
      nowSec: NOW,
      deadline: Number.POSITIVE_INFINITY,
    });
    const alert = warned.find((w) => w.includes('reward delivery proofs'))!;
    const journal = warned.find((w) => w.includes('not whole past'))!;
    for (const a of awaiting) {
      expect(alert).toContain(a.packetHash);
      expect(journal).toContain(a.packetHash);
    }
  });
});

describe('outcomeOf (Codex #2599 r4)', () => {
  it('reports only what the contract refused; a transport failure is not a refusal', () => {
    expect(outcomeOf(revert('TransportChunkProofInvalid', [P1, 1n, P2]), 'f')).toEqual({ kind: 'failed', reason: 'f: TransportChunkProofInvalid' });
    expect(outcomeOf(revert('TransportChunkAlreadyIndexed', [P1, 2n]), 'f')).toEqual({ kind: 'ok' });
    expect(outcomeOf(new HttpRequestError({ url: 'https://rpc.example/KEY', details: 'timeout' }), 'f')).toEqual({ kind: 'stopped' });
    expect(outcomeOf(new Error('socket hang up'), 'f')).toEqual({ kind: 'stopped' });
  });
});

describe('dayRuns (Codex #2599 r6)', () => {
  it('collapses only contiguous runs', () => {
    expect(dayRuns([15n, 10n, 11n, 12n, 20n, 21n])).toBe('10–12, 15, 20–21');
    expect(dayRuns([7n])).toBe('7');
  });
});

describe('actionScope (Codex #2599 r4)', () => {
  it('names only the chunk a chunked proof refused, and every later page for a paged index', () => {
    expect(actionScope({ kind: 'proveChunk', packetHash: P1 as never, chunkIndex: 2, dayIds: [12n, 10n, 11n], proof: [] })).toBe('chunk 2, 3 days (days 10–12)');
    expect(actionScope({ kind: 'proveChunk', packetHash: P1 as never, chunkIndex: 0, dayIds: [10n, 12n], proof: [] }), 'a gap is never covered').toBe('chunk 0, 2 days (days 10, 12)');
    expect(actionScope({ kind: 'indexPage', batchId: P1 as never, dayIds: [5n, 6n, 7n, 8n], indexedFrom: 2 }), 'only the days not yet indexed').toBe(
      'the days its epoch has not indexed yet, 2 days (days 7–8), from the next page on',
    );
    expect(actionScope({ kind: 'proveList', packetHash: P1 as never, dayIds: [1n, 2n] })).toBe('its whole day list, 2 days (days 1–2)');
  });
});
