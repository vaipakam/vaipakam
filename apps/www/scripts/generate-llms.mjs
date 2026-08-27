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
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with `LiveValue.tsx` so the published markdown and the rendered
// pages cannot disagree about what a `{liveValue:...}` token means.
// This script therefore runs under `tsx`, not bare node (#1606 review).
import { substituteLiveValuesInMarkdown } from './liveValueMarkdown.ts';
// The SAME decode + freshness rule the rendered pages apply, not a
// second opinion about the same rail (#1664 item 3).
import { fetchProtocolConfigSnapshot } from '../src/lib/protocolConfigSnapshot.ts';
// Read the same `.env*` files Vite gives the bundle (Codex #1895 r1).
// A process.env-only read here published one deployment's figures while
// the rendered pages consulted another, with nothing saying so.
import { readViteEnv } from './viteEnv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'src', 'content');
const PUBLIC = resolve(__dirname, '..', 'public');
const DOCS_OUT = resolve(PUBLIC, 'docs');

const ORIGIN = (
  readViteEnv('VITE_WWW_PUBLIC_ORIGIN') ?? 'https://vaipakam.com'
).replace(/\/+$/, '');

/**
 * The chain whose published configuration the rendered docs follow —
 * the SAME env var and default `useProtocolConfig` reads, so the live
 * endpoint this index advertises describes the deployment the docs
 * describe. Pointing a crawler at a different chain than the prose
 * would hand it correct-looking figures for someone else's deployment
 * (#1664 items 3 + 4).
 */
const DOCS_CONFIG_CHAIN_ID = readViteEnv('VITE_DOCS_CONFIG_CHAIN_ID') ?? '84532';

/**
 * The indexer this build's pages actually read — same env var, default
 * and trailing-slash normalisation as `useProtocolConfig` (Codex #1821
 * r1 P2). Hard-coding production here made a preview or self-hosted
 * build advertise an indexer its own pages never consult: the chain id
 * would agree while the SERVICE did not, which is the same "figures for
 * someone else's deployment" failure the chain pin exists to prevent.
 */
const INDEXER_ORIGIN = (
  readViteEnv('VITE_INDEXER_ORIGIN') ?? 'https://indexer.vaipakam.com'
).replace(/\/+$/, '');

/**
 * Longer than the browser's 4 s. A reader waiting on a page is the
 * reason that one is short; a build is not, and one slow response
 * should not be the difference between live figures and a refused
 * build.
 */
const CONFIG_TIMEOUT_MS = 20_000;

/**
 * Fetch the published snapshot these exports will quote, and REFUSE to
 * write them if it cannot be had (#1664 item 3).
 *
 * Failing closed is the point. `/docs/*.md` and `llms-full.txt` are
 * static artifacts served until the next deploy — nothing re-fetches
 * them the way a page does — so a build that quietly fell back to
 * compile-time defaults would publish stale rates to AI crawlers
 * indefinitely, with no signal anywhere that it had happened. The
 * rendered pages can degrade gracefully because they retry on every
 * load and label what they are showing; a file cannot do either.
 *
 * `ALLOW_STALE_EXPORTS=1` is the escape hatch, and it is not silent: it
 * says so on stderr and the artifacts are stamped as build-time
 * defaults rather than published values, so the fallback is legible in
 * the output itself and not just in a CI log nobody keeps. Same shape
 * as the existing `REQUIRE_INDEXER_ORIGIN` gate in app's deploy
 * script — a deliberate override, announced.
 */
async function loadPublishedConfig() {
  const snap = await fetchProtocolConfigSnapshot({
    origin: INDEXER_ORIGIN,
    chainId: Number(DOCS_CONFIG_CHAIN_ID),
    timeoutMs: CONFIG_TIMEOUT_MS,
  });
  if (snap) {
    console.log(
      `[generate-llms] published config: ${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID}` +
        ` (updatedAt ${new Date(snap.updatedAt * 1000).toISOString()})`,
    );
    return snap;
  }
  if (process.env.ALLOW_STALE_EXPORTS === '1') {
    console.error(
      '[generate-llms] WARNING: no published config could be read from ' +
        `${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID}.\n` +
        '  ALLOW_STALE_EXPORTS=1 is set, so the exports are being written ' +
        'from BUILD-TIME DEFAULTS.\n' +
        '  They will not reflect a governance retune until a later build ' +
        'reads a live snapshot.',
    );
    return null;
  }
  console.error(
    `[generate-llms] Could not read a published config from ` +
      `${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID}.\n` +
      '\n' +
      '  Refusing to write the machine-readable exports: they are static\n' +
      '  files served until the next deploy, so falling back to build-time\n' +
      '  defaults would publish figures that silently stop matching the\n' +
      '  rendered pages after any governance retune.\n' +
      '\n' +
      '  Either make the indexer reachable, or re-run with\n' +
      '  ALLOW_STALE_EXPORTS=1 to publish build-time defaults deliberately\n' +
      '  (the artifacts then say so).',
  );
  process.exit(1);
}

const publishedConfig = await loadPublishedConfig();

/**
 * The provenance line that goes at the top of EVERY published document.
 *
 * Per document, not only in `llms.txt`, because the document is the unit
 * of consumption: a crawler fetches `docs/overview.en.md` on its own,
 * and an assistant ingests it on its own. A figure with the date kept in
 * a different file is, to that reader, a figure with no date — which is
 * the same failure this whole change is about, moved from "wrong number"
 * to "undated number". An undated number is the one that gets repeated
 * with confidence.
 *
 * An HTML comment so it is invisible in any rendered view of the
 * markdown while still being plain text a machine reader gets for free.
 * Kept to two lines: this is metadata attached to the document, not a
 * preamble competing with its first heading.
 */
function figureProvenanceNote() {
  if (publishedConfig) {
    const stamped = new Date(publishedConfig.updatedAt * 1000).toISOString();
    return (
      `<!-- Protocol figures (fees, VPFI tiers) below are from the published ` +
      `configuration of chain ${DOCS_CONFIG_CHAIN_ID}, stamped ${stamped}. ` +
      `Newer values: ${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID} -->\n\n`
    );
  }
  return (
    `<!-- Protocol figures (fees, VPFI tiers) below are BUILD-TIME DEFAULTS: ` +
    `the published configuration could not be read when this was generated, ` +
    `so they do not reflect any later change. Current values: ` +
    `${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID} -->\n\n`
  );
}

/** content subdir → public URL slug. Locale suffixes carry over
 *  (`Overview.ta.md` → `overview.ta.md`). */
const DOC_SETS = [
  { dir: 'whitepaper', filePrefix: 'Whitepaper', slug: 'whitepaper' },
  { dir: 'overview', filePrefix: 'Overview', slug: 'overview' },
  { dir: 'userguide', filePrefix: 'Basic', slug: 'userguide-basic' },
  { dir: 'userguide', filePrefix: 'Advanced', slug: 'userguide-advanced' },
];

// Recreate from scratch: public/docs/ is generated + gitignored, so a
// deleted/renamed source markdown would otherwise leave its stale copy
// behind for Vite to keep shipping (Codex #1309 r4). Each build's
// public docs exactly match the current src/content set.
rmSync(DOCS_OUT, { recursive: true, force: true });
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
    // Substituted, not copied verbatim (#1606 review). These artifacts
    // are advertised to AI crawlers by llms.txt; publishing them raw left
    // 420 `{liveValue:...}` tokens in the machine-readable surface even
    // after the rendered pages were fixed. Formatted for THIS file's
    // locale, matching what a reader of the same page sees.
    writeFileSync(
      resolve(DOCS_OUT, outName),
      figureProvenanceNote() +
        substituteLiveValuesInMarkdown(
          readFileSync(resolve(srcDir, file), 'utf8'),
          locale,
          publishedConfig?.config ?? null,
        ),
    );
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

${
  publishedConfig
    ? `The protocol figures in these documents (fees, VPFI tier thresholds and
discounts) were read from the published configuration of chain
${DOCS_CONFIG_CHAIN_ID} at ${new Date(publishedConfig.updatedAt * 1000).toISOString()},
and are current as of this build. Each deployment is independently
tunable — for another chain, or for figures newer than this build, read
${INDEXER_ORIGIN}/config/:chainId.`
    : `NOTE: the protocol figures in these documents (fees, VPFI tier
thresholds and discounts) are BUILD-TIME DEFAULTS. The published
configuration could not be read when this build ran, so these figures do
not reflect any later governance retune. For current values read
${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID}.`
}

## Docs

- [Protocol overview](${enUrl('overview')}): friendly product tour${localesFor('overview') ? ` (also: ${localesFor('overview')})` : ''}
- [User guide — Basic](${enUrl('userguide-basic')}): plain-language guide to lending, borrowing, and NFT rental${localesFor('userguide-basic') ? ` (also: ${localesFor('userguide-basic')})` : ''}
- [User guide — Advanced](${enUrl('userguide-advanced')}): advanced-mode features, offer matching, rate desk${localesFor('userguide-advanced') ? ` (also: ${localesFor('userguide-advanced')})` : ''}
- [Technical whitepaper](${enUrl('whitepaper')}): architecture, risk model, liquidation mechanics

## Live protocol data (public JSON API)

Read-only, keyless, CORS-open endpoints served by the indexer at
${INDEXER_ORIGIN} — fetch these instead of scraping the app:

- [GET /offers/stats](${INDEXER_ORIGIN}/offers/stats): open-offer counts and totals
- [GET /offers/active](${INDEXER_ORIGIN}/offers/active): the live offer book
- [GET /offers/markets](${INDEXER_ORIGIN}/offers/markets): quotable (pair, tenor) markets
- [GET /loans/stats](${INDEXER_ORIGIN}/loans/stats): loan counts by status
- [GET /loans/timeseries](${INDEXER_ORIGIN}/loans/timeseries): historical loan activity
- [GET /config/{chainId}](${INDEXER_ORIGIN}/config/${DOCS_CONFIG_CHAIN_ID}): the live protocol configuration — fee rates, discount tiers, thresholds — under a name-keyed \`values\` object. ${
  publishedConfig
    ? `**The docs above carry the published configuration as it stood at the moment named near the top of this file; read this endpoint for anything newer.**`
    : `**The docs above carry the protocol's compiled starting rates, which do not follow a governance retune; read this endpoint for the current figures.**`
} Check \`updatedAt\` (unix seconds) before treating them as current, and skip a response flagged \`stale\` — that means the indexer knows the row predates a governance change it has not yet re-read. These are the RAW configured values: a per-party fee discount is additionally capped at 5000 BPS (50%) when applied, so a \`tierDiscountBps\` above that ceiling is not what any user receives. Each chain runs an independently tunable deployment, so the figures are per-chain; the link points at the one the docs describe
- [GET /](${INDEXER_ORIGIN}/): self-describing index of every public endpoint

## Apps

- [Marketing site + docs](${ORIGIN}/): this site (English at /, localized under /es/, /ta/, …)
- [Connected app](https://defi.vaipakam.com/): the wallet-connected product surface

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
  // The bundle states its own provenance too (Codex #1895 r1). Each
  // document embedded below already carries one, but this is the first
  // thing a reader of llms-full.txt meets, and on the fallback path it
  // is the difference between "defaults, and it says so" and a file of
  // undated figures.
  figureProvenanceNote().trim(),
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
