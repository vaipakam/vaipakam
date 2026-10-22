/** #2535 — guided matching recommends only screened offers, holds an
 *  offer whose screen has not answered, and never shows the unscreened
 *  tail. */
import { describe, expect, it } from 'vitest';
import type { IndexedOffer } from '../data/indexer';
import { legVerdictKey, type TokenSecurityVerdict } from '../data/tokenSecurity';
import { AssetType } from '../lib/types';
import {
  GUIDED_MATCH_LIMIT,
  MATCH_SCREEN_MAX,
  MATCH_SCREEN_STEP,
  pickGuidedMatches,
} from './guidedMatches';

const CHAIN = 1;
const LENDING = '0x00000000000000000000000000000000000000a1';
/** Each offer gets its own collateral token, so its verdict is its own. */
const collateral = (id: number) => `0x${id.toString(16).padStart(40, '0')}`;

const offer = (id: number): IndexedOffer =>
  ({
    chainId: CHAIN,
    offerId: id,
    assetType: AssetType.ERC20,
    collateralAssetType: AssetType.ERC20,
    lendingAsset: LENDING,
    collateralAsset: collateral(1000 + id),
  }) as unknown as IndexedOffer;

const offers = (n: number) => Array.from({ length: n }, (_, i) => offer(i + 1));

type V = Record<string, TokenSecurityVerdict | undefined>;
/** Verdicts for both legs of each listed offer. */
const verdicts = (entries: [number, TokenSecurityVerdict][]): V => {
  const out: V = {};
  for (const [id, v] of entries) {
    out[legVerdictKey(CHAIN, LENDING)] = { kind: 'clean' };
    out[legVerdictKey(CHAIN, collateral(1000 + id))] = v;
  }
  return out;
};
const clean: TokenSecurityVerdict = { kind: 'clean' };
const block: TokenSecurityVerdict = { kind: 'block', reasons: ['x'] };

describe('pickGuidedMatches', () => {
  it('lists the top offers once every leg is screened clean', () => {
    const c = offers(8);
    const pick = pickGuidedMatches(c, verdicts(c.map((o) => [o.offerId, clean])), MATCH_SCREEN_STEP);
    expect(pick.matches.map((m) => m.offer.offerId)).toEqual([1, 2, 3, 4, 5]);
    expect(pick.matches.every((m) => !m.checking)).toBe(true);
    expect(pick).toMatchObject({ hiddenFlagged: 0, screening: false, deepen: false, unscreenedTail: false });
  });

  it('holds an unanswered offer as "checking" in its place, never as clean', () => {
    const c = offers(6);
    const v = verdicts([[1, clean], [3, clean], [4, clean], [5, clean]]); // 2 unanswered
    const pick = pickGuidedMatches(c, v, MATCH_SCREEN_STEP);
    expect(pick.matches.map((m) => [m.offer.offerId, m.checking])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
      [5, false],
    ]);
    expect(pick.screening).toBe(true);
  });

  it('drops a held offer that turns out flagged, and the next one moves up', () => {
    const c = offers(6);
    const pick = pickGuidedMatches(
      c,
      verdicts([[1, clean], [2, block], [3, clean], [4, clean], [5, clean], [6, clean]]),
      MATCH_SCREEN_STEP,
    );
    expect(pick.matches.map((m) => m.offer.offerId)).toEqual([1, 3, 4, 5, 6]);
    expect(pick.hiddenFlagged).toBe(1);
  });

  it('never lists an offer past the screened depth', () => {
    // The whole screened head is flagged; candidates exist beyond it.
    const c = offers(MATCH_SCREEN_STEP + 10);
    const v = verdicts(c.slice(0, MATCH_SCREEN_STEP).map((o) => [o.offerId, block]));
    const pick = pickGuidedMatches(c, v, MATCH_SCREEN_STEP);
    expect(pick.matches).toEqual([]);
    expect(pick.hiddenFlagged).toBe(MATCH_SCREEN_STEP);
    // ...so the head grows rather than showing the tail unscreened.
    expect(pick).toMatchObject({ deepen: true, screening: true, unscreenedTail: false });
  });

  it('waits for held offers before deepening', () => {
    const c = offers(MATCH_SCREEN_STEP + 10);
    const v = verdicts(c.slice(1, MATCH_SCREEN_STEP).map((o) => [o.offerId, block])); // 1 unanswered
    const pick = pickGuidedMatches(c, v, MATCH_SCREEN_STEP);
    expect(pick.matches.map((m) => m.checking)).toEqual([true]);
    expect(pick.deepen).toBe(false);
    expect(pick.screening).toBe(true);
  });

  it('stops at the bound and says more offers exist', () => {
    const c = offers(MATCH_SCREEN_MAX + 5);
    const v = verdicts(c.slice(0, MATCH_SCREEN_MAX).map((o) => [o.offerId, block]));
    const pick = pickGuidedMatches(c, v, MATCH_SCREEN_MAX);
    expect(pick.matches).toEqual([]);
    expect(pick).toMatchObject({ deepen: false, screening: false, unscreenedTail: true });
  });

  it('a short list with nothing left to screen is final, with no tail note', () => {
    const c = offers(3);
    const pick = pickGuidedMatches(c, verdicts(c.map((o) => [o.offerId, clean])), MATCH_SCREEN_STEP);
    expect(pick.matches).toHaveLength(3);
    expect(pick).toMatchObject({ deepen: false, screening: false, unscreenedTail: false });
    expect(GUIDED_MATCH_LIMIT).toBe(5);
  });
});
