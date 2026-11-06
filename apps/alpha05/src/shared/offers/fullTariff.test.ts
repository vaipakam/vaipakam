import { describe, expect, it } from 'vitest';
import { storedTariffFrom, suggestedCeiling, tariffIssues, tariffMatches, type TariffRead } from './fullTariff';

const E = 10n ** 18n;
const read = (over: Partial<TariffRead> = {}): TariffRead => ({
  enabled: true,
  smallest: { cStar: 2n * E, numeraireOk: true },
  largest: { cStar: 5n * E, numeraireOk: true },
  liquid: true,
  freeVpfi: 10n * E,
  ...over,
});
const kinds = (r: TariffRead, maxCStar = 6n * E) => tariffIssues({ maxCStar, allowDowngrade: false }, r).map((i) => i.kind);

describe('tariffIssues', () => {
  it('raises nothing when every condition holds for the largest loan', () => {
    expect(kinds(read())).toEqual([]);
  });
  it('names a switched-off tariff and an unread switch', () => {
    expect(kinds(read({ enabled: false }))).toEqual(['off']);
    expect(kinds(read({ enabled: null }))).toEqual(['unread']);
  });
  it('names an unpriced or illiquid lending asset, and judges no ceiling or vault without a price', () => {
    expect(kinds(read({ largest: { cStar: 0n, numeraireOk: false } }))).toEqual(['unpriced']);
    expect(kinds(read({ liquid: false }))).toEqual(['illiquid']);
  });
  it('tells a ceiling below every loan from one below only the largest', () => {
    expect(kinds(read(), 1n * E)).toEqual(['ceiling-below-all']);
    expect(kinds(read(), 3n * E)).toEqual(['ceiling-below-largest']);
  });
  it('names a vault short of the largest loan, and a vault that could not be read', () => {
    expect(tariffIssues({ maxCStar: 6n * E, allowDowngrade: true }, read({ freeVpfi: 4n * E }))).toEqual([{ kind: 'vault-short', free: 4n * E, needed: 5n * E }]);
    expect(kinds(read({ freeVpfi: null }))).toEqual(['unread']);
  });
  it('says the quotes could not be read instead of judging the ceiling', () => {
    expect(kinds(read({ smallest: null }))).toEqual(['unread']);
  });
});

describe('the stored opt-in', () => {
  it('reads the offer fields and matches only the exact choice', () => {
    const stored = storedTariffFrom({ creatorFull: true, creatorMaxCStar: 5n, creatorAllowFullDowngrade: false });
    expect(tariffMatches(stored, { maxCStar: 5n, allowDowngrade: false })).toBe(true);
    expect(tariffMatches(stored, { maxCStar: 5n, allowDowngrade: true })).toBe(false);
    expect(tariffMatches(storedTariffFrom({}), { maxCStar: 0n, allowDowngrade: false })).toBe(false);
  });
});

describe('suggestedCeiling', () => {
  it("is today's tariff for the largest loan, and none without a priced, non-zero figure", () => {
    expect(suggestedCeiling({ cStar: 5n, numeraireOk: true })).toBe(5n);
    expect(suggestedCeiling({ cStar: 5n, numeraireOk: false })).toBeNull();
    expect(suggestedCeiling({ cStar: 0n, numeraireOk: true })).toBeNull();
    expect(suggestedCeiling(null)).toBeNull();
  });
});
