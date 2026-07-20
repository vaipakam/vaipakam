import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import { resolveMintSymbol } from './mintSymbol';
import { copy } from '../content/copy';

// The faucet labels use tmpl `{{units, number}}` formatting, which
// i18next applies only once initialised — init so the label reads with
// its locale-formatted count (else the fallback shows a raw number).
beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: {} } },
      interpolation: { escapeValue: false },
    });
  }
});

/**
 * #1111 — prove the second-liquid faucet label is DYNAMIC, not a hard-coded
 * "mUSDC". The e2e smoke test can't tell the two apart on the Base-Sepolia
 * fork (where the slot's symbol IS "mUSDC"); these pure-logic tests feed a
 * deliberately non-"mUSDC" symbol, which a regression back to a hard-coded
 * label could never reproduce.
 */
describe('resolveMintSymbol (#1111)', () => {
  it('returns a non-empty live symbol verbatim — including non-mUSDC tickers', () => {
    expect(resolveMintSymbol('mUSDC')).toBe('mUSDC');
    // The load-bearing case: a symbol that is NOT the hard-coded fallback must
    // still flow through unchanged.
    expect(resolveMintSymbol('tLQ2')).toBe('tLQ2');
    expect(resolveMintSymbol('zTEST')).toBe('zTEST');
  });

  it('returns null when the read is unresolved / errored / not a usable string', () => {
    expect(resolveMintSymbol(undefined)).toBeNull(); // loading
    expect(resolveMintSymbol(null)).toBeNull();
    expect(resolveMintSymbol('')).toBeNull(); // empty string
    expect(resolveMintSymbol(123)).toBeNull(); // non-string
    expect(resolveMintSymbol({})).toBeNull();
  });
});

describe('liquid2 faucet label composition (#1111)', () => {
  const { liquid2 } = copy.faucet;

  it('labels the row + button from the resolved live symbol', () => {
    // A non-mUSDC symbol proves the label is not hard-coded to "mUSDC".
    expect(liquid2.title('tLQ2')).toBe('Mock USD Coin (tLQ2)');
    expect(liquid2.action(10_000, 'tLQ2')).toBe('Mint 10,000 tLQ2');
    // The happy-path mUSDC case still reads correctly.
    expect(liquid2.title('mUSDC')).toBe('Mock USD Coin (mUSDC)');
    expect(liquid2.action(10_000, 'mUSDC')).toBe('Mint 10,000 mUSDC');
  });

  it('falls back to a GENERIC label when the symbol is unresolved (null)', () => {
    // The caller (Faucet.tsx) picks the generic key when the symbol is
    // null; these are the generic labels it renders.
    expect(liquid2.titleGeneric).toBe('Mock USD Coin (test stablecoin)');
    expect(liquid2.actionGeneric(10_000)).toBe('Mint 10,000 test stablecoin');
    // Never advertises the specific "mUSDC" ticker while unresolved.
    expect(liquid2.titleGeneric).not.toContain('mUSDC');
    expect(liquid2.actionGeneric(10_000)).not.toContain('mUSDC');
  });

  // End-to-end at the pure-logic level: a live read of a non-mUSDC symbol
  // produces a non-mUSDC button label — the regression #1111 guards against.
  it('a non-mUSDC live read yields a non-mUSDC button label', () => {
    const sym = resolveMintSymbol('tLQ2');
    const label = sym ? liquid2.action(10_000, sym) : liquid2.actionGeneric(10_000);
    expect(label).toBe('Mint 10,000 tLQ2');
    expect(label).not.toContain('mUSDC');
  });
});
