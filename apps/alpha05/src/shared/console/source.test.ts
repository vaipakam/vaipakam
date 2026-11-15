/**
 * RW-77 — the Console uses the index's snapshot only while it may be shown,
 * reads the chain otherwise, and calls a chain answer older than the
 * snapshot a failure.
 */
import { describe, expect, it } from 'vitest';
import type { DirectRead } from './direct';
import type { ConfigSnapshot } from './snapshot';
import { CLOCK_SKEW_SEC, SNAPSHOT_MAX_AGE_SEC, ageOf, judgeSnapshot, settleSettings } from './source';

const NOW = 1_900_000_000;
const snap = (over: Partial<Extract<ConfigSnapshot, { available: true }>> = {}): ConfigSnapshot => ({
  available: true,
  values: { treasuryFeeBps: '200' },
  unreported: ['priceGuard'],
  bundleUnreported: null,
  sourceBlock: 1_000,
  updatedAt: NOW - 60,
  stale: false,
  staleAtBlock: null,
  ...over,
});
const direct = (block: bigint, over: Partial<DirectRead> = {}): DirectRead => ({
  block,
  timestamp: NOW - 2,
  values: { treasuryFeeBps: '300' },
  unreported: [],
  bundleIssue: null,
  ...over,
});

describe('judgeSnapshot', () => {
  it('uses a dated, recent, labelled snapshot the index has not marked behind', () => {
    expect(judgeSnapshot(snap(), NOW)).toEqual({ use: true });
  });
  it('names each reason a snapshot is not used', () => {
    expect(judgeSnapshot(null, NOW)).toEqual({ use: false, reason: 'unreachable' });
    expect(judgeSnapshot({ available: false }, NOW)).toEqual({ use: false, reason: 'none' });
    expect(judgeSnapshot(snap({ stale: true, updatedAt: 0 }), NOW)).toEqual({ use: false, reason: 'behind' });
    expect(judgeSnapshot(snap({ values: null }), NOW)).toEqual({ use: false, reason: 'unlabelled' });
    // Bundle values with no list of what went unanswered: the settings it
    // leaves out could not be named, so the chain is read instead.
    expect(judgeSnapshot(snap({ unreported: null }), NOW)).toEqual({ use: false, reason: 'partial' });
    expect(judgeSnapshot(snap({ bundleUnreported: 'abi mismatch' }), NOW)).toEqual({ use: false, reason: 'unlabelled' });
    expect(judgeSnapshot(snap({ updatedAt: 0 }), NOW)).toEqual({ use: false, reason: 'undated' });
    expect(judgeSnapshot(snap({ updatedAt: NOW + CLOCK_SKEW_SEC + 1 }), NOW)).toEqual({ use: false, reason: 'future' });
    expect(judgeSnapshot(snap({ updatedAt: NOW - SNAPSHOT_MAX_AGE_SEC - 1 }), NOW)).toEqual({ use: false, reason: 'old' });
  });
  it('still uses a snapshot exactly a day old, or a little ahead of the device clock', () => {
    expect(judgeSnapshot(snap({ updatedAt: NOW - SNAPSHOT_MAX_AGE_SEC }), NOW)).toEqual({ use: true });
    expect(judgeSnapshot(snap({ updatedAt: NOW + CLOCK_SKEW_SEC }), NOW)).toEqual({ use: true });
  });
});

describe('ageOf', () => {
  it('is unknown with no time or a time ahead of the device clock', () => {
    expect(ageOf(0, NOW)).toEqual({ kind: 'unknown' });
    expect(ageOf(NOW + CLOCK_SKEW_SEC + 1, NOW)).toEqual({ kind: 'unknown' });
  });
  it('flags an answer more than a day old', () => {
    expect(ageOf(NOW - 10, NOW)).toEqual({ kind: 'known', seconds: 10, old: false });
    expect(ageOf(NOW - SNAPSHOT_MAX_AGE_SEC - 1, NOW)).toEqual({ kind: 'known', seconds: SNAPSHOT_MAX_AGE_SEC + 1, old: true });
  });
});

describe('settleSettings', () => {
  const nowSec = () => NOW;
  it('takes the snapshot without reading the chain when it may be shown', async () => {
    let reads = 0;
    const out = await settleSettings({ snapshot: async () => snap(), direct: async () => (reads++, direct(2_000n)), nowSec });
    expect(out).toEqual({ source: 'snapshot', values: { treasuryFeeBps: '200' }, unreported: ['priceGuard'], block: 1_000, asOf: NOW - 60 });
    expect(reads).toBe(0);
  });
  it('reads the chain and keeps the index’s failure when the index does not answer', async () => {
    const out = await settleSettings({ snapshot: () => Promise.reject(new Error('down')), direct: async () => direct(2_000n), nowSec });
    expect(out.source).toBe('chain');
    if (out.source !== 'chain') throw new Error('unreachable');
    expect(out.why).toBe('unreachable');
    expect(out.indexError?.message).toBe('down');
    expect(out.values).toEqual({ treasuryFeeBps: '300' });
    expect(out.block).toBe(2_000);
  });
  it('reads the chain past a snapshot marked behind, and needs it to reach the change', async () => {
    const behind = snap({ stale: true, updatedAt: 0, staleAtBlock: 1_500 });
    const ok = await settleSettings({ snapshot: async () => behind, direct: async () => direct(1_500n), nowSec });
    expect(ok).toMatchObject({ source: 'chain', why: 'behind', block: 1_500 });
    const short = await settleSettings({ snapshot: async () => behind, direct: async () => direct(1_499n), nowSec });
    expect(short).toMatchObject({ source: 'unknown', why: 'behind', failure: { kind: 'behind', directBlock: 1_499, snapshotBlock: 1_500 } });
  });
  it('counts a chain answer older than an old snapshot as failed', async () => {
    const old = snap({ updatedAt: NOW - SNAPSHOT_MAX_AGE_SEC - 5 });
    const out = await settleSettings({ snapshot: async () => old, direct: async () => direct(999n), nowSec });
    expect(out).toMatchObject({ source: 'unknown', why: 'old', failure: { kind: 'behind', directBlock: 999, snapshotBlock: 1_000 } });
  });
  it('is unknown, never unset, when the chain read fails too', async () => {
    const out = await settleSettings({ snapshot: async () => ({ available: false }), direct: () => Promise.reject(new Error('rpc down')), nowSec });
    expect(out).toEqual({ source: 'unknown', why: 'none', indexError: null, failure: { kind: 'read', reason: 'rpc down' } });
  });
  it('passes on the direct read’s bundle issue', async () => {
    const out = await settleSettings({
      snapshot: async () => snap({ values: null }),
      direct: async () => direct(2_000n, { bundleIssue: { kind: 'codeChanged' } }),
      nowSec,
    });
    expect(out).toMatchObject({ source: 'chain', why: 'unlabelled', bundleIssue: { kind: 'codeChanged' } });
  });
});
