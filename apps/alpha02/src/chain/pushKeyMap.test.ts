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
        'deskSignedBook',
      ],
      'loan.created': [
        'myLoans',
        'loan',
        'deskTape',
        'deskCandles',
        'deskHistory',
        'deskMarkets',
      ],
      // RPC read-diet PR 0 — 'vaultAssets' rides loan.updated (settlement /
      // periodic-interest events are the event class that moves escrow into
      // a party's vault; design §4.1.2), and loan.updated now also fires on
      // data-only entitlement changes (partial repay/match/rescue,
      // collateral top-up, extension).
      'loan.updated': [
        'myLoans',
        'loan',
        'claimables',
        'deskHistory',
        'vaultAssets',
      ],
      // RPC read-diet PR 0 (design §4.0.1) — a position NFT changed hands.
      // Holder-keyed roots must learn ownership flips from the push rail:
      // PR A removes the per-block blanket that currently masks this key's
      // absence, and the design's §7(c) live check observes this frame
      // before that demotion ships. positionOwners is nominally a
      // chain-read cache (LiveChainSync territory), but ownership.changed
      // fires only on actual transfers — rare — so the overlap with the
      // per-block nudge is negligible and deliberate.
      'ownership.changed': [
        'myLoans',
        'myOffers',
        'claimables',
        'positionOwners',
        'loan',
        'offer',
      ],
      'activity.appended': ['activity'],
    });
  });

  it('ownership flips dirty every holder-keyed root (RPC read-diet PR 0)', () => {
    expect(KEY_MAP['ownership.changed']).toEqual(
      expect.arrayContaining([
        'myLoans',
        'myOffers',
        'claimables',
        'positionOwners',
      ]),
    );
  });

  it('loan.updated carries vaultAssets (settlement escrow → vault; RPC read-diet PR 0)', () => {
    expect(KEY_MAP['loan.updated']).toContain('vaultAssets');
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
    // The signed book rides offer.changed ONLY (Codex #1145 r8 P3):
    // on-chain lifecycle flips (fill / cancel / nonce burn) flow
    // through the ingest scan's signedOfferUpdates count, but gasless
    // POSTS never touch the chain — offer.created is a chain-offer
    // signal and must not drag the signed book with it.
    expect(KEY_MAP['offer.changed']).toContain('deskSignedBook');
    expect(KEY_MAP['offer.created']).not.toContain('deskSignedBook');
    expect(KEY_MAP['loan.created']).not.toContain('deskSignedBook');
    // previewMatch / chain-now anchors are LiveChainSync territory —
    // 'deskPreviewMatch' is registered in its LIVE_KEYS (#1145 round-5),
    // not here (double-invalidating a chain read from push frames would
    // just burn RPC).
    expect(allRoots).not.toContain('deskPreviewMatch');
  });
});
