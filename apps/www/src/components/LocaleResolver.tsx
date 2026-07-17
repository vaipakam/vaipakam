import { useEffect, type ReactNode } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import i18n from 'i18next';
import { LANGUAGE_STORAGE_KEY } from '@vaipakam/i18n';
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
  // True only for the unprefixed root tree (explicit `locale="en"`
  // prop, no `:locale` URL param).
  const isDefaultTree = locale === 'en' && !fromParam;

  useEffect(() => {
    // Compare against the ACTIVE language, not resolvedLanguage —
    // the latter lags a lazily-loading bundle and would re-fire
    // changeLanguage on every remount during the load window.
    if (i18n.language === target) return;
    if (isDefaultTree) {
      // Unprefixed URL, but the user carries a stored non-English
      // preference (their own picker choice, or one seeded from the
      // cross-app cookie). Forcing `en` here would fire the
      // `languageChanged` cookie write-back and clobber a language
      // the user chose on a sibling surface (Codex #1309 r8). Leave
      // the active language alone: translated preferences are about
      // to be redirected to their prefixed URL by
      // `DefaultLocaleRedirect`, and placeholder preferences render
      // English anyway via i18next fallback (with the `<html lang>`
      // stamp already gated to translated locales by the factory).
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      } catch {
        // Storage unavailable — fall through to the normal force.
      }
      if (stored && stored !== 'en' && isSupportedLocale(stored)) return;
    }
    void i18n.changeLanguage(target);
  }, [target, isDefaultTree]);

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
