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

/**
 * Normalise a raw i18next language tag to a SUPPORTED_LOCALES base
 * code ('es-MX' → 'es'; anything unrecognised → 'en').
 *
 * Why the ACTIVE language (`i18n.language`) and never
 * `resolvedLanguage` for user-choice surfaces (`<html lang>`/`dir`,
 * the cross-domain cookie, picker selection): i18next only "resolves"
 * a language that has at least one loaded translation. A placeholder
 * locale (empty `{}` bundle awaiting translation) — or any lazy
 * bundle still in flight at init — therefore resolves to 'en', and
 * keying the document language off it stomps the user's actual
 * choice back to English on every reload. The active language is
 * what the user picked; the resolution result is only about which
 * strings render.
 */
export function normalizeToSupportedLocale(raw: string | undefined): string {
  if (!raw) return 'en';
  const base = raw.toLowerCase().split('-')[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? base : 'en';
}

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
  /**
   * Locales this app actually renders translated content for (the
   * app's TRANSLATED_LOCALES). Gates what a bare navigator detection
   * may PERSIST at init: a first-time visitor whose browser reports a
   * placeholder locale (recognised code, no real translation) must
   * not get that code written to the cross-domain cookie or stamped
   * on `<html lang>` over English text — that would label English
   * content as another language and seed sibling subdomains as if the
   * user explicitly chose it (Codex #1309 r2 P2). An EXPLICIT choice
   * (existing cookie/localStorage, a picker click, a locale URL
   * prefix) is always honoured in full, placeholder or not.
   * Defaults to 'en' + every code with a lazy loader.
   */
  translatedLocales?: readonly string[];
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
/** Seed localStorage from the parent-domain cookie (see file header)
 *  and report whether ANY explicit stored preference existed BEFORE
 *  i18next initialises — i18next's `caches: ['localStorage']` writes
 *  the navigator-detected language during init, so this is the only
 *  moment "explicit user choice" and "automatic detection cache" can
 *  be told apart. */
function seedLanguageFromCookie(storageKey: string): boolean {
  if (typeof window === 'undefined') return false;
  let hadExplicitPref = false;
  try {
    hadExplicitPref = window.localStorage.getItem(storageKey) !== null;
  } catch {
    /* storage blocked — treat as no stored preference */
  }
  const cookie = readCookie(LANG_COOKIE);
  if (!cookie) return hadExplicitPref;
  // Defensive: only honour cookie values that match a supported
  // locale. Stops a tampered cookie from forcing i18next into
  // a missing-bundle state.
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(cookie)) {
    return hadExplicitPref;
  }
  hadExplicitPref = true;
  // Overwrite localStorage when it disagrees so the detector picks
  // the cookie value. No-op when they already agree. Guarded like the
  // read above: a privacy mode that blocks storage but kept the
  // cookie must degrade to cookie-less detection, not throw during
  // the pre-render side-effect import (Codex #1309 r3).
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored !== cookie) {
      window.localStorage.setItem(storageKey, cookie);
    }
  } catch {
    /* storage blocked — i18next's own detector falls back gracefully */
  }
  return hadExplicitPref;
}

/**
 * Initialise the shared i18next singleton for one app surface. Call
 * ONCE from the app's `src/i18n/index.ts` (imported before render in
 * `main.tsx`), then re-export the returned instance.
 */
export function initVaipakamI18n(options: VaipakamI18nOptions): I18nInstance {
  const storageKey = options.storageKey ?? LANGUAGE_STORAGE_KEY;
  const lazyLoaders = options.lazyLoaders ?? {};
  const translatedLocales =
    options.translatedLocales ?? ['en', ...Object.keys(lazyLoaders)];

  const hadExplicitPref = seedLanguageFromCookie(storageKey);

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
  // after init so the detector chain has populated `i18n.language`.
  // Awaiting isn't necessary — `useTranslation()` re-renders when
  // `addResourceBundle()` fires, and the English fallback covers the
  // in-flight window. The ACTIVE language (never resolvedLanguage) is
  // the right source here — see normalizeToSupportedLocale.
  const initialLng = normalizeToSupportedLocale(i18n.language);
  if (initialLng !== 'en') void loadLocaleBundle(initialLng);

  // Two distinct concepts (Codex #1309 r5):
  //
  //   PREFERENCE — the language the user wants (persists to
  //   localStorage + the cross-domain cookie, drives the picker and
  //   the active i18next language). Persisted at init only when it
  //   came from an explicit stored preference OR this app renders it
  //   translated; a bare navigator detection of a placeholder locale
  //   is not persisted, and i18next's localStorage auto-cache of it
  //   is scrubbed so it can't masquerade as explicit next visit.
  //
  //   CONTENT LANGUAGE — what `<html lang>`/`dir` declare. Always
  //   gated on translatedLocales, REGARDLESS of how the preference
  //   arrived (picker, cookie from a sibling subdomain, URL prefix):
  //   the attribute describes the text actually rendered, and a
  //   placeholder locale renders English fallback text. A preference
  //   for an untranslated locale therefore keeps `lang="en"` until
  //   its bundle ships — at which point the same stamp flips
  //   automatically.
  const stampFor = (lng: string) =>
    translatedLocales.includes(lng) ? lng : 'en';
  const persistable =
    hadExplicitPref || translatedLocales.includes(initialLng);
  if (!persistable && typeof window !== 'undefined') {
    try {
      if (window.localStorage.getItem(storageKey) === i18n.language) {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      /* storage blocked — nothing cached to scrub */
    }
  }

  // Init-time cookie write so the FIRST-visit navigator-detected
  // (translated) language propagates across `.vaipakam.com`
  // immediately, even before the user touches the picker. Writing the
  // cookie at init means every first picker click LATER on any
  // subdomain just rewrites the same cookie key — there's no
  // "before-cookie-existed" window. In source-order BEFORE the
  // `languageChanged` listener registration because i18next may emit
  // `languageChanged` synchronously during init (inline resources +
  // sync detector).
  //
  // ONLY in the persistable case, and carrying the PREFERENCE (not
  // the gated stamp): writing a forced-'en' fallback would lock
  // sibling subdomains that DO translate the user's language to
  // English — a preference the user never expressed (Codex #1309 r3).
  // No cookie = each surface keeps making its own best detection.
  if (persistable) {
    writeCookie(LANG_COOKIE, initialLng);
  }

  // Future language changes (LanguagePicker click, etc.) load the
  // new bundle on demand.
  i18n.on('languageChanged', (lng) => {
    void loadLocaleBundle(normalizeToSupportedLocale(lng));
  });

  // Mirror every user-initiated language change to the parent-domain
  // cookie so sibling subdomains under `.vaipakam.com` pick the new
  // value up on their next visit. Idempotent. Normalised so the
  // cookie value always passes the seed-side SUPPORTED_LOCALES
  // validation.
  i18n.on('languageChanged', (lng) => {
    writeCookie(LANG_COOKIE, normalizeToSupportedLocale(lng));
  });

  // Keep the document `lang`/`dir` in sync with the CONTENT language
  // (see stampFor above) so RTL scripts flip layout exactly when a
  // translated bundle actually renders. Applies on BOTH paths — init
  // and every language change — so no route into a placeholder
  // preference (picker, sibling-subdomain cookie, URL prefix) can
  // label English fallback text as another language.
  applyDocumentDirection(stampFor(initialLng));
  i18n.on('languageChanged', (lng) => {
    applyDocumentDirection(stampFor(normalizeToSupportedLocale(lng)));
  });

  return i18n;
}
