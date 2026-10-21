/**
 * #2561 — a remittance sent to a mirror that has since been redeployed.
 *
 * Base records the remote adapter each remittance was bound to
 * (`getRemitRoute` answers it beside the adapter the lane names now). The ack
 * pass reads the receipt on the mirror Diamond this keeper is configured with,
 * so a remittance that executed behind the OLD adapter never shows a receipt
 * there. These tests pin what the pass does then: it tells the operator, in one
 * digest with the evidence, instead of leaving the reservation to wait in
 * silence; it says nothing for an ordinary delivery still in flight; it treats
 * a Diamond without the getter as "route unknown"; and it clears the alert once
 * the reservation is settled or its adapter is the lane's again.
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
  parseUndeliveredAlertKey,
  REMIT_OVERDUE_SEC,
  remitRouteVerdict,
  undeliveredAlertDetail,
  undeliveredAlertFooter,
  undeliveredAlertHeader,
  undeliveredAlertKey,
  undeliveredAlertPattern,
  undeliveredReason,
} from '../src/remitRoute';
import { lateOutstanding, runRemitAck } from '../src/remitAck';

// The ops-channel tests post through a configured channel; the epoch fence
// (armed by a real tick's indexer read) is not what they exercise.
vi.mock('../src/epochFence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/epochFence')>()),
  assertEpochsHold: async () => {},
}));
// Short reserves, so the stalls below can outlast the read cutoffs (receipts
// at deadline − 650 ms, routes at − 500 ms) and the deadline itself within a
// fast test.
vi.mock('../src/runWindow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runWindow')>()),
  readCutoffMs: (deadlineMs: number) => deadlineMs - 500,
  priorStageCutoffMs: (nextMs: number) => nextMs - 150,
}));

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
  quote: fn('quoteRemitAckFee'),
};
const sel = (f: AbiFunction | string) => toFunctionSelector(f as never).toLowerCase();
const SEL = {
  cfg: sel(F.cfg),
  nonce: sel(F.nonce),
  reservation: sel(F.reservation),
  route: sel(F.route),
  received: sel(F.received),
  quote: sel(F.quote),
  gate: sel('function getCompensationOutstanding(uint32) view returns (uint256)'),
  agg: sel(AGGREGATE3 as never),
};

const BASE = 84532;
const ARB = 421614;
const BASE_RPC = 'https://mock-rpc.invalid/base-sepolia';
const ARB_RPC = 'https://mock-rpc.invalid/arb-sepolia';
const BNB = 97;
const BNB_RPC = 'https://mock-rpc.invalid/bnb-testnet';
const OLD = '0x00000000000000000000000000000000000a11ce' as const;
const NEW = '0x00000000000000000000000000000000000a11c2' as const;
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
  route: { sent: string; live: string } | 'unrouted';
  /** Seconds since the send (default: one minute, an ordinary delivery). */
  ageSec?: number;
  /** Whether the configured mirror holds reservation 1's receipt. */
  receipt?: boolean;
  /** Open alert keys the keeper database holds. */
  openAlerts?: string[];
  /** The ledger nonce (default 1: reservation 1 only). */
  nonce?: number;
  /** Which reservations' receipts the mirror holds; overrides `receipt`. */
  receiptIds?: number[];
  /** Hold the mirror's fee quote this long before it reverts, so the ack
   *  send runs past the tick's deadline. */
  slowQuoteMs?: number;
  /** The tick's deadline, from now (default 60 s). */
  deadlineInMs?: number;
  /** Per-reservation status, overriding `status` (3 = Released). */
  statusById?: Record<number, number>;
  /** Released reservations open on the late-delivery queue. */
  lateOpenIds?: number[];
  /** Configure the ops channel, and hold each post this long. */
  telegramDelayMs?: number;
  /** Make the keeper database's alert-key listing fail. */
  failAlertList?: boolean;
  /** Make the keeper database's acknowledgement-attempt read fail. */
  failAttempts?: boolean;
  /** Per-reservation destination chain, overriding Arbitrum Sepolia. */
  dstById?: Record<number, number>;
  /** Hold the mirror's receipt read for this reservation this long. */
  slowReceipt?: { id: number; ms: number };
  /** A released reservation's stamped stranded share is zero. */
  zeroStranded?: boolean;
  /** Make the compensation-gate read revert. */
  failGate?: boolean;
  /** Configure BNB Testnet as a second mirror. */
  bnb?: boolean;
  /** Hold the fee quote only on this RPC (default: every mirror). */
  slowQuoteRpc?: string;
  /** Hold Base's reservation read for this reservation this long. */
  slowReservation?: { id: number; ms: number };
  /** The mirror reverts the receipt read for these reservations. */
  revertReceiptIds?: number[];
  /** These RPCs answer the fee quote (default: every quote reverts). */
  quoteOkRpcs?: string[];
};

/** Whether a JSON-RPC batch reads `getRemitReservation(id)`, directly or
 *  inside an `aggregate3` (decoded, so another argument cannot match). */
function readsReservation(reqs: { method?: string; params?: unknown[] }[], id: number): boolean {
  return reqs.some((req) => {
    if (req.method !== 'eth_call') return false;
    const data = (((req.params?.[0] ?? {}) as { data?: string }).data ?? '0x').toLowerCase() as `0x${string}`;
    const calls = data.slice(0, 10) === SEL.agg
      ? (decodeFunctionData({ abi: [AGGREGATE3] as Abi, data }).args[0] as readonly { callData: `0x${string}` }[]).map((c) => c.callData.toLowerCase())
      : [data];
    return calls.some((c) => c.slice(0, 10) === SEL.reservation
      && Number((decodeFunctionData({ abi: [F.reservation] as Abi, data: c as `0x${string}` }).args as readonly bigint[])[0]) === id);
  });
}

function install(book: Book): { routeReads: () => number; routeIds: number[]; posts: number[]; postTexts: string[]; quotes: () => number; quoteRpcs: string[]; sendRpcs: string[]; restore: () => void } {
  const real = globalThis.fetch;
  let routeReads = 0;
  const routeIds: number[] = [];
  /** When each ops post began, in ms since install, beside each route read's. */
  const posts: number[] = [];
  const postTexts: string[] = [];
  let quotes = 0;
  const quoteRpcs: string[] = [];
  /** The RPC of each broadcast the keeper started (its nonce read). */
  const sendRpcs: string[] = [];
  const answer = (rpc: string, data: string): { ok: string } | { revert: string } => {
    const s = data.slice(0, 10);
    if (s === SEL.cfg) {
      // (reporter, baseChainId, ?, isCanonical, ?): canonical on Base only.
      return { ok: enc(F.cfg, ['0x0000000000000000000000000000000000000000', BASE, 0, rpc === BASE_RPC, 0n]) };
    }
    if (s === SEL.nonce) return { ok: enc(F.nonce, BigInt(book.nonce ?? 1)) };
    if (s === SEL.gate) return book.failGate ? { revert: '0x' } : { ok: `0x${'0'.repeat(64)}` };
    if (s === SEL.reservation) {
      const { args } = decodeFunctionData({ abi: [F.reservation] as Abi, data: data as `0x${string}` });
      const id = Number((args as readonly bigint[])[0]);
      const status = book.statusById?.[id] ?? book.status;
      return {
        ok: tupleOut(F.reservation, {
          status,
          strandedRecycled: status === 3 && !book.zeroStranded ? 10n ** 18n : 0n,
          dstChainId: book.dstById?.[id] ?? ARB,
          ccipMessageId: MESSAGE_ID,
          total: 5n * 10n ** 18n,
          sentAt: BigInt(Math.floor(Date.now() / 1000) - (book.ageSec ?? 60)),
          strandedStamped: true,
        }),
      };
    }
    if (s === SEL.route) {
      routeReads += 1;
      const { args } = decodeFunctionData({ abi: [F.route] as Abi, data: data as `0x${string}` });
      routeIds.push(Number((args as readonly bigint[])[0]));
      if (book.route === 'unrouted') return { revert: FUNCTION_DOES_NOT_EXIST };
      const r = book.route;
      return { ok: enc(F.route, [r.sent, r.live]) };
    }
    // The configured mirror holds no receipt for remittance 1 unless the book
    // says it does.
    if (s === SEL.quote && book.quoteOkRpcs?.includes(rpc)) return { ok: enc(F.quote, 1n) };
    if (s === SEL.received) {
      const { args } = decodeFunctionData({ abi: [F.received] as Abi, data: data as `0x${string}` });
      const id = Number((args as readonly unknown[]).find((a) => typeof a === 'bigint'));
      if (book.revertReceiptIds?.includes(id)) return { revert: '0x' };
      const held = book.receiptIds ? book.receiptIds.includes(id) : book.receipt;
      return { ok: tupleOut(F.received, held ? { receivedAt: 1_700_000_000n, srcChainId: BASE } : {}) };
    }
    return { revert: '0x' };
  };

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const rpc = String(input);
    if (new URL(rpc).hostname === 'api.telegram.org') {
      posts.push(routeIds.length);
      postTexts.push(String(JSON.parse(init?.body ?? '{}').text ?? ''));
      await new Promise((r) => setTimeout(r, book.telegramDelayMs ?? 0));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    if (JSON.stringify(reqs).toLowerCase().includes(SEL.quote.slice(2))) {
      quotes += 1;
      quoteRpcs.push(rpc);
    }
    const wire = JSON.stringify(reqs).toLowerCase();
    if (book.slowReceipt && wire.includes(SEL.received.slice(2)) && wire.includes(book.slowReceipt.id.toString(16).padStart(64, '0'))) {
      await new Promise((r) => setTimeout(r, book.slowReceipt!.ms));
    }
    if (book.slowReservation && rpc === BASE_RPC && readsReservation(reqs, book.slowReservation.id)) {
      await new Promise((r) => setTimeout(r, book.slowReservation!.ms));
    }
    if (book.slowQuoteMs && (book.slowQuoteRpc ?? rpc) === rpc && JSON.stringify(reqs).toLowerCase().includes(SEL.quote.slice(2))) {
      await new Promise((r) => setTimeout(r, book.slowQuoteMs));
    }
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      if (req.method === 'eth_chainId') return ok(rpc === BASE_RPC ? '0x14a34' : rpc === BNB_RPC ? '0x61' : '0x66eee');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');
      if (req.method === 'eth_getTransactionCount') sendRpcs.push(rpc);
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
  return { routeReads: () => routeReads, routeIds, posts, postTexts, quotes: () => quotes, quoteRpcs, sendRpcs, restore: () => { globalThis.fetch = real; } };
}

/** A D1 stub: answers `keeper_ops_alert` key listings from `openAlerts`, and
 *  records every statement with its binds. */
function d1(openAlerts: string[] = [], lateOpenIds: number[] = [], failAlertList = false, failAttempts = false) {
  const bound: { sql: string; binds: unknown[] }[] = [];
  const handle = {
    prepare: (q: string) => {
      const stmt: Record<string, unknown> = { sql: q };
      let binds: unknown[] = [];
      stmt.bind = (...b: unknown[]) => {
        binds = b;
        bound.push({ sql: q, binds: b });
        return stmt;
      };
      const rows = () => {
        if (q.includes('FROM keeper_work_open')) {
          return lateOpenIds.map((id) => ({ item: String(id), block: 1, payload: JSON.stringify({ remitId: id }) }));
        }
        if (!q.includes('FROM keeper_ops_alert WHERE alert_key LIKE')) return [];
        if (failAlertList) throw new Error('D1 unavailable');
        const prefix = String(binds[0]).replace(/%$/, '');
        return openAlerts.filter((k) => k.startsWith(prefix)).map((alert_key) => ({ alert_key }));
      };
      stmt.all = async () => ({ results: rows(), success: true, meta: {} });
      stmt.first = async () => rows()[0] ?? null;
      stmt.run = async () => ({ results: [], success: true, meta: {} });
      return stmt;
    },
    batch: async (stmts: { sql?: string }[]) => {
      if (failAttempts && stmts.some((x) => x.sql?.includes('FROM keeper_remit_ack'))) throw new Error('D1 unavailable');
      return [];
    },
    exec: async () => ({}),
  };
  return { handle, bound };
}

async function tick(book: Book) {
  const { routeReads, routeIds, posts, postTexts, quotes, quoteRpcs, sendRpcs, restore } = install(book);
  const shared = d1();
  const keeper = d1(book.openAlerts, book.lateOpenIds, book.failAlertList, book.failAttempts);
  const warns: string[] = [];
  const errors: string[] = [];
  const spies = [
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' '))),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' '))),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
  const started = Date.now();
  let elapsedMs = 0;
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
        ...(book.bnb ? { RPC_BNB_TESTNET: BNB_RPC } : {}),
        ...(book.telegramDelayMs === undefined ? {} : { TG_OPS_BOT_TOKEN: 'test-token', TG_OPS_CHAT_ID: '-1' }),
      } as never,
      { scheduledTimeMs: undefined, deadlineMs: Date.now() + (book.deadlineInMs ?? 60_000) },
    );
    elapsedMs = Date.now() - started;
  } finally {
    restore();
    spies.forEach((s) => s.mockRestore());
  }
  // The ops channel is unconfigured here, so a raised alert is the logged
  // "NOT delivered" line carrying its text.
  const alerts = warns.filter((w) => w.includes('ops alert NOT delivered'));
  const cleared = keeper.bound.filter((b) => b.sql.startsWith('DELETE FROM keeper_ops_alert')).map((b) => b.binds[0]);
  const cursors = keeper.bound.filter((b) => b.sql.includes('INSERT INTO keeper_remit_ack_frontier')).map((b) => b.binds[3]);
  return { alerts, warns, errors, cleared, routeReads: routeReads(), routeIds, posts, postTexts, quotes: quotes(), quoteRpcs, sendRpcs, elapsedMs, cursors };
}

const BASE_DIAMOND = '0x2535baC87F3df287268fC697F2f31cf418365303';

afterEach(() => vi.restoreAllMocks());

const key = (reason: 'retired' | 'overdue', path: 'pending' | 'late' = 'pending', id = 1) =>
  undeliveredAlertKey(path, BASE, BASE_DIAMOND as never, reason, id);
const Z = '0x0000000000000000000000000000000000000000';

describe('remitAck and a remittance with no receipt on the configured mirror (#2561)', () => {
  it('alerts the operator with the evidence when the route is retired', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW } });
    expect(t.routeReads).toBe(1);
    expect(t.alerts).toHaveLength(1);
    const text = t.alerts[0];
    expect(text).toMatch(/1 remittance\(s\) still Pending on Base were sent through a remote adapter the lane no longer names/);
    expect(text).toContain('remit 1');
    // viem decodes addresses checksummed, so compare case-insensitively.
    expect(text.toLowerCase()).toContain(`sent to adapter ${OLD}, lane now names ${NEW}`);
    expect(text).toContain(MESSAGE_ID);
    expect(text).toContain('total 5000000000000000000 VPFI wei');
    expect(text).toMatch(/finalizeRemitReservation\(remitId\).*releaseRemitReservation\(remitId\)/s);
    expect(t.errors.join('\n')).not.toMatch(/undelivered/);
  });

  it('reports an undelivered remittance even when an acknowledgement ahead of it outlives the deadline', async () => {
    // Reservation 1 holds a receipt, so its ack is sent, and the mirror's fee
    // quote stalls past the tick's deadline. Reservation 2 has no receipt and a
    // retired route. Its alert must not depend on the send finishing in time
    // (Codex #2607 r3): every path is reported before anything is broadcast.
    const t = await tick({
      status: 1,
      nonce: 2,
      receiptIds: [1],
      route: { sent: OLD, live: NEW },
      slowQuoteMs: 1_500,
      deadlineInMs: 1_000,
    });
    expect(t.routeIds).toEqual([2]);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('remit 2');
    expect(t.alerts[0]).not.toContain('remit 1');
  });

  it('a quote stalled on one mirror does not hold up another mirror\'s acknowledgement', async () => {
    // Reservation 1 goes to Arbitrum Sepolia, whose fee quote stalls past the
    // deadline; reservation 2 goes to BNB Testnet. Both hold a receipt and
    // neither was attempted. Each mirror sends in its own lane, so BNB is
    // quoted whatever Arbitrum does (Codex #2607 r13).
    const t = await tick({
      status: 1,
      nonce: 2,
      receiptIds: [1, 2],
      dstById: { 2: BNB },
      bnb: true,
      route: { sent: NEW, live: NEW },
      slowQuoteMs: 5_000,
      slowQuoteRpc: ARB_RPC,
      deadlineInMs: 1_000,
    });
    expect(t.quoteRpcs).toContain(BNB_RPC);
    // The stalled quote is abandoned at the deadline: the pass does not wait
    // the stall out.
    expect(t.elapsedMs).toBeLessThan(3_000);
  });

  it('a mirror whose quote answers later still gets a send while a faster mirror has a backlog', async () => {
    // Reservations 1–5 go to Arbitrum Sepolia and 6 to BNB Testnet; all hold
    // a receipt and every quote answers, BNB's 300 ms later. The tick's five
    // slots go round the mirrors once the quotes are in, so BNB is sent
    // rather than losing every slot to the faster mirror (Codex #2607 r17).
    const t = await tick({
      status: 1,
      nonce: 6,
      receiptIds: [1, 2, 3, 4, 5, 6],
      dstById: { 6: BNB },
      bnb: true,
      route: { sent: NEW, live: NEW },
      quoteOkRpcs: [ARB_RPC, BNB_RPC],
      slowQuoteMs: 300,
      slowQuoteRpc: BNB_RPC,
    });
    expect(t.sendRpcs).toContain(BNB_RPC);
    expect(t.sendRpcs.filter((r) => r === ARB_RPC).length).toBeLessThanOrEqual(4);
  });

  it('Pending acknowledgements whose quotes fail leave their slots to a late one on a healthy mirror', async () => {
    // Reservations 1–5 are Pending on Arbitrum Sepolia, whose quotes all
    // revert after 300 ms. Reservation 6 is Released, open on the late queue, on BNB
    // Testnet, whose quote answers. A failed quote takes no slot, so the late
    // acknowledgement is sent (Codex #2607 r17).
    const t = await tick({
      status: 1,
      nonce: 5,
      statusById: { 6: 3 },
      lateOpenIds: [6],
      receiptIds: [1, 2, 3, 4, 5, 6],
      dstById: { 6: BNB },
      bnb: true,
      route: { sent: NEW, live: NEW },
      quoteOkRpcs: [BNB_RPC],
      slowQuoteMs: 300,
      slowQuoteRpc: ARB_RPC,
    });
    expect(t.quoteRpcs).toContain(ARB_RPC);
    expect(t.sendRpcs).toEqual([BNB_RPC]);
  });

  it('a slow ledger scan neither holds the run nor stops the late path', async () => {
    // Reservation 1 is Pending and Base's read of it stalls past the deadline.
    // Reservation 2 is Released, open on the late queue, with no receipt and a
    // retired route. The scan is bounded by its own cutoff, and the late path
    // does not wait on it (Codex #2607 r14).
    const t = await tick({
      status: 1,
      nonce: 2,
      statusById: { 2: 3 },
      lateOpenIds: [2],
      route: { sent: OLD, live: NEW },
      slowReservation: { id: 1, ms: 8_000 },
      deadlineInMs: 3_000,
    });
    expect(t.alerts.join('\n')).toContain('remit 2');
    expect(t.elapsedMs).toBeLessThan(4_000);
  });

  it('a scan cut partway works what it read and resumes at the first unread reservation', async () => {
    // A 150-reservation window reads in two chunks; the second (ids 101–150)
    // stalls past the scan cutoff. The first chunk's reservations are still
    // worked, so reservation 5's receipt is acknowledged, and the cursor
    // stops at 101 rather than the window being re-read from scratch every
    // run (Codex #2607 r15).
    const t = await tick({
      status: 1,
      nonce: 150,
      receiptIds: [5],
      route: { sent: NEW, live: NEW },
      slowReservation: { id: 120, ms: 8_000 },
      deadlineInMs: 3_000,
    });
    expect(t.quotes).toBeGreaterThan(0);
    expect(t.cursors).toEqual([101]);
  });

  it('reports a receipt read the destination answers with an error, never leaves it silent', async () => {
    // The mirror reverts reservation 1's receipt read (a deployment entry
    // naming a Diamond without the read, say). That is an answer, not a gap,
    // so it is reported with the cause (Codex #2607 r14).
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, revertReceiptIds: [1] });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toMatch(/cannot read their receipts/);
    expect(t.alerts[0]).toMatch(/answered the receipt read with an error/);
    expect(t.alerts[0]).toContain('remit 1');
  });

  it('a receipt read abandoned at the cutoff is not reported as refused', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, slowReceipt: { id: 1, ms: 1_500 }, deadlineInMs: 1_000 });
    expect(t.alerts.join('\n')).not.toMatch(/answered the receipt read with an error/);
  });

  it('a slow ops channel on one path cannot starve the other path', async () => {
    // Reservation 1 is Pending and reservation 2 is Released and open on the
    // late queue; neither has a receipt, both were sent to a retired adapter.
    // Each ops post outlives the deadline. Neither path's post may hold up the
    // other path's classification or its alert (Codex #2607 r4, r6).
    const t = await tick({
      status: 1,
      statusById: { 2: 3 },
      lateOpenIds: [2],
      route: { sent: OLD, live: NEW },
      telegramDelayMs: 1_500,
      deadlineInMs: 1_000,
    });
    expect([...t.routeIds].sort()).toEqual([1, 2]);
    expect(t.postTexts.some((a) => a.includes('remit 1'))).toBe(true);
    expect(t.postTexts.some((a) => a.includes('remit 2'))).toBe(true);
  });

  it('a slow late-path mirror read does not hold up the Pending acknowledgements', async () => {
    // Reservation 1 is Pending and its receipt is on the mirror, so its ack is
    // due. Reservation 2 is released and open on the late queue, and its
    // receipt read outlives the deadline. The Pending send must still start
    // (Codex #2607 r6).
    const t = await tick({
      status: 1,
      statusById: { 2: 3 },
      lateOpenIds: [2],
      receiptIds: [1],
      route: { sent: NEW, live: NEW },
      slowReceipt: { id: 2, ms: 1_500 },
      deadlineInMs: 1_000,
    });
    expect(t.quotes).toBeGreaterThan(0);
  });

  it('a mirror read still in flight at the read cutoff is abandoned, so another mirror is still acknowledged', async () => {
    // Reservation 1 goes to Arbitrum Sepolia and holds its receipt there.
    // Reservation 2 goes to Base Sepolia, configured as a mirror too, whose
    // receipt read stalls past the deadline. That read is abandoned at the
    // read cutoff, so reservation 1's ack is still sent before the deadline,
    // and nothing is decided about 2 (Codex #2607 r7).
    const t = await tick({
      status: 1,
      nonce: 2,
      receiptIds: [1],
      dstById: { 2: BASE },
      route: { sent: OLD, live: NEW },
      slowReceipt: { id: 2, ms: 1_500 },
      deadlineInMs: 1_000,
    });
    expect(t.quotes).toBeGreaterThan(0);
    expect(t.routeIds).toEqual([]);
    expect(t.alerts).toEqual([]);
  });

  it('a mirror stalled until its read is abandoned does not silence another mirror\'s alert', async () => {
    // Reservation 1 goes to Arbitrum Sepolia, which holds no receipt for it,
    // behind a retired adapter. Reservation 2 goes to Base Sepolia, whose
    // receipt read stalls. The stalled read is abandoned at the receipt
    // cutoff, which leaves the route reads their own reserve, so 1 is still
    // alerted (Codex #2607 r8).
    const t = await tick({
      status: 1,
      nonce: 2,
      dstById: { 2: BASE },
      route: { sent: OLD, live: NEW },
      slowReceipt: { id: 2, ms: 1_500 },
      deadlineInMs: 1_000,
    });
    expect(t.routeIds).toEqual([1]);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('remit 1');
    expect(t.alerts[0]).not.toContain('remit 2');
  });

  it('a released remittance whose gate is unread is reported with the gate unknown, and not sent', async () => {
    // Reservation 2 is released, its stamped stranded share is zero, and the
    // compensation-gate read fails. It may hold the gate, so it is classified
    // and reported with the gate stated as unknown, never dropped as settled;
    // and no ack is paid for on the unread gate (Codex #2607 r9).
    const t = await tick({
      status: 2,
      statusById: { 2: 3, 3: 3 },
      lateOpenIds: [2, 3],
      receiptIds: [3],
      zeroStranded: true,
      failGate: true,
      route: { sent: OLD, live: NEW },
    });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('remit 2');
    expect(t.alerts[0]).toMatch(/whether it holds chain 421614's compensation gate is not known/);
    expect(t.quotes).toBe(0);
  });

  it('alerts a remittance to a chain the keeper has no RPC for, with its route', async () => {
    // Reservation 1 went to BNB Testnet, which this keeper is not configured
    // for, on the adapter the lane still names. It is reported as
    // unobservable rather than dropped (Codex #2607 r6), and its route, which
    // Base holds, is read and stated (r11).
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, dstById: { 1: 97 } });
    expect(t.routeIds).toEqual([1]);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('no RPC or deployment for');
    expect(t.alerts[0]).toContain('remit 1');
    expect(t.alerts[0]).toContain('sent to the adapter the lane still names');
    expect(t.alerts[0]).toContain('no RPC or deployment for, give it both');
  });

  it('a remittance to an unconfigured chain behind a retired adapter is the retired case, not a configuration gap', async () => {
    // Configuring the chain would not help: the receipt, if any, is behind
    // the old adapter. So it is alerted as retired, with the configuration gap
    // stated beside the route, and no promise that configuration resolves it
    // (Codex #2607 r11).
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW }, dstById: { 1: 97 } });
    expect(t.routeIds).toEqual([1]);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toMatch(/were sent through a remote adapter the lane no longer names/);
    expect(t.alerts[0].toLowerCase()).toContain(`sent to adapter ${OLD}`.toLowerCase());
    expect(t.alerts[0]).toContain('the keeper has no RPC or deployment for chain 97');
    expect(t.alerts[0]).not.toContain('no RPC or deployment for, give it both');
  });

  it('still alerts when the attempt log is unreadable, and sends nothing that run', async () => {
    // Reservation 1 has no receipt behind a retired adapter; reservation 2 has
    // its receipt. The attempt log fails: 1 is still alerted, 2 is not sent
    // (Codex #2607 r6).
    const t = await tick({ status: 1, nonce: 2, receiptIds: [2], route: { sent: OLD, live: NEW }, failAttempts: true });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('remit 1');
    expect(t.quotes).toBe(0);
    expect(t.errors.some((e) => e.includes('attempt log unread'))).toBe(true);
  });

  it('still sends acknowledgements while every alert post stalls', async () => {
    // Reservation 1 holds a receipt; reservation 2 is undelivered and alerted.
    // Each ops post outlives the deadline. The ack for 1 must not wait for it
    // (Codex #2607 r5): posts run beside the sends, not before them.
    const t = await tick({
      status: 1,
      nonce: 2,
      receiptIds: [1],
      route: { sent: OLD, live: NEW },
      telegramDelayMs: 1_500,
      deadlineInMs: 1_000,
    });
    expect(t.posts.length).toBeGreaterThan(0);
    expect(t.quotes).toBeGreaterThan(0);
  });

  it('still sends a new alert when the open-alert list cannot be read', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW }, failAlertList: true });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('remit 1');
    expect(t.errors.join('\n')).toMatch(/alert reconciliation failed this run \(new alerts were still sent\)/);
  });

  it('says nothing while a delivery on the current route is still in flight', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW } });
    expect(t.routeReads).toBe(1);
    expect(t.alerts).toEqual([]);
  });

  it('reports a Pending remittance overdue on the CURRENT route, and says the cause is unknown', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, ageSec: REMIT_OVERDUE_SEC + 3600 });
    expect(t.alerts).toHaveLength(1);
    const text = t.alerts[0];
    expect(text).toMatch(/have no receipt on the mirror the keeper reads, more than 8 hours after the send\. The keeper does not know why/);
    expect(text).toContain('sent 9h ago; sent to the adapter the lane still names');
    expect(text).toMatch(/manual execution/);
    expect(text).toMatch(/replaced behind the same adapter/);
  });

  it('reports an overdue remittance on a Diamond without the route getter as route unknown', async () => {
    const quiet = await tick({ status: 1, route: 'unrouted' });
    expect(quiet.alerts).toEqual([]);
    expect(quiet.errors.join('\n')).not.toMatch(/undelivered/);
    const t = await tick({ status: 1, route: 'unrouted', ageSec: REMIT_OVERDUE_SEC });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain('Base holds no record of the adapter it was sent to');
  });

  it('names a lane that no longer has any adapter', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: Z } });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0].toLowerCase()).toContain(`sent to adapter ${OLD}, lane now names no adapter`);
  });

  it('clears an open alert once the recorded adapter is the lane\'s again', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, openAlerts: [key('retired')] });
    expect(t.cleared).toEqual([key('retired')]);
    expect(t.alerts).toEqual([]);
  });

  it('a change of reason clears the old key and alerts under the new one at once', async () => {
    const t = await tick({ status: 1, route: { sent: NEW, live: NEW }, ageSec: REMIT_OVERDUE_SEC, openAlerts: [key('retired')] });
    expect(t.cleared).toEqual([key('retired')]);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toMatch(/The keeper does not know why/);
  });

  it('clears an open alert once the configured mirror holds the receipt, and reads no route', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW }, receipt: true, openAlerts: [key('retired'), key('overdue')] });
    expect(t.cleared.sort()).toEqual([key('overdue'), key('retired')].sort());
    expect(t.routeReads).toBe(0);
    expect(t.alerts).toEqual([]);
  });

  it('clears the alert once the reservation is no longer Pending, with no reservation re-read', async () => {
    const t = await tick({ status: 2, route: { sent: OLD, live: NEW }, openAlerts: [key('retired')] });
    expect(t.cleared).toEqual([key('retired')]);
    expect(t.alerts).toEqual([]);
  });

  it('keeps the alert while the reservation is still Pending on the same reason', async () => {
    const t = await tick({ status: 1, route: { sent: OLD, live: NEW }, openAlerts: [key('retired')] });
    expect(t.cleared).toEqual([]);
  });
});

describe('remitRouteVerdict (#2561)', () => {
  const ok = (r: readonly string[]) => ({ status: 'success' as const, result: r });

  it('the same adapter, in any letter case, is the current route', () => {
    expect(remitRouteVerdict(ok([OLD, OLD.toUpperCase().replace('0X', '0x')]))).toEqual({ kind: 'current' });
  });

  it('a moved adapter is a retired route, reported with both', () => {
    expect(remitRouteVerdict(ok([OLD, NEW]))).toEqual({ kind: 'retired', sent: OLD, live: NEW });
    // A lane no longer configured at all is retired too.
    expect(remitRouteVerdict(ok([OLD, Z]))).toEqual({ kind: 'retired', sent: OLD, live: Z });
  });

  it('no recorded route is unknown, not current', () => {
    expect(remitRouteVerdict(ok([Z, NEW]))).toEqual({ kind: 'unrecorded' });
  });

  it('a failed read decides nothing; an unrouted selector is unknown', () => {
    expect(remitRouteVerdict(undefined)).toEqual({ kind: 'unread' });
    expect(remitRouteVerdict({ status: 'failure', error: new Error('timeout') })).toEqual({ kind: 'unread' });
    expect(remitRouteVerdict({ status: 'failure', error: { data: FUNCTION_DOES_NOT_EXIST } })).toEqual({ kind: 'unrecorded' });
  });
});

describe('undeliveredReason (#2561)', () => {
  const now = 1_800_000_000;
  const retired = { kind: 'retired' as const, sent: OLD, live: NEW };
  it('a retired route is reported on either path, at once', () => {
    expect(undeliveredReason('pending', retired, now, now)).toBe('retired');
    expect(undeliveredReason('late', retired, now, now)).toBe('retired');
  });
  it('a Pending reservation on the current or an unrecorded route is reported only once overdue', () => {
    for (const route of [{ kind: 'current' as const }, { kind: 'unrecorded' as const }]) {
      expect(undeliveredReason('pending', route, now - REMIT_OVERDUE_SEC + 1, now)).toBeUndefined();
      expect(undeliveredReason('pending', route, now - REMIT_OVERDUE_SEC, now)).toBe('overdue');
    }
  });
  it('a released reservation on its current route is not reported: that is what a release means', () => {
    expect(undeliveredReason('late', { kind: 'current' }, 0, now)).toBeUndefined();
  });
  it('an unread route decides nothing', () => {
    expect(undeliveredReason('pending', { kind: 'unread' }, 0, now)).toBeUndefined();
  });
});

describe('undelivered alert keys and text (#2561)', () => {
  it('round-trips the reason and remitId and matches its own path pattern only', () => {
    const k = key('retired', 'late', 42);
    expect(parseUndeliveredAlertKey(k)).toEqual({ reason: 'retired', remitId: 42 });
    expect(k.startsWith(undeliveredAlertPattern('late', BASE, BASE_DIAMOND as never).replace(/%$/, ''))).toBe(true);
    expect(k.startsWith(undeliveredAlertPattern('pending', BASE, BASE_DIAMOND as never).replace(/%$/, ''))).toBe(false);
    expect(parseUndeliveredAlertKey('remit-undelivered:pending:1:0xabc:bogus:1')).toBeUndefined();
    expect(parseUndeliveredAlertKey('remit-undelivered:pending:1:0xabc:retired:x')).toBeUndefined();
  });

  const base = { remitId: 7, dstChainId: ARB, route: { kind: 'retired' as const, sent: OLD, live: NEW }, ageSec: 3600, ccipMessageId: MESSAGE_ID, totalWei: 10n };

  it('the late text names the outstanding share and the recovery paths, and no Pending valve', () => {
    const header = undeliveredAlertHeader('late', 'retired', BASE, 1);
    const footer = undeliveredAlertFooter('late', 'retired');
    expect(header).toMatch(/1 released remittance\(s\) still wait on a late acknowledgement/);
    expect(undeliveredAlertDetail({ ...base, outstanding: { kind: 'stranded', wei: 3n } })).toContain('total 10 VPFI wei; stranded share 3 VPFI wei still unresolved');
    expect(footer).toMatch(/late acknowledgement/);
    expect(footer).toMatch(/recordRecoveryCeremony/);
    expect(footer).toMatch(/recordRecoveryTerminalLoss/);
    expect(`${header} ${footer}`).not.toMatch(/releaseRemitReservation|finalizeRemitReservation/);
    // The receipt's holder is found from the execution, never assumed (r5).
    expect(footer).not.toMatch(/old mirror/);
    expect(footer).toMatch(/holds its receipt/);
    expect(footer).toMatch(/has not executed, no mirror can acknowledge it yet/);
  });

  it('an unread gate on a zero stranded share is stated as unknown, never as nothing outstanding', () => {
    expect(lateOutstanding({ strandedRecycled: 0n, strandedStamped: true }, 'unread')).toEqual({ kind: 'gate-unread' });
    // A known share or an unstamped one is stated as it is, gate read or not.
    expect(lateOutstanding({ strandedRecycled: 3n, strandedStamped: true }, 'unread')).toEqual({ kind: 'stranded', wei: 3n });
    expect(lateOutstanding({ strandedRecycled: 0n, strandedStamped: false }, 'unread')).toEqual({ kind: 'unstamped' });
    expect(undeliveredAlertDetail({ ...base, outstanding: { kind: 'gate-unread' } })).toMatch(/compensation gate is not known \(the gate could not be read this run\)/);
  });

  it('the Pending text offers forced finalization only on consumption evidence, and says what it books', () => {
    const footer = undeliveredAlertFooter('pending', 'retired');
    // Execution alone is not the evidence: forced finalization attests
    // consumption with a zero received figure (Codex #2607 r6).
    expect(footer).toMatch(/Only if the destination receipt shows the remittance CONSUMED/);
    expect(footer).toMatch(/zero received figure/);
    expect(footer).toMatch(/clears any compensation gate/);
    expect(footer).toMatch(/quarantined or provisional receipt is not that evidence/);
    expect(footer).not.toMatch(/If it executed, finalizeRemitReservation/);
  });

  it('a released compensation remittance names the gate it holds, never a zero stranded share', () => {
    const outstanding = lateOutstanding({ strandedRecycled: 0n, strandedStamped: true }, true);
    expect(outstanding).toEqual({ kind: 'gate' });
    const detail = undeliveredAlertDetail({ ...base, outstanding });
    expect(detail).toContain(`holds chain ${ARB}'s compensation gate`);
    expect(detail).not.toMatch(/stranded share 0/);
  });

  it('an unstamped stranded share is stated as unknown, not as zero', () => {
    const outstanding = lateOutstanding({ strandedRecycled: 0n, strandedStamped: false }, false);
    expect(undeliveredAlertDetail({ ...base, outstanding })).toMatch(/not stamped on Base yet, so its size is not known/);
  });

  it('the Pending text names both valves and no outstanding share', () => {
    expect(undeliveredAlertDetail(base)).not.toMatch(/stranded|gate/);
    expect(undeliveredAlertFooter('pending', 'retired')).toMatch(/finalizeRemitReservation\(remitId\).*releaseRemitReservation\(remitId\)/s);
    expect(undeliveredAlertFooter('pending', 'overdue')).toMatch(/finalizeRemitReservation\(remitId\).*releaseRemitReservation\(remitId\)/s);
  });
});
