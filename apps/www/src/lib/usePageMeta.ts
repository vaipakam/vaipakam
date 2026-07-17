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
 * Canonical origin is HARDCODED to the apex (`https://vaipakam.com`),
 * not `window.location.origin`. The `vaipakam-www` Worker also
 * accepts requests on `www.vaipakam.com` (which 301s to apex via a
 * Cloudflare Bulk Redirect rule), so a visitor who hits the www host
 * before the redirect fires would otherwise emit a www-rooted
 * canonical — splitting Google's ranking between two hostnames
 * serving identical content. Forcing the canonical to apex collapses
 * any accidental hostname variant into one indexable URL group.
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

/** The canonical hostname every page on this site declares. Apex,
 *  not www; see file header comment for the duplicate-content
 *  rationale. Hardcoded — a build-time env-var override is not
 *  meaningful here because the canonical is what crawlers index,
 *  and that has to be the production hostname even on staging
 *  builds (otherwise staging URLs leak into Google's index). */
const CANONICAL_ORIGIN = 'https://vaipakam.com';

/** Social-share image served from public/ — absolute URL because
 *  scrapers don't resolve relative og:image paths reliably. */
const OG_IMAGE = `${CANONICAL_ORIGIN}/banner.png`;

interface UsePageMetaInput {
  /** i18n key for the page title. Resolved via `t()` so each locale
   *  renders its own translated string. */
  titleKey: string;
  /** i18n key for the page description. Same resolution. */
  descriptionKey: string;
  /** Override the canonical PATH (default: the current pathname).
   *  For English-only pages reachable under locale prefixes (see
   *  EN_ONLY_ROUTES in scripts/seo-routes.mjs): `/es/protocol-
   *  console/docs` self-canonicalizing would let English duplicates
   *  be indexed per locale — pinning the canonical to the unprefixed
   *  path consolidates every variant onto the one advertised URL
   *  (Codex #1309 r5). */
  canonicalPath?: string;
}

/** Open Graph + Twitter Card tags maintained alongside the basics.
 *  Derived from the SAME title/description/canonical, so pages never
 *  drift between what Google shows and what a Discord/X/Telegram
 *  unfurl shows. `property` vs `name` matters: OG readers look up
 *  `meta[property=...]`, Twitter looks up `meta[name=...]`. */
const OG_TAGS = (
  title: string,
  description: string,
  url: string,
  locale: string,
): Array<{ attr: 'property' | 'name'; key: string; content: string }> => [
  { attr: 'property', key: 'og:type', content: 'website' },
  { attr: 'property', key: 'og:site_name', content: 'Vaipakam' },
  { attr: 'property', key: 'og:title', content: title },
  { attr: 'property', key: 'og:description', content: description },
  { attr: 'property', key: 'og:url', content: url },
  { attr: 'property', key: 'og:image', content: OG_IMAGE },
  { attr: 'property', key: 'og:locale', content: locale },
  { attr: 'name', key: 'twitter:card', content: 'summary_large_image' },
  { attr: 'name', key: 'twitter:title', content: title },
  { attr: 'name', key: 'twitter:description', content: description },
  { attr: 'name', key: 'twitter:image', content: OG_IMAGE },
];

export function usePageMeta({
  titleKey,
  descriptionKey,
  canonicalPath,
}: UsePageMetaInput) {
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

    // <link rel="canonical"> — pinned to the apex hostname regardless
    // of which host actually served the request. See the file header
    // comment for the duplicate-content rationale. Strip trailing
    // slashes so `/whitepaper` and `/whitepaper/` both resolve to a
    // single canonical. Query strings are dropped from the canonical
    // because none of the marketing routes have canonical query
    // parameters; if a future route does, it can override via a
    // route-specific `usePageMeta` extension.
    const path =
      (canonicalPath ?? location.pathname).replace(/\/+$/, '') || '/';
    const canonicalHref = `${CANONICAL_ORIGIN}${path}`;

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

    // OG + Twitter tags — one upsert per tag, keyed by property/name.
    // BCP-47-ish og:locale from the active language (coarse two-letter
    // codes are accepted by every major scraper).
    for (const tag of OG_TAGS(title, description, canonicalHref, i18n.language)) {
      let el = document.querySelector(
        `meta[${tag.attr}="${tag.key}"]`,
      ) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(tag.attr, tag.key);
        document.head.appendChild(el);
      }
      el.content = tag.content;
    }

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
  }, [t, titleKey, descriptionKey, canonicalPath, location.pathname, i18n.language]);
}
