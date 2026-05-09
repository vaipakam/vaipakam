import { useEffect, type ReactNode } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import i18n from 'i18next';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../i18n/glossary';

/**
 * Route-tree wrapper that synchronises i18n with the URL's locale
 * prefix (e.g. `/es/dashboard` → Spanish). English is the default and
 * lives at the unprefixed root (`/dashboard`); any other supported
 * locale gets a prefix.
 *
 * Mounted at the root of every locale-prefixed route subtree in
 * `App.tsx`. It reads the `:locale` URL param (or accepts an explicit
 * `locale` prop for the root no-prefix tree) and calls
 * `i18n.changeLanguage(...)` so the rest of the React tree renders
 * in the correct language. The `<html lang>` and `dir` attributes are
 * already wired by the `applyDir` listener in `i18n/index.ts`.
 *
 * Renders `<Outlet />` by default — i.e. it sits at the top of a
 * nested route tree. Pass `children` to use it imperatively
 * (e.g. wrap a single page).
 *
 * SEO win: every supported locale now has a distinct, crawlable URL.
 * Combined with the `<HreflangAlternates>` component (rendered once
 * at App-root) search engines can cleanly index each locale and
 * route users to the right one from search results.
 */
interface LocaleResolverProps {
  /** When the route matches the unprefixed root tree, callers pass
   *  `'en'` explicitly. When the route includes a `:locale` URL param
   *  this is left undefined and the param drives the resolution. */
  locale?: SupportedLocale;
  /** Optional children for imperative usage. When omitted, `<Outlet />`
   *  is rendered so child routes mount cleanly. */
  children?: ReactNode;
}

export function isSupportedLocale(s: string | undefined): s is SupportedLocale {
  return !!s && (SUPPORTED_LOCALES as readonly string[]).includes(s);
}

export function LocaleResolver({ locale, children }: LocaleResolverProps) {
  const params = useParams<{ locale?: string }>();
  const fromParam = params.locale;
  const target: SupportedLocale = locale
    ?? (isSupportedLocale(fromParam) ? fromParam : 'en');

  useEffect(() => {
    if (i18n.resolvedLanguage !== target) {
      void i18n.changeLanguage(target);
    }
  }, [target]);

  return <>{children ?? <Outlet />}</>;
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
export function withLocalePrefix(
  path: string,
  locale: SupportedLocale,
): string {
  if (locale === 'en') return path.startsWith('/') ? path : `/${path}`;
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (clean === '/') return `/${locale}`;
  return `/${locale}${clean}`;
}
