/**
 * remitAck's reservation scan (#1896).
 *
 * The pass walks a bounded window of the Base reservation ledger to find which
 * remittances are still Pending. That walk was one `getRemitReservation` per
 * id — up to MAX_SCAN_PER_TICK (200) subrequests per tick against a
 * 50-per-invocation ceiling. The per-selector attribution measured 200 of the
 * pass's 249 requests there, on a pass whose transaction work is 8% of its
 * traffic; batching is the right lever for that shape.
 *
 * The second test is the one that matters more. The sequential version let a
 * failed read THROW, which unwound to the per-chain catch, so
 * `putRemitAckScanState` never ran and neither the frontier nor the scan cursor
 * advanced past an id whose status was never read. A batched read does not
 * throw — `batchedRead` returns a per-entry failure — so the obvious
 * translation (skip the entry, keep going) would silently advance the cursor
 * past an unread reservation and drop it from the scan until the window wrapped.
 * That is the regression this file exists to prevent.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
} from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
} from '@vaipakam/contracts/abis';
import { MULTICALL3_ADDRESS } from '../src/multicall3';

const AGGREGATE3 = {
  type: 'function',
  name: 'aggregate3',
  stateMutability: 'payable',
  inputs: [
    {
      name: 'calls',
      type: 'tuple[]',
      components: [
        { name: 'target', type: 'address' },
        { name: 'allowFailure', type: 'bool' },
        { name: 'callData', type: 'bytes' },
      ],
    },
  ],
  outputs: [
    {
      name: 'returnData',
      type: 'tuple[]',
      components: [
        { name: 'success', type: 'bool' },
        { name: 'returnData', type: 'bytes' },
      ],
    },
  ],
} as const;

const REMIT: readonly AbiFunction[] = [
  ...(RewardRemittanceFacetABI as AbiFunction[]),
  ...(RewardRemittanceLensFacetABI as AbiFunction[]),
];

function fn(abi: readonly AbiFunction[], name: string): AbiFunction {
  const item = abi.find((i) => i.type === 'function' && i.name === name);
  if (!item) throw new Error(`${name} not found on ABI`);
  return item;
}

const F = {
  cfg: fn(RewardReporterFacetABI as AbiFunction[], 'getRewardReporterConfig'),
  nonce: fn(REMIT, 'getRemitReservationNonce'),
  reservation: fn(REMIT, 'getRemitReservation'),
} as const;

const SEL = {
  cfg: toFunctionSelector(F.cfg).toLowerCase(),
  nonce: toFunctionSelector(F.nonce).toLowerCase(),
  reservation: toFunctionSelector(F.reservation).toLowerCase(),
  agg: toFunctionSelector(AGGREGATE3).toLowerCase(),
};

const CHAIN_ID = 84532;
/** Reservation ids 1..NONCE — the whole ledger fits one window. */
const NONCE = 6;
/** Every reservation answers Released (3): terminal, so the scan completes
 *  without entering the ack-submission path this test is not about. */
const TERMINAL_STATUS = 3;

function enc(f: AbiFunction, result: unknown): string {
  return encodeFunctionResult({ abi: [f] as Abi, functionName: f.name, result: result as never });
}

/** A reservation tuple built from the compiled ABI, zeroed but for `status`. */
function reservation(status: number): string {
  const out = F.reservation.outputs;
  const one = (p: { name?: string; type: string; components?: readonly unknown[] }): unknown => {
    if (p.name === 'status') return status;
    if (p.name === 'dstChainId') return CHAIN_ID;
    const t = p.type;
    if (t.endsWith('[]')) return [];
    if (t === 'tuple') return ((p.components ?? []) as { name?: string; type: string }[]).map(one);
    if (t === 'address') return '0x0000000000000000000000000000000000000000';
    if (t === 'bool') return false;
    if (t === 'string') return '';
    if (t === 'bytes') return '0x';
    if (/^bytes\d+$/.test(t)) return `0x${'00'.repeat(Number(t.slice(5)))}`;
    return 0n;
  };
  const vals = out.map((o) => one(o as never));
  return enc(F.reservation, out.length === 1 ? vals[0] : vals);
}

type Seen = { serialReservations: number; batches: { to: string; inner: string[] }[]; reads: Map<number, number> };

/** @param failId reservation id whose batched read comes back as a failure. */
function install(failId?: number): { seen: Seen; restore: () => void } {
  const seen: Seen = { serialReservations: 0, batches: [], reads: new Map() };
  const real = globalThis.fetch;

  const answerOne = (data: string): string | null => {
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === SEL.cfg) {
      // (reporter, baseChainId, ?, isCanonical, ?) — canonical, this chain.
      return enc(F.cfg, [
        '0x0000000000000000000000000000000000000000',
        CHAIN_ID,
        0,
        true,
        0n,
      ]);
    }
    if (sel === SEL.nonce) return enc(F.nonce, BigInt(NONCE));
    if (sel === SEL.reservation) {
      const { args } = decodeFunctionData({
        abi: [F.reservation] as Abi,
        data: data as `0x${string}`,
      });
      const id = Number((args as readonly unknown[])[0]);
      seen.reads.set(id, (seen.reads.get(id) ?? 0) + 1);
      if (failId !== undefined && id === failId) return null;
      return reservation(TERMINAL_STATUS);
    }
    return null;
  };

  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok('0x14a34');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');
      if (req.method !== 'eth_call') return ok(null);
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      const to = (call.to ?? '').toLowerCase();
      const data = (call.data ?? '0x').toLowerCase();

      if (data.slice(0, 10) === SEL.agg) {
        const { args } = decodeFunctionData({
          abi: [AGGREGATE3] as Abi,
          data: data as `0x${string}`,
        });
        const calls = args[0] as readonly { callData: string }[];
        seen.batches.push({ to, inner: calls.map((c) => c.callData.slice(0, 10).toLowerCase()) });
        return ok(
          encodeFunctionResult({
            abi: [AGGREGATE3],
            functionName: 'aggregate3',
            result: calls.map((c) => {
              const r = answerOne(c.callData.toLowerCase());
              // A per-entry failure is `success: false`, which is exactly how a
              // reverting call arrives inside a real aggregate3.
              return { success: r !== null, returnData: (r ?? '0x') as `0x${string}` };
            }),
          }),
        );
      }

      if (data.slice(0, 10) === SEL.reservation) seen.serialReservations += 1;
      const r = answerOne(data);
      return r === null
        ? { jsonrpc: '2.0', id: req.id ?? 1, error: { code: -32000, message: 'reverted' } }
        : ok(r);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { seen, restore: () => { globalThis.fetch = real; } };
}

/** A D1 stub that records every statement it was asked to prepare. */
function db(): { handle: unknown; sql: string[] } {
  const sql: string[] = [];
  const handle = {
    prepare: (q: string) => {
      sql.push(q);
      const stmt: Record<string, unknown> = {};
      stmt.bind = () => stmt;
      stmt.all = async () => ({ results: [], success: true, meta: {} });
      stmt.first = async () => null;
      stmt.run = async () => ({ results: [], success: true, meta: {} });
      return stmt;
    },
    batch: async () => [],
    exec: async () => ({}),
  };
  return { handle, sql };
}

/**
 * Two stubs, one per database (#2450): the scan state is keeper-private, so
 * its writes must reach `KEEPER_DB` — a pass that wrote it to the shared
 * handle would record progress where the next tick never reads it.
 */
async function run(shared: unknown, keeper: unknown): Promise<void> {
  const { runRemitAck } = await import('../src/remitAck');
  await runRemitAck({
    DB: shared,
    KEEPER_DB: keeper,
    KEEPER_ENABLED: 'true',
    REWARD_REMIT_ENABLED: 'true',
    KEEPER_PRIVATE_KEY:
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
  } as never);
}

/** Did the pass persist its scan progress? */
const wroteScanState = (sql: string[]): boolean =>
  sql.some((q) => q.includes('keeper_remit_ack_frontier') && q.includes('INSERT'));

describe('remitAck reservation scan (#1896)', () => {
  it('batches the whole window, with no per-reservation read', async () => {
    const { seen, restore } = install();
    const shared = db();
    const { handle, sql } = db();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(shared.handle, handle);
    } finally {
      restore();
      spy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }

    expect(seen.batches.length).toBeGreaterThan(0);
    for (const b of seen.batches) expect(b.to).toBe(MULTICALL3_ADDRESS.toLowerCase());

    // Every reservation read is INSIDE a batch, and none outside it.
    const inner = seen.batches.flatMap((b) => b.inner);
    expect(inner.filter((s) => s === SEL.reservation)).toHaveLength(NONCE);
    expect(seen.serialReservations).toBe(0);

    // The scan ran to completion and persisted its progress — without this, a
    // version that read nothing would satisfy "no serial reads" trivially.
    expect(wroteScanState(sql)).toBe(true);
    // ...and persisted it to the keeper's own database, never the shared one.
    expect(shared.sql.filter((q) => /keeper_remit_ack/.test(q))).toEqual([]);
  });

  it('ABORTS the scan on a failed read rather than skipping the reservation', async () => {
    // The behaviour the sequential version got for free by throwing. A batched
    // read hands back a per-entry failure instead, so skipping it would advance
    // the cursor past a reservation whose status was never read — dropping it
    // from the scan until the rotating window came back around.
    const { seen, restore } = install(3);
    const shared = db();
    const { handle, sql } = db();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(shared.handle, handle);
    } finally {
      restore();
      spy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }

    // It did attempt the batch.
    expect(seen.batches.length).toBeGreaterThan(0);

    // THE ASSERTION. Neither the frontier nor the cursor moved.
    expect(wroteScanState(sql)).toBe(false);

    // And the operator can see which id stopped it.
    expect(warned.join('\n')).toMatch(/scan aborted at remit=3/);
  });
});

/**
 * A D1 stub that answers by statement text: `answers` maps a substring of the
 * SQL to the rows that statement returns, and every bound statement is kept
 * (with its binds) so a write can be asserted by what it wrote.
 */
function answeringDb(answers: [string, unknown[]][]): { handle: unknown; bound: { sql: string; binds: unknown[] }[] } {
  const bound: { sql: string; binds: unknown[] }[] = [];
  const handle = {
    prepare: (q: string) => {
      const stmt: Record<string, unknown> = { sql: q, binds: [] as unknown[] };
      const rows = () => answers.find(([k]) => q.includes(k))?.[1] ?? [];
      stmt.bind = (...b: unknown[]) => {
        stmt.binds = b;
        bound.push({ sql: q, binds: b });
        return stmt;
      };
      stmt.all = async () => ({ results: rows(), success: true, meta: {} });
      stmt.first = async () => rows()[0] ?? null;
      stmt.run = async () => ({ results: [], success: true, meta: {} });
      return stmt;
    },
    batch: async (stmts: { all?: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.all?.())),
    exec: async () => ({}),
  };
  return { handle, bound };
}

describe('remitAck late deliveries — every release until the chain shows it finished (Codex #2489 r1)', () => {
  it('reads every open release however many are newer, skips the done set, and records the finished ones', async () => {
    const { seen, restore } = install();
    // 60 releases: the old read took the newest 50, so ids 1..10 never got a look.
    const released = Array.from({ length: 60 }, (_, i) => ({ remit_id: i + 1 }));
    const shared = answeringDb([['RemitReservationReleased', released]]);
    // id 7 was recorded done on an earlier tick.
    const keeper = answeringDb([['FROM keeper_work_done', [{ item: '7' }]]]);
    const quiet = ['error', 'warn', 'log'].map((m) => vi.spyOn(console, m as 'log').mockImplementation(() => {}));
    try {
      await run(shared.handle, keeper.handle);
    } finally {
      restore();
      quiet.forEach((s) => s.mockRestore());
    }
    // Past the main scan's window (ids 1..6), every release is read once — the
    // oldest included — except the one already done.
    expect(seen.reads.get(8), 'an old release, outside the newest 50').toBe(1);
    expect(seen.reads.get(60), 'the newest').toBe(1);
    expect(seen.reads.get(7) ?? 0, 'done: never read again').toBe(0);
    // Each one read as released with nothing stranded is recorded done, in the
    // keeper's own database.
    const recorded = keeper.bound
      .filter((b) => b.sql.includes('INSERT OR IGNORE INTO keeper_work_done'))
      .map((b) => b.binds[3]);
    expect(recorded).toHaveLength(59);
    expect(recorded).toContain('8');
    expect(recorded).not.toContain('7');
    expect(keeper.bound.every((b) => !b.sql.includes('keeper_work_done') || b.binds[2] === 'late_ack')).toBe(true);
    expect(shared.bound.filter((b) => b.sql.includes('keeper_work_done')), 'never the shared database').toEqual([]);
  });
});
