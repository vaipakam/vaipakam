#!/usr/bin/env node
/**
 * Build-time generator for the AI-crawler surface of vaipakam.com:
 *
 *   1. `public/docs/*.md` — the canonical long-form docs (whitepaper,
 *      overview, user guides) copied verbatim from `src/content/` to
 *      stable public URLs. Clean Markdown is the highest-fidelity
 *      input an AI tool can ingest — far better than scraping the
 *      rendered HTML — and the files already exist as the pages'
 *      source of truth, so this costs nothing to maintain.
 *
 *   2. `public/llms.txt` — the llmstxt.org convention: a Markdown
 *      index at the site root telling AI crawlers what this site is
 *      and where the canonical machine-readable resources live
 *      (the raw docs above + the indexer's public JSON API).
 *
 *   3. `public/llms-full.txt` — single-file concatenation of the
 *      English docs for tools that prefer one fetch.
 *
 * Wired to `prebuild` alongside generate-sitemap.mjs; outputs are
 * gitignored (regenerated every build).
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'src', 'content');
const PUBLIC = resolve(__dirname, '..', 'public');
const DOCS_OUT = resolve(PUBLIC, 'docs');

const ORIGIN = (
  process.env.VITE_WWW_PUBLIC_ORIGIN ?? 'https://vaipakam.com'
).replace(/\/+$/, '');

/** content subdir → public URL slug. Locale suffixes carry over
 *  (`Overview.ta.md` → `overview.ta.md`). */
const DOC_SETS = [
  { dir: 'whitepaper', filePrefix: 'Whitepaper', slug: 'whitepaper' },
  { dir: 'overview', filePrefix: 'Overview', slug: 'overview' },
  { dir: 'userguide', filePrefix: 'Basic', slug: 'userguide-basic' },
  { dir: 'userguide', filePrefix: 'Advanced', slug: 'userguide-advanced' },
];

mkdirSync(DOCS_OUT, { recursive: true });

const published = []; // { slug, locale, url }
for (const set of DOC_SETS) {
  const srcDir = resolve(SRC, set.dir);
  for (const file of readdirSync(srcDir)) {
    const m = file.match(
      new RegExp(`^${set.filePrefix}\\.([a-z]{2})\\.md$`),
    );
    if (!m) continue;
    const locale = m[1];
    const outName = `${set.slug}.${locale}.md`;
    copyFileSync(resolve(srcDir, file), resolve(DOCS_OUT, outName));
    published.push({ slug: set.slug, locale, url: `${ORIGIN}/docs/${outName}` });
  }
}

// ── llms.txt ─────────────────────────────────────────────────────────
const enUrl = (slug) =>
  published.find((p) => p.slug === slug && p.locale === 'en')?.url;

const localesFor = (slug) =>
  published
    .filter((p) => p.slug === slug && p.locale !== 'en')
    .map((p) => p.locale)
    .sort()
    .join(', ');

const llms = `# Vaipakam

> Vaipakam is a decentralized, non-custodial peer-to-peer lending, borrowing and NFT rental protocol. Users set their own terms and deal vault-to-vault — every user's assets sit in their own on-chain smart-contract vault; there is no shared pool and no middleman. Interest rates, durations, and collateral are chosen per offer by the participants.

Key facts:
- Smart contracts use the EIP-2535 Diamond standard; per-user vaults are isolated UUPS proxies.
- Two liquidation paths: health-factor based (for price-feed assets) and time-based on default.
- NFT rental (ERC-4907) with prepaid fees; renters get use rights, never ownership.
- VPFI is an optional fee-discount token — never required to lend, borrow, or rent.
- No KYC; wallets are screened against an on-chain sanctions oracle only.

## Docs

- [Protocol overview](${enUrl('overview')}): friendly product tour${localesFor('overview') ? ` (also: ${localesFor('overview')})` : ''}
- [User guide — Basic](${enUrl('userguide-basic')}): plain-language guide to lending, borrowing, and NFT rental${localesFor('userguide-basic') ? ` (also: ${localesFor('userguide-basic')})` : ''}
- [User guide — Advanced](${enUrl('userguide-advanced')}): advanced-mode features, offer matching, rate desk${localesFor('userguide-advanced') ? ` (also: ${localesFor('userguide-advanced')})` : ''}
- [Technical whitepaper](${enUrl('whitepaper')}): architecture, risk model, liquidation mechanics

## Live protocol data (public JSON API)

Read-only, keyless, CORS-open endpoints served by the indexer at
https://indexer.vaipakam.com — fetch these instead of scraping the app:

- [GET /offers/stats](https://indexer.vaipakam.com/offers/stats): open-offer counts and totals
- [GET /offers/active](https://indexer.vaipakam.com/offers/active): the live offer book
- [GET /offers/markets](https://indexer.vaipakam.com/offers/markets): quotable (pair, tenor) markets
- [GET /loans/stats](https://indexer.vaipakam.com/loans/stats): loan counts by status
- [GET /loans/timeseries](https://indexer.vaipakam.com/loans/timeseries): historical loan activity
- [GET /](https://indexer.vaipakam.com/): self-describing index of every public endpoint

## Apps

- [Marketing site + docs](${ORIGIN}/): this site (English at /, localized under /es/, /ta/, …)
- [Connected app](https://alpha02.vaipakam.com/): the wallet-connected product surface

## Optional

- [llms-full.txt](${ORIGIN}/llms-full.txt): all English docs concatenated in one file
- [Sitemap](${ORIGIN}/sitemap.xml)
`;

writeFileSync(resolve(PUBLIC, 'llms.txt'), llms);

// ── llms-full.txt — English docs, one fetch ─────────────────────────
const FULL_ORDER = ['overview', 'userguide-basic', 'userguide-advanced', 'whitepaper'];
const fullParts = [
  '# Vaipakam — full documentation bundle',
  '',
  `Generated from the canonical docs on ${ORIGIN}. See ${ORIGIN}/llms.txt for the index.`,
  '',
];
for (const slug of FULL_ORDER) {
  const entry = published.find((p) => p.slug === slug && p.locale === 'en');
  if (!entry) continue;
  fullParts.push('');
  fullParts.push('---');
  fullParts.push('');
  fullParts.push(readFileSync(resolve(DOCS_OUT, `${slug}.en.md`), 'utf8'));
}
writeFileSync(resolve(PUBLIC, 'llms-full.txt'), fullParts.join('\n'));

console.log(
  `[llms] published ${published.length} raw docs → /docs/, plus llms.txt + llms-full.txt`,
);
