/**
 * i18n bootstrap.
 *
 * Loads all hand-curated locale bundles eagerly at startup. The total
 * payload is small (chrome strings only, ~10 locales × <1 KB each) so
 * lazy / on-demand loading would add complexity without saving bytes.
 * When the corpus grows past ~50 KB per locale (Phase 2: card-help
 * summaries; Phase 3: per-page UI strings), switch to
 * `i18next-http-backend` and lazy-load on `changeLanguage`.
 *
 * Detection chain (priority order):
 *   1. URL path prefix —  e.g. `/es/...` overrides everything below.
 *      Not used today; reserved for SEO-friendly per-locale routes.
 *   2. localStorage key `vaipakam:language` — the LanguagePicker
 *      writes here. We deliberately reuse the key the picker has
 *      always used so existing user preferences carry forward.
 *   3. `navigator.languages` — first match against `supportedLngs`.
 *   4. Cloudflare `cf-ipcountry` cookie hint — populated by an edge
 *      worker for users who don't have a matching browser locale set.
 *      Not used today; reserved.
 *   5. Fallback to English.
 *
 * Pending locales (te, ml, kn) are listed in `supportedLngs` so the
 * picker can offer them, but no resource bundle is registered. When
 * a user picks one, i18next's `fallbackLng: 'en'` chain renders the
 * English string with no error. Once `npm run translate` populates
 * those JSONs, future builds pick them up via the `import` glob below
 * and the locale starts resolving to its own strings instead.
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

import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import hi from './locales/hi.json';
import ar from './locales/ar.json';
import ta from './locales/ta.json';
import ko from './locales/ko.json';

const STORAGE_KEY = 'vaipakam:language';

/**
 * Cross-subdomain seed: if a `vaipakam_lang` cookie exists at the
 * `.vaipakam.com` parent scope but this origin's localStorage is
 * empty (fresh visit to a sibling subdomain), copy the cookie value
 * into localStorage BEFORE i18next initialises so its built-in
 * `localStorage` detector picks it up.
 *
 * Why we don't add a `cookie` entry to the detector chain: the
 * version of `i18next-browser-languagedetector` in use writes
 * cookies as same-origin by default; getting it to scope to the
 * parent domain requires `cookieDomain` plumbing that varies by
 * version. Seeding-then-detecting is one well-understood line of
 * code; a `languageChanged` listener handles the write-back.
 *
 * Same-origin users with a pre-existing localStorage entry are
 * left alone — the cookie's a parent-scope FALLBACK, not an
 * override.
 */
function seedLanguageFromCookie() {
  if (typeof window === 'undefined') return;
  const cookie = readCookie(LANG_COOKIE);
  if (!cookie) return;
  if (window.localStorage.getItem(STORAGE_KEY)) return;
  // Defensive: only honour cookie values that match a supported
  // locale. Stops a tampered cookie from forcing i18next into
  // a missing-bundle state.
  if ((SUPPORTED_LOCALES as readonly string[]).includes(cookie)) {
    window.localStorage.setItem(STORAGE_KEY, cookie);
  }
}
seedLanguageFromCookie();

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      fr: { translation: fr },
      de: { translation: de },
      ja: { translation: ja },
      zh: { translation: zh },
      hi: { translation: hi },
      ar: { translation: ar },
      ta: { translation: ta },
      ko: { translation: ko },
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
applyDir(i18n.resolvedLanguage ?? 'en');
i18n.on('languageChanged', applyDir);

// Mirror every user-initiated language change to the parent-domain
// cookie so sibling subdomains under `.vaipakam.com` pick the new
// value up on their next visit. Fires for both the picker (explicit
// choice) and the detector chain's first resolve (implicit) — the
// latter is fine because writing the same value the user already has
// is idempotent.
i18n.on('languageChanged', (lng) => {
  writeCookie(LANG_COOKIE, lng);
});

export default i18n;
