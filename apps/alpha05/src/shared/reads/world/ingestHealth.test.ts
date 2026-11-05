import { describe, expect, it } from 'vitest';
import { STALE_AFTER_SEC, freshnessOf, withCursor, type IngestHealth } from './ingestHealth';

const DIAMOND = '0x63816B149266C9dBFB7683dfd02D851915238049';
const health = (over: Partial<IngestHealth['chains'][number]> = {}): IngestHealth => ({
  checkedAt: 1_000_000,
  chains: [{ chainId: 84532, lastBlock: 500, scannedAt: 999_940, ageSeconds: 60, deployment: { diamond: DIAMOND }, ...over }],
});
const base = { chainId: 84532, diamond: DIAMOND, elapsedSec: 0, error: null };

describe('freshnessOf', () => {
  it('is unavailable when the index could not be read, naming why', () => {
    expect(freshnessOf({ ...base, health: null, error: 'timed out' })).toEqual({ kind: 'unavailable', reason: 'timed out' });
  });
  it('is fresh with the block and age the index reports, aged by the time since the read', () => {
    expect(freshnessOf({ ...base, health: health(), elapsedSec: 30 })).toEqual({ kind: 'fresh', lastBlock: 500, scannedAt: 999_940, ageSeconds: 90 });
  });
  it('is stale once the cursor has not advanced for half an hour', () => {
    expect(freshnessOf({ ...base, health: health({ ageSeconds: STALE_AFTER_SEC }) }).kind).toBe('stale');
    expect(freshnessOf({ ...base, health: health({ ageSeconds: STALE_AFTER_SEC - 1 }) }).kind).toBe('fresh');
  });
  it('is unknown for a chain the index does not scan or has no cursor for', () => {
    expect(freshnessOf({ ...base, health: health(), chainId: 97 }).kind).toBe('unknown');
    expect(freshnessOf({ ...base, health: health({ lastBlock: null, scannedAt: null, ageSeconds: null }) }).kind).toBe('unknown');
  });
  it('is unknown, never fresh, when the index describes another protocol contract', () => {
    const f = freshnessOf({ ...base, health: health({ deployment: { diamond: '0x' + '1'.repeat(40) } }) });
    expect(f).toEqual({ kind: 'unknown', reason: 'The index describes a different protocol contract than this build.' });
  });
  it('never reports a negative age', () => {
    expect(freshnessOf({ ...base, health: health({ ageSeconds: -30 }) })).toMatchObject({ ageSeconds: 0 });
  });
});

describe('withCursor', () => {
  const fresh = freshnessOf({ ...base, health: health() });
  it('advances the stamp on a newer push cursor', () => {
    expect(withCursor(fresh, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toEqual({ kind: 'fresh', lastBlock: 600, scannedAt: 999_990, ageSeconds: 10 });
  });
  it('ignores an older cursor', () => {
    expect(withCursor(fresh, { lastBlock: 400, updatedAt: 999_000 }, 1_000_000)).toBe(fresh);
  });
  it('lifts an unreachable poll but never an unknown deployment', () => {
    const unavailable = freshnessOf({ ...base, health: null, error: 'x' });
    expect(withCursor(unavailable, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000).kind).toBe('fresh');
    const unknown = freshnessOf({ ...base, health: health({ deployment: { diamond: '0x' + '1'.repeat(40) } }) });
    expect(withCursor(unknown, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toBe(unknown);
  });
});
