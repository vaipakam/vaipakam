import { SUPPORTED_LOCALES, type SupportedLocale } from './glossary';

/**
 * Locale-prefix helpers for URL paths.
 *
 * Split out of `components/LocaleResolver.tsx` so that file exports a
 * component and nothing else; a module mixing a component with plain
 * functions makes editing the component a full reload instead of a hot
 * swap. These are pure string functions with no React dependency, so this
 * is where they belonged anyway — `LocaleResolver` is one of their callers,
 * not their home.
 */

export function isSupportedLocale(s: string | undefined): s is SupportedLocale {
  return !!s && (SUPPORTED_LOCALES as readonly string[]).includes(s);
}

/**
 * Strip the leading locale prefix from a pathname, if any. Returns the
 * pathname unchanged when the first segment isn't a supported locale.
 * Used by the LanguagePicker (and any callsite that needs the bare
 * route to compose a different prefix).
 */
export function stripLocalePrefix(pathname: string): string {
  const m = pathname.match(/^\/([a-z]{2})(\/.*|$)/);
  if (!m) return pathname;
  if (!isSupportedLocale(m[1])) return pathname;
  return m[2] || '/';
}

/**
 * Compose a path with the given locale prefix. English (the default)
 * stays at the unprefixed root; every other supported locale gets a
 * `/<locale>` prefix. Pass already-stripped paths in.
 */
export function withLocalePrefix(path: string, locale: SupportedLocale): string {
  if (locale === 'en') return path.startsWith('/') ? path : `/${path}`;
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === '/') return `/${locale}`;
  return `/${locale}${clean}`;
}
