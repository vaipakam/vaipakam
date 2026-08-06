/**
 * "Is this string ACTUALLY in the reader's language?" — the one
 * question `copy.*` cannot answer.
 *
 * Every `copy.*` read resolves through i18next with the English source
 * as `defaultValue` (see reactiveCopy.ts), which is exactly what you
 * want almost everywhere: a missing translation degrades to readable
 * English instead of a raw key. The cost is that the two cases are
 * indistinguishable at the call site — a translated string and an
 * English fallback both arrive as a string.
 *
 * That is fine for content. It is NOT fine for any UI that makes a
 * CLAIM ABOUT the string's language: "in your language", a
 * translated-by note, a per-language disclosure. Those surfaces have
 * to know, and there are two live ways to be wrong:
 *
 *   1. A supported-but-untranslated locale. 34 codes are routable via
 *      SUPPORTED_LOCALES; alpha02 ships translations for 10. Picking
 *      Portuguese is legitimate and renders English everywhere.
 *   2. A translated locale whose lazy chunk failed to load — offline,
 *      a CDN hiccup, a blocked request. createI18n logs and falls back
 *      to English by design.
 *
 * In both, the language CODE says `pt` / `ta` while the text says
 * English. Gate on the resource instead, so what you checked is what
 * you render.
 *
 * First caller: the Recovery page's declaration gloss, where the false
 * claim would land at the moment the user signs an attestation that
 * they read and understood the text (Codex #1563 r9).
 */

import type { i18n as I18nInstance } from 'i18next';
import { normalizeToSupportedLocale } from '@vaipakam/i18n';

/**
 * The value the ACTIVE locale's OWN bundle holds for `key`, or null
 * when it holds nothing usable — English active, no bundle registered,
 * key absent, or an empty string (which i18next renders blank rather
 * than falling back, so it is unusable rather than merely untranslated).
 *
 * Never consults the English fallback chain — that omission is the
 * whole point of the function.
 *
 * Reads the ACTIVE language rather than `resolvedLanguage`, per
 * normalizeToSupportedLocale's contract: resolution reports 'en' for
 * any bundle still in flight, which would suppress a translation that
 * is about to render. Components calling this from `useTranslation()`
 * re-render on the store's `added` event, so a bundle landing late
 * flips the answer on its own.
 *
 * `key` is the full i18next path including the `copy.` prefix the
 * reactive-copy proxy applies — e.g. `copy.recover.ackTextTranslation`.
 */
export function ownLocaleResource(
  i18n: I18nInstance,
  key: string,
): string | null {
  const active = normalizeToSupportedLocale(i18n.language);
  if (active === 'en') return null;
  const value = i18n.getResource(active, 'translation', key);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
