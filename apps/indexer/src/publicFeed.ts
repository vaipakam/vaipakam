/**
 * #3774 — the public data feed: a versioned, documented subset of this
 * indexer's reads (FeaturesOverExistingPartsDesign.md §8).
 *
 *   GET /public/v1            the feed's own catalogue (static)
 *   GET /public/v1/<route>    one route of the subset, wrapped
 *
 * WHY A SUBSET AND NOT THE WHOLE API. The un-versioned routes serve the app
 * and change with it. A caller outside the platform needs a surface that
 * does not move under it, says how fresh each answer is, and says what each
 * figure leaves out. So the feed is a fixed list of routes, each answered by
 * the SAME handler the app uses (one copy of every read, §8's "a separate
 * service would be a second copy"), inside an envelope that adds:
 *
 *   - `version`        'v1'; a change that would break a caller is a v2;
 *   - `asOf`           the block the indexer had reached on the chain, read
 *                      just BEFORE the data, so the data covers at least
 *                      through that block (it may include a little more);
 *   - `about`          where every figure comes from and what it leaves out;
 *   - `notice`         that no figure is the platform's rate or a benchmark.
 *
 * WHAT IS NEVER SERVED. Only chain-derived records. Nothing the platform
 * keeps privately for a wallet (goals, alert settings, watched loans, the
 * Telegram link) lives in this Worker's routes at all; they are the agent's.
 * The subset also leaves out the per-wallet convenience reads the app uses
 * (claimables, notifications, by-participant): they are chain data, but they
 * exist to serve one wallet's own page, not a public feed.
 *
 * LIMITS. A per-IP budget (`PUBLIC_FEED_RATELIMIT`, 120 a minute, fails
 * closed like every limiter here) taken before any read, and each route's
 * own cache time, stated in `about.cacheSeconds`.
 */
import { type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { slotRefusalStatus, takeCallerSlot } from '@vaipakam/lib/rateLimit';
import { chainServed, requestedChainId } from './servedChain';
import { CURSOR_KIND } from './chainIndexer';
import {
  handleOfferById,
  handleOffersActive,
  handleOffersMarkets,
  handleOffersRecent,
  handleOffersStats,
} from './offerRoutes';
import {
  handleLoanById,
  handleLoansActive,
  handleLoansRateCandles,
  handleLoansRecent,
  handleLoansStats,
} from './loanRoutes';

export const PUBLIC_FEED_PREFIX = '/public/v1';
export const PUBLIC_FEED_VERSION = 'v1';

/** What a response says about its figures. */
export interface FeedAbout {
  /** One line: what the route returns. */
  what: string;
  /** Where the figures come from. */
  source: string;
  /** What the figures leave out, each a short phrase. */
  excludes: string[];
}

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;

interface FeedRoute {
  /** The feed's path pattern, after the prefix. */
  pattern: RegExp;
  /** The path as documented. */
  path: string;
  /** The app route the handler serves, with `$1` for the captured id. */
  target: string;
  handler: Handler;
  about: FeedAbout;
}

const CHAIN_EVENTS = "the Diamond's own events on this chain, as the indexer recorded them";

/**
 * The v1 subset. Adding a route is additive; changing a route's shape or
 * removing one is a v2. `publicFeed.test.ts` pins this list.
 */
export const FEED_ROUTES: readonly FeedRoute[] = Object.freeze([
  {
    pattern: /^\/offers\/active$/,
    path: '/offers/active',
    target: '/offers/active',
    handler: handleOffersActive,
    about: {
      what: 'The open offer book, paginated.',
      source: CHAIN_EVENTS,
      excludes: ['cancelled, filled and expired offers', 'gasless signed offers (their own book, not indexed here)'],
    },
  },
  {
    pattern: /^\/offers\/recent$/,
    path: '/offers/recent',
    target: '/offers/recent',
    handler: handleOffersRecent,
    about: { what: 'Recently created offers.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/offers\/markets$/,
    path: '/offers/markets',
    target: '/offers/markets',
    handler: handleOffersMarkets,
    about: {
      what: 'Quotable (lending asset, collateral asset, term) markets with their open-offer aggregates.',
      source: CHAIN_EVENTS,
      excludes: ['offers that are not open'],
    },
  },
  {
    pattern: /^\/offers\/stats$/,
    path: '/offers/stats',
    target: '/offers/stats',
    handler: handleOffersStats,
    about: { what: 'Open-offer counts and totals.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/offers\/(\d+)$/,
    path: '/offers/{id}',
    target: '/offers/$1',
    handler: handleOfferById,
    about: { what: 'One offer by id.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/loans\/active$/,
    path: '/loans/active',
    target: '/loans/active',
    handler: handleLoansActive,
    about: { what: 'Active loans, paginated.', source: CHAIN_EVENTS, excludes: ['closed loans'] },
  },
  {
    pattern: /^\/loans\/recent$/,
    path: '/loans/recent',
    target: '/loans/recent',
    handler: handleLoansRecent,
    about: {
      what: 'Recently opened loans, optionally for one market.',
      source: CHAIN_EVENTS,
      excludes: ['with a market filter: loans whose agreed terms the chain has not yet confirmed'],
    },
  },
  {
    pattern: /^\/loans\/stats$/,
    path: '/loans/stats',
    target: '/loans/stats',
    handler: handleLoansStats,
    about: {
      what: 'Loan counts by status and the totals the transparency page shows.',
      source: CHAIN_EVENTS,
      excludes: ["the temporary loan a lender's sale creates"],
    },
  },
  {
    pattern: /^\/loans\/rate-candles$/,
    path: '/loans/rate-candles',
    target: '/loans/rate-candles',
    handler: handleLoansRateCandles,
    about: {
      what: 'The agreed rates of filled loans in one market, by interval (open, high, low, close).',
      source: `${CHAIN_EVENTS}: each loan's rate and term as agreed when it opened`,
      excludes: [
        'loans whose agreed terms the chain has not yet confirmed (counted as `unplaced`)',
        "the temporary loan a lender's sale creates",
        'loans with an NFT on either side',
        'intervals with no filled loan (no figure is drawn for them)',
      ],
    },
  },
  {
    pattern: /^\/loans\/(\d+)$/,
    path: '/loans/{id}',
    target: '/loans/$1',
    handler: handleLoanById,
    about: { what: 'One loan by id, with its status.', source: CHAIN_EVENTS, excludes: [] },
  },
]);

/** The notice every feed response carries. */
export const FEED_NOTICE =
  'Figures are records of what happened on chain. None is the platform’s rate, a benchmark, advice or an offer.';

/** The feed's catalogue, served at the prefix itself. */
export function feedCatalogue() {
  return {
    service: 'vaipakam-indexer public data feed',
    version: PUBLIC_FEED_VERSION,
    prefix: PUBLIC_FEED_PREFIX,
    docs: 'https://github.com/vaipakam/vaipakam/blob/main/docs/PublicDataFeed.md',
    notice: FEED_NOTICE,
    rateLimit: { perIp: 120, periodSeconds: 60, overLimit: 429 },
    chainParam: 'Every route takes ?chainId=<id>. Without it the default chain is used.',
    envelope: {
      version: 'v1',
      chainId: 'the chain answered for',
      asOf: '{ block, scannedAt } — the indexer had reached this block when the read began; null when the chain has no cursor yet',
      about: '{ what, source, excludes[] }',
      notice: 'as above',
      data: 'the route’s own answer',
    },
    routes: FEED_ROUTES.map((r) => ({ method: 'GET', path: `${PUBLIC_FEED_PREFIX}${r.path}`, ...r.about })),
  };
}

function json(body: unknown, status: number, cache: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cache,
    },
  });
}

export function handlePublicFeedPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** Whether `path` is in the feed's namespace. */
export function isPublicFeedPath(path: string): boolean {
  return path === PUBLIC_FEED_PREFIX || path.startsWith(`${PUBLIC_FEED_PREFIX}/`);
}

/** The feed route `rest` names, with its captured id, or null. */
export function matchFeedRoute(rest: string): { route: FeedRoute; params: string[] } | null {
  for (const route of FEED_ROUTES) {
    const m = rest.match(route.pattern);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

/** GET /public/v1[/…] */
export async function handlePublicFeed(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const refusal = slotRefusalStatus(await takeCallerSlot(req, env.PUBLIC_FEED_RATELIMIT));
  if (refusal) return json({ error: refusal.error }, refusal.status, 'no-store');
  if (url.pathname === PUBLIC_FEED_PREFIX) return json(feedCatalogue(), 200, 'public, max-age=3600');

  const hit = matchFeedRoute(url.pathname.slice(PUBLIC_FEED_PREFIX.length));
  if (!hit) return json({ error: 'not-in-feed', catalogue: PUBLIC_FEED_PREFIX }, 404, 'public, max-age=60');

  const chainId = requestedChainId(url);
  // The cursor is read BEFORE the data, so `asOf.block` is a floor: every
  // record at or below it is in the data. An unserved chain reads no
  // cursor; the handler answers its own 503 for it.
  let asOf: { block: number; scannedAt: number } | null = null;
  if (chainServed(env, chainId)) {
    try {
      const c = await env.DB.prepare('SELECT last_block, updated_at FROM indexer_cursor WHERE chain_id = ? AND kind = ?')
        .bind(chainId, CURSOR_KIND)
        .first<{ last_block: number; updated_at: number }>();
      asOf = c ? { block: c.last_block, scannedAt: c.updated_at } : null;
    } catch (err) {
      console.error('[publicFeed] cursor read failed', redactedError(err));
      return json({ error: 'feed-unavailable' }, 503, 'no-store');
    }
  }

  // The app's own handler answers, on the app's own path.
  const target = hit.route.target.replace('$1', hit.params[0] ?? '');
  const inner = await hit.route.handler(new Request(`${url.origin}${target}${url.search}`, req), env, ...hit.params);
  const cache = inner.headers.get('Cache-Control') ?? 'public, max-age=10';
  if (inner.status !== 200) {
    // An error is passed through as it came, with the feed's version so a
    // caller can tell which surface answered.
    const body = await inner.text();
    return new Response(body, {
      status: inner.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cache, 'X-Feed-Version': PUBLIC_FEED_VERSION },
    });
  }
  const data: unknown = await inner.json();
  return json(
    { version: PUBLIC_FEED_VERSION, chainId, asOf, about: hit.route.about, notice: FEED_NOTICE, data },
    200,
    cache,
  );
}
