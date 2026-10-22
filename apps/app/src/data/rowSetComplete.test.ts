/** #2536 — a position list is the wallet's whole set only when the chain
 *  leg answered; the indexed fallback can lag. */
import { describe, expect, it } from 'vitest';
import { rowSetComplete } from './hooks';

describe('rowSetComplete', () => {
  it('is complete when the chain leg answered, whatever the indexer did', () => {
    expect(rowSetComplete({ rows: [], chainOk: true, indexerOk: true })).toBe(true);
    expect(rowSetComplete({ rows: [], chainOk: true, indexerOk: false })).toBe(true);
  });
  it('is incomplete when only the indexed fallback answered', () => {
    expect(rowSetComplete({ rows: [], chainOk: false, indexerOk: true })).toBe(false);
  });
});
