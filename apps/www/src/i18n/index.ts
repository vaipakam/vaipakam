/**
 * i18n bootstrap.
 *
 * English is loaded eagerly (it's the fallback target — needs to
 * be available synchronously for the first paint). Every other
 * locale loads lazily via Vite dynamic imports on first use, so
 * the initial bundle ships ~134 KB of English copy instead of all
 * ~1.8 MB of the 10-locale corpus.
 *
 * Detection chain (priority order):
 *   1. URL path prefix —  e.g. `/es/...` overrides everything below.
 *      Handled by the LocaleResolver router wrapper, not the
 *      detector here.
 *   2. localStorage key `vaipakam:language` — the LanguagePicker
 *      writes here. We deliberately reuse the key the picker has
 *      always used so existing user preferences carry forward.
 *   3. `navigator.languages` — first match against `supportedLngs`.
 *   4. `<html lang>` — populated by an edge worker for users who
 *      don't have a matching browser locale set.
 *   5. Fallback to English.
 *
 * Pending locales (te, ml, kn) are listed in `supportedLngs` so the
 * picker can offer them, but no resource bundle is registered yet.
 * When a user picks one, i18next's `fallbackLng: 'en'` chain
 * renders the English string with no error.
 *
 * Lazy-load mechanics: i18n.init runs synchronously with English
 * pre-registered as the only resource. Detected non-English locales
 * are kicked off via `loadLocaleBundle()` immediately after init
 * and again on every `changeLanguage` event. While the bundle is
 * in flight, components calling `useTranslation()` render English
 * (the fallback chain hits) — so the visible swap is "page renders
 * in English for ~50-200 ms, then re-renders in the user's locale"
 * rather than "page renders in keys then re-renders in the locale."
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import {
  readCookie,
  writeCookie,
  LANG_COOKIE,
} from '@vaipakam/lib/crossDomainPref';

import { SUPPORTED_LOCALES } from './glossary';

// English — eager. Always available so the fallback chain renders
// readable copy instead of raw keys while a non-English bundle is
// in flight on first paint.
import en from './locales/en.json';

const STORAGE_KEY = 'vaipakam:language';

/**
 * Map of locale code → dynamic-import loader. Vite recognises the
 * `import('./locales/${...}.json')` pattern at build time and
 * splits each JSON into its own chunk; the chunk is fetched only
 * when the loader is called.
 *
 * Listing each loader explicitly (rather than `import.meta.glob`)
 * gives Vite the best static-analysis signal so the chunks are
 * named after the locale and tree-shaking is precise. The trade-
 * off is that adding a new locale also needs an entry here — but
 * that pairs with adding the locale to `SUPPORTED_LOCALES` and
 * the LanguagePicker, so it's one obvious place per locale.
 */
const LAZY_LOCALE_LOADERS: Record<
  string,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  ja: () => import('./locales/ja.json'),
  zh: () => import('./locales/zh.json'),
  hi: () => import('./locales/hi.json'),
  ar: () => import('./locales/ar.json'),
  ta: () => import('./locales/ta.json'),
  ko: () => import('./locales/ko.json'),
};

/**
 * Cross-subdomain seed: if a `vaipakam_lang` cookie exists at the
 * `.vaipakam.com` parent scope, write its value into THIS origin's
 * localStorage BEFORE i18next initialises so its built-in
 * `localStorage` detector picks it up.
 *
 * Why the cookie is authoritative (not a fallback): every Vaipakam
 * subdomain runs its own copy of i18next, and i18next's
 * `caches: ['localStorage']` writes the navigator-detected language
 * to localStorage on the very first init — even before the user
 * touches a picker. So a user who lands on defi.vaipakam.com first
 * gets `es` cached locally, then switches their explicit choice to
 * `ja` via the picker on labs.vaipakam.com (which writes the
 * cookie). Without this seed overwriting defi's stale localStorage,
 * the next defi visit reads `es` from defi's own localStorage and
 * ignores the `ja` cookie — manifesting as "language doesn't
 * sync." Theme handling has the same shape (cookie wins over
 * localStorage in `readStoredTheme`); language gets the same
 * precedence here.
 *
 * Why we don't add a `cookie` entry to the detector chain: the
 * version of `i18next-browser-languagedetector` in use writes
 * cookies as same-origin by default; getting it to scope to the
 * parent domain requires `cookieDomain` plumbing that varies by
 * version. Seeding-then-detecting is one well-understood line of
 * code; a `languageChanged` listener handles the write-back.
 */
function seedLanguageFromCookie() {
  if (typeof window === 'undefined') return;
  const cookie = readCookie(LANG_COOKIE);
  if (!cookie) return;
  // Defensive: only honour cookie values that match a supported
  // locale. Stops a tampered cookie from forcing i18next into
  // a missing-bundle state.
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(cookie)) return;
  // Overwrite localStorage when it disagrees so the detector picks
  // the cookie value. No-op when they already agree.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored !== cookie) {
    window.localStorage.setItem(STORAGE_KEY, cookie);
  }
}
seedLanguageFromCookie();

async function loadLocaleBundle(lng: string): Promise<void> {
  if (lng === 'en') return; // already eager-loaded
  if (i18n.hasResourceBundle(lng, 'translation')) return;
  const loader = LAZY_LOCALE_LOADERS[lng];
  if (!loader) return;
  try {
    const mod = await loader();
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true);
  } catch (err) {
    // Loader failed — i18next falls back to English silently. Log
    // for diagnostics but don't break the page.
    // eslint-disable-next-line no-console
    console.warn(`[i18n] Failed to load locale bundle "${lng}":`, err);
  }
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    supportedLngs: [...SUPPORTED_LOCALES],
    fallbackLng: 'en',
    // Don't break the page if a key is missing — render the source
    // English string so the user still sees something readable.
    returnNull: false,
    interpolation: {
      // React already escapes interpolated values; no double-escape.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: STORAGE_KEY,
      // Persist the detected/chosen locale here too so a fresh visit
      // matches the LanguagePicker's read.
      caches: ['localStorage'],
    },
    react: {
      // Crucial for the lazy-load flow.
      //
      // `bindI18n` (default `'languageChanged'`) is what react-i18next
      // subscribes to on the i18n INSTANCE. We add `'loaded'` so a
      // freshly-loaded resource bundle (via `i18next-http-backend` or
      // any other async resource loader) also triggers re-renders.
      //
      // `bindI18nStore` (default `''` — empty) is what react-i18next
      // subscribes to on the resource STORE. Setting `'added removed'`
      // is what makes `useTranslation()` re-render when our own
      // `loadLocaleBundle()` calls `addResourceBundle()` after a
      // dynamic-import resolves.
      //
      // Without this config, picking Spanish from the LanguagePicker
      // visibly does nothing on the first click: i18n.changeLanguage
      // fires `languageChanged`, React re-renders, but the Spanish
      // bundle hasn't downloaded yet so `t(key)` falls back to
      // English. When `addResourceBundle('es', ...)` lands ~100 ms
      // later, react-i18next has nothing wired to it and the page
      // stays in English. A second picker click fires `languageChanged`
      // again, the bundle is now in memory, and the page finally
      // renders in Spanish — which manifests as "language only changes
      // on the second click."
      bindI18n: 'languageChanged loaded',
      bindI18nStore: 'added removed',
    },
  });

// Kick off the detected locale's bundle if it's not English. Done
// after init so `i18n.resolvedLanguage` is populated by the
// detector chain. Awaiting isn't necessary — `useTranslation()`
// re-renders when `addResourceBundle()` fires, and the English
// fallback covers the in-flight window.
const initialLng = i18n.resolvedLanguage ?? 'en';
if (initialLng !== 'en') void loadLocaleBundle(initialLng);

// Init-time cookie write so the FIRST-visit navigator-detected
// language propagates across `.vaipakam.com` immediately, even
// before the user touches the picker. Without this, a user landing
// on labs first (navigator → es) and then visiting defi would have
// defi's own first-init pick up `navigator → es` independently —
// fine in this case because they agree, but as soon as the user
// flips one subdomain via the picker, the OTHER subdomain's
// localStorage is stale and the cross-domain seed has nothing to
// do with locking the choice in. Writing the cookie at init means
// every first picker click LATER on any subdomain just rewrites
// the same cookie key — there's no "before-cookie-existed" window.
//
// The init-time write is in source-order BEFORE the
// `languageChanged` listener registration because i18next may emit
// `languageChanged` synchronously during init (when resources are
// inline + LanguageDetector is sync). Capturing `initialLng` from
// `i18n.resolvedLanguage` and writing it directly side-steps the
// listener-registration race.
writeCookie(LANG_COOKIE, initialLng);

// Future language changes (LanguagePicker click, etc.) load the
// new bundle on demand.
i18n.on('languageChanged', (lng) => {
  void loadLocaleBundle(lng);
});

// Mirror every user-initiated language change to the parent-domain
// cookie so sibling subdomains under `.vaipakam.com` pick the new
// value up on their next visit. Idempotent — writing the same
// value the user already has is a no-op.
i18n.on('languageChanged', (lng) => {
  writeCookie(LANG_COOKIE, lng);
});

// Keep the document direction in sync with the active language so RTL
// scripts (Arabic) flip layout. The HTML element gets `dir="rtl"`;
// CSS that uses logical properties (margin-inline-start, etc.) reacts
// automatically. Components using physical properties may need a
// targeted RTL pass in Phase 2.
function applyDir(lng: string) {
  if (typeof document === 'undefined') return;
  const rtl = ['ar', 'he', 'fa', 'ur'];
  document.documentElement.setAttribute(
    'dir',
    rtl.includes(lng) ? 'rtl' : 'ltr',
  );
  document.documentElement.setAttribute('lang', lng);
}
applyDir(initialLng);
i18n.on('languageChanged', applyDir);

export default i18n;
