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
    // RPC read-diet PR 0 — a data-only entitlement mutation (partial
    // repay/match, the FallbackPending partial-rescue class, collateral
    // top-up, extension, periodic-interest advance) rides loan.updated:
    // previously a scan with ONLY these events broadcast nothing beyond
    // activity.appended, which is exactly the design §1.5 audit gap.
    expect(
      invalidationKeysFromResult(result({ loanEntitlementUpdates: 1 })),
    ).toEqual(['loan.updated']);
    // RPC read-diet PR 0 — a position-NFT ownership re-point gets its own
    // key (holder-keyed views: own positions / claimables / detail owner).
    expect(invalidationKeysFromResult(result({ ownershipTransfers: 1 }))).toEqual([
      'ownership.changed',
    ]);
  });

  it('treats absent optional counts as zero (older result shapes)', () => {
    // The two PR 0 counts are optional on ChainIndexerResult so the early
    // return paths stay untouched — absence must read as "no key", not a
    // crash or a spurious push.
    expect(invalidationKeysFromResult(result())).toEqual([]);
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
        loanEntitlementUpdates: 2,
        ownershipTransfers: 1,
        activityEvents: 9,
      }),
    );
    expect(keys).toEqual([
      'offer.created',
      'offer.changed',
      'loan.created',
      'loan.updated',
      'ownership.changed',
      'activity.appended',
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
