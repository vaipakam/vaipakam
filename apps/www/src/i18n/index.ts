/**
 * www i18n bootstrap — a thin wiring of the shared
 * `initVaipakamI18n` factory (packages/i18n/src/createI18n.ts, which
 * is this file's former body, hoisted verbatim when alpha02 became
 * the third surface needing it).
 *
 * What stays here: THIS app's eager English bundle and the explicit
 * lazy-loader map for its translated locales. Listing each loader
 * explicitly (rather than `import.meta.glob`) gives Vite the best
 * static-analysis signal so each JSON splits into its own chunk,
 * fetched only on first use. Adding a new locale = add the JSON in
 * `locales/`, add a loader line here, promote it in `glossary.ts`
 * (TRANSLATED_LOCALES) and `localeConfig.ts` (visibility) — see
 * docs/DesignsAndPlans/I18nPlan.md.
 *
 * Detection chain, cross-subdomain `vaipakam_lang` cookie handling,
 * RTL `<html dir>` sync, and the lazy-load re-render wiring all live
 * in the shared factory — identical on every Vaipakam surface.
 */

import { initVaipakamI18n } from '@vaipakam/i18n/createI18n';

// English — eager. Always available so the fallback chain renders
// readable copy instead of raw keys while a non-English bundle is
// in flight on first paint.
import en from './locales/en.json';

const i18n = initVaipakamI18n({
  en,
  lazyLoaders: {
    es: () => import('./locales/es.json'),
    fr: () => import('./locales/fr.json'),
    de: () => import('./locales/de.json'),
    ja: () => import('./locales/ja.json'),
    zh: () => import('./locales/zh.json'),
    hi: () => import('./locales/hi.json'),
    ar: () => import('./locales/ar.json'),
    ta: () => import('./locales/ta.json'),
    ko: () => import('./locales/ko.json'),
  },
});

export default i18n;
