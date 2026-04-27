#!/usr/bin/env tsx
/**
 * Post-build SEO meta injection — landing-page-only locale shells.
 *
 * Two outputs per build:
 *
 *   1. `dist/index.html` (English root) gets the hreflang + canonical
 *      + OG-locale-alternate block injected before `</head>`.
 *
 *   2. `dist/<locale>/index.html` per non-default locale — a copy of
 *      the English root index with `<html lang>` / `<title>` /
 *      `<meta description>` swapped to the locale's text, plus a
 *      locale-pointed canonical and the same hreflang block. Arabic
 *      additionally carries `dir="rtl"` on `<html>` so RTL layout
 *      applies pre-hydration.
 *
 * **No `_redirects` file is written** — and that's deliberate.
 * Earlier iterations rewrote `/<locale>/*` sub-routes to a per-locale
 * shell via `_redirects`, which interacted badly with Cloudflare
 * Workers Static Assets' `auto-trailing-slash` html_handling and
 * collapsed the URL bar (e.g. a deep link to `/ta/help/advanced`
 * landed at `/ta/`, dropping the route segment). The hardened
 * design here:
 *
 *   - Direct hits at `/<locale>/` (sitemap URLs, hand-typed,
 *     bookmarked, social-card scrapes, search results) are served by
 *     Cloudflare's asset matcher straight from `dist/<locale>/index.html`,
 *     so the crawler / scraper sees locale-correct meta before any JS
 *     runs. **This is where SEO actually matters** — landing pages
 *     are the bulk of indexed and shared URLs.
 *
 *   - Sub-routes like `/<locale>/dashboard` or `/<locale>/help/advanced`
 *     fall through to
 *     `wrangler.jsonc.assets.not_found_handling: "single-page-application"`,
 *     which serves the English `dist/index.html`. React Router boots,
 *     `LocaleResolver` reads the URL prefix, i18next switches to the
 *     locale, and the page renders correctly. First-paint is English
 *     for those URLs, but they're a tiny fraction of organic traffic
 *     and the user-facing UX is identical post-hydration.
 *
 *   - A bare `/<locale>` (no trailing slash) gets a single 301
 *     redirect from Cloudflare's `auto-trailing-slash` rule to
 *     `/<locale>/`. That's fine — single redirect, no chain, no URL
 *     fragment to lose, lands on the canonical form.
 *
 * **No sibling `dist/<locale>.html` files** — having both
 * `/<locale>.html` and `/<locale>/index.html` in dist confused
 * Cloudflare's `auto-trailing-slash` normalisation and 301'd
 * `/<locale>/` to `/<locale>` (drop slash). Only the directory-index
 * form is emitted now.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSLATED_LOCALES } from '../src/i18n/glossary.ts';

const DEFAULT_LOCALE = 'en';
const SITE_URL = (process.env.SITE_URL ?? 'https://vaipakam.com').replace(/\/$/, '');
const DIST_DIR = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'dist');
const RTL_LOCALES = new Set(['ar']);

interface LocaleMeta {
  htmlLang: string;
  title: string;
  description: string;
}

const META: Record<string, LocaleMeta> = {
  en: {
    htmlLang: 'en',
    title: 'Vaipakam | Decentralized P2P Lending & NFT Rentals',
    description:
      'Lend and borrow ERC-20 tokens. Rent NFTs. Set your own terms. Trustless, transparent, fully on-chain.',
  },
  es: {
    htmlLang: 'es',
    title: 'Vaipakam | Préstamos P2P descentralizados y alquiler de NFT',
    description:
      'Presta y pide prestados tokens ERC-20. Alquila NFT. Define tus propios términos. Sin custodia, transparente, totalmente on-chain.',
  },
  fr: {
    htmlLang: 'fr',
    title: 'Vaipakam | Prêts P2P décentralisés et location de NFT',
    description:
      'Prêtez et empruntez des tokens ERC-20. Louez des NFT. Définissez vos propres conditions. Sans confiance, transparent, entièrement on-chain.',
  },
  de: {
    htmlLang: 'de',
    title: 'Vaipakam | Dezentralisiertes P2P-Lending & NFT-Vermietung',
    description:
      'Verleihen und leihen Sie ERC-20-Token. Mieten Sie NFTs. Setzen Sie Ihre eigenen Bedingungen. Vertrauenslos, transparent, vollständig on-chain.',
  },
  ja: {
    htmlLang: 'ja',
    title: 'Vaipakam | 分散型P2P貸付・NFTレンタル',
    description:
      'ERC-20トークンの貸付・借入、NFTのレンタル。条件は自分で設定。トラストレス・透明・完全オンチェーン。',
  },
  zh: {
    htmlLang: 'zh',
    title: 'Vaipakam | 去中心化点对点借贷与NFT租赁',
    description:
      '借出与借入 ERC-20 代币,租赁 NFT。自定义条款。无需信任、透明、完全链上运行。',
  },
  ko: {
    htmlLang: 'ko',
    title: 'Vaipakam | 탈중앙화 P2P 대출 및 NFT 임대',
    description:
      'ERC-20 토큰 대출과 차입, NFT 임대. 직접 조건을 설정하세요. 트러스트리스, 투명, 완전 온체인.',
  },
  hi: {
    htmlLang: 'hi',
    title: 'Vaipakam | विकेन्द्रीकृत P2P ऋण और NFT किराया',
    description:
      'ERC-20 टोकन उधार दें और लें। NFT किराए पर लें। अपनी शर्तें खुद तय करें। ट्रस्टलेस, पारदर्शी, पूरी तरह ऑन-चेन।',
  },
  ta: {
    htmlLang: 'ta',
    title: 'Vaipakam | பரவலாக்கப்பட்ட P2P கடன் வழங்கல் & NFT வாடகை',
    description:
      'ERC-20 டோக்கன்களை கடன் வழங்கி/பெறுங்கள். NFT-களை வாடகைக்கு எடுங்கள். உங்கள் விதிமுறைகளை அமைக்கவும். நம்பிக்கையற்ற, வெளிப்படையான, முழுமையாக ஆன்-செயின்.',
  },
  ar: {
    htmlLang: 'ar',
    title: 'Vaipakam | إقراض P2P لامركزي وتأجير NFT',
    description:
      'أقرض واقترض رموز ERC-20. استأجر NFTs. حدد شروطك الخاصة. بلا حفظ مركزي، شفاف، بالكامل على السلسلة.',
  },
};

const OG_LOCALES: Record<string, string> = {
  en: 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
  de: 'de_DE',
  ja: 'ja_JP',
  zh: 'zh_CN',
  ko: 'ko_KR',
  hi: 'hi_IN',
  ta: 'ta_IN',
  ar: 'ar_AR',
};

function localisedPath(locale: string): string {
  return locale === DEFAULT_LOCALE ? '/' : `/${locale}/`;
}

function metaBlock(currentLocale: string): string {
  const lines: string[] = [
    '    <!-- SEO locale alternates (auto-generated by scripts/inject-seo-meta.ts) -->',
    `    <link rel="canonical" href="${SITE_URL}${localisedPath(currentLocale)}" />`,
  ];
  for (const peer of TRANSLATED_LOCALES) {
    lines.push(
      `    <link rel="alternate" hreflang="${peer}" href="${SITE_URL}${localisedPath(peer)}" />`,
    );
  }
  lines.push(
    `    <link rel="alternate" hreflang="x-default" href="${SITE_URL}${localisedPath(DEFAULT_LOCALE)}" />`,
  );
  const ogLocale = OG_LOCALES[currentLocale] ?? 'en_US';
  lines.push(`    <meta property="og:locale" content="${ogLocale}" />`);
  for (const peer of TRANSLATED_LOCALES) {
    if (peer === currentLocale) continue;
    const peerOg = OG_LOCALES[peer];
    if (!peerOg) continue;
    lines.push(`    <meta property="og:locale:alternate" content="${peerOg}" />`);
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a locale-variant shell from the root index.html. Swaps
 * `<html lang>` (and `dir` for RTL), `<title>`, and `<meta
 * description>` to the locale's copy; injects the hreflang block
 * with the locale-pointed canonical so search engines treat each
 * `/<locale>/` URL as the canonical version for that language.
 */
function buildShell(baseHtml: string, locale: string): string {
  const meta = META[locale] ?? META[DEFAULT_LOCALE];
  const dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';

  let html = baseHtml;

  html = html.replace(
    /<html\s+lang="[^"]*"(?:\s+dir="[^"]*")?[^>]*>/i,
    `<html lang="${meta.htmlLang}" dir="${dir}">`,
  );
  html = html.replace(
    /<title>[^<]*<\/title>/i,
    `<title>${escapeHtml(meta.title)}</title>`,
  );
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
  );

  // Strip any pre-existing meta block from a prior pass (the English
  // root index.html already carries one — this prevents stacking
  // duplicates when a locale shell is derived from it).
  html = html.replace(
    /\s*<!-- SEO locale alternates[\s\S]*?<meta property="og:locale:alternate" content="[^"]*" \/>(?:\s*<meta property="og:locale:alternate" content="[^"]*" \/>)*/i,
    '',
  );

  const inject = ['', metaBlock(locale), ''].join('\n');
  html = html.replace(/<\/head>/i, `${inject}  </head>`);

  return html;
}

function main(): void {
  const indexPath = join(DIST_DIR, 'index.html');
  const baseHtml = readFileSync(indexPath, 'utf-8');

  // English root: keep its original lang/title/description, just
  // inject the hreflang + OG-locale block.
  const englishMetaInject = ['', metaBlock(DEFAULT_LOCALE), ''].join('\n');
  const englishHtml = baseHtml.replace(
    /<\/head>/i,
    `${englishMetaInject}  </head>`,
  );
  writeFileSync(indexPath, englishHtml, 'utf-8');
  console.log(`[inject-seo-meta] injected meta block into dist/index.html`);

  // Per-locale landing-page shells. Only `dist/<locale>/index.html`
  // is emitted — no sibling `<locale>.html`, no `_redirects`. See
  // the header comment for why.
  for (const locale of TRANSLATED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const dir = join(DIST_DIR, locale);
    mkdirSync(dir, { recursive: true });
    const shell = buildShell(baseHtml, locale);
    writeFileSync(join(dir, 'index.html'), shell, 'utf-8');
    console.log(`[inject-seo-meta] wrote dist/${locale}/index.html`);
  }

  console.log(
    `[inject-seo-meta] generated ${TRANSLATED_LOCALES.length} landing-page shells (root + ${TRANSLATED_LOCALES.length - 1} prefixed); no _redirects (relies on wrangler not_found_handling for sub-routes)`,
  );
}

main();
