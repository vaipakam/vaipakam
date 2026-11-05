import { SUPPORTED_LOCALES, type SupportedLocale } from '@vaipakam/i18n/glossary';
import TRANSLATED from './translatedLocales.json';
import { LOCALE_NATIVE_LABELS, type LocaleDisplayConfig } from '@vaipakam/i18n/localeDisplay';

/** Locales this app renders translated content for. English only until the
 *  route PRs land and the per-route guide sections are translated (the
 *  index.html bootstrap's TRANSLATED list mirrors this file). */
export const TRANSLATED_LOCALES: readonly string[] = TRANSLATED;

export const LANGUAGE_PICKER_ENABLED = true;

const PICKER_VISIBLE: ReadonlySet<SupportedLocale> = new Set(['en', 'es', 'zh', 'hi', 'ja', 'ta', 'fr', 'de', 'ar', 'ko']);

export const LOCALE_DISPLAY_CONFIG: Record<SupportedLocale, LocaleDisplayConfig> = Object.fromEntries(
  SUPPORTED_LOCALES.map((code) => [code, { code, label: LOCALE_NATIVE_LABELS[code], visible: PICKER_VISIBLE.has(code) }]),
) as Record<SupportedLocale, LocaleDisplayConfig>;
