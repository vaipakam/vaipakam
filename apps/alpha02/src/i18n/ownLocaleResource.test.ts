/**
 * The distinction this guards is invisible at the call site: a
 * translated string and an English fallback are both just strings. A
 * regression here doesn't throw and doesn't render a raw key — it
 * renders English under a label promising the reader's own language,
 * on the page where they sign an attestation that they understood it.
 */
import { describe, expect, it } from 'vitest';
import type { i18n as I18nInstance } from 'i18next';

import { ownLocaleResource } from './ownLocaleResource';

const KEY = 'copy.recover.ackTextTranslation';

/** Minimal stand-in for the two i18next surfaces the helper touches. */
function fakeI18n(
  language: string,
  resources: Record<string, Record<string, unknown>> = {},
): I18nInstance {
  return {
    language,
    getResource: (lng: string, ns: string, key: string) =>
      ns === 'translation' ? resources[lng]?.[key] : undefined,
  } as unknown as I18nInstance;
}

describe('ownLocaleResource', () => {
  it('returns the translation when the active locale really carries it', () => {
    const i18n = fakeI18n('ta', { ta: { [KEY]: 'தமிழ் உரை' } });
    expect(ownLocaleResource(i18n, KEY)).toBe('தமிழ் உரை');
  });

  it('accepts a region tag, matching the base bundle', () => {
    const i18n = fakeI18n('es-MX', { es: { [KEY]: 'texto' } });
    expect(ownLocaleResource(i18n, KEY)).toBe('texto');
  });

  // The whole point: `copy.*` would hand back English here, and the
  // caller could not tell.
  it('returns null for a supported locale with no bundle registered', () => {
    // `pt` is routable via SUPPORTED_LOCALES but alpha02 ships no
    // translation for it.
    const i18n = fakeI18n('pt', { ta: { [KEY]: 'தமிழ் உரை' } });
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });

  it('returns null when a translated locale is active but its chunk failed to load', () => {
    // Bundle absent from the store — createI18n logs the loader failure
    // and leaves i18next falling back to English.
    const i18n = fakeI18n('ta', {});
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });

  it('returns null when the bundle loaded but lacks this key', () => {
    const i18n = fakeI18n('ta', { ta: { 'copy.recover.title': 'தலைப்பு' } });
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });

  it('treats an empty or whitespace-only value as unusable', () => {
    // i18next renders these blank rather than falling back, so they are
    // worse than missing.
    expect(ownLocaleResource(fakeI18n('ta', { ta: { [KEY]: '' } }), KEY)).toBeNull();
    expect(
      ownLocaleResource(fakeI18n('ta', { ta: { [KEY]: '   ' } }), KEY),
    ).toBeNull();
  });

  it('returns null for a non-string leaf', () => {
    const i18n = fakeI18n('ta', { ta: { [KEY]: { nested: 'oops' } } });
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });

  it('returns null when English is active — there is nothing to gloss', () => {
    const i18n = fakeI18n('en', { en: { [KEY]: 'english' } });
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });

  it('returns null for an unrecognised tag rather than probing it', () => {
    // normalizeToSupportedLocale maps anything unknown to 'en'.
    const i18n = fakeI18n('xx', { xx: { [KEY]: 'never rendered' } });
    expect(ownLocaleResource(i18n, KEY)).toBeNull();
  });
});
