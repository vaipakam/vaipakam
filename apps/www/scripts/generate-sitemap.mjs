#!/usr/bin/env node
/**
 * Build-time sitemap.xml + robots.txt generator for the
 * www.vaipakam.com marketing site.
 *
 * Why both files in one script: they are tightly coupled — robots.txt
 * names the sitemap URL, and a stale combination is the most common
 * source of "Google can't find my pages" issues. Generating both in
 * the same pass guarantees they agree.
 *
 * Output:
 *   - apps/www/public/sitemap.xml — every (route × translated-locale)
 *     pair, with `<xhtml:link rel="alternate" hreflang>` siblings so
 *     Google indexes each locale variant as part of one page-group
 *     instead of treating them as duplicates.
 *   - apps/www/public/robots.txt — opens crawling for every UA and
 *     points at the sitemap.
 *
 * Wired to `prebuild` in apps/www/package.json so a clean
 * `pnpm --filter ./apps/www build` regenerates both before Vite
 * runs. The generated files land in `public/`, which Vite copies
 * verbatim into `dist/` so Cloudflare Workers Static Assets serves
 * them at the site root (`/sitemap.xml` and `/robots.txt`).
 *
 * Site origin: defaults to `https://www.vaipakam.com` — the canonical
 * post-cutover URL. The legacy `labs.vaipakam.com` host is served by
 * a Cloudflare Bulk Redirect rule that 301s every path to the
 * matching www URL, so both backlinks and crawler-cached entries
 * recover. Override the origin via `VITE_WWW_PUBLIC_ORIGIN` at build
 * time for staging deploys.
 *
 * Locale list: must match `TRANSLATED_LOCALES` in
 * `apps/www/src/i18n/glossary.ts`. Listing a placeholder locale
 * here would advertise non-existent translated pages to crawlers,
 * which is a self-inflicted ranking penalty. The list is duplicated
 * here (rather than imported) because this script runs as a Node
 * `.mjs` and the TS source isn't transpiled at sitemap-gen time —
 * the comment above flags the contract; CI could add a guard later
 * if drift becomes a problem.
 *
 * Route list: must match the marketing routes in
 * `apps/www/src/App.tsx`. Same duplication justification. Adding
 * a new marketing route is "edit two files" and that's by design —
 * an in-app route that shouldn't be indexed (e.g. a per-user page)
 * just doesn't get added here, and the absence is the indexing
 * decision.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORIGIN = (
  process.env.VITE_WWW_PUBLIC_ORIGIN ?? 'https://www.vaipakam.com'
).replace(/\/+$/, '');

// Locales with shipping translation bundles — mirrors
// `TRANSLATED_LOCALES` in apps/labs/src/i18n/glossary.ts.
const LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'ja',
  'zh',
  'hi',
  'ar',
  'ta',
  'ko',
];

// Marketing routes — mirrors apps/labs/src/App.tsx. Sitemap order
// matches likely-importance for the crawler's first-pass scan
// (landing → buy-vpfi → docs → legal). Search-engine sitemaps don't
// formally rank by file order, but the loose convention helps when
// a crawler imposes a soft URL budget on huge sitemaps.
const ROUTES = [
  '/',
  '/buy-vpfi',
  '/help/overview',
  '/help/basic',
  '/help/advanced',
  '/help/technical',
  '/help/search',
  '/discord',
  '/terms',
  '/privacy',
  '/data-rights',
];

/** Compose a localised URL — English at the unprefixed root, every
 *  other locale gets a `/<locale>/` prefix. Mirrors the
 *  `withLocalePrefix` helper in apps/labs/src/components/LocaleResolver.tsx;
 *  duplicated here for the same Node-can't-import-TS reason. */
function localizedPath(route, locale) {
  if (locale === 'en') return route;
  if (route === '/') return `/${locale}`;
  return `/${locale}${route}`;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
      'xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  );

  for (const route of ROUTES) {
    for (const locale of LOCALES) {
      const loc = `${ORIGIN}${localizedPath(route, locale)}`;
      lines.push('  <url>');
      lines.push(`    <loc>${escapeXml(loc)}</loc>`);
      lines.push(`    <lastmod>${today}</lastmod>`);
      // Per-locale alternates — every URL in this <url> entry's
      // group lists every other locale's variant as an alternate,
      // plus an x-default pointing at the English (root) variant.
      // Google uses these to dedupe locale variants under one
      // canonical group instead of treating them as duplicate
      // content competing for ranking.
      for (const alt of LOCALES) {
        const altLoc = `${ORIGIN}${localizedPath(route, alt)}`;
        lines.push(
          `    <xhtml:link rel="alternate" hreflang="${alt}" href="${escapeXml(
            altLoc,
          )}" />`,
        );
      }
      const xDefault = `${ORIGIN}${localizedPath(route, 'en')}`;
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(
          xDefault,
        )}" />`,
      );
      // Priority + changefreq are advisory — Google ignores them
      // in 2026 — but Bing / Yandex / DuckDuckGo still consult
      // them. Landing page is highest, docs medium, legal lowest.
      let priority;
      if (route === '/') priority = '1.0';
      else if (route.startsWith('/help/')) priority = '0.8';
      else if (route === '/buy-vpfi') priority = '0.9';
      else priority = '0.5';
      lines.push(`    <priority>${priority}</priority>`);
      lines.push('  </url>');
    }
  }

  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

function buildRobots() {
  // `Allow: /` is implied by the absence of `Disallow`, but
  // emitting it explicitly makes the file's intent unambiguous to
  // operator-eyeball reviews.
  return [
    '# Vaipakam marketing site — public crawl policy.',
    '# Generated by apps/labs/scripts/generate-sitemap.mjs',
    `# at ${new Date().toISOString()}`,
    '',
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

function main() {
  const publicDir = resolve(__dirname, '..', 'public');
  mkdirSync(publicDir, { recursive: true });
  const sitemapPath = resolve(publicDir, 'sitemap.xml');
  const robotsPath = resolve(publicDir, 'robots.txt');
  writeFileSync(sitemapPath, buildSitemap(), 'utf8');
  writeFileSync(robotsPath, buildRobots(), 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `[sitemap] wrote ${sitemapPath} (${ROUTES.length} routes × ${LOCALES.length} locales = ${ROUTES.length * LOCALES.length} URLs)`,
  );
  // eslint-disable-next-line no-console
  console.log(`[sitemap] wrote ${robotsPath}`);
}

main();
