/**
 * Route-driven SEO metadata — one table for the whole app instead of
 * a per-page hook call (adapted from apps/www's usePageMeta; an app
 * with a closed route set is better served by a single source of
 * truth mounted once in AppShell).
 *
 * Per route it maintains four head tags:
 *   1. `document.title`            — browser tab + search-result heading
 *   2. `<meta name="description">` — search-result snippet (public
 *                                    routes only)
 *   3. `<link rel="canonical">`    — absolute, pinned to the
 *                                    production origin so a staging /
 *                                    preview host can never leak into
 *                                    the index as a duplicate
 *   4. `<meta name="robots">`      — `noindex` on wallet-gated,
 *                                    per-user surfaces (positions,
 *                                    claims, vault, activity,
 *                                    settings, faucet). Backed up by
 *                                    X-Robots-Tag rules in
 *                                    `public/_headers` so even a
 *                                    JS-less crawler sees the policy.
 *
 * Indexing policy (mirrors the sitemap in scripts/generate-seo.mjs):
 * generic product surfaces are indexable; anything keyed to the
 * connected wallet is not. NotFound renders noindex so soft-404 URLs
 * don't accumulate in the index.
 *
 * Titles/descriptions come from `copy.seo.*`, so they translate with
 * the rest of the catalog once locale bundles land.
 */

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { copy } from '../content/copy';

/** Production origin every canonical is rooted at. Hardcoded on
 *  purpose (same rationale as www): the canonical is what crawlers
 *  index, and that must be the production hostname even on preview
 *  builds. Update at the alpha02 → defi cutover. */
const CANONICAL_ORIGIN = 'https://alpha02.vaipakam.com';

interface RouteMeta {
  title: string;
  description?: string;
  /** false → emit `<meta name="robots" content="noindex">`. */
  index: boolean;
}

function metaForPath(pathname: string): RouteMeta {
  const seo = copy.seo;
  // Longest-prefix table; aliases (App.tsx `Navigate` routes) never
  // render AppShell content long enough to matter — the canonical of
  // the target route wins after the redirect.
  if (pathname === '/') return { ...seo.home, index: true };
  if (pathname.startsWith('/borrow')) return { ...seo.borrow, index: true };
  if (pathname.startsWith('/lend')) return { ...seo.lend, index: true };
  if (pathname.startsWith('/rent')) return { ...seo.rent, index: true };
  if (pathname.startsWith('/offers')) return { ...seo.offers, index: true };
  if (pathname.startsWith('/desk')) return { ...seo.desk, index: true };
  if (pathname.startsWith('/vpfi')) return { ...seo.vpfi, index: true };
  if (pathname.startsWith('/nft')) return { ...seo.nftVerifier, index: true };
  if (pathname.startsWith('/help')) return { ...seo.help, index: true };
  if (pathname.startsWith('/positions')) return { ...seo.positions, index: false };
  if (pathname.startsWith('/claims')) return { ...seo.claims, index: false };
  if (pathname.startsWith('/vault')) return { ...seo.vault, index: false };
  if (pathname.startsWith('/activity')) return { ...seo.activity, index: false };
  if (pathname.startsWith('/settings')) return { ...seo.settings, index: false };
  if (pathname.startsWith('/faucet')) return { ...seo.faucet, index: false };
  return { ...seo.notFound, index: false };
}

function upsertMeta(name: string, content: string): HTMLMetaElement {
  let tag = document.querySelector(
    `meta[name="${name}"]`,
  ) as HTMLMetaElement | null;
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = name;
    document.head.appendChild(tag);
  }
  tag.content = content;
  return tag;
}

export function SeoMeta() {
  const { pathname } = useLocation();
  // Subscribes this component to language changes so head tags
  // re-resolve — it renders no DOM, so it sits outside the
  // LanguageRemount subtree's copy-proxy re-evaluation guarantee.
  const { i18n } = useTranslation();

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const meta = metaForPath(pathname);

    document.title = meta.title;

    if (meta.description) upsertMeta('description', meta.description);

    // Robots policy. The tag is written for noindex routes and
    // REMOVED for indexable ones (a stale noindex left behind after
    // a client-side navigation would silently deindex a public page).
    const robots = document.querySelector('meta[name="robots"]');
    if (!meta.index) {
      upsertMeta('robots', 'noindex');
    } else if (robots) {
      robots.remove();
    }

    // Canonical — absolute, production-origin, query dropped
    // (no route uses canonical query parameters today).
    const path = pathname.replace(/\/+$/, '') || '/';
    let canonical = document.querySelector(
      'link[rel="canonical"]',
    ) as HTMLLinkElement | null;
    if (meta.index) {
      if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.appendChild(canonical);
      }
      canonical.href =
        path === '/' ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${path}`;
    } else if (canonical) {
      // A canonical on a noindex page is contradictory — drop it.
      canonical.remove();
    }
  }, [pathname, i18n.resolvedLanguage]);

  return null;
}
