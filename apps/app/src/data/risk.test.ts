/** #2531 — the liquidation-price sentence never states a figure it cannot
 *  substantiate, and never a zero. */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { liquidationPriceText, type LoanRisk } from './risk';

const WAD = 10n ** 18n;
const priced = (over: Partial<LoanRisk> = {}): LoanRisk => ({
  priced: true,
  healthFactor: 2n * WAD,
  ltv: 4n * 10n ** 17n,
  liquidationPrice: {
    kind: 'priced',
    perUnitWad: 30_000n * WAD,
    numeraire: { symbol: 'USD', isDefault: true },
  },
  ...over,
});

describe('liquidationPriceText', () => {
  it('states the line, its unit and what it assumes', () => {
    expect(liquidationPriceText(priced(), 'WBTC')).toBe(
      copy.risk.liquidationPriceAt('30,000', 'USD', 'WBTC'),
    );
  });

  it('says the price is already past the line below a health factor of 1.00', () => {
    expect(liquidationPriceText(priced({ healthFactor: WAD - 1n }), 'WBTC')).toBe(
      copy.risk.liquidationPricePassed('30,000', 'USD', 'WBTC'),
    );
  });

  it('rounds the shown price UP, never below the line (100 / 3)', () => {
    // 33.333…334 to nearest would read 33.3333, under the real line.
    const risk = priced({
      healthFactor: 3n * WAD,
      liquidationPrice: {
        kind: 'priced',
        perUnitWad: 33_333_333_333_333_333_334n,
        numeraire: { symbol: 'USD', isDefault: true },
      },
    });
    expect(liquidationPriceText(risk, 'WBTC')).toBe(
      copy.risk.liquidationPriceAt('33.3334', 'USD', 'WBTC'),
    );
  });

  it('names the reference currency generically when its symbol is unread', () => {
    const risk = priced({
      liquidationPrice: { kind: 'priced', perUnitWad: 30_000n * WAD, numeraire: null },
    });
    expect(liquidationPriceText(risk, 'WBTC')).toBe(
      copy.risk.liquidationPriceAt('30,000', copy.risk.liquidationPriceUnitUnknown, 'WBTC'),
    );
  });

  it('gives a reason, not a figure, for every case without one', () => {
    expect(liquidationPriceText({ priced: false, healthFactor: 0n, ltv: 0n }, 'WBTC')).toBe(
      copy.risk.liquidationPriceNotPriced,
    );
    expect(liquidationPriceText(priced({ liquidationPrice: { kind: 'none' } }), 'WBTC')).toBe(
      copy.risk.liquidationPriceNone,
    );
    expect(liquidationPriceText(priced({ liquidationPrice: { kind: 'unknown' } }), 'WBTC')).toBe(
      copy.risk.liquidationPriceUnknown,
    );
    expect(liquidationPriceText(priced({ liquidationPrice: undefined }), undefined)).toBe(
      copy.risk.liquidationPriceTokenUnknown,
    );
    expect(liquidationPriceText(priced(), undefined)).toBe(copy.risk.liquidationPriceTokenUnknown);
  });
});
