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

type Seen = { serialReservations: number; batches: { to: string; inner: string[] }[] };

/** @param failId reservation id whose batched read comes back as a failure. */
function install(failId?: number): { seen: Seen; restore: () => void } {
  const seen: Seen = { serialReservations: 0, batches: [] };
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

async function run(handle: unknown): Promise<void> {
  const { runRemitAck } = await import('../src/remitAck');
  await runRemitAck({
    DB: handle,
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
    const { handle, sql } = db();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(handle);
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
  });

  it('ABORTS the scan on a failed read rather than skipping the reservation', async () => {
    // The behaviour the sequential version got for free by throwing. A batched
    // read hands back a per-entry failure instead, so skipping it would advance
    // the cursor past a reservation whose status was never read — dropping it
    // from the scan until the rotating window came back around.
    const { seen, restore } = install(3);
    const { handle, sql } = db();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(handle);
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
