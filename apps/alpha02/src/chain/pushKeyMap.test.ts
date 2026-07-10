/**
 * #1131 slice A — the push KEY_MAP's desk registrations, pinned.
 *
 * Why a unit test and not a fork e2e: the CI-Anvil harness runs the
 * indexer STUB (plain HTTP, no WebSocket rail — the same no-WS posture
 * spec 15 asserts for the chain side), so an invalidate frame can never
 * be delivered on the fork tier. This test pins the frame→root mapping
 * table itself; the live half — observing a real push invalidation
 * refresh the desk — rides the production WS rail post-deploy (see the
 * phase-3 row in e2e/COVERAGE.md).
 *
 * The EXACT arrays are pinned (not just membership): a root silently
 * dropped from a frame would otherwise still pass a contains-check
 * elsewhere, and a root silently ADDED to the wrong frame burns
 * needless refetches on every ingest write.
 */
import { describe, expect, it } from 'vitest';
import { KEY_MAP } from './IndexerPushSync';

describe('IndexerPushSync KEY_MAP (#1131 desk roots)', () => {
  it('pins the full frame→root table', () => {
    expect(KEY_MAP).toEqual({
      'offer.created': [
        'activeOffers',
        'myOffers',
        'offer',
        'deskMarkets',
        'deskBook',
        'deskAmendSource',
      ],
      'offer.changed': [
        'activeOffers',
        'myOffers',
        'offer',
        'deskMarkets',
        'deskBook',
        'deskAmendSource',
      ],
      'loan.created': [
        'myLoans',
        'loan',
        'deskTape',
        'deskCandles',
        'deskHistory',
        'deskMarkets',
      ],
      'loan.updated': ['myLoans', 'loan', 'claimables', 'deskHistory'],
      'activity.appended': ['activity'],
    });
  });

  it('offer frames carry the offer-fed desk views (book, markets, amend seed)', () => {
    for (const key of ['offer.created', 'offer.changed']) {
      expect(KEY_MAP[key]).toEqual(
        expect.arrayContaining(['deskBook', 'deskMarkets', 'deskAmendSource']),
      );
    }
  });

  it('a fill (loan.created) dirties tape, candles, history and markets — book rides the same scan’s offer.changed', () => {
    expect(KEY_MAP['loan.created']).toEqual(
      expect.arrayContaining(['deskTape', 'deskCandles', 'deskHistory', 'deskMarkets']),
    );
    // The accept consumes offer principal, which the ingest scan
    // reports as offer.changed in the SAME frame — deskBook must not
    // be duplicated onto loan.created (double refetch per fill).
    expect(KEY_MAP['loan.created']).not.toContain('deskBook');
  });

  it('loan status transitions restate history rows', () => {
    expect(KEY_MAP['loan.updated']).toContain('deskHistory');
  });

  it('never maps immutable or chain-read caches', () => {
    const allRoots = Object.values(KEY_MAP).flat();
    // Token metadata is immutable — invalidating it is pure waste.
    expect(allRoots).not.toContain('deskSymbols');
    // The signed book is indexer-fed but NOT chain-ingest-fed: a
    // gasless post never touches the chain, so no DO frame can carry
    // it; its freshness contract is the 15s cache + the fill path's
    // targeted invalidations. Deliberate absence — pinned so a future
    // addition is a conscious decision, not drift.
    expect(allRoots).not.toContain('deskSignedBook');
    // previewMatch / chain-now anchors are LiveChainSync territory.
    expect(allRoots).not.toContain('deskPreviewMatch');
  });
});
