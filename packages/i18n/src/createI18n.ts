/**
 * Shared i18next bootstrap factory — the exact bootstrap extracted
 * from apps/www/src/i18n/index.ts, parameterised so every Vaipakam
 * surface (www, alpha02, and any future app) initialises identically:
 *
 *   - English is loaded eagerly (it's the fallback target — needs to
 *     be available synchronously for the first paint). Every other
 *     locale loads lazily via the caller-supplied dynamic-import map,
 *     so the initial bundle ships English copy only.
 *
 *   - Detection chain (priority order):
 *       1. URL path prefix (`/es/...`) — handled by the caller's
 *          router wrapper (LocaleResolver), not the detector here.
 *       2. `vaipakam_lang` cookie at the `.vaipakam.com` parent scope
 *          — seeded into localStorage BEFORE i18next initialises so a
 *          choice made on any sibling subdomain is honoured here.
 *          The cookie is authoritative over localStorage because
 *          i18next's `caches: ['localStorage']` writes the navigator-
 *          detected language on the very first init, even before the
 *          user touches a picker — without the seed, a stale local
 *          cache would shadow the user's explicit cross-domain choice.
 *       3. localStorage (default key `vaipakam:language`).
 *       4. `navigator.languages` — first match against supportedLngs.
 *       5. `<html lang>` — last-resort hint.
 *       6. Fallback to English.
 *
 *   - Placeholder locales (codes in SUPPORTED_LOCALES with no bundle
 *     registered / no lazy loader) resolve every key to the English
 *     string via `fallbackLng: 'en'` — picking one never breaks the
 *     page.
 *
 *   - `<html lang>` + `dir` stay in sync with the active language
 *     (RTL locales flip layout for logical-property CSS).
 *
 *   - Every language change is mirrored to the parent-domain cookie
 *     so sibling subdomains pick the new value up on their next
 *     visit.
 */

import i18n, { type i18n as I18nInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import {
  readCookie,
  writeCookie,
  LANG_COOKIE,
} from '@vaipakam/lib/crossDomainPref';

import { SUPPORTED_LOCALES } from './glossary';
import { applyDocumentDirection } from './rtl';

/** localStorage key shared by every surface — the LanguagePicker has
 *  always written here, so preferences carry forward. */
export const LANGUAGE_STORAGE_KEY = 'vaipakam:language';

export type LocaleBundle = Record<string, unknown>;
export type LazyLocaleLoader = () => Promise<{ default: LocaleBundle }>;

export interface VaipakamI18nOptions {
  /** English resource bundle, registered eagerly. */
  en: LocaleBundle;
  /**
   * Locale code → dynamic-import loader map. Listing each loader
   * explicitly (rather than `import.meta.glob`) gives Vite the best
   * static-analysis signal so each JSON splits into its own chunk,
   * fetched only on first use. Codes without a loader fall back to
   * English silently.
   */
  lazyLoaders?: Record<string, LazyLocaleLoader>;
  /** Override the localStorage key (default `vaipakam:language`). */
  storageKey?: string;
}

/**
 * Cross-subdomain seed: if a `vaipakam_lang` cookie exists at the
 * `.vaipakam.com` parent scope, write its value into THIS origin's
 * localStorage BEFORE i18next initialises so its built-in
 * `localStorage` detector picks it up. See the file header for why
 * the cookie wins over localStorage.
 *
 * Why we don't add a `cookie` entry to the detector chain: the
 * version of `i18next-browser-languagedetector` in use writes
 * cookies as same-origin by default; getting it to scope to the
 * parent domain requires `cookieDomain` plumbing that varies by
 * version. Seeding-then-detecting is one well-understood line of
 * code; a `languageChanged` listener handles the write-back.
 */
function seedLanguageFromCookie(storageKey: string) {
  if (typeof window === 'undefined') return;
  const cookie = readCookie(LANG_COOKIE);
  if (!cookie) return;
  // Defensive: only honour cookie values that match a supported
  // locale. Stops a tampered cookie from forcing i18next into
  // a missing-bundle state.
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(cookie)) return;
  // Overwrite localStorage when it disagrees so the detector picks
  // the cookie value. No-op when they already agree.
  const stored = window.localStorage.getItem(storageKey);
  if (stored !== cookie) {
    window.localStorage.setItem(storageKey, cookie);
  }
}

/**
 * Initialise the shared i18next singleton for one app surface. Call
 * ONCE from the app's `src/i18n/index.ts` (imported before render in
 * `main.tsx`), then re-export the returned instance.
 */
export function initVaipakamI18n(options: VaipakamI18nOptions): I18nInstance {
  const storageKey = options.storageKey ?? LANGUAGE_STORAGE_KEY;
  const lazyLoaders = options.lazyLoaders ?? {};

  seedLanguageFromCookie(storageKey);

  async function loadLocaleBundle(lng: string): Promise<void> {
    if (lng === 'en') return; // already eager-loaded
    if (i18n.hasResourceBundle(lng, 'translation')) return;
    const loader = lazyLoaders[lng];
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
        en: { translation: options.en },
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
        lookupLocalStorage: storageKey,
        // Persist the detected/chosen locale here too so a fresh visit
        // matches the LanguagePicker's read.
        caches: ['localStorage'],
      },
      react: {
        // Crucial for the lazy-load flow.
        //
        // `bindI18n` (default `'languageChanged'`) is what react-i18next
        // subscribes to on the i18n INSTANCE. We add `'loaded'` so a
        // freshly-loaded resource bundle also triggers re-renders.
        //
        // `bindI18nStore` (default `''` — empty) is what react-i18next
        // subscribes to on the resource STORE. Setting `'added removed'`
        // is what makes `useTranslation()` re-render when our own
        // `loadLocaleBundle()` calls `addResourceBundle()` after a
        // dynamic-import resolves. Without it, picking a language from
        // the picker visibly does nothing until a SECOND click.
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
  // before the user touches the picker. Writing the cookie at init
  // means every first picker click LATER on any subdomain just
  // rewrites the same cookie key — there's no "before-cookie-existed"
  // window. In source-order BEFORE the `languageChanged` listener
  // registration because i18next may emit `languageChanged`
  // synchronously during init (inline resources + sync detector).
  writeCookie(LANG_COOKIE, initialLng);

  // Future language changes (LanguagePicker click, etc.) load the
  // new bundle on demand.
  i18n.on('languageChanged', (lng) => {
    void loadLocaleBundle(lng);
  });

  // Mirror every user-initiated language change to the parent-domain
  // cookie so sibling subdomains under `.vaipakam.com` pick the new
  // value up on their next visit. Idempotent.
  i18n.on('languageChanged', (lng) => {
    writeCookie(LANG_COOKIE, lng);
  });

  // Keep the document direction in sync with the active language so
  // RTL scripts (Arabic, Hebrew, Farsi, Urdu) flip layout.
  applyDocumentDirection(initialLng);
  i18n.on('languageChanged', applyDocumentDirection);

  return i18n;
}
