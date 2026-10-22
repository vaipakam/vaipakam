/** #2536 — how much of the wallet's current set a position list is:
 *  whole when the chain leg answered, lagging when only the indexed
 *  fallback did, partial when a leg neither source could read. */
import { describe, expect, it } from 'vitest';
import { rowSetState, weakestRowSetState } from './hooks';

describe('rowSetState', () => {
  it('is complete when the chain leg answered, whatever the indexer did', () => {
    expect(rowSetState({ rows: [], chainOk: true, indexerOk: true })).toBe('complete');
    expect(rowSetState({ rows: [], chainOk: true, indexerOk: false })).toBe('complete');
  });
  it('is lagging when only the indexed fallback answered', () => {
    expect(rowSetState({ rows: [], chainOk: false, indexerOk: true })).toBe('lagging');
  });
  it('is partial when a leg answered from neither source (Codex #2663 r1)', () => {
    // A legacy deploy's held-offer leg is indexer-only; with the indexer
    // down too, offers held through a transfer are missing at any age.
    expect(rowSetState({ rows: [], chainOk: false, indexerOk: false })).toBe('partial');
  });
});

describe('weakestRowSetState', () => {
  it('takes the weaker of the lists', () => {
    expect(weakestRowSetState('complete', 'complete')).toBe('complete');
    expect(weakestRowSetState('complete', 'lagging')).toBe('lagging');
    expect(weakestRowSetState('lagging', 'partial')).toBe('partial');
  });
});
