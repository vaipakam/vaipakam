/**
 * Locale display metadata shared by every app's LanguagePicker.
 *
 * Native-language labels live HERE (a language's own name for itself
 * doesn't vary by app); per-locale picker VISIBILITY stays app-side —
 * www may show all 10 translated locales while alpha02 shows only the
 * codes its operator has readied — so each app composes its own
 * `LOCALE_DISPLAY_CONFIG` from these labels plus its own flags.
 */

import type { SupportedLocale } from './glossary';

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

/** Native self-name for every supported locale. */
export const LOCALE_NATIVE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  hi: 'हिन्दी',
  ta: 'தமிழ்',
  ar: 'العربية',
  te: 'తెలుగు',
  kn: 'ಕನ್ನಡ',
  ml: 'മലയാളം',
  bn: 'বাংলা',
  mr: 'मराठी',
  pa: 'ਪੰਜਾਬੀ',
  gu: 'ગુજરાતી',
  ur: 'اردو',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  tl: 'Filipino',
  id: 'Bahasa Indonesia',
  pt: 'Português (Brasil)',
  ru: 'Русский',
  uk: 'Українська',
  tr: 'Türkçe',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  el: 'Ελληνικά',
  cs: 'Čeština',
  fa: 'فارسی',
  he: 'עברית',
  sw: 'Kiswahili',
};
