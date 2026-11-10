import { describe, expect, it } from 'vitest';
import { equivalentText } from './numeraireValue';

/** Returns the key and its variables, so a test reads what was chosen. */
const copy = {
  text: (k: string) => k,
  format: (k: string, v: Record<string, string>) => `${k} ${JSON.stringify(v)}`,
} as unknown as Parameters<typeof equivalentText>[3];

describe('equivalentText', () => {
  it('states a liquid amount in the numeraire, cut to cents, and a sub-cent one as under a cent', () => {
    expect(equivalentText({ kind: 'value', value: 1234_567n * 10n ** 15n }, 'USD', 'WETH', copy)).toBe('numeraire.value {"value":"1,234.56","unit":"USD"}');
    expect(equivalentText({ kind: 'value', value: 10n ** 15n }, 'USD', 'WETH', copy)).toBe('numeraire.tiny {"unit":"USD"}');
    expect(equivalentText({ kind: 'value', value: 0n }, 'USD', 'WETH', copy)).toBe('numeraire.value {"value":"0.00","unit":"USD"}');
  });
  it('names a neutral unit when the symbol is unset or unread', () => {
    expect(equivalentText({ kind: 'value', value: 10n ** 18n }, null, 'WETH', copy)).toBe('numeraire.value {"value":"1.00","unit":"home.exposureUnit"}');
  });
  it('says no price for an asset the protocol values at nothing, and why none for a disputed price', () => {
    expect(equivalentText({ kind: 'unpriced' }, 'USD', 'tILQ', copy)).toBe('numeraire.unpriced {"asset":"tILQ"}');
    expect(equivalentText({ kind: 'distrusted' }, 'USD', 'WETH', copy)).toBe('numeraire.distrusted {"asset":"WETH"}');
  });
});
