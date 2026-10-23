import { describe, expect, it } from 'vitest';
import { offerTerminalTopics } from '../../src/data/bookCatchUp.ts';
import { CHUNK_BLOCKS, MAX_CHUNKS_PER_SCAN, catchUpRange, tallyCalls, terminalTopics } from './catchUpTally.mjs';

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const chunk = (from, to, topics = offerTerminalTopics()) => ({
  method: 'eth_getLogs',
  params: [{ address: '0xd1a0', fromBlock: hex(from), toBlock: hex(to), topics: [topics] }],
});
const head = { method: 'eth_blockNumber', params: [] };

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
    expect(t.catchUp.scans).toHaveLength(2);
    expect(t.budgeted).toBe(6);
    expect(t.catchUp.oversized).toEqual([]);
    expect(t.catchUp.overlong).toEqual([]);
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
    expect(t.catchUp.scans).toHaveLength(2);
    expect(t.catchUp.scans.every((s) => s.chunks === 2)).toBe(true);
  });

  it('keeps a retry of a FAILED chunk with its scan', () => {
    const [c1, c2] = scan(100, 2_000);
    const t = tallyCalls([{ ...c1, outcome: 'failed' }, { ...c1, outcome: 'failed' }, { ...c1, outcome: 'ok' }, c2]);
    expect(t.catchUp.scans).toHaveLength(1);
    expect(t.catchUp.retries).toBe(2);
    expect(t.budgeted).toBe(1);
  });

  it('counts every re-scan of an unchanged range that succeeded (#2710 r1)', () => {
    // The head and cursor have not moved, so each refetch asks for the
    // identical window — the over-frequent polling the audit exists to catch.
    const calls = [];
    for (let i = 0; i < 8; i++) calls.push(head, { ...chunk(500, 619), outcome: 'ok' });
    const t = tallyCalls(calls);
    expect(t.catchUp.retries).toBe(0);
    expect(t.catchUp.scans).toHaveLength(8);
    expect(t.budgeted).toBe(16);
  });

  it('never reads an unknown outcome as a failure', () => {
    const c = chunk(500, 619);
    const t = tallyCalls([c, c]);
    expect(t.catchUp.retries).toBe(0);
    expect(t.catchUp.scans).toHaveLength(2);
  });

  it('keeps two scans issued at once over the identical range apart', () => {
    const [a1, a2] = scan(100, 2_000);
    const t = tallyCalls([{ ...a1, outcome: 'ok' }, { ...a1, outcome: 'ok' }, a2, a2]);
    expect(t.catchUp.scans).toHaveLength(2);
    expect(t.catchUp.scans.every((x) => x.chunks === 2)).toBe(true);
  });

  it('fails the shape rules the app sets for itself', () => {
    const wide = tallyCalls([chunk(1, Number(CHUNK_BLOCKS) + 1)]);
    expect(wide.catchUp.oversized).toHaveLength(1);
    const long = tallyCalls(scan(1, (MAX_CHUNKS_PER_SCAN + 1) * Number(CHUNK_BLOCKS)));
    expect(long.catchUp.overlong).toHaveLength(1);
  });
});
