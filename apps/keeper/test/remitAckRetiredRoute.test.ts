/**
 * #2561 — a remittance sent to a mirror that has since been redeployed.
 *
 * Base records where each remittance went (`getRemitRoute`). The ack pass reads
 * the receipt on the mirror Diamond this keeper is configured with, so a
 * remittance that landed at the OLD receiver never shows a receipt there. These
 * tests pin what the pass does then: it tells the operator, with the evidence,
 * instead of leaving the reservation to wait in silence; it says nothing for an
 * ordinary delivery still in flight; it treats a Diamond without the getter as
 * "route unknown"; and it clears the alert once the reservation is settled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
} from '@vaipakam/contracts/abis';
import {
  remitIdOfAlertKey,
  remitRouteVerdict,
  retiredRouteAlertKey,
  retiredRouteAlertPattern,
  retiredRouteAlertText,
} from '../src/remitRoute';
import { runRemitAck } from '../src/remitAck';

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

const ABI: readonly AbiFunction[] = [
  ...(RewardRemittanceFacetABI as AbiFunction[]),
  ...(RewardRemittanceLensFacetABI as AbiFunction[]),
  ...(RewardReporterFacetABI as AbiFunction[]),
];
const fn = (name: string): AbiFunction => {
  const f = ABI.find((i) => i.type === 'function' && i.name === name);
  if (!f) throw new Error(`${name} not on the ABI`);
  return f;
};
const F = {
  cfg: fn('getRewardReporterConfig'),
  nonce: fn('getRemitReservationNonce'),
  reservation: fn('getRemitReservation'),
  route: fn('getRemitRoute'),
  received: fn('getReceivedRemit'),
};
const sel = (f: AbiFunction | string) => toFunctionSelector(f as never).toLowerCase();
const SEL = {
  cfg: sel(F.cfg),
  nonce: sel(F.nonce),
  reservation: sel(F.reservation),
  route: sel(F.route),
  received: sel(F.received),
  gate: sel('function getCompensationOutstanding(uint32) view returns (uint256)'),
  agg: sel(AGGREGATE3 as never),
};

const BASE = 84532;
const ARB = 421614;
const BASE_RPC = 'https://mock-rpc.invalid/base-sepolia';
const ARB_RPC = 'https://mock-rpc.invalid/arb-sepolia';
const OLD = { messenger: '0x00000000000000000000000000000000000a11ce', recipient: '0x0000000000000000000000000000000000000b0b' } as const;
const NEW = { messenger: '0x00000000000000000000000000000000000a11c2', recipient: '0x0000000000000000000000000000000000000b02' } as const;
const MESSAGE_ID = `0x${'ab'.repeat(32)}`;
const FUNCTION_DOES_NOT_EXIST = '0xa9ad62f8';

const enc = (f: AbiFunction, result: unknown) =>
  encodeFunctionResult({ abi: [f] as Abi, functionName: f.name, result: result as never });

/** A zero value for `p`, with the named fields overridden. */
function zero(p: AbiParameter, set: Record<string, unknown>): unknown {
  if (p.name && p.name in set) return set[p.name];
  const t = p.type;
  if (t.endsWith('[]')) return [];
  if (t === 'tuple') return ((p as { components: AbiParameter[] }).components ?? []).map((c) => zero(c, set));
  if (t === 'address') return '0x0000000000000000000000000000000000000000';
  if (t === 'bool') return false;
  if (/^bytes\d+$/.test(t)) return `0x${'00'.repeat(Number(t.slice(5)))}`;
  if (t === 'bytes' || t === 'string') return t === 'bytes' ? '0x' : '';
  return 0n;
}
const tupleOut = (f: AbiFunction, set: Record<string, unknown>) => enc(f, zero(f.outputs[0], set));

type Book = {
  /** Status of reservation 1 (1 Pending, 2 Acked). */
  status: number;
  /** What `getRemitRoute(1)` answers; `'unrouted'` = the Diamond predates it. */
  route: { sent: typeof OLD; live: typeof OLD } | 'unrouted';
  /** Open alert keys the keeper database holds. */
  openAlerts?: string[];
};

function install(book: Book): { routeReads: () => number; restore: () => void } {
  const real = globalThis.fetch;
  let routeReads = 0;
  const answer = (rpc: string, data: string): { ok: string } | { revert: string } => {
    const s = data.slice(0, 10);
    if (s === SEL.cfg) {
      // (reporter, baseChainId, ?, isCanonical, ?): canonical on Base only.
      return { ok: enc(F.cfg, ['0x0000000000000000000000000000000000000000', BASE, 0, rpc === BASE_RPC, 0n]) };
    }
    if (s === SEL.nonce) return { ok: enc(F.nonce, 1n) };
    if (s === SEL.gate) return { ok: `0x${'0'.repeat(64)}` };
    if (s === SEL.reservation) {
      return {
        ok: tupleOut(F.reservation, {
          status: book.status,
          dstChainId: ARB,
          ccipMessageId: MESSAGE_ID,
          total: 5n * 10n ** 18n,
          strandedStamped: true,
        }),
      };
    }
    if (s === SEL.route) {
      routeReads += 1;
      const { args } = decodeFunctionData({ abi: [F.route] as Abi, data: data as `0x${string}` });
      expect((args as readonly bigint[])[0]).toBe(1n);
      if (book.route === 'unrouted') return { revert: FUNCTION_DOES_NOT_EXIST };
      const r = book.route;
      return { ok: enc(F.route, [r.sent.messenger, r.sent.recipient, r.live.messenger, r.live.recipient]) };
    }
    // The configured mirror holds no receipt for remittance 1.
    if (s === SEL.received) return { ok: tupleOut(F.received, {}) };
    return { revert: '0x' };
  };

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const rpc = String(input);
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok(rpc === BASE_RPC ? '0x14a34' : '0x66eee');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');
      if (req.method !== 'eth_call') return { jsonrpc: '2.0', id: req.id ?? 1, error: { code: -32601, message: `unexpected ${req.method}` } };
      const data = (((req.params?.[0] ?? {}) as { data?: string }).data ?? '0x').toLowerCase();
      if (data.slice(0, 10) === SEL.agg) {
        const { args } = decodeFunctionData({ abi: [AGGREGATE3] as Abi, data: data as `0x${string}` });
        const calls = args[0] as readonly { callData: string }[];
        return ok(
          encodeFunctionResult({
            abi: [AGGREGATE3],
            functionName: 'aggregate3',
            result: calls.map((c) => {
              const a = answer(rpc, c.callData.toLowerCase());
              return 'ok' in a
                ? { success: true, returnData: a.ok as `0x${string}` }
                : { success: false, returnData: a.revert as `0x${string}` };
            }),
          }),
        );
      }
      const a = answer(rpc, data);
      return 'ok' in a ? ok(a.ok) : { jsonrpc: '2.0', id: req.id ?? 1, error: { code: 3, message: 'execution reverted', data: a.revert } };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { routeReads: () => routeReads, restore: () => { globalThis.fetch = real; } };
}

/** A D1 stub: answers `keeper_ops_alert` key listings from `openAlerts`, and
 *  records every statement with its binds. */
function d1(openAlerts: string[] = []) {
  const bound: { sql: string; binds: unknown[] }[] = [];
  const handle = {
    prepare: (q: string) => {
      const stmt: Record<string, unknown> = {};
      let binds: unknown[] = [];
      stmt.bind = (...b: unknown[]) => {
        binds = b;
        bound.push({ sql: q, binds: b });
        return stmt;
      };
      const rows = () => {
        if (!q.includes('FROM keeper_ops_alert WHERE alert_key LIKE')) return [];
        const prefix = String(binds[0]).replace(/%$/, '');
        return openAlerts.filter((k) => k.startsWith(prefix)).map((alert_key) => ({ alert_key }));
      };
      stmt.all = async () => ({ results: rows(), success: true, meta: {} });
      stmt.first = async () => rows()[0] ?? null;
      stmt.run = async () => ({ results: [], success: true, meta: {} });
      return stmt;
    },
    batch: async () => [],
    exec: async () => ({}),
  };
  return { handle, bound };
}

async function tick(book: Book) {
  const { routeReads, restore } = install(book);
  const shared = d1();
  const keeper = d1(book.openAlerts);
  const warns: string[] = [];
  const errors: string[] = [];
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' '))),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' '))),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
  try {
    await runRemitAck(
      {
        DB: shared.handle,
        KEEPER_DB: keeper.handle,
        KEEPER_ENABLED: 'true',
        REWARD_REMIT_ENABLED: 'true',
        KEEPER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        RPC_BASE_SEPOLIA: BASE_RPC,
        RPC_ARB_SEPOLIA: ARB_RPC,
      } as never,
      { scheduledTimeMs: undefined, deadlineMs: Date.now() + 60_000 },
    );
  } finally {
    restore();
    spies.forEach((s) => s.mockRestore());
  }
  // The ops channel is unconfigured here, so a raised alert is the logged
  // "NOT delivered" line carrying its text.
  const alerts = warns.filter((w) => w.includes('ops alert NOT delivered'));
  const cleared = keeper.bound.filter((b) => b.sql.startsWith('DELETE FROM keeper_ops_alert')).map((b) => b.binds[0]);
  return { alerts, warns, errors, cleared, routeReads: routeReads() };
}

const BASE_DIAMOND = '0x2535baC87F3df287268fC697F2f31cf418365303';

afterEach(() => vi.restoreAllMocks());

describe('remitAck and a remittance sent to a retired mirror (#2561)', () => {
  it('alerts the operator with the evidence when the route is retired and the mirror holds no receipt', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW } });
    expect(t.routeReads).toBe(1);
    expect(t.alerts).toHaveLength(1);
    const text = t.alerts[0];
    expect(text).toMatch(/Remittance 1 is still Pending on Base, and the keeper cannot acknowledge it/);
    // viem decodes addresses checksummed, so compare case-insensitively.
    expect(text.toLowerCase()).toContain(`messenger ${OLD.messenger}, receiver ${OLD.recipient}`);
    expect(text.toLowerCase()).toContain(`messenger ${NEW.messenger}, receiver ${NEW.recipient}`);
    expect(text).toContain(MESSAGE_ID);
    expect(text).toContain('total 5000000000000000000 VPFI wei');
    expect(text).toMatch(/finalizeRemitReservation\(1\).*releaseRemitReservation\(1\)/s);
    expect(t.errors.join('\n')).not.toMatch(/retired-route/);
  });

  it('says nothing while a delivery on the current route is still in flight', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW } });
    expect(t.routeReads).toBe(1);
    expect(t.alerts).toEqual([]);
  });

  it('treats a Diamond without the route getter as route unknown, not as an error', async () => {
    const t = await tick({ status: 1, route: 'unrouted' });
    expect(t.alerts).toEqual([]);
    expect(t.errors.join('\n')).not.toMatch(/retired-route/);
  });

  it('clears the alert once the reservation is no longer Pending', async () => {
    const key = retiredRouteAlertKey('pending', BASE, BASE_DIAMOND as never, 1);
    const t = await tick({ status: 2, route: { sent: OLD, live: NEW }, openAlerts: [key] });
    expect(t.cleared).toEqual([key]);
    expect(t.alerts).toEqual([]);
  });

  it('keeps the alert while the reservation is still Pending', async () => {
    const key = retiredRouteAlertKey('pending', BASE, BASE_DIAMOND as never, 1);
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW }, openAlerts: [key] });
    expect(t.cleared).toEqual([]);
  });
});

describe('remitRouteVerdict (#2561)', () => {
  const ok = (r: readonly string[]) => ({ status: 'success' as const, result: r });
  const Z = '0x0000000000000000000000000000000000000000';

  it('the same pair, in any letter case, is the current route', () => {
    expect(remitRouteVerdict(ok([OLD.messenger, OLD.recipient, OLD.messenger.toUpperCase().replace('0X', '0x'), OLD.recipient]))).toEqual({ kind: 'current' });
  });

  it('either leg moved is a retired route, reported with both pairs', () => {
    expect(remitRouteVerdict(ok([OLD.messenger, OLD.recipient, OLD.messenger, NEW.recipient]))).toEqual({
      kind: 'retired',
      sent: OLD,
      live: { messenger: OLD.messenger, recipient: NEW.recipient },
    });
    // A lane no longer configured at all is retired too.
    expect(remitRouteVerdict(ok([OLD.messenger, OLD.recipient, Z, Z])).kind).toBe('retired');
  });

  it('no recorded route is unknown, not current', () => {
    expect(remitRouteVerdict(ok([Z, Z, NEW.messenger, NEW.recipient]))).toEqual({ kind: 'unrecorded' });
  });

  it('a failed read decides nothing; an unrouted selector is unknown', () => {
    expect(remitRouteVerdict(undefined)).toEqual({ kind: 'unread' });
    expect(remitRouteVerdict({ status: 'failure', error: new Error('timeout') })).toEqual({ kind: 'unread' });
    expect(remitRouteVerdict({ status: 'failure', error: { data: FUNCTION_DOES_NOT_EXIST } })).toEqual({ kind: 'unrecorded' });
  });
});

describe('retired-route alert keys (#2561)', () => {
  it('round-trips the remitId and matches its own pattern only', () => {
    const key = retiredRouteAlertKey('late', BASE, BASE_DIAMOND as never, 42);
    expect(remitIdOfAlertKey(key)).toBe(42);
    expect(key.startsWith(retiredRouteAlertPattern('late', BASE, BASE_DIAMOND as never).replace(/%$/, ''))).toBe(true);
    expect(key.startsWith(retiredRouteAlertPattern('pending', BASE, BASE_DIAMOND as never).replace(/%$/, ''))).toBe(false);
    expect(remitIdOfAlertKey('remit-route-retired:pending:1:0xabc:x')).toBeUndefined();
  });

  it('the late text names the share and no terminal valve', () => {
    const text = retiredRouteAlertText({
      path: 'late',
      baseChainId: BASE,
      remitId: 7,
      dstChainId: ARB,
      sent: OLD,
      live: NEW,
      ccipMessageId: MESSAGE_ID,
      totalWei: 1n,
    });
    expect(text).toMatch(/Released remittance 7 still counts its recycled share as in transit/);
    expect(text).not.toMatch(/releaseRemitReservation/);
  });
});
