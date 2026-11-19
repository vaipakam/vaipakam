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
 * TABLES. The feed reads only tables `scripts/check-table-classification.mjs`
 * classes as replay-derived (rebuilt from the chain alone), never one born
 * off-chain or hybrid. A route taking an address joins only when a design
 * names it public; today that is the repayment record alone (#3778).
 *
 * PARAMETERS. Each route lists the query parameters it takes. Only those
 * and `chainId` reach the handler; any other is refused with a 400 naming
 * it, so a caller never relies on an app-only switch that may change.
 *
 * LIMITS. One per-IP budget for every feed route (`PUBLIC_FEED_RATELIMIT`,
 * 120 a minute, fails closed like every limiter here) taken before any
 * read. Cloudflare counts it per location, so the figure is approximate. A
 * 429 states the limit and period and carries Retry-After. Each response
 * states its own cache time in `about.cacheSeconds`.
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
import { RECORD_EXCLUDES, handleRepaymentRecord } from './repaymentRecord';

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

/** The per-IP budget `wrangler.jsonc` declares for `PUBLIC_FEED_RATELIMIT`. */
export const FEED_RATE_LIMIT = Object.freeze({ perIp: 120, periodSeconds: 60 });

const PAGE = ['limit', 'before'] as const;
const PAIR_TERM = ['lendingAsset', 'collateralAsset', 'durationDays'] as const;

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;

interface FeedRoute {
  /** The feed's path pattern, after the prefix. */
  pattern: RegExp;
  /** The path as documented. */
  path: string;
  /** The app route the handler serves, with `$1` for the captured id. */
  target: string;
  handler: Handler;
  /** The query parameters the route takes, besides `chainId`. */
  params: readonly string[];
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
    params: [...PAGE, ...PAIR_TERM, 'excludeExpired', 'excludeSaleVehicles', 'excludeOffsetVehicles'],
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
    params: [...PAGE, ...PAIR_TERM],
    about: { what: 'Recently created offers.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/offers\/markets$/,
    path: '/offers/markets',
    target: '/offers/markets',
    handler: handleOffersMarkets,
    params: [],
    about: {
      what: 'Each pair and term (lending asset, collateral asset, term) with open offers, and their open-offer aggregates.',
      source: CHAIN_EVENTS,
      excludes: ['offers that are not open'],
    },
  },
  {
    pattern: /^\/offers\/stats$/,
    path: '/offers/stats',
    target: '/offers/stats',
    handler: handleOffersStats,
    params: [],
    about: { what: 'Open-offer counts and totals.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/offers\/(\d+)$/,
    path: '/offers/{id}',
    target: '/offers/$1',
    handler: handleOfferById,
    params: [],
    about: { what: 'One offer by id.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    pattern: /^\/loans\/active$/,
    path: '/loans/active',
    target: '/loans/active',
    handler: handleLoansActive,
    params: [...PAGE],
    about: { what: 'Active loans, paginated.', source: CHAIN_EVENTS, excludes: ['closed loans'] },
  },
  {
    pattern: /^\/loans\/recent$/,
    path: '/loans/recent',
    target: '/loans/recent',
    handler: handleLoansRecent,
    params: [...PAGE, ...PAIR_TERM, 'excludeSaleVehicles'],
    about: {
      what: 'Recently opened loans, optionally for one pair and term.',
      source: CHAIN_EVENTS,
      excludes: ['with a pair-and-term filter: loans whose agreed terms the chain has not yet confirmed'],
    },
  },
  {
    pattern: /^\/loans\/stats$/,
    path: '/loans/stats',
    target: '/loans/stats',
    handler: handleLoansStats,
    params: [],
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
    params: [...PAIR_TERM, 'interval', 'range'],
    about: {
      what:
        "The agreed rates of this platform's own past loans for one pair and term, by interval (open, high, low, close). `fills` is each interval's sample size.",
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
    params: [],
    about: { what: 'One loan by id, with its status.', source: CHAIN_EVENTS, excludes: [] },
  },
  {
    // #3778 — the one route that takes an address. It answers for ONE
    // address the caller names; no feed route lists, ranks, searches or
    // filters addresses by their record (publicFeedContract.test.ts holds
    // that). See docs/RepaymentRecordDerivation.md.
    pattern: /^\/repayment-record\/([^/]+)$/,
    path: '/repayment-record/{address}',
    target: '/repayment-record/$1',
    handler: handleRepaymentRecord,
    params: [],
    about: {
      what: 'A count of how the loans and rentals one address held as borrower or renter on this platform closed, with the statements of what it is and is not.',
      source: CHAIN_EVENTS,
      excludes: [...RECORD_EXCLUDES],
    },
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
    rateLimit: {
      ...FEED_RATE_LIMIT,
      scope: 'one budget across every feed route',
      overLimit: '429, stating the limit and period, with Retry-After',
      note: 'Cloudflare counts the budget per location, so the figure is approximate.',
    },
    parameters: 'Each route lists its parameters. Any other parameter is refused with a 400 naming it.',
    chainParam: 'Every route takes ?chainId=<id>. Without it the default chain is used.',
    envelope: {
      version: 'v1',
      chainId: 'the chain answered for',
      asOf: '{ block, scannedAt } — the indexer had reached this block when the read began; null when the chain has no cursor yet',
      about: '{ what, source, excludes[], cacheSeconds }',
      notice: 'as above',
      data: 'the route’s own answer',
    },
    routes: FEED_ROUTES.map((r) => ({
      method: 'GET',
      path: `${PUBLIC_FEED_PREFIX}${r.path}`,
      params: ['chainId', ...r.params],
      ...r.about,
    })),
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

/** The `max-age` a Cache-Control value states, or null when it states none. */
export function maxAge(cacheControl: string): number | null {
  const m = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** GET /public/v1[/…] */
export async function handlePublicFeed(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const refusal = slotRefusalStatus(await takeCallerSlot(req, env.PUBLIC_FEED_RATELIMIT));
  if (refusal) {
    const res = json(
      { error: refusal.error, limit: { ...FEED_RATE_LIMIT, per: 'caller IP address, counted per Cloudflare location' } },
      refusal.status,
      'no-store',
    );
    if (refusal.status === 429) res.headers.set('Retry-After', String(FEED_RATE_LIMIT.periodSeconds));
    return res;
  }
  if (url.pathname === PUBLIC_FEED_PREFIX) return json(feedCatalogue(), 200, 'public, max-age=3600');

  const hit = matchFeedRoute(url.pathname.slice(PUBLIC_FEED_PREFIX.length));
  if (!hit) return json({ error: 'not-in-feed', catalogue: PUBLIC_FEED_PREFIX }, 404, 'public, max-age=60');

  // Only the route's own parameters and chainId reach the handler.
  const allowed = new Set(['chainId', ...hit.route.params]);
  const unknown = [...new Set([...url.searchParams.keys()].filter((k) => !allowed.has(k)))];
  if (unknown.length > 0) {
    return json(
      { error: 'unknown-parameter', parameters: unknown, allowed: [...allowed] },
      400,
      'public, max-age=60',
    );
  }
  const forwarded = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (allowed.has(k)) forwarded.append(k, v);
  const query = forwarded.toString();
  const search = query ? `?${query}` : '';

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
  const inner = await hit.route.handler(new Request(`${url.origin}${target}${search}`, req), env, ...hit.params);
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
    {
      version: PUBLIC_FEED_VERSION,
      chainId,
      asOf,
      about: { ...hit.route.about, cacheSeconds: maxAge(cache) },
      notice: FEED_NOTICE,
      data,
    },
    200,
    cache,
  );
}
