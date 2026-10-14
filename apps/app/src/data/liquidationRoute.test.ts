import { describe, expect, it } from 'vitest';
import { parseLiquidationRoute } from './liquidationRoute';

const EXPECT = { chainId: 84532, loanId: '21' };
const ok = {
  chainId: 84532,
  loanId: '21',
  sellToken: '0xb8c6509BAAF63f9BE8Da35b9069A0BcB82522bA2',
  buyToken: '0x5C4d10FFf67e968D785e154c91Cb8987ea6B194e',
  sellAmount: '1000000000000000000',
  calls: [{ adapterIdx: '0', data: '0x' }],
  ranked: [{ kind: 'testnetMock', expectedOutput: '2970000000000000000000' }],
  failed: [],
};

describe('parseLiquidationRoute (#2463)', () => {
  it('reads a route into bigint calls and the amount it sells', () => {
    expect(parseLiquidationRoute(ok, EXPECT)).toEqual({
      kind: 'route',
      route: {
        calls: [{ adapterIdx: 0n, data: '0x' }],
        sellAmount: 10n ** 18n,
        sellToken: ok.sellToken,
        buyToken: ok.buyToken,
      },
    });
  });

  it('an answered empty list is "none", not "unreadable"', () => {
    expect(parseLiquidationRoute({ ...ok, calls: [] }, EXPECT)).toEqual({ kind: 'none' });
  });

  it('refuses an answer for another chain or loan', () => {
    expect(parseLiquidationRoute({ ...ok, chainId: 8453 }, EXPECT)).toEqual({ kind: 'unreadable' });
    expect(parseLiquidationRoute({ ...ok, loanId: '22' }, EXPECT)).toEqual({ kind: 'unreadable' });
  });

  it('refuses any malformed field rather than building a partial route', () => {
    const bad = [
      null,
      'route',
      { ...ok, sellAmount: '1e18' },
      { ...ok, sellAmount: 100 },
      { ...ok, sellToken: '0x12' },
      { ...ok, calls: 'none' },
      { ...ok, calls: [{ adapterIdx: '-1', data: '0x' }] },
      { ...ok, calls: [{ adapterIdx: '0', data: '0xabc' }] },
      { ...ok, calls: [{ adapterIdx: 0, data: '0x' }] },
      { ...ok, calls: [{ adapterIdx: '0', data: '0x' }, null] },
    ];
    for (const b of bad) expect(parseLiquidationRoute(b, EXPECT)).toEqual({ kind: 'unreadable' });
  });
});
