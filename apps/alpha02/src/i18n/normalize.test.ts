/**
 * Pins the regression class the fork-tier spec 23 caught on PR #1309:
 * document language / picker selection / remount keys must derive
 * from the ACTIVE language, normalised — never from i18next's
 * `resolvedLanguage`, which falls back to 'en' for any locale whose
 * bundle is empty (all placeholder locales) or still in flight.
 */

import { describe, expect, it } from 'vitest';
import { normalizeToSupportedLocale } from '@vaipakam/i18n/createI18n';

describe('normalizeToSupportedLocale', () => {
  it('passes supported base codes through', () => {
    expect(normalizeToSupportedLocale('es')).toBe('es');
    expect(normalizeToSupportedLocale('ta')).toBe('ta');
  });

  it('normalises regioned tags to their supported base', () => {
    expect(normalizeToSupportedLocale('es-MX')).toBe('es');
    expect(normalizeToSupportedLocale('zh-Hant')).toBe('zh');
    expect(normalizeToSupportedLocale('PT-BR')).toBe('pt');
  });

  it('falls back to en for unknown or missing tags', () => {
    expect(normalizeToSupportedLocale('xx')).toBe('en');
    expect(normalizeToSupportedLocale('')).toBe('en');
    expect(normalizeToSupportedLocale(undefined)).toBe('en');
  });
});
