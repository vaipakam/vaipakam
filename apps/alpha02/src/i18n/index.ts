/**
 * alpha02 i18n bootstrap — a thin wiring of the shared
 * `initVaipakamI18n` factory (packages/i18n). Imported for its side
 * effect from `main.tsx` BEFORE the app renders.
 *
 * The English resource is deliberately EMPTY: alpha02's English
 * strings live in `src/content/copy.ts` (the single source of truth)
 * and reach i18next as per-key `defaultValue`s via the reactive copy
 * proxy — there is no second English catalog to drift. Locale bundles
 * in `./locales/<code>.json` override per key; every supported code
 * has a bundle file (placeholder `{}` until translated) so the loader
 * map below never needs editing when a translation lands.
 *
 * Each `import('./locales/x.json')` line splits into its own Vite
 * chunk, fetched only when that language is first activated.
 */

import { initVaipakamI18n } from '@vaipakam/i18n/createI18n';
import { TRANSLATED_LOCALES } from './localeConfig';

const i18n = initVaipakamI18n({
  en: {},
  // English-only today: a navigator-detected non-English locale is
  // NOT persisted or stamped on <html lang> at init (the text would
  // be English fallback). An explicit picker choice IS honoured in
  // full — including for placeholder locales awaiting translation.
  translatedLocales: TRANSLATED_LOCALES,
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
    te: () => import('./locales/te.json'),
    kn: () => import('./locales/kn.json'),
    ml: () => import('./locales/ml.json'),
    bn: () => import('./locales/bn.json'),
    mr: () => import('./locales/mr.json'),
    pa: () => import('./locales/pa.json'),
    gu: () => import('./locales/gu.json'),
    ur: () => import('./locales/ur.json'),
    vi: () => import('./locales/vi.json'),
    th: () => import('./locales/th.json'),
    tl: () => import('./locales/tl.json'),
    id: () => import('./locales/id.json'),
    pt: () => import('./locales/pt.json'),
    ru: () => import('./locales/ru.json'),
    uk: () => import('./locales/uk.json'),
    tr: () => import('./locales/tr.json'),
    it: () => import('./locales/it.json'),
    nl: () => import('./locales/nl.json'),
    pl: () => import('./locales/pl.json'),
    el: () => import('./locales/el.json'),
    cs: () => import('./locales/cs.json'),
    fa: () => import('./locales/fa.json'),
    he: () => import('./locales/he.json'),
    sw: () => import('./locales/sw.json'),
  },
});

export default i18n;
