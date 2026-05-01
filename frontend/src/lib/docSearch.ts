/**
 * Hybrid documentation search — client-side index for the four `/help/*`
 * doc kinds (Overview, User Guide Basic, User Guide Advanced,
 * Whitepaper). The index is built once at module load from the same
 * eagerly-imported markdown files the pages already consume, so adding
 * search costs zero extra network at runtime.
 *
 * Why client-side over Google Programmable Search Engine:
 *   - The markdown is already in the bundle (eagerly imported as raw
 *     strings by the page components — same `import.meta.glob` pattern
 *     reused here so we don't double-fetch).
 *   - Section anchors are already extracted by `extractMarkdownToc`,
 *     so each search hit can deep-link to `<route>#<slug>` for free.
 *   - Locale-aware naturally — index only the active locale's files
 *     plus the English-only Whitepaper.
 *   - No third-party tracking, no quota, no crawler-lag for
 *     freshly-deployed sections.
 *
 * The companion "search the web ↗" link rendered by the search page
 * covers the case where a user wants Google's web-style search across
 * the live site — that's a single `<a href>` to
 * `google.com/search?q=site:vaipakam.com+<query>`, no SDK, no embed.
 */

import type { TFunction } from 'i18next';

/**
 * The four doc kinds the search covers. The route + label mapping
 * lives in {@link docKindMeta}. Keeping the enum small and string-
 * literal-typed makes filtering + grouping straightforward downstream
 * without an enum import dance.
 */
export type DocKind = 'overview' | 'userguide-basic' | 'userguide-advanced' | 'whitepaper';

export interface DocKindMeta {
  /** In-app route the hit links to — combined with `#<anchor>` per
   *  hit to land on the exact section. */
  route: (locale: string) => string;
  /** i18n key for the human-readable doc-kind label rendered in the
   *  results list. */
  labelKey: string;
}

export const DOC_KIND_META: Record<DocKind, DocKindMeta> = {
  overview: {
    route: (locale) => withLocale('/help/overview', locale),
    labelKey: 'helpSearch.docKind.overview',
  },
  'userguide-basic': {
    route: (locale) => withLocale('/help/basic', locale),
    labelKey: 'helpSearch.docKind.userguideBasic',
  },
  'userguide-advanced': {
    route: (locale) => withLocale('/help/advanced', locale),
    labelKey: 'helpSearch.docKind.userguideAdvanced',
  },
  whitepaper: {
    // Whitepaper is English-only — the route never carries a locale
    // prefix, so the `withLocale` indirection is skipped.
    route: () => '/help/technical',
    labelKey: 'helpSearch.docKind.whitepaper',
  },
};

function withLocale(path: string, locale: string): string {
  return locale === 'en' ? path : `/${locale}${path}`;
}

// ─── Markdown ingestion ───────────────────────────────────────────────

const OVERVIEW_FILES = import.meta.glob('../content/overview/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const USERGUIDE_FILES = import.meta.glob('../content/userguide/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const WHITEPAPER_FILES = import.meta.glob('../content/whitepaper/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

// ─── Slug derivation ─────────────────────────────────────────────────
// Mirrors `slugify` in lib/markdownToc — kept private here to avoid a
// circular import (markdownToc imports React, and a search index built
// at module scope shouldn't pull React in transitively for environments
// like SSR pre-rendering).

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ─── Section slicing ─────────────────────────────────────────────────

interface RawSection {
  /** Heading text — used for the section title in results. */
  title: string;
  /** GitHub-style slug of `title` — matches the `id="..."` installed by
   *  `headingComponents` so deep links work. */
  anchor: string;
  /** Plain text body of the section (heading + everything until the
   *  next H2/H3). Lowercased copy lives in {@link IndexedSection.lc}
   *  so we don't recompute on every keystroke. */
  body: string;
}

/**
 * Walk the raw markdown line-by-line, slicing into sections at every
 * H2 or H3 boundary. Code-fence aware so a `## foo` line inside a
 * fenced block doesn't cleave the section.
 *
 * The first chunk before any heading (intro paragraph, frontmatter
 * residue) is dropped — it has no anchor to deep-link to and surfaces
 * as orphan noise in results.
 */
function sliceSections(raw: string): RawSection[] {
  const lines = raw.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  let inCodeFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      if (current) current.body += line + '\n';
      continue;
    }
    if (!inCodeFence) {
      const h = /^(#{2,3})\s+(.+)$/.exec(line);
      if (h) {
        const title = h[2].trim();
        current = { title, anchor: slugify(title), body: title + '\n' };
        sections.push(current);
        continue;
      }
    }
    if (current) current.body += line + '\n';
  }

  // Drop sections with empty body — happens when two headings sit
  // adjacent with nothing between them. Empty body matches every
  // query and pollutes results.
  return sections.filter((s) => s.body.trim().length > s.title.length);
}

// ─── Build-time index ────────────────────────────────────────────────

interface IndexedSection {
  docKind: DocKind;
  locale: string;
  title: string;
  anchor: string;
  body: string;
  /** Pre-lowercased body for cheap case-insensitive substring match. */
  lc: string;
}

/**
 * Build the flat index across all four doc kinds for a given locale.
 * Whitepaper always uses its English file regardless of locale (it's
 * intentionally English-only).
 *
 * Memoized per locale so language toggles don't re-slice the markdown.
 */
const indexCache = new Map<string, IndexedSection[]>();

function buildIndex(locale: string): IndexedSection[] {
  const cached = indexCache.get(locale);
  if (cached) return cached;

  const out: IndexedSection[] = [];

  const pushFrom = (
    raw: string,
    docKind: DocKind,
    fileLocale: string,
  ): void => {
    if (!raw) return;
    for (const sec of sliceSections(raw)) {
      out.push({
        docKind,
        locale: fileLocale,
        title: sec.title,
        anchor: sec.anchor,
        body: sec.body,
        lc: sec.body.toLowerCase(),
      });
    }
  };

  const overviewKey = `../content/overview/Overview.${locale}.md`;
  pushFrom(
    OVERVIEW_FILES[overviewKey] ?? OVERVIEW_FILES['../content/overview/Overview.en.md'] ?? '',
    'overview',
    OVERVIEW_FILES[overviewKey] ? locale : 'en',
  );

  const basicKey = `../content/userguide/Basic.${locale}.md`;
  pushFrom(
    USERGUIDE_FILES[basicKey] ?? USERGUIDE_FILES['../content/userguide/Basic.en.md'] ?? '',
    'userguide-basic',
    USERGUIDE_FILES[basicKey] ? locale : 'en',
  );

  const advancedKey = `../content/userguide/Advanced.${locale}.md`;
  pushFrom(
    USERGUIDE_FILES[advancedKey] ?? USERGUIDE_FILES['../content/userguide/Advanced.en.md'] ?? '',
    'userguide-advanced',
    USERGUIDE_FILES[advancedKey] ? locale : 'en',
  );

  // Whitepaper is intentionally English-only.
  pushFrom(
    WHITEPAPER_FILES['../content/whitepaper/Whitepaper.en.md'] ?? '',
    'whitepaper',
    'en',
  );

  indexCache.set(locale, out);
  return out;
}

// ─── Public search API ───────────────────────────────────────────────

export interface SearchHit {
  docKind: DocKind;
  /** Localised label for the doc kind, resolved by the caller via the
   *  passed `t()`. Pre-baked into the hit so the results list can map
   *  straight to `<a>` rendering without re-resolving. */
  docKindLabel: string;
  title: string;
  anchor: string;
  /** In-app href — e.g. `/help/basic#offer-card`. Caller renders it
   *  through `<Link>` or `<a>` as appropriate. */
  href: string;
  /** Short snippet of body text around the first match, split into
   *  three pieces so the renderer wraps the match in <mark> without
   *  re-running a regex on the output. */
  snippet: { prefix: string; match: string; suffix: string };
  /** Number of times the query string appears in the section body —
   *  used for ranking. */
  count: number;
}

const SNIPPET_RADIUS = 80; // chars of context on each side of the match

function buildSnippet(body: string, lc: string, query: string, queryLc: string): { prefix: string; match: string; suffix: string } {
  const idx = lc.indexOf(queryLc);
  if (idx < 0) {
    return { prefix: body.slice(0, 160), match: '', suffix: '' };
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + query.length + SNIPPET_RADIUS);
  const matchOriginal = body.slice(idx, idx + query.length);
  const prefixRaw = body.slice(start, idx);
  const suffixRaw = body.slice(idx + query.length, end);
  const prefix = (start > 0 ? '… ' : '') + prefixRaw.replace(/\s+/g, ' ').trimStart();
  const suffix = suffixRaw.replace(/\s+/g, ' ').trimEnd() + (end < body.length ? ' …' : '');
  return { prefix, match: matchOriginal, suffix };
}

/**
 * Run a case-insensitive substring search over the indexed sections
 * for the active locale. Returns the top {@link limit} hits, ranked
 * by:
 *   1. Title hits first (heading matches are higher signal than body
 *      matches).
 *   2. Body match count, descending.
 *
 * The `t` parameter is passed in (rather than imported here) so this
 * module stays React-free and is safely importable from non-React
 * contexts (tests, sitemap generation).
 */
export function searchDocs(
  query: string,
  locale: string,
  t: TFunction,
  limit = 50,
): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const queryLc = trimmed.toLowerCase();
  const index = buildIndex(locale);

  const hits: SearchHit[] = [];
  for (const sec of index) {
    if (!sec.lc.includes(queryLc)) continue;

    const titleLc = sec.title.toLowerCase();
    const titleHit = titleLc.includes(queryLc);

    let count = 0;
    let from = 0;
    while ((from = sec.lc.indexOf(queryLc, from)) !== -1) {
      count++;
      from += queryLc.length;
    }

    hits.push({
      docKind: sec.docKind,
      docKindLabel: t(DOC_KIND_META[sec.docKind].labelKey),
      title: sec.title,
      anchor: sec.anchor,
      href: `${DOC_KIND_META[sec.docKind].route(sec.locale)}#${sec.anchor}`,
      snippet: buildSnippet(sec.body, sec.lc, trimmed, queryLc),
      count: titleHit ? count + 1000 : count,
    });
  }

  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, limit);
}

/**
 * Build the `google.com/search?q=site:vaipakam.com+<query>` URL the
 * results page surfaces as a "Search the web" escape hatch. Single
 * `<a href>` — no embed, no SDK, no quota.
 */
export function googleSiteSearchUrl(query: string): string {
  const q = `site:vaipakam.com ${query.trim()}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
