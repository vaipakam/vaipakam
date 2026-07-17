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

/** Segment-boundary match: `/borrow` and `/borrow/…` — but NOT
 *  `/borrow-old`, which App.tsx routes to NotFound. A bare
 *  startsWith would emit indexable meta for soft-404 URLs under
 *  every public prefix (Codex #1309 r1 P2). */
function inSection(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

function metaForPath(pathname: string): RouteMeta {
  const seo = copy.seo;
  // Section table; aliases (App.tsx `Navigate` routes) never render
  // AppShell content long enough to matter — the canonical of the
  // target route wins after the redirect, and anything unmatched
  // (including alias paths pre-redirect and true 404s) falls to the
  // noindex NotFound row.
  if (pathname === '/') return { ...seo.home, index: true };
  if (inSection(pathname, '/borrow')) return { ...seo.borrow, index: true };
  if (inSection(pathname, '/lend')) return { ...seo.lend, index: true };
  if (inSection(pathname, '/rent')) return { ...seo.rent, index: true };
  if (inSection(pathname, '/offers')) return { ...seo.offers, index: true };
  if (inSection(pathname, '/desk')) return { ...seo.desk, index: true };
  if (inSection(pathname, '/vpfi')) return { ...seo.vpfi, index: true };
  if (inSection(pathname, '/nft')) return { ...seo.nftVerifier, index: true };
  if (inSection(pathname, '/help')) return { ...seo.help, index: true };
  if (inSection(pathname, '/positions')) return { ...seo.positions, index: false };
  if (inSection(pathname, '/claims')) return { ...seo.claims, index: false };
  if (inSection(pathname, '/vault')) return { ...seo.vault, index: false };
  if (inSection(pathname, '/activity')) return { ...seo.activity, index: false };
  if (inSection(pathname, '/settings')) return { ...seo.settings, index: false };
  if (inSection(pathname, '/faucet')) return { ...seo.faucet, index: false };
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
