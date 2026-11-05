import { describe, expect, it } from 'vitest';
import { STALE_AFTER_SEC, freshnessOf, ingestHalt, withCursor, type IngestHealth } from './ingestHealth';

const DIAMOND = '0x63816B149266C9dBFB7683dfd02D851915238049';
const health = (over: Partial<IngestHealth['chains'][number]> = {}, schema: IngestHealth['schema'] = { state: 'current' }): IngestHealth => ({
  checkedAt: 1_000_000,
  schema,
  chains: [{ chainId: 84532, lastBlock: 500, scannedAt: 999_940, ageSeconds: 60, deployment: { diamond: DIAMOND, resetPending: false, adoptedBlind: false }, ...over }],
});
const base = { chainId: 84532, diamond: DIAMOND, elapsedSec: 0, error: null };

describe('freshnessOf', () => {
  it('is unavailable when the index could not be read, naming why', () => {
    expect(freshnessOf({ ...base, health: null, error: 'timed out' })).toEqual({ kind: 'unavailable', reason: 'timed out' });
  });
  it('is fresh with the block and age the index reports, aged by the time since the read', () => {
    expect(freshnessOf({ ...base, health: health(), elapsedSec: 30 })).toEqual({ kind: 'fresh', lastBlock: 500, scannedAt: 999_940, ageSeconds: 90, refreshError: null, halted: null });
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
    const f = freshnessOf({ ...base, health: health({ deployment: { diamond: '0x' + '1'.repeat(40), resetPending: false, adoptedBlind: false } }) });
    expect(f).toEqual({ kind: 'unknown', reason: 'The index describes a different protocol contract than this build.' });
  });
  it('is unknown, never fresh, until the deployment record proves the figures came from this build\'s contract', () => {
    const reason = (deployment: IngestHealth['chains'][number]['deployment']) => {
      const f = freshnessOf({ ...base, health: health({ deployment }) });
      return f.kind === 'unknown' ? f.reason : f.kind;
    };
    // No record: an indexer before its deployment table, or a cursor no pass attributed.
    expect(reason(null)).toBe('The index does not say which protocol contract its figures came from.');
    // Mid-reset: the older contract's rows are being cleared.
    expect(reason({ diamond: DIAMOND, resetPending: true, adoptedBlind: false })).toBe("The index is part-way through clearing an older contract's figures.");
    // Blind adoption: no prior record to compare, so the rows' origin is not known.
    expect(reason({ diamond: DIAMOND, resetPending: false, adoptedBlind: true })).toBe("The index cannot yet confirm its figures all came from this build's protocol contract.");
    // Proven, compared case-insensitively.
    expect(reason({ diamond: DIAMOND.toLowerCase(), resetPending: false, adoptedBlind: false })).toBe('fresh');
  });
  it('is unknown, never fresh, when the scan time is ahead of the indexer\'s clock', () => {
    expect(freshnessOf({ ...base, health: health({ ageSeconds: -30 }) })).toEqual({
      kind: 'unknown',
      reason: "The index's scan time is ahead of its own clock, so its age cannot be told.",
    });
  });
  it('discloses a failed re-read beside the last answer instead of a healthy stamp', () => {
    expect(freshnessOf({ ...base, health: health(), error: 'HTTP 503', elapsedSec: 120 })).toEqual({
      kind: 'fresh',
      lastBlock: 500,
      scannedAt: 999_940,
      ageSeconds: 180,
      refreshError: 'HTTP 503',
      halted: null,
    });
  });
});

describe('ingest halt', () => {
  it('discloses a stopped index at once, keeping its last block and age', () => {
    const f = freshnessOf({ ...base, health: health({}, { state: 'pending', missing: ['0084_x.sql', '0085_y.sql'] }) });
    expect(f).toMatchObject({ kind: 'fresh', lastBlock: 500, halted: 'the index has stopped scanning until its database is updated (2 changes waiting)' });
    expect(freshnessOf({ ...base, health: health({}, { state: 'unknown' }) })).toMatchObject({ halted: 'the index has stopped scanning because it cannot confirm its database is up to date' });
  });
  it('discloses a chain the index keeps rows for but no longer scans', () => {
    const h = { ...health(), configured: { chains: [97] } };
    expect(freshnessOf({ ...base, health: h })).toMatchObject({ kind: 'fresh', halted: 'the index is no longer configured to scan this chain' });
    expect(freshnessOf({ ...base, health: { ...health(), configured: { chains: [84532] } } })).toMatchObject({ halted: null });
  });
  it('treats an answer without a schema status as not proven running', () => {
    expect(ingestHalt(undefined)).not.toBeNull();
    expect(ingestHalt({ state: 'current' })).toBeNull();
  });
  it('keeps the halt when a push cursor advances the stamp', () => {
    const f = freshnessOf({ ...base, health: health({}, { state: 'unknown' }) });
    expect(withCursor(f, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toMatchObject({ lastBlock: 600, halted: expect.any(String) });
  });
});

describe('withCursor', () => {
  const fresh = freshnessOf({ ...base, health: health() });
  it('advances the stamp on a newer push cursor', () => {
    expect(withCursor(fresh, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toEqual({ kind: 'fresh', lastBlock: 600, scannedAt: 999_990, ageSeconds: 10, refreshError: null, halted: null });
  });
  it('ignores a cursor dated ahead of the clock', () => {
    expect(withCursor(fresh, { lastBlock: 600, updatedAt: 1_000_001 }, 1_000_000)).toBe(fresh);
  });
  it('keeps a failed re-read disclosed when a push frame advances the stamp', () => {
    const failed = freshnessOf({ ...base, health: health(), error: 'HTTP 503' });
    expect(withCursor(failed, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toMatchObject({ lastBlock: 600, refreshError: 'HTTP 503' });
  });
  it('ignores an older cursor', () => {
    expect(withCursor(fresh, { lastBlock: 400, updatedAt: 999_000 }, 1_000_000)).toBe(fresh);
  });
  it('never stands in for an unreadable or unattributed answer: a cursor frame names no contract', () => {
    const unavailable = freshnessOf({ ...base, health: null, error: 'HTTP 503' });
    expect(withCursor(unavailable, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toBe(unavailable);
    const unknown = freshnessOf({ ...base, health: health({ deployment: { diamond: '0x' + '1'.repeat(40), resetPending: false, adoptedBlind: false } }) });
    expect(withCursor(unknown, { lastBlock: 600, updatedAt: 999_990 }, 1_000_000)).toBe(unknown);
  });
});
