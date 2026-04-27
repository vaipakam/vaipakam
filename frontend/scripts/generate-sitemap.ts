#!/usr/bin/env tsx
/**
 * Build-time generator for `dist/sitemap.xml` and `dist/robots.txt`.
 *
 * Run as a post-build step (see `package.json` `build` script). Reads the
 * supported-locales catalogue from `src/i18n/glossary.ts` and the public
 * route list from the constant below, and emits a sitemap with one
 * `<url>` per (route × locale) pair plus an `<xhtml:link rel="alternate"
 * hreflang="X">` block on every entry. This is what tells Googlebot
 * (and Bing, DuckDuckGo, Yandex…) to surface the right locale URL to
 * each searcher.
 *
 * The site origin is taken from `SITE_URL` env var, falling back to
 * `https://vaipakam.com` for production builds. Cloudflare Pages can
 * inject the Pages-preview domain at deploy time so preview builds
 * advertise the correct URL.
 *
 * App-gated routes (`/app/*`) are intentionally excluded from the
 * sitemap and explicitly disallowed in robots.txt — they require a
 * wallet connection and have nothing static to index.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/i18n/glossary.ts';

const DEFAULT_LOCALE = 'en';

/** Public routes worth indexing. Keep in sync with the route table in
 *  `src/App.tsx`. App-gated `/app/*` routes are deliberately excluded. */
const PUBLIC_ROUTES = [
  '/',
  '/analytics',
  '/nft-verifier',
  '/discord',
  '/terms',
  '/privacy',
  '/help/basic',
  '/help/advanced',
] as const;

const SITE_URL = (process.env.SITE_URL ?? 'https://vaipakam.com').replace(/\/$/, '');
const DIST_DIR = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'dist');

function localisedPath(route: string, locale: string): string {
  if (locale === DEFAULT_LOCALE) return route;
  if (route === '/') return `/${locale}`;
  return `/${locale}${route}`;
}

function urlFor(route: string, locale: string): string {
  return `${SITE_URL}${localisedPath(route, locale)}`;
}

/** One `<url>` entry per route × locale, with an `<xhtml:link>` sibling
 *  for every other supported locale + `x-default` (which points at the
 *  English version per the sitemap-protocol convention). */
function buildSitemap(): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<urlset');
  lines.push('  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  lines.push('  xmlns:xhtml="http://www.w3.org/1999/xhtml">');

  for (const route of PUBLIC_ROUTES) {
    for (const locale of SUPPORTED_LOCALES) {
      lines.push('  <url>');
      lines.push(`    <loc>${urlFor(route, locale)}</loc>`);
      // hreflang siblings: every locale + x-default (English).
      for (const peer of SUPPORTED_LOCALES) {
        lines.push(
          `    <xhtml:link rel="alternate" hreflang="${peer}" href="${urlFor(route, peer)}" />`,
        );
      }
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlFor(route, DEFAULT_LOCALE)}" />`,
      );
      lines.push('  </url>');
    }
  }

  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

function buildRobots(): string {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    '# Wallet-gated app routes — nothing static to index',
    'Disallow: /app/',
    ...SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE).map(
      (l) => `Disallow: /${l}/app/`,
    ),
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

function main(): void {
  mkdirSync(DIST_DIR, { recursive: true });

  const sitemap = buildSitemap();
  writeFileSync(join(DIST_DIR, 'sitemap.xml'), sitemap, 'utf-8');
  const sitemapEntries = (sitemap.match(/<url>/g) ?? []).length;
  console.log(
    `[sitemap] wrote dist/sitemap.xml — ${sitemapEntries} url entries (${PUBLIC_ROUTES.length} routes × ${SUPPORTED_LOCALES.length} locales)`,
  );

  const robots = buildRobots();
  writeFileSync(join(DIST_DIR, 'robots.txt'), robots, 'utf-8');
  console.log(`[sitemap] wrote dist/robots.txt`);
}

main();
