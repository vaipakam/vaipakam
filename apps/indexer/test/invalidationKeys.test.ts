/**
 * #757 Phase B — the scan-result → push-invalidation-key mapping.
 * `invalidationKeysFromResult` is the contract between a completed
 * ingest pass and every connected client's refetch behaviour: a
 * missing key means a UI that silently stays stale after its data
 * changed, an extra key means refetch storms. Pinned here per count
 * field so a rename/reshuffle in ChainIndexerResult can't silently
 * detach a surface from its push.
 */
import { describe, expect, it } from 'vitest';
import { invalidationKeysFromResult } from '../src/chainIngestDO';
import type { ChainIndexerResult } from '../src/chainIndexer';

function result(overrides: Partial<ChainIndexerResult> = {}): ChainIndexerResult {
  return {
    scannedFrom: 0n,
    scannedTo: 0n,
    newOffers: 0,
    statusUpdates: 0,
    detailRefreshes: 0,
    newLoans: 0,
    loanStatusUpdates: 0,
    loanDetailRefreshes: 0,
    activityEvents: 0,
    ...overrides,
  };
}

describe('invalidationKeysFromResult', () => {
  it('maps a no-op scan to zero keys (no refetch storm on idle ticks)', () => {
    expect(invalidationKeysFromResult(result())).toEqual([]);
  });

  it('maps each count to its slice', () => {
    expect(invalidationKeysFromResult(result({ newOffers: 1 }))).toEqual([
      'offer.created',
    ]);
    expect(invalidationKeysFromResult(result({ statusUpdates: 2 }))).toEqual([
      'offer.changed',
    ]);
    expect(invalidationKeysFromResult(result({ detailRefreshes: 1 }))).toEqual([
      'offer.changed',
    ]);
    expect(invalidationKeysFromResult(result({ newLoans: 1 }))).toEqual([
      'loan.created',
    ]);
    expect(invalidationKeysFromResult(result({ loanStatusUpdates: 1 }))).toEqual([
      'loan.updated',
    ]);
    // A heal-only pass (stub loan rows healed to canonical metadata)
    // must still push — clients would otherwise sit on incomplete
    // loan data until a slow poll.
    expect(invalidationKeysFromResult(result({ loanDetailRefreshes: 1 }))).toEqual([
      'loan.updated',
    ]);
    expect(invalidationKeysFromResult(result({ activityEvents: 3 }))).toEqual([
      'activity.appended',
    ]);
  });

  it('emits each key at most once for a busy scan', () => {
    const keys = invalidationKeysFromResult(
      result({
        newOffers: 4,
        statusUpdates: 2,
        detailRefreshes: 1,
        newLoans: 2,
        loanStatusUpdates: 1,
        loanDetailRefreshes: 3,
        activityEvents: 9,
      }),
    );
    expect(keys).toEqual([
      'offer.created',
      'offer.changed',
      'loan.created',
      'loan.updated',
      'activity.appended',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
