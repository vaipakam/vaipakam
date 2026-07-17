/**
 * Pins the reactive-copy contract the module-scope audit rests on
 * (Codex #1309 r5 flagged `const text = copy.desk.x` captures as
 * frozen — they are not, and this test is the proof):
 *
 *   - Capturing an OBJECT BRANCH (`const text = copy.desk.positions`)
 *     at module scope is SAFE: the capture is a cached sub-proxy, and
 *     each string LEAF read on it resolves through i18next at ACCESS
 *     time — so a later language change is reflected on the very next
 *     read through the old reference.
 *   - Capturing a STRING LEAF (`const s = copy.a.b`) at module scope
 *     is the unsafe pattern (freezes the import-time language) — the
 *     Home/OfferFlow/keepers/NftVerifier call sites were converted to
 *     per-render functions for exactly this reason.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import i18n from 'i18next';
import { createTranslatedCopy } from './reactiveCopy';

const source = {
  desk: {
    positions: { title: 'Your positions', empty: 'Nothing here yet' },
  },
} as const;

describe('createTranslatedCopy', () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init({
        lng: 'en',
        fallbackLng: 'en',
        resources: { en: { translation: {} } },
      });
    }
  });

  it('resolves string leaves through i18next at access time, even via a module-scope sub-proxy capture', async () => {
    const copy = createTranslatedCopy(source);
    // "Module-scope" capture of an object branch — the pattern the
    // desk panels use.
    const text = copy.desk.positions;
    expect(text.title).toBe('Your positions'); // English fallback

    // A translation bundle lands and the language switches AFTER the
    // capture…
    i18n.addResourceBundle('es', 'translation', {
      copy: { desk: { positions: { title: 'Tus posiciones' } } },
    });
    await i18n.changeLanguage('es');

    // …and the OLD reference serves the new language on its next
    // read: leaves resolve at access time, not capture time.
    expect(text.title).toBe('Tus posiciones');
    // Missing keys keep falling back to the English source.
    expect(text.empty).toBe('Nothing here yet');

    await i18n.changeLanguage('en');
    expect(text.title).toBe('Your positions');
  });

  it('returns identity-stable cached sub-proxies', () => {
    const copy = createTranslatedCopy(source);
    expect(copy.desk.positions).toBe(copy.desk.positions);
  });
});
