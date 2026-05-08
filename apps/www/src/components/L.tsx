import { Link, NavLink, type LinkProps, type NavLinkProps } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';
import {
  withLocalePrefix,
  isSupportedLocale,
  stripLocalePrefix,
} from './LocaleResolver';
import type { SupportedLocale } from '../i18n/glossary';

function rewrite(
  to: LinkProps['to'],
  locale: SupportedLocale,
): LinkProps['to'] {
  if (typeof to === 'string') {
    if (!to.startsWith('/')) return to;
    return withLocalePrefix(stripLocalePrefix(to), locale);
  }
  if (to && typeof to === 'object' && 'pathname' in to && to.pathname) {
    const p = to.pathname;
    if (!p.startsWith('/')) return to;
    return { ...to, pathname: withLocalePrefix(stripLocalePrefix(p), locale) };
  }
  return to;
}

function useActiveLocale(): SupportedLocale {
  const { i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  return isSupportedLocale(lng) ? lng : 'en';
}

/**
 * Drop-in replacement for `react-router-dom`'s `<Link>` that
 * automatically prepends the active locale prefix to absolute paths.
 *
 * Behaviour:
 *   - `to="/foo"` on Spanish (`es`) → `/es/foo`
 *   - `to="/foo"` on English (default) → `/foo`
 *   - `to="foo"` (relative) → unchanged
 *   - `to="https://..."` (external) → unchanged
 *   - `to="#anchor"` → unchanged
 *   - `to={{ pathname: '/foo' }}` (object form) → `pathname` rewritten,
 *     other fields preserved
 *
 * Internal links across the app should prefer this over the bare
 * `Link` so the locale prefix carries through user navigation. The
 * route table in `App.tsx` accepts both prefixed and unprefixed forms
 * for safety, so missing migrations don't break anything — they just
 * silently switch the user back to the default locale on click.
 */
export function L({ to, ...rest }: LinkProps) {
  const locale = useActiveLocale();
  const finalTo = useMemo(() => rewrite(to, locale), [to, locale]);
  return <Link to={finalTo} {...rest} />;
}

/**
 * Locale-aware NavLink wrapper. Same prefix rewrite as `<L>`, but
 * preserves NavLink's active-state styling props (`className`,
 * `style`, `children` as functions of `{ isActive, isPending }`).
 */
export function NL({ to, ...rest }: NavLinkProps) {
  const locale = useActiveLocale();
  const finalTo = useMemo(() => rewrite(to, locale), [to, locale]);
  return <NavLink to={finalTo} {...rest} />;
}

export default L;
