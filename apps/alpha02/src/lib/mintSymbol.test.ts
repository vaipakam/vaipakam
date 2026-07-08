import { describe, it, expect } from 'vitest';
import { resolveMintSymbol } from './mintSymbol';
import { copy } from '../content/copy';

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
    expect(liquid2.title(null)).toBe('Mock USD Coin (test stablecoin)');
    expect(liquid2.action(10_000, null)).toBe('Mint 10,000 test stablecoin');
    // Never advertises the specific "mUSDC" ticker while unresolved.
    expect(liquid2.title(null)).not.toContain('mUSDC');
    expect(liquid2.action(10_000, null)).not.toContain('mUSDC');
  });

  // End-to-end at the pure-logic level: a live read of a non-mUSDC symbol
  // produces a non-mUSDC button label — the regression #1111 guards against.
  it('a non-mUSDC live read yields a non-mUSDC button label', () => {
    const sym = resolveMintSymbol('tLQ2');
    expect(liquid2.action(10_000, sym)).toBe('Mint 10,000 tLQ2');
    expect(liquid2.action(10_000, sym)).not.toContain('mUSDC');
  });
});
