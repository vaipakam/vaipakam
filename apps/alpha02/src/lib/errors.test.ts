/**
 * The contract-revert copy is owned (in English) by @vaipakam/lib, but must
 * localize on the alpha02 frontend: `submitErrorText` passes lib a `translate`
 * hook that resolves `contractError.<stableKey>` from the active locale bundle,
 * falling back to the lib English when a locale hasn't translated that key.
 * This pins that wiring — the same access-time-resolution contract the copy
 * proxy has (see reactiveCopy.test.ts).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import i18n from 'i18next';
import { submitErrorText } from './errors';

// A revert carrying only the decoded error NAME (no selector bytes) — the
// decoder keys it by the name, which is what the locale bundle mirrors.
const MAX_LENDING_REVERT = { revert: { name: 'MaxLendingAboveCeiling' } };

describe('submitErrorText — localized contract errors', () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: {} } } });
    }
  });

  it('serves the lib English by default (no locale override present)', () => {
    expect(submitErrorText(MAX_LENDING_REVERT)).toMatch(/collateral is too low/i);
  });

  it('lets a locale bundle override the message by its stable key', async () => {
    i18n.addResourceBundle('es', 'translation', {
      contractError: { MaxLendingAboveCeiling: 'Tu garantía es demasiado baja.' },
    });
    await i18n.changeLanguage('es');
    expect(submitErrorText(MAX_LENDING_REVERT)).toBe('Tu garantía es demasiado baja.');

    // A key the locale hasn't translated still falls back to lib English.
    const untranslated = submitErrorText({ revert: { name: 'PartialRepayNotAllowed' } });
    expect(untranslated).toMatch(/allow partial repayment/i);

    await i18n.changeLanguage('en');
    expect(submitErrorText(MAX_LENDING_REVERT)).toMatch(/collateral is too low/i);
  });
});
