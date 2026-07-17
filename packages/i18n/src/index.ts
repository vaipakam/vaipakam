export {
  GLOSSARY_KEEP_VERBATIM,
  GLOSSARY_STYLE_NOTES,
  SUPPORTED_LOCALES,
  LOCALE_NAMES,
  type SupportedLocale,
  type LocaleCode,
} from './glossary';
export {
  RTL_LOCALES,
  isRtlLocale,
  applyDocumentDirection,
} from './rtl';
export {
  LOCALE_NATIVE_LABELS,
  type LocaleDisplayConfig,
} from './localeDisplay';
export {
  initVaipakamI18n,
  normalizeToSupportedLocale,
  LANGUAGE_STORAGE_KEY,
  type VaipakamI18nOptions,
  type LocaleBundle,
  type LazyLocaleLoader,
} from './createI18n';
