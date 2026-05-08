/**
 * Locale display configuration.
 *
 * Controls TWO things, both at compile time:
 *
 *   1. **Master switch** (`LANGUAGE_PICKER_ENABLED`) — set to `false`
 *      to hide the LanguagePicker dropdown entirely from both the
 *      public Navbar and the in-app settings panel. URL-based locale
 *      routing (`/es/...`, `/ta/...`) keeps working regardless; the
 *      picker is just the user-facing surface for switching.
 *
 *   2. **Per-locale visibility** (`visible` field on each entry) —
 *      controls whether the locale appears in the dropdown options.
 *      Placeholder locales (no translation bundle yet) ship with
 *      `visible: false` so they don't surface in the picker until the
 *      translation lands. You can flip a placeholder to `visible: true`
 *      if you want the picker to advertise it as "coming soon"; the
 *      app will still render English text under that locale code via
 *      i18next's `fallbackLng: 'en'`.
 *
 * Adding or rotating a locale:
 *   - To **show** an existing locale that's currently hidden: flip
 *     `visible: true`.
 *   - To **hide** a locale temporarily: flip `visible: false`. URL
 *     routing still works for users with bookmarks; they just don't
 *     see it in the picker.
 *   - To **promote a placeholder** once translated: add the JSON
 *     bundle in `locales/`, register it in `i18n/index.ts`, move the
 *     code from `PLACEHOLDER_LOCALES` to `TRANSLATED_LOCALES` in
 *     `glossary.ts`, then flip `visible: true` here.
 *
 * Native-language labels: each entry uses the language's own name
 * (e.g. "தமிழ்" not "Tamil") so users can find their language in the
 * picker even without reading English.
 */

import type { SupportedLocale } from './glossary';

/** Master switch. When false, the LanguagePicker is not rendered at
 *  all. URL-based locale routing continues to work for users with
 *  pre-existing bookmarks or hreflang-discovered URLs. */
export const LANGUAGE_PICKER_ENABLED = true;

export interface LocaleDisplayConfig {
  code: SupportedLocale;
  /** Native-language label shown in the picker. Stays in the locale's
   *  own script regardless of the active UI language so users can
   *  recognise their language without reading English. */
  label: string;
  /** Whether this locale appears in the LanguagePicker dropdown
   *  options. Set to `false` for placeholders awaiting translation
   *  (or to temporarily disable a translated locale). */
  visible: boolean;
}

/** Per-locale picker config. Order here defines order in the dropdown.
 *  Translated locales come first, placeholders at the bottom. */
export const LOCALE_DISPLAY_CONFIG: Record<SupportedLocale, LocaleDisplayConfig> = {
  // Translated (10) — visible by default
  en: { code: 'en', label: 'English', visible: true },
  es: { code: 'es', label: 'Español', visible: true },
  fr: { code: 'fr', label: 'Français', visible: true },
  de: { code: 'de', label: 'Deutsch', visible: true },
  ja: { code: 'ja', label: '日本語', visible: true },
  zh: { code: 'zh', label: '中文', visible: true },
  ko: { code: 'ko', label: '한국어', visible: true },
  hi: { code: 'hi', label: 'हिन्दी', visible: true },
  ta: { code: 'ta', label: 'தமிழ்', visible: true },
  ar: { code: 'ar', label: 'العربية', visible: true },
  // Placeholders (24) — hidden until translation bundle lands. Order
  // groups by region for review-friendliness; doesn't affect the
  // dropdown (placeholders are hidden by default).

  // South Asia
  te: { code: 'te', label: 'తెలుగు', visible: false },
  kn: { code: 'kn', label: 'ಕನ್ನಡ', visible: false },
  ml: { code: 'ml', label: 'മലയാളം', visible: false },
  bn: { code: 'bn', label: 'বাংলা', visible: false },
  mr: { code: 'mr', label: 'मराठी', visible: false },
  pa: { code: 'pa', label: 'ਪੰਜਾਬੀ', visible: false },
  gu: { code: 'gu', label: 'ગુજરાતી', visible: false },
  ur: { code: 'ur', label: 'اردو', visible: false }, // RTL

  // SE Asia
  vi: { code: 'vi', label: 'Tiếng Việt', visible: false },
  th: { code: 'th', label: 'ไทย', visible: false },
  tl: { code: 'tl', label: 'Filipino', visible: false },
  id: { code: 'id', label: 'Bahasa Indonesia', visible: false },

  // Europe (high-volume crypto markets)
  pt: { code: 'pt', label: 'Português (Brasil)', visible: false },
  ru: { code: 'ru', label: 'Русский', visible: false },
  uk: { code: 'uk', label: 'Українська', visible: false },
  tr: { code: 'tr', label: 'Türkçe', visible: false },
  it: { code: 'it', label: 'Italiano', visible: false },
  nl: { code: 'nl', label: 'Nederlands', visible: false },
  pl: { code: 'pl', label: 'Polski', visible: false },
  el: { code: 'el', label: 'Ελληνικά', visible: false },
  cs: { code: 'cs', label: 'Čeština', visible: false },

  // Middle East — RTL (existing rtl.css overlay handles all four
  // when applyDir() flips `<html dir="rtl">`)
  fa: { code: 'fa', label: 'فارسی', visible: false }, // RTL
  he: { code: 'he', label: 'עברית', visible: false }, // RTL

  // Africa
  sw: { code: 'sw', label: 'Kiswahili', visible: false },
};

/** Locales currently visible in the LanguagePicker. Computed once at
 *  module load so consumers don't re-filter on every render. */
export const VISIBLE_LOCALES: ReadonlyArray<LocaleDisplayConfig> =
  Object.values(LOCALE_DISPLAY_CONFIG).filter((entry) => entry.visible);
