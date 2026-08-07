/**
 * apps/defi's view of the translation glossary and locale registry.
 *
 * The terms, the style notes and the locale universe are NOT defined
 * here — they are re-exported from `@vaipakam/i18n/glossary`, which is
 * the single definition every surface shares. This file existed as a
 * full copy from before the hoist, and the copy had already started to
 * rot in both directions: it still protected `VPFIBuyAdapter` /
 * `VPFIBuyReceiver`, names the #687-A excision removed from the tree,
 * while missing `CONFIRM` — the typed-confirmation literal
 * `VaultRecover.tsx` compares the user's input against, whose loss
 * renders a gate nobody speaking that language can pass. Two glossaries
 * where only one of them learns (#1582).
 *
 * The import path stays `./glossary` so the eleven consumers across
 * components, pages and build scripts are unaffected.
 */
export {
  GLOSSARY_KEEP_VERBATIM,
  GLOSSARY_STYLE_NOTES,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
} from '@vaipakam/i18n/glossary';
export type { LocaleCode, SupportedLocale } from '@vaipakam/i18n/glossary';

/** Subset of SUPPORTED_LOCALES that ships a translation bundle. Drives
 *  hreflang / sitemap / per-locale SEO shells — those should advertise
 *  ONLY pages that exist as localised content. Listing a placeholder
 *  locale in hreflang would be misleading to search engines because
 *  the actual rendered text is English.
 *
 *  Deliberately app-owned rather than shared: which subset of the
 *  common locale universe actually ships differs per surface, and the
 *  shared registry says so explicitly. */
export const TRANSLATED_LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'ja',
  'zh',
  'hi',
  'ar',
  'ta',
  'ko',
] as const;

export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];
