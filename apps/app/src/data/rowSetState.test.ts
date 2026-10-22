/** #2536 — how much of the wallet's current set a position list is.
 *  The producing hook decides it per leg (Codex #2663 r2); these pin the
 *  read-through and the combination rule. */
import { describe, expect, it } from 'vitest';
import { rowSetState, weakestRowSetState } from './hooks';

describe('rowSetState', () => {
  it('reads the state the producing hook decided, not the collapsed flags', () => {
    // Legacy deploy: chain created leg + held endpoint answered, created
    // endpoint failed -> indexerOk false, yet nothing is missing past lag.
    expect(
      rowSetState({ rows: [], chainOk: false, indexerOk: false, rowSet: 'lagging' }),
    ).toBe('lagging');
    expect(rowSetState({ rows: [], chainOk: true, indexerOk: false, rowSet: 'complete' })).toBe(
      'complete',
    );
    expect(rowSetState({ rows: [], chainOk: false, indexerOk: false, rowSet: 'partial' })).toBe(
      'partial',
    );
  });
});

describe('weakestRowSetState', () => {
  it('takes the weaker of the lists', () => {
    expect(weakestRowSetState('complete', 'complete')).toBe('complete');
    expect(weakestRowSetState('complete', 'lagging')).toBe('lagging');
    expect(weakestRowSetState('lagging', 'partial')).toBe('partial');
  });
});
