/**
 * alpha02 locale configuration — the per-app half of the i18n split
 * (the shared half lives in @vaipakam/i18n; see its README).
 *
 * Three app-owned decisions live here:
 *
 *   1. `TRANSLATED_LOCALES` — which locales actually ship translated
 *      content in THIS app. Drives SEO surfaces (hreflang, sitemap):
 *      a placeholder bundle must never be advertised to crawlers as a
 *      localised page. alpha02 starts English-only; move a code up
 *      when its `locales/<code>.json` is genuinely translated.
 *
 *   2. `LANGUAGE_PICKER_ENABLED` — master switch for the picker UI.
 *
 *   3. Per-locale picker visibility — which codes the Settings
 *      Language card offers. The first translation wave (es, zh, hi,
 *      ja) is visible from day one as "coming soon" (picking one
 *      renders English until its bundle is filled — the operator
 *      intends to fill these immediately); every other placeholder is
 *      hidden until promoted.
 *
 * Promotion recipe (placeholder → translated):
 *   1. Fill `src/i18n/locales/<code>.json` (hand-authored, or
 *      `pnpm --filter @vaipakam/i18n translate -- --locales-dir
 *      apps/alpha02/src/i18n/locales <code>`).
 *   2. Add the code to `TRANSLATED_LOCALES` below.
 *   3. Flip `visible: true` in `PICKER_VISIBLE` below if not already.
 *   Lazy loaders in `i18n/index.ts` already cover every supported
 *   code — no wiring change needed there.
 */

import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@vaipakam/i18n/glossary';
import {
  LOCALE_NATIVE_LABELS,
  type LocaleDisplayConfig,
} from '@vaipakam/i18n/localeDisplay';

/** Locales with genuinely translated bundles in apps/alpha02.
 *  English-only until the first translation wave lands. */
export const TRANSLATED_LOCALES = ['en'] as const;
export type TranslatedLocale = (typeof TRANSLATED_LOCALES)[number];

/** Master switch. When false, the Language card is not rendered at
 *  all; stored preferences keep working. */
export const LANGUAGE_PICKER_ENABLED = true;

/** Codes offered in the Settings Language card today: English plus
 *  the first translation wave (es, zh, hi, ja — the major-market
 *  set chosen for wave 1). */
const PICKER_VISIBLE: ReadonlySet<SupportedLocale> = new Set([
  'en',
  'es',
  'zh',
  'hi',
  'ja',
]);

/** Per-locale picker config, derived from the shared native-label
 *  map so labels can't drift between apps. Order follows
 *  SUPPORTED_LOCALES (visible entries surface in that order). */
export const LOCALE_DISPLAY_CONFIG: Record<SupportedLocale, LocaleDisplayConfig> =
  Object.fromEntries(
    SUPPORTED_LOCALES.map((code) => [
      code,
      {
        code,
        label: LOCALE_NATIVE_LABELS[code],
        visible: PICKER_VISIBLE.has(code),
      },
    ]),
  ) as Record<SupportedLocale, LocaleDisplayConfig>;

/** Locales currently visible in the Language card. Computed once at
 *  module load so consumers don't re-filter on every render. */
export const VISIBLE_LOCALES: ReadonlyArray<LocaleDisplayConfig> =
  SUPPORTED_LOCALES.map((code) => LOCALE_DISPLAY_CONFIG[code]).filter(
    (entry) => entry.visible,
  );
