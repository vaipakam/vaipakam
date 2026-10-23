import { describe, expect, it } from 'vitest';
import { offerTerminalTopics } from '../../src/data/bookCatchUp.ts';
import { CHUNK_BLOCKS, MAX_CHUNKS_PER_SCAN, catchUpRange, createCallLedger, tallyCalls, terminalTopics } from './catchUpTally.mjs';

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const chunk = (from, to, topics = offerTerminalTopics(), outcome = 'ok') => ({
  method: 'eth_getLogs',
  params: [{ address: '0xd1a0', fromBlock: hex(from), toBlock: hex(to), topics: [topics] }],
  outcome,
});
const head = { method: 'eth_blockNumber', params: [], outcome: 'ok' };

/** One scan of `blocks` blocks from `from`, chunked the way the app chunks. */
function scan(from, blocks) {
  const out = [];
  const step = Number(CHUNK_BLOCKS);
  for (let f = from; f < from + blocks; f += step) out.push(chunk(f, Math.min(f + step - 1, from + blocks - 1)));
  return out;
}

describe('terminalTopics', () => {
  it('is the same set the app scans for', () => {
    expect(terminalTopics()).toEqual(offerTerminalTopics());
  });
});

describe('catchUpRange', () => {
  it('recognises only the book terminal-event set', () => {
    expect(catchUpRange(chunk(10, 20))).toEqual({ from: 10n, to: 20n });
    const [, ...missingOne] = offerTerminalTopics();
    expect(catchUpRange(chunk(10, 20, missingOne))).toBeNull();
    expect(catchUpRange({ method: 'eth_getLogs', params: [{ topics: ['0xabc'] }] })).toBeNull();
    expect(catchUpRange(head)).toBeNull();
  });

  it('matches the topic set in any order and case', () => {
    const t = offerTerminalTopics().map((x) => x.toUpperCase().replace('0X', '0x')).reverse();
    expect(catchUpRange(chunk(1, 2, t))).toEqual({ from: 1n, to: 2n });
  });
});

describe('tallyCalls (#2097)', () => {
  it('reproduces the stalled-cache run: 14 raw calls, budgeted as 6', () => {
    // 2026-09-10: cursor ~4,952 blocks behind, two refetches in the window.
    const calls = [head, ...scan(1_000, 4_950), head, ...scan(1_015, 4_950), head, { method: 'eth_call' }];
    const t = tallyCalls(calls);
    expect(t.total).toBe(14);
    expect(t.catchUp.chunks).toBe(10);
    expect(t.catchUp.runs).toHaveLength(2);
    expect(t.budgeted).toBe(6);
    expect(t.catchUp.oversized).toEqual([]);
    expect(t.catchUp.longRuns).toEqual([]);
  });

  it('gives a current cache the same budgeted figure as a stalled one', () => {
    const current = tallyCalls([head, ...scan(5_000, 120), head, ...scan(5_015, 120), head, { method: 'eth_call' }]);
    expect(current.total).toBe(6);
    expect(current.budgeted).toBe(6);
  });

  it('still counts a page that scans far more often than the design', () => {
    const calls = [];
    for (let i = 0; i < 12; i++) calls.push(head, ...scan(9_000 + i * 15, 120));
    expect(tallyCalls(calls).budgeted).toBe(24);
  });

  it('keeps two interleaved scans apart', () => {
    const [a1, a2] = scan(100, 2_000);
    const [b1, b2] = scan(150, 2_000);
    const t = tallyCalls([a1, b1, a2, b2]);
    expect(t.catchUp.runs).toHaveLength(2);
    expect(t.catchUp.runs.every((s) => s.chunks === 2)).toBe(true);
  });

  it('counts every attempt, and floors the budget by the failed ones (#2710 r6)', () => {
    // Two failed attempts and a success over one window: retries or three
    // scans? The wire cannot say, so all three count, and the floor
    // discounts the two that failed — the most the transport could have added.
    const [c1, c2] = scan(100, 2_000);
    const t = tallyCalls([{ ...c1, outcome: 'failed' }, { ...c1, outcome: 'failed' }, c1, c2]);
    expect(t.catchUp.runs).toHaveLength(3);
    expect(t.budgeted).toBe(3);
    expect(t.budgetedFloor).toBe(1);
    expect(t.failedCounts).toEqual({ eth_getLogs: 2 });
  });

  it('counts every re-scan of an unchanged range that succeeded (#2710 r1)', () => {
    // The head and cursor have not moved, so each refetch asks for the
    // identical window — the over-frequent polling the audit exists to catch.
    const calls = [];
    for (let i = 0; i < 8; i++) calls.push(head, chunk(500, 619));
    const t = tallyCalls(calls);
    expect(t.catchUp.runs).toHaveLength(8);
    expect(t.budgeted).toBe(16);
    expect(t.budgetedFloor).toBe(16);
  });

  it('keeps failing re-scans over the budget floor too (#2710 r6)', () => {
    // A page re-scanning a failing range after its own head reads: every
    // scan counts, and the floor gives back only one unit per failure.
    const calls = [];
    for (let i = 0; i < 8; i++) calls.push(head, chunk(500, 619, undefined, 'failed'));
    const t = tallyCalls(calls);
    expect(t.budgeted).toBe(16);
    expect(t.budgetedFloor).toBe(8);
  });

  it('reads a call with no observed result as a failed attempt (#2710 r4)', () => {
    const t = tallyCalls([{ ...chunk(500, 619), outcome: undefined }]);
    expect(t.failedCounts).toEqual({ eth_getLogs: 1 });
    expect(t.budgetedFloor).toBe(0);
  });

  it('does not continue a run past a window that failed (#2710 r4)', () => {
    // The app stops a scan at a failed window, so a request starting one
    // block after it is a new scan, even when it is contiguous.
    const w = Number(CHUNK_BLOCKS);
    const t = tallyCalls([{ ...chunk(1, w), outcome: 'failed' }, head, chunk(w + 1, 2 * w), chunk(2 * w + 1, 2 * w + 40)]);
    expect(t.catchUp.runs).toHaveLength(2);
    expect(t.budgeted).toBe(3);
  });

  it('continues a run from a repeated window that succeeded', () => {
    const w = Number(CHUNK_BLOCKS);
    const t = tallyCalls([{ ...chunk(1, w), outcome: 'failed' }, chunk(1, w), chunk(w + 1, w + 40)]);
    expect(t.catchUp.runs.map((r) => r.chunks)).toEqual([1, 2]);
    expect(t.budgeted).toBe(2);
    expect(t.budgetedFloor).toBe(1);
  });

  it('keeps two scans issued at once over the identical range apart', () => {
    const [a1, a2] = scan(100, 2_000);
    const t = tallyCalls([a1, a1, a2, a2]);
    expect(t.catchUp.runs).toHaveLength(2);
    expect(t.catchUp.runs.every((x) => x.chunks === 2)).toBe(true);
  });

  it('fails the shape rules the app sets for itself', () => {
    const wide = tallyCalls([chunk(1, Number(CHUNK_BLOCKS) + 1)]);
    expect(wide.catchUp.oversized).toHaveLength(1);
  });

  it('reports a run longer than one scan as unresolved, charged the fewest scans (#2710 r2)', () => {
    // One scan of exactly 20 full windows, then the indexer lands on its end
    // and the next tick scans on from there: block numbers alone read one run.
    const full = MAX_CHUNKS_PER_SCAN * Number(CHUNK_BLOCKS);
    const t = tallyCalls([head, ...scan(1, full), head, ...scan(1 + full, 2_500)]);
    expect(t.catchUp.runs).toHaveLength(1);
    expect(t.catchUp.longRuns).toHaveLength(1);
    expect(t.catchUp.scansCharged).toBe(2);
    expect(t.budgeted).toBe(4);
  });

  it('still charges a page that scans far past the skip cap', () => {
    const t = tallyCalls(scan(1, 50 * Number(CHUNK_BLOCKS)));
    expect(t.catchUp.scansCharged).toBe(3);
    expect(t.catchUp.longRuns).toHaveLength(1);
  });
});

describe('createCallLedger (#2710 r4)', () => {
  const body = (calls) => JSON.stringify(calls);
  it('records only while recording, and settles each call by its own id', () => {
    let on = false;
    const l = createCallLedger(() => on);
    expect(l.onRequest(body({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }))).toBeNull();
    on = true;
    const pending = l.onRequest(body([
      { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' },
      { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [] },
      { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [] },
    ]));
    l.onResponse(pending, body([
      { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'range' } },
      { jsonrpc: '2.0', id: 1, result: '0x10' },
    ]));
    expect(l.calls.map((c) => [c.method, c.outcome])).toEqual([
      ['eth_blockNumber', 'ok'],
      ['eth_getLogs', 'failed'],
      ['eth_call', 'failed'],
    ]);
  });

  it('reads a malformed body or no response as a failure, as the transport does', () => {
    const l = createCallLedger();
    const a = l.onRequest(body({ jsonrpc: '2.0', id: 7, method: 'eth_getLogs' }));
    l.onResponse(a, '<html>502 Bad Gateway</html>');
    const b = l.onRequest(body({ jsonrpc: '2.0', id: 8, method: 'eth_getLogs' }));
    l.onResponse(b, null);
    expect(l.calls.map((c) => c.outcome)).toEqual(['failed', 'failed']);
  });

  it('counts chain calls only, not another JSON-RPC protocol (#2710 r5)', () => {
    const l = createCallLedger();
    const p = l.onRequest(body([
      { jsonrpc: '2.0', id: 1, method: 'irn_subscribe', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'eth_chainId' },
    ]));
    l.onResponse(p, body([{ jsonrpc: '2.0', id: 1, result: 'sub' }, { jsonrpc: '2.0', id: 2, result: '0x1' }]));
    expect(l.calls.map((c) => [c.method, c.outcome])).toEqual([['eth_chainId', 'ok']]);
    expect(l.onRequest(body({ jsonrpc: '2.0', id: 3, method: 'irn_publish' }))).toBeNull();
  });

  it('ignores a body that is not JSON-RPC', () => {
    const l = createCallLedger();
    expect(l.onRequest('not json')).toBeNull();
    expect(l.onRequest(body({ event: 'pageview' }))).toBeNull();
    expect(l.calls).toEqual([]);
  });
});
