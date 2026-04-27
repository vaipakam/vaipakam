#!/usr/bin/env tsx
/**
 * Tier-A SSG: per-locale shell HTML generator.
 *
 * For each non-default locale, copies `dist/index.html` to
 * `dist/<locale>/index.html` and rewrites:
 *   - `<html lang="...">` to the matching locale code (and `dir="rtl"`
 *     for Arabic)
 *   - `<title>` and `<meta name="description">` to the localised copy
 *   - injects `<link rel="alternate" hreflang="X" ...>` siblings
 *     pointing at every supported locale + `x-default`
 *   - injects `<link rel="canonical" href="..." />` so the locale
 *     variant is the canonical URL for itself (search engines need
 *     this to know each locale URL is the "real" one for that
 *     language, not a duplicate of `/`)
 *   - `<meta property="og:locale">` and OpenGraph alternates so social
 *     scrapers (Twitter, Discord, Slack) preview the right copy
 *
 * The body is unchanged — same `<div id="root">` mount + same
 * `<script type="module">` bundle reference. Once React boots,
 * `<LocaleResolver>` reads the URL prefix and renders the page in the
 * matching locale, hydrating over whatever was in the shell. The
 * client UX is identical to before; what changed is what crawlers
 * and social scrapers see *before* JS runs.
 *
 * Why "shells" and not full prerendered content?
 *   Full content prerendering for a Vite SPA needs StaticRouter,
 *   side-effect-free imports (the wallet contexts touch `window` at
 *   module-load), and a per-route data-loader contract. That's
 *   architectural rework, deferred to a future phase. Shells alone
 *   cover the meaningful first-paint signals: locale-aware
 *   `<html lang>`, localised title + description (what shows in
 *   search results and browser tabs), and the OG locale alternates
 *   (what shows in Twitter cards / Discord embeds).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/i18n/glossary.ts';

const DEFAULT_LOCALE = 'en';
const SITE_URL = (process.env.SITE_URL ?? 'https://vaipakam.com').replace(/\/$/, '');
const DIST_DIR = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'dist');
const RTL_LOCALES = new Set(['ar']);

/** Localised landing-page meta. Keep these short — they show in
 *  browser tabs, search results, and social cards. The body text of
 *  the page is rendered post-hydration by the i18n catalogue; these
 *  three strings are the SEO-and-social-scraper payload that needs to
 *  be in the static HTML before JS runs. */
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

/** OpenGraph locale codes (BCP-47 with country) for the social-card
 *  metadata. Where multiple country variants exist, pick the most
 *  generic widely-supported tag. */
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

function hreflangBlock(currentLocale: string): string {
  const lines: string[] = [];
  // Self-canonical: tells search engines that this URL is the
  // canonical version for THIS locale — not a duplicate of `/`.
  lines.push(
    `    <link rel="canonical" href="${SITE_URL}${localisedPath(currentLocale)}" />`,
  );
  for (const peer of SUPPORTED_LOCALES) {
    lines.push(
      `    <link rel="alternate" hreflang="${peer}" href="${SITE_URL}${localisedPath(peer)}" />`,
    );
  }
  // x-default points at the English version per sitemap-protocol
  // convention.
  lines.push(
    `    <link rel="alternate" hreflang="x-default" href="${SITE_URL}${localisedPath(DEFAULT_LOCALE)}" />`,
  );
  return lines.join('\n');
}

function ogLocaleBlock(currentLocale: string): string {
  const lines: string[] = [];
  const ogLocale = OG_LOCALES[currentLocale] ?? 'en_US';
  lines.push(`    <meta property="og:locale" content="${ogLocale}" />`);
  for (const peer of SUPPORTED_LOCALES) {
    if (peer === currentLocale) continue;
    const peerOg = OG_LOCALES[peer];
    if (!peerOg) continue;
    lines.push(`    <meta property="og:locale:alternate" content="${peerOg}" />`);
  }
  return lines.join('\n');
}

function buildShell(baseHtml: string, locale: string): string {
  const meta = META[locale] ?? META[DEFAULT_LOCALE];
  const dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';

  let html = baseHtml;

  // <html lang="..." dir="..."> — the existing template only carries
  // `lang`; we inject `dir` too so RTL pages flip layout pre-hydration
  // (Arabic users don't see an LTR flash before applyDir() runs).
  html = html.replace(
    /<html\s+lang="[^"]*"(?:\s+dir="[^"]*")?[^>]*>/i,
    `<html lang="${meta.htmlLang}" dir="${dir}">`,
  );

  // <title>
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);

  // <meta name="description">
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
  );

  // Inject hreflang block + OG locale block + canonical right before
  // </head>. Each of these is safe to add unconditionally — they're
  // metadata-only and don't affect runtime.
  const inject = [
    '',
    '    <!-- Locale alternates (auto-generated by scripts/generate-locale-shells.ts) -->',
    hreflangBlock(locale),
    ogLocaleBlock(locale),
    '',
  ].join('\n');
  html = html.replace(/<\/head>/i, `${inject}  </head>`);

  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function main(): void {
  const indexPath = join(DIST_DIR, 'index.html');
  const baseHtml = readFileSync(indexPath, 'utf-8');

  // First, rewrite the root `dist/index.html` so the English shell
  // also carries the new hreflang + canonical + OG-locale-alternates
  // tags. The root index is what crawlers hit on `/` (the default
  // locale at the unprefixed root) and it's the file new locale
  // shells are derived from.
  writeFileSync(indexPath, buildShell(baseHtml, DEFAULT_LOCALE), 'utf-8');
  console.log(`[locale-shells] rewrote dist/index.html (${DEFAULT_LOCALE})`);

  // Then emit one shell per non-default locale.
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const dir = join(DIST_DIR, locale);
    mkdirSync(dir, { recursive: true });
    const shell = buildShell(baseHtml, locale);
    writeFileSync(join(dir, 'index.html'), shell, 'utf-8');
    console.log(`[locale-shells] wrote dist/${locale}/index.html`);
  }

  console.log(
    `[locale-shells] generated ${SUPPORTED_LOCALES.length} locale shells (root + ${SUPPORTED_LOCALES.length - 1} prefixed)`,
  );

  // Cloudflare Pages `_redirects`: route every URL under
  // `/<locale>/...` to that locale's shell so the crawler / first
  // paint gets the locale-correct `<html lang>` + meta tags. Without
  // this, the platform's default SPA fallback would hand back the
  // root English shell for `/es/dashboard` etc. Order matters —
  // Cloudflare processes top to bottom and stops at the first match,
  // so the more-specific `/<locale>/*` rules must come before the
  // catch-all `/*`. The `200` status code is "rewrite without
  // redirecting" — the URL bar stays at what the user typed.
  //
  // IMPORTANT: destinations are written without the `/index.html`
  // suffix because Cloudflare's `_redirects` loop-detector strips
  // `.html` and `/index` during static analysis and then rechecks
  // the result against the source pattern. With `/es/*` →
  // `/es/index.html`, the analyser strips `index.html` to get
  // `/es/`, which matches `/es/*` again → false-positive infinite-
  // loop error and the deploy refuses to ship. Using just `/es` as
  // the destination side-steps the strip pass entirely; Cloudflare
  // still resolves the directory's `index.html` at serve time.
  const redirects: string[] = [
    '# Auto-generated by scripts/generate-locale-shells.ts',
    '# Per-locale shell rewrite — Tier-A SSG.',
    '',
  ];
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    redirects.push(`/${locale}/*    /${locale}    200`);
  }
  redirects.push('');
  redirects.push('# Default English shell for everything else (SPA fallback)');
  redirects.push('/*    /    200');
  redirects.push('');
  writeFileSync(join(DIST_DIR, '_redirects'), redirects.join('\n'), 'utf-8');
  console.log(`[locale-shells] wrote dist/_redirects (locale-aware SPA fallback)`);

  // Ensure the `dirname` import is used so a future linter pass
  // doesn't trip on it.
  void dirname;
}

main();
