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
const EN = 'In your language, so you can read what it says.';

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
    expect(ownLocaleResource(i18n, KEY, EN)).toBe('தமிழ் உரை');
  });

  it('accepts a region tag, matching the base bundle', () => {
    const i18n = fakeI18n('es-MX', { es: { [KEY]: 'texto' } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBe('texto');
  });

  // The whole point: `copy.*` would hand back English here, and the
  // caller could not tell.
  it('returns null for a supported locale with no bundle registered', () => {
    // `pt` is routable via SUPPORTED_LOCALES but alpha02 ships no
    // translation for it.
    const i18n = fakeI18n('pt', { ta: { [KEY]: 'தமிழ் உரை' } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('returns null when a translated locale is active but its chunk failed to load', () => {
    // Bundle absent from the store — createI18n logs the loader failure
    // and leaves i18next falling back to English.
    const i18n = fakeI18n('ta', {});
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('returns null when the bundle loaded but lacks this key', () => {
    const i18n = fakeI18n('ta', { ta: { 'copy.recover.title': 'தலைப்பு' } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('treats an empty or whitespace-only value as unusable', () => {
    // i18next renders these blank rather than falling back, so they are
    // worse than missing.
    expect(ownLocaleResource(fakeI18n('ta', { ta: { [KEY]: '' } }), KEY, EN)).toBeNull();
    expect(
      ownLocaleResource(fakeI18n('ta', { ta: { [KEY]: '   ' } }), KEY, EN),
    ).toBeNull();
  });

  it('returns null for a non-string leaf', () => {
    const i18n = fakeI18n('ta', { ta: { [KEY]: { nested: 'oops' } } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('returns null when English is active — there is nothing to gloss', () => {
    const i18n = fakeI18n('en', { en: { [KEY]: 'english' } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('returns null for an unrecognised tag rather than probing it', () => {
    // normalizeToSupportedLocale maps anything unknown to 'en'.
    const i18n = fakeI18n('xx', { xx: { [KEY]: 'never rendered' } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  // Presence is not proof of translation — neither ingestion path can
  // reject a source-identical leaf in general, because plenty are
  // legitimately identical (`Vaipakam`, `GTC`, `{{amount}} {{symbol}}`).
  it('returns null when the bundle merely echoes the English back', () => {
    const i18n = fakeI18n('es', { es: { [KEY]: EN } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('ignores surrounding whitespace when comparing against the source', () => {
    const i18n = fakeI18n('es', { es: { [KEY]: `  ${EN}  ` } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBeNull();
  });

  it('keeps a translation that merely starts with the English', () => {
    // Only a whole-value match means "untranslated"; a genuine
    // translation that happens to share a prefix still counts.
    const i18n = fakeI18n('es', { es: { [KEY]: `${EN} Y algo más.` } });
    expect(ownLocaleResource(i18n, KEY, EN)).toBe(`${EN} Y algo más.`);
  });

  // A supplier can echo the source back while a word processor or model
  // output "improves" the punctuation on the way. One curly apostrophe
  // is not a translation.
  it('sees through typographic punctuation in an English echo', () => {
    const src = "the protocol's policy — see the guide...";
    const echo = 'the protocol\u2019s policy \u2014 see the guide\u2026';
    expect(ownLocaleResource(fakeI18n('es', { es: { [KEY]: echo } }), KEY, src)).toBeNull();
  });

  it('sees through non-breaking and exotic spaces in an English echo', () => {
    const src = 'read and understood the guide';
    const echo = 'read\u00A0and \u2009understood\u3000the  guide';
    expect(ownLocaleResource(fakeI18n('es', { es: { [KEY]: echo } }), KEY, src)).toBeNull();
  });

  it('sees through Unicode composition differences', () => {
    // Same word both ways: NFD "e + combining acute" vs NFC "\u00e9".
    const nfd = 'prot\u0065\u0301ge';
    const nfc = 'prot\u00E9ge';
    expect(nfd).not.toBe(nfc); // genuinely different code points
    expect(
      ownLocaleResource(fakeI18n('es', { es: { [KEY]: nfd } }), KEY, nfc),
    ).toBeNull();
  });

  it('still keeps a real translation that uses typographic punctuation', () => {
    // Normalisation must not collapse DIFFERENT texts together.
    const es = 'la pol\u00EDtica del protocolo \u2014 consulta la gu\u00EDa';
    expect(
      ownLocaleResource(fakeI18n('es', { es: { [KEY]: es } }), KEY, "the protocol's policy"),
    ).toBe(es);
  });
});
