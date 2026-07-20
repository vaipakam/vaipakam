import { describe, it, expect } from 'vitest';
import {
  decodeContractError,
  friendlyContractError,
  contractErrorCatalog,
  GAS_ESTIMATE_UNAVAILABLE_KEY,
} from './decodeContractError.js';

// A curated selector from the friendly table (kept in sync with the source).
const SEL_HF_TOO_LOW = '0x62e82dca';

describe('decodeContractError — translate hook', () => {
  it('returns English unchanged when no translator is passed (default)', () => {
    expect(decodeContractError({ data: SEL_HF_TOO_LOW })).toMatch(/Health factor too low/i);
  });

  it('still accepts a bare string fallback (back-compat)', () => {
    expect(decodeContractError({}, 'custom default')).toBe('custom default');
    expect(decodeContractError({})).toBe('Transaction failed');
    // The options form carries the same fallback semantics.
    expect(decodeContractError({}, { fallback: 'opts default' })).toBe('opts default');
  });

  it('routes curated selector copy through the translator with a stable key', () => {
    const seen: Array<[string, string]> = [];
    const out = decodeContractError(
      { data: SEL_HF_TOO_LOW },
      {
        translate: (key, english) => {
          seen.push([key, english]);
          return `LOCALE:${key}`;
        },
      },
    );
    expect(seen).toHaveLength(1);
    const [key, english] = seen[0];
    expect(key).toBeTruthy();
    expect(english).toMatch(/Health factor too low/i);
    // The localizer's return value is what surfaces to the caller.
    expect(out).toBe(`LOCALE:${key}`);
    // The key the decoder emits is exactly what the catalog exposes — so a
    // locale bundle keyed the same way lands.
    expect(contractErrorCatalog()[key]).toBe(english);
  });

  it('keys a name-decoded revert by the Solidity error name', () => {
    const out = decodeContractError(
      { revert: { name: 'MaxLendingAboveCeiling' } },
      { translate: (key) => `L:${key}` },
    );
    expect(out).toBe('L:MaxLendingAboveCeiling');
  });

  it('localizes the #780 gas-estimate rewrite under a stable key', () => {
    const out = decodeContractError(
      { message: 'exceeds max transaction gas limit' },
      {
        translate: (key, english) =>
          key === GAS_ESTIMATE_UNAVAILABLE_KEY ? 'GAS_LOCALE' : english,
      },
    );
    expect(out).toBe('GAS_LOCALE');
  });

  it('localizes the pre-sign friendly path via friendlyContractError(translate)', () => {
    // English by default (no translator).
    expect(friendlyContractError({ name: 'MaxLendingAboveCeiling' })).toMatch(
      /collateral is too low/i,
    );
    // With a translator: routed by the same stable key (the error name).
    expect(
      friendlyContractError({ name: 'MaxLendingAboveCeiling' }, (key) => `L:${key}`),
    ).toBe('L:MaxLendingAboveCeiling');
    // A humanized fallback for a known-but-uncurated name is localizable too.
    expect(friendlyContractError({ name: 'SaleListingActive' }, (key) => `L:${key}`)).toBe(
      'L:SaleListingActive',
    );
  });

  it('does NOT invoke the translator for a generic base revert (no curated copy)', () => {
    let called = false;
    const out = decodeContractError(
      { reason: 'Deadline exceeded' },
      {
        translate: () => {
          called = true;
          return 'X';
        },
      },
    );
    expect(called).toBe(false);
    expect(out).toBe('Deadline exceeded');
  });
});

describe('contractErrorCatalog', () => {
  it('exposes curated copy by stable key, including the gas-estimate key', () => {
    const cat = contractErrorCatalog();
    expect(cat.MaxLendingAboveCeiling).toMatch(/collateral is too low/i);
    expect(cat[GAS_ESTIMATE_UNAVAILABLE_KEY]).toMatch(/could not estimate/i);
    // Curated (selector + name) plus a humanized fallback for every known
    // selector name, so translators see every key the decoder can emit.
    expect(Object.keys(cat).length).toBeGreaterThan(150);
  });

  it('seeds humanized fallbacks for known-but-uncurated selector names', () => {
    const cat = contractErrorCatalog();
    // Reachable errors with no curated copy still appear (as their humanized
    // sentence) so a locale bundle can translate them (Codex #1367 r1).
    expect(cat.SaleListingActive).toBe('Sale listing active');
    expect(cat.InvalidAsset).toBe('Invalid asset');
    // Curated copy still wins over the humanized fallback for the same name.
    expect(cat.MaxLendingAboveCeiling).toMatch(/collateral is too low/i);
    expect(cat.MaxLendingAboveCeiling).not.toBe('Max lending above ceiling');
  });

  it("catalog value for a key equals what the decoder returns for that error", () => {
    const cat = contractErrorCatalog();
    expect(decodeContractError({ revert: { name: 'MaxLendingAboveCeiling' } })).toBe(
      cat.MaxLendingAboveCeiling,
    );
  });
});
