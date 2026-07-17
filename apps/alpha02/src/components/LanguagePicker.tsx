/**
 * Display-language picker — a native <select> (mobile-first: the OS
 * wheel/sheet beats a custom dropdown on phones) listing the locales
 * `localeConfig.ts` marks visible, labelled in each language's own
 * script so users can find theirs without reading English.
 *
 * Selecting a language calls `i18n.changeLanguage`, which (via the
 * shared @vaipakam/i18n factory) lazy-loads the locale bundle,
 * persists to localStorage AND the `.vaipakam.com` parent-domain
 * cookie (so vaipakam.com / defi.vaipakam.com pick the choice up),
 * and flips `<html lang>`/`dir`. `<LanguageRemount>` then remounts
 * the tree so every `copy.*` string re-resolves.
 */

import { useTranslation } from 'react-i18next';
import { normalizeToSupportedLocale } from '@vaipakam/i18n/createI18n';
import { copy } from '../content/copy';
import { VISIBLE_LOCALES } from '../i18n/localeConfig';

export function LanguagePicker() {
  const { i18n } = useTranslation();
  // ACTIVE language, never resolvedLanguage: a placeholder locale
  // (empty bundle) resolves to 'en', which would show English as
  // selected right after the user picked Spanish. The picker reflects
  // the CHOICE; the strings' fallback is a separate concern.
  const active = normalizeToSupportedLocale(i18n.language);

  return (
    <select
      className="input"
      style={{ maxWidth: 320 }}
      aria-label={copy.chrome.settings.languagePickerAria}
      value={
        VISIBLE_LOCALES.some((entry) => entry.code === active) ? active : 'en'
      }
      onChange={(event) => {
        void i18n.changeLanguage(event.target.value);
      }}
    >
      {VISIBLE_LOCALES.map((entry) => (
        <option key={entry.code} value={entry.code}>
          {entry.label}
        </option>
      ))}
    </select>
  );
}
