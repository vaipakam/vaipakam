import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Per-page SEO metadata hook.
 *
 * Sets three things on `document.head` for the duration of the page
 * mount, and tears them down (canonical only) on unmount:
 *
 *   1. `document.title`             — search-result heading
 *   2. `<meta name="description">`  — search-result snippet (~155 chars)
 *   3. `<link rel="canonical">`     — disambiguates URL variants for
 *                                     crawlers (trailing slash, query
 *                                     strings, etc.). Self-referential
 *                                     per locale: `/es/whitepaper`
 *                                     canonicals to itself, NOT to
 *                                     `/whitepaper`. Locale association
 *                                     is handled by `<HreflangAlternates>`.
 *
 * Why direct DOM manipulation rather than React Helmet: zero deps,
 * SSR-safe-by-default (the `useEffect` doesn't run during SSR), and
 * the existing `<HreflangAlternates>` component already uses this
 * exact pattern — keeping the SEO machinery one-shape.
 *
 * The canonical origin is derived from `window.location.origin`,
 * which auto-tracks every domain bound to the labs Worker
 * (labs.vaipakam.com today; vaipakam.com / www.vaipakam.com after
 * cutover). No env var needed; the canonical always matches the
 * domain the user is actually on.
 *
 * Usage:
 *
 *     usePageMeta({
 *       titleKey: 'pageMeta.whitepaper.title',
 *       descriptionKey: 'pageMeta.whitepaper.description',
 *     });
 *
 * Both keys resolve through i18next, so each locale renders its
 * own translated title/description. Missing keys fall through to
 * English via the existing `fallbackLng: 'en'` chain — adding a
 * new page is "set both keys in en.json now, fill other locales
 * incrementally."
 */
import { useTranslation } from 'react-i18next';

interface UsePageMetaInput {
  /** i18n key for the page title. Resolved via `t()` so each locale
   *  renders its own translated string. */
  titleKey: string;
  /** i18n key for the page description. Same resolution. */
  descriptionKey: string;
}

export function usePageMeta({ titleKey, descriptionKey }: UsePageMetaInput) {
  const { t, i18n } = useTranslation();
  const location = useLocation();

  // Re-resolve labels on every language change so a click on the
  // LanguagePicker mid-page rewrites <title> and <meta description>
  // in lockstep. `i18n.language` is part of the dep array so the
  // effect re-runs after `i18n.changeLanguage()` fires.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const title = t(titleKey);
    const description = t(descriptionKey);

    // <title>
    document.title = title;

    // <meta name="description">. Reuse an existing tag if Vite or
    // a previous mount already wrote one; otherwise create.
    let descTag = document.querySelector(
      'meta[name="description"]',
    ) as HTMLMetaElement | null;
    if (!descTag) {
      descTag = document.createElement('meta');
      descTag.name = 'description';
      document.head.appendChild(descTag);
    }
    descTag.content = description;

    // <link rel="canonical"> — self-referential to the current URL.
    // Strip trailing slashes so `/whitepaper` and `/whitepaper/`
    // both resolve to a single canonical (the trailing-slash form
    // never has different content). Query strings are dropped from
    // the canonical because none of the marketing routes have
    // canonical query parameters; if a future route does, it can
    // override via a route-specific `usePageMeta` extension.
    const origin = window.location.origin;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const canonicalHref = `${origin}${path}`;

    let canonicalTag = document.querySelector(
      'link[rel="canonical"][data-page-meta="1"]',
    ) as HTMLLinkElement | null;
    if (!canonicalTag) {
      canonicalTag = document.createElement('link');
      canonicalTag.rel = 'canonical';
      canonicalTag.dataset.pageMeta = '1';
      document.head.appendChild(canonicalTag);
    }
    canonicalTag.href = canonicalHref;

    return () => {
      // Tear down ONLY the canonical on unmount — leaving the title
      // and description in place avoids a flash of empty/old values
      // during the next page's mount. The next page's `usePageMeta`
      // overwrites both. The canonical IS torn down because every
      // page has its own absolute URL — leaving the previous one
      // mounted while a new page paints would briefly tell crawlers
      // the wrong canonical.
      if (canonicalTag && canonicalTag.parentNode) {
        canonicalTag.parentNode.removeChild(canonicalTag);
      }
    };
  }, [t, titleKey, descriptionKey, location.pathname, i18n.language]);
}
