import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { TRANSLATED_LOCALES } from '../i18n/glossary';
import { stripLocalePrefix, withLocalePrefix } from './LocaleResolver';

/**
 * Inject `<link rel="alternate" hreflang="X" href="..." />` tags into
 * `<head>` for every supported locale plus an `x-default` pointing at
 * the English (root) version of the current page.
 *
 * Search engines use these to index every locale variant of a page
 * separately and to route users from search results to the locale
 * matching their accept-language. The tags are managed via direct DOM
 * manipulation in a `useEffect` so we don't add a SSR-only dependency
 * (React Helmet) for what's effectively three element insertions per
 * navigation. Old tags are removed before the new set is added so a
 * route change cleans up after itself.
 *
 * Mounted once at the top of the app (`App.tsx`); routes don't need
 * to render their own copy.
 */
export function HreflangAlternates() {
  const location = useLocation();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const head = document.head;
    const origin = window.location.origin;
    const stripped = stripLocalePrefix(location.pathname);

    // Drop any previously-injected alternate tags. We mark our own
    // tags with `data-i18n-alt="1"` so we don't disturb anything an
    // upstream tool (e.g. a CMS preview) might have placed in head.
    head
      .querySelectorAll('link[rel="alternate"][data-i18n-alt="1"]')
      .forEach((el) => el.remove());

    // One alternate per **translated** locale, pointing at the same
    // page in that locale. Placeholder locales (recognised by URL
    // routing but without a translation bundle) are excluded — listing
    // them in hreflang would advertise non-existent localised pages
    // to crawlers, which is misleading and can hurt ranking.
    for (const loc of TRANSLATED_LOCALES) {
      const href = `${origin}${withLocalePrefix(stripped, loc)}${location.search}${location.hash}`;
      const link = document.createElement('link');
      link.rel = 'alternate';
      link.hreflang = loc;
      link.href = href;
      link.dataset.i18nAlt = '1';
      head.appendChild(link);
    }

    // x-default points at the English (default) version. Crawlers fall
    // back to this when none of the explicit hreflang values matches
    // the user.
    const xdef = document.createElement('link');
    xdef.rel = 'alternate';
    xdef.hreflang = 'x-default';
    xdef.href = `${origin}${stripped}${location.search}${location.hash}`;
    xdef.dataset.i18nAlt = '1';
    head.appendChild(xdef);
  }, [location.pathname, location.search, location.hash]);

  return null;
}
