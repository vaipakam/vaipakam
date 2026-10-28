import { describe, expect, it } from 'vitest';
import { DEFAULT_NUMERAIRE, numeraireOf } from './numeraire';

describe('numeraireOf', () => {
  it('reads the empty word as the USD default, and says it is the default', () => {
    expect(numeraireOf(`0x${'0'.repeat(64)}`)).toEqual({ symbol: DEFAULT_NUMERAIRE, isDefault: true });
  });

  it('decodes a packed symbol, upper-cased', () => {
    expect(numeraireOf(`0x657572${'0'.repeat(58)}`)).toEqual({ symbol: 'EUR', isDefault: false });
  });

  it('names nothing it cannot read', () => {
    expect(numeraireOf('0x1234')).toBeNull();
    expect(numeraireOf(`0x01${'0'.repeat(62)}`)).toBeNull();
  });
});
