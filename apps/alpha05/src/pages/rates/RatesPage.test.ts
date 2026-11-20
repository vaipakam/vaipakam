/** #3751 — the Observed rates page states each half apart, labels points by
 *  their range, says "not enough loans yet" for a withheld point, and states
 *  the rule from the index's own answer. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import '../../test/i18n';
import type { SupportedChain } from '../../chain/chains';
import { HelpProvider } from '../../shared/help/HelpContext';
import { parseRateCurve, parseRateHistory, type RateCurve, type RateHistory } from '../../shared/rates/curve';
import { curveAnswer, historyAnswer } from '../../shared/rates/curveFixture';
import { RatesView, type HistoryPick, type ReadState } from './RatesPage';

type Hex = `0x${string}`;
const ASSET = '0x00000000000000000000000000000000000000E1' as Hex;
const chain: SupportedChain = {
  chainId: 31337,
  name: 'Anvil',
  rpcEndpoints: [],
  blockExplorer: 'https://explorer.example',
  testnet: true,
  nativeGasSymbol: 'ETH',
  diamondAddress: '0x00000000000000000000000000000000000000D1',
  deployBlock: 7,
};
const NOW = 1_900_000_000;
const ready = (c: RateCurve): ReadState<RateCurve> => ({ status: 'ready', data: c, reason: null });
const curve = (over: (a: ReturnType<typeof curveAnswer>) => void = () => {}) => {
  const a = curveAnswer(31337, ASSET, NOW - 120);
  over(a);
  return parseRateCurve(a, { chainId: 31337, asset: ASSET });
};

const html = (c: ReadState<RateCurve>, history: HistoryPick | null = null) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        HelpProvider,
        null,
        createElement(RatesView, {
          chain,
          asset: ASSET,
          suggested: [ASSET],
          meta: { [ASSET.toLowerCase()]: { symbol: 'WETH', decimals: 18 } } as never,
          curve: c,
          history,
          nowSec: NOW,
          onPickChain: () => {},
          onPickAsset: () => {},
          onPickTerm: () => {},
          onPickRange: () => {},
          onRetry: () => {},
        }),
      ),
    ),
  );

describe('RatesView', () => {
  it('says reading, a failed read, a busy index and a build with no index, each with no figure', () => {
    expect(html({ status: 'reading', data: null, reason: null })).toContain('Reading the observed rates for WETH on Anvil.');
    expect(html({ status: 'failed', data: null, reason: 'The indexer answered 503 for /rates/curve.' })).toContain('could not be read, so none is shown (The indexer answered 503');
    expect(html({ status: 'failed', data: null, reason: 'The indexer answered 429 for /rates/curve.', busy: true })).toContain('too many requests right now');
    expect(html({ status: 'off', data: null, reason: null })).toContain('This build has no index to read observed rates from');
  });

  it('shows both halves apart, the time computed and the notice', () => {
    const out = html(ready(curve()));
    expect(out).toContain('Computed by the index at');
    expect(out).toContain('2 min ago');
    expect(out).toContain('They are not advice, a forecast or an offer');
    expect(out).toContain('Outside rate source');
    expect(out).toContain('Not available yet. The protocol’s contract view for this average does not exist yet');
    expect(out).toContain('Our own loans');
  });

  it('labels each point by its range and shows the band for a shown one', () => {
    const out = html(ready(curve()));
    expect(out).toContain('Up to 14 days');
    expect(out).toContain('15–60 days');
    expect(out).toContain('Over 270 days');
    expect(out).toContain('5.2%');
    expect(out).toContain('4.8% to 5.75%');
    expect(out).toContain('From 14 loans, 6 lenders and 9 borrowers.');
  });

  it('states the loans left out as unconfirmed beside every figure, zero too', () => {
    const out = html(ready(curve()));
    expect(out).toContain('2 more left out because their agreed terms are not confirmed yet.');
    expect(out).toContain('0 more left out because their agreed terms are not confirmed yet.');
    const silent = html(ready(curve((a) => a.ownLoans.terms.forEach((t: Record<string, unknown>) => delete t.unconfirmedLeftOut))));
    expect(silent).toContain('The index did not say how many loans it left out as unconfirmed.');
    expect(html(ready(curve()))).toContain('every loan, open or closed, whatever its status');
  });

  it('says "not enough loans yet" for a withheld point and why another is withheld', () => {
    const out = html(ready(curve()));
    expect(out).toContain('Not enough loans yet');
    expect(out).toContain('could not read this point’s whole look-back');
  });

  it('states the rule from the index answer, not a copy kept in the app', () => {
    const out = html(ready(curve()));
    expect(out).toContain('How this is computed');
    expect(out).toContain('Largest share one wallet may carry, per side');
    expect(out).toContain('20%');
    expect(out).toContain('Minimum distinct lenders');
    expect(out).toContain('loans whose rate followed a link');
    expect(out).toContain('fallback recoveries, which pay principal, interest and bonus as one sum');
    expect(out).not.toContain('loans still open');
    expect(out).toContain('Over 270 days: loans started in the last 730 days');
    expect(out).toContain('The index marks this rule provisional');
    // A setting the app has no name for is listed under the index's own key.
    const odd = html(ready(curve((a) => ((a.ownLoans.rule as Record<string, unknown>).trimEnds = 'both'))));
    expect(odd).toContain('trimEnds');
  });

  it('says an asset the index has not computed has no figure', () => {
    const out = html(ready(curve((a) => Object.assign(a, { computed: false, day: null, asOf: null }))));
    expect(out).toContain('The index has not computed rates for WETH yet');
  });

  it('lists only the filled history days, a withheld day in words', () => {
    const today = Math.floor(NOW / 86_400);
    const h: RateHistory = parseRateHistory(historyAnswer(31337, ASSET, 30, today), { chainId: 31337, asset: ASSET, days: 30 });
    const out = html(ready(curve()), { days: 30, range: '90d', read: { status: 'ready', data: h, reason: null } });
    expect(out).toContain('a missing day is not a zero');
    expect(out.match(/<tr>/g)?.length).toBe(4); // header + three filled days
    expect(out).toContain('5.12%');
    expect(out).toContain('not published');
  });
});
