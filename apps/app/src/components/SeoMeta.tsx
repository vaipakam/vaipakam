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
 *                                    settings, risk-access, faucet).
 *                                    Backed up by
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
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';

/** Production origin every canonical is rooted at. Hardcoded on
 *  purpose (same rationale as www): the canonical is what crawlers
 *  index, and that must be the production hostname even on preview
 *  builds.
 *
 *  This is ALREADY the intended final value — do not "update it at the
 *  cutover". The cutover runs defi → app, and this app is the
 *  successor, so the only edit this constant could take today would
 *  repoint indexed public routes at the hostname the rollout retires.
 *  It changes only if the canonical hostname itself changes. (#1854;
 *  the note here previously named the cutover in the wrong direction.) */
const CANONICAL_ORIGIN = 'https://app.vaipakam.com';

interface RouteMeta {
  title: string;
  description?: string;
  /** false → emit `<meta name="robots" content="noindex">`. */
  index: boolean;
  /** false → strengthen to `noindex,nofollow` (Codex #1547 r1). Set
   *  ONLY for /recover: the flow is deliberately unlisted, and its
   *  links must not lend it crawl equity either. Other noindex routes
   *  keep default follow — their outbound links (help, explorer) are
   *  fine to crawl. */
  follow?: false;
}

/** Match a route with exactly one optional child segment
 *  (`/nft/:tokenId`, `/positions/:loanId`): the base itself or ONE
 *  extra segment — `/nft/123/extra` is NotFound in the router and
 *  must fall to the noindex row, same as `/nft-old`
 *  (Codex #1309 r3). */
function inSection(pathname: string, base: string): boolean {
  if (pathname === base) return true;
  if (!pathname.startsWith(`${base}/`)) return false;
  const rest = pathname.slice(base.length + 1);
  return rest.length > 0 && !rest.includes('/');
}

function metaForPath(rawPathname: string): RouteMeta {
  // React Router matches `/borrow/` to the `/borrow` route (verified
  // matchRoutes behaviour) — normalize trailing slashes so a slashed
  // URL of a public page doesn't fall through to the noindex NotFound
  // row while rendering valid content (Codex #1309 r6).
  // LOWER-CASED, like `tosExitRoutes.isExitRoute` does for the same
  // reason (round 35 P3): React Router matches route declarations
  // case-insensitively, so `/Analytics` renders the real page — while
  // these exact comparisons fell through to the NotFound row, making a
  // working public page announce "Page not found", emit `noindex` and
  // drop its canonical. Two modules classifying the same pathname must
  // not disagree about what the router will do with it.
  const pathname = rawPathname.toLowerCase().replace(/\/+$/, '') || '/';
  const seo = copy.seo;
  // Route table mirroring App.tsx EXACTLY: exact-only routes match
  // exactly (in the router, `/borrow/anything` is NotFound — emitting
  // borrow meta there would index a soft 404; Codex #1309 r2 P2);
  // only the two parameterised sections use boundary matching.
  // Aliases (`Navigate` routes) and anything unmatched fall to the
  // noindex NotFound row.
  if (pathname === '/') return { ...seo.home, index: true };
  if (pathname === '/borrow') return { ...seo.borrow, index: true };
  if (pathname === '/lend') return { ...seo.lend, index: true };
  if (pathname === '/rent') return { ...seo.rent, index: true };
  if (pathname === '/offers') return { ...seo.offers, index: true };
  if (pathname === '/desk') return { ...seo.desk, index: true };
  if (pathname === '/vpfi') return { ...seo.vpfi, index: true };
  // NftVerifier only performs a lookup for positive-integer token ids
  // (`/^[1-9]\d*$/` in the page) — a malformed id (`/nft/foo`,
  // `/nft/0`) renders just the empty form, a thin duplicate that must
  // not be indexable (Codex #1309 r5).
  if (pathname === '/nft') return { ...seo.nftVerifier, index: true };
  // A TOKEN DETAIL IS NOT INDEXABLE, and this must agree with
  // `_headers.base` (round 35 P3). The `/:locale/*` response rule added
  // for locale-prefixed bookmarks also matches `/nft/123`, so the header
  // says noindex while this row said indexable and emitted a canonical —
  // a direct contradiction of the functional spec's requirement that a
  // crawler which does not run the app sees the same decision a browser
  // sees after it loads.
  //
  // Resolved toward noindex rather than by narrowing the header rule,
  // because it is right on its own merits: token details are an
  // unbounded url space of thin lookups, the sitemap has never listed
  // them, and the verifier's own entry point stays indexable. Malformed
  // ids (`/nft/foo`, `/nft/0`) render just the empty form and were
  // already excluded (Codex #1309 r5); this widens that to every token
  // id rather than only the malformed ones.
  // ONE child segment, via the same helper every other parameterised
  // section uses (round 36 P3). My widened regex matched
  // `/nft/123/extra` too — a URL the router renders as NotFound, which
  // would then have carried the verifier's title and description. The
  // helper's docstring already stated this rule; I wrote a second
  // matcher beside it instead of using it.
  if (inSection(pathname, '/nft')) {
    return { ...seo.nftVerifier, index: false };
  }
  if (pathname === '/help') return { ...seo.help, index: true };
  // #1959 review round 2 P2 — both are public marketing deep-link
  // targets. Without a row here they fell through to the NotFound row,
  // so a working page announced itself as "Page not found" in the tab,
  // emitted `noindex`, and dropped its canonical — the exact regression
  // the `/data-rights` row below was added for. Indexable, unlike the
  // per-user surfaces: these two are the public record.
  if (pathname === '/analytics') return { ...seo.analytics, index: true };
  if (pathname === '/protocol-console') {
    // INDEXABLE ONLY WHEN IT ACTUALLY SHOWS ANYTHING (review round 6 P2).
    // With `VITE_ADMIN_DASHBOARD_PUBLIC=false` the page renders only its
    // hidden-state message, so indexing it advertises a surface the
    // deployment has decided to withhold — and this row's own
    // description promises current parameter values, which that posture
    // does not provide. `generate-seo.mjs` drops the sitemap entry under
    // the same flag; both must agree or one contradicts the other.
    return { ...seo.protocolConsole, index: isProtocolConsolePublic() };
  }
  if (inSection(pathname, '/positions')) return { ...seo.positions, index: false };
  if (pathname === '/claims') return { ...seo.claims, index: false };
  if (pathname === '/vault') return { ...seo.vault, index: false };
  if (pathname === '/activity') return { ...seo.activity, index: false };
  if (pathname === '/settings') return { ...seo.settings, index: false };
  if (pathname === '/risk-access') return { ...seo.riskAccess, index: false };
  if (pathname === '/recover') {
    // Deliberately-unlisted surface: noindex AND nofollow (Codex #1547
    // r1) — mirrored by the /recover X-Robots-Tag rules in _headers.
    return { ...seo.recover, index: false, follow: false };
  }
  if (pathname === '/faucet') return { ...seo.faucet, index: false };
  // #1960 review round 1 P2 — without this row the page fell through to
  // `notFound`, so a working data-rights page announced itself as "Page
  // not found" in the tab and could carry a stale description from the
  // previous route. noindex like the other per-user surfaces.
  if (pathname === '/data-rights') return { ...seo.dataRights, index: false };
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
  // re-resolve. Belt-and-braces: this component lives INSIDE
  // LanguageRemount (via AppShell), so a language switch — and the
  // later bundle-arrival remount — re-mounts it and re-runs the
  // effect regardless of deps; the ACTIVE-language dep below is the
  // explicit signal (resolvedLanguage would miss placeholder/lazy
  // states — Codex #1309 r5).
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
      upsertMeta(
        'robots',
        meta.follow === false ? 'noindex,nofollow' : 'noindex',
      );
    } else if (robots) {
      robots.remove();
    }

    // Canonical — absolute, production-origin, query dropped
    // (no route uses canonical query parameters today).
    //
    // LOWER-CASED with the same rule `metaForPath` classifies by (round
    // 36 P3). Normalising only the classification was half a fix: a
    // crawler on `/Analytics` then got the correct indexable metadata
    // and a canonical pointing at `/Analytics`, so the duplicate
    // self-canonicalised instead of consolidating onto the `/analytics`
    // the sitemap publishes. One normalisation, used by both, or the
    // two disagree again the next time one of them moves.
    const path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
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
  }, [pathname, i18n.language]);

  return null;
}
