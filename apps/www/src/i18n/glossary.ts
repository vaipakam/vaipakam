/**
 * www's locale registry — thin layer over the shared @vaipakam/i18n
 * core (the glossary, SUPPORTED_LOCALES universe, and types moved
 * there when alpha02 became the third surface needing them; see
 * packages/i18n/README.md).
 *
 * Only `TRANSLATED_LOCALES` is genuinely www-owned: which subset of
 * the shared locale universe ships an actual translation bundle in
 * THIS app. It drives hreflang / sitemap / per-locale SEO shells —
 * those must advertise ONLY pages that exist as localised content.
 * Listing a placeholder locale in hreflang would be misleading to
 * search engines because the actual rendered text is English.
 *
 * NOTE for scripts: `scripts/generate-sitemap.mjs` duplicates this
 * list as a plain array (Node .mjs can't import TS at sitemap-gen
 * time). When you promote a locale here, update the script's LOCALES
 * too.
 */

export {
  GLOSSARY_KEEP_VERBATIM,
  GLOSSARY_STYLE_NOTES,
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  type SupportedLocale,
  type LocaleCode,
} from '@vaipakam/i18n/glossary';

/** Subset of SUPPORTED_LOCALES that ships a translation bundle in
 *  apps/www. Promotion recipe: docs/DesignsAndPlans/I18nPlan.md. */
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
