/**
 * #3774 — what the public feed promises a caller, pinned:
 *
 *  (a) each route takes only the parameters it lists. The list is checked
 *      against the parameters the route's handler actually reads, only
 *      those and `chainId` are forwarded, and any other is refused with a
 *      400 naming it;
 *  (b) the field names each route returns in v1. A removal or rename fails
 *      here; an addition passes. The names live in
 *      `fixtures/publicFeedFields.json` (regenerate with
 *      `UPDATE_FEED_FIELDS=1`, and only to ADD names);
 *  (c) the tables each route reads, recorded from the SQL it runs. Every
 *      one is a table `scripts/check-table-classification.mjs` classes as
 *      replay-derived (rebuilt from the chain alone), never born off-chain
 *      or hybrid. One wallet's own-page reads stay out, and a route taking
 *      an address joins only when a design names it public: today that is
 *      the repayment record alone (#3778), which answers for one address
 *      and never lists, ranks, searches or filters addresses.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { FEED_RATE_LIMIT, FEED_ROUTES, handlePublicFeed } from '../src/publicFeed';
import type { Env } from '../src/env';
import { RECORD_STATEMENTS, RECORD_VERSION } from '../src/repaymentRecord';
// @ts-expect-error — a plain .mjs script with no type declarations.
import { CLASSIFICATION } from '../scripts/check-table-classification.mjs';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const FIELDS_FILE = new URL('./fixtures/publicFeedFields.json', import.meta.url);

const CHAIN = 84532;
const NOW = Math.floor(Date.now() / 1000);
const USDC = '0x' + 'aa'.repeat(20);
const WETH = '0x' + 'bb'.repeat(20);
const A = '0x' + '11'.repeat(20);
const B = '0x' + '22'.repeat(20);
const NFT = '0x' + 'cc'.repeat(20);
const PAIR = `lendingAsset=${USDC}&collateralAsset=${WETH}&durationDays=30`;

/** A sample request for each route, filled enough that every list has rows. */
const SAMPLE: Record<string, string> = {
  '/offers/active': '/offers/active',
  '/offers/recent': '/offers/recent',
  '/offers/stats': '/offers/stats',
  '/offers/{id}': '/offers/1',
  '/loans/active': '/loans/active',
  '/loans/recent': `/loans/recent?${PAIR}`,
  '/loans/stats': '/loans/stats',
  '/loans/rate-candles': `/loans/rate-candles?${PAIR}&interval=1d&range=30d`,
  '/loans/{id}': '/loans/1',
  '/repayment-record/{address}': `/repayment-record/${B}`,
  '/rentals/by-collection': `/rentals/by-collection?collection=${NFT}`,
  '/rentals/may-use': `/rentals/may-use?collection=${NFT}&user=${B}`,
};

function insert(db: { prepare(sql: string): { run(...a: unknown[]): unknown } }, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    ...Object.values(row),
  );
}

/** A migrated database with offers and loans, and a log of every SQL run. */
function seeded() {
  const h = createSqliteD1(MIGRATIONS);
  insert(h.db, 'indexer_cursor', { chain_id: CHAIN, kind: 'diamond', last_block: 500, updated_at: NOW - 10 });
  for (const id of [1, 2]) {
    insert(h.db, 'offers', {
      chain_id: CHAIN,
      offer_id: id,
      status: 'active',
      creator: A,
      offer_type: id - 1,
      lending_asset: USDC,
      collateral_asset: WETH,
      asset_type: 0,
      collateral_asset_type: 0,
      amount: '1000',
      interest_rate_bps: 500,
      collateral_amount: '2',
      duration_days: 30,
      first_seen_block: 1,
      first_seen_at: NOW - 100,
      updated_at: NOW - 100,
      created_at: NOW - 100,
    });
  }
  for (const id of [1, 2]) {
    insert(h.db, 'loans', {
      chain_id: CHAIN,
      loan_id: id,
      offer_id: id,
      status: 'active',
      lender: A,
      borrower: B,
      borrower_current_owner: B,
      principal: '1000',
      collateral_amount: '2',
      lending_asset: USDC,
      collateral_asset: WETH,
      asset_type: 0,
      collateral_asset_type: 0,
      duration_days: 30,
      interest_rate_bps: 500 + id,
      start_block: 10,
      start_at: NOW - 3600 * id,
      updated_at: NOW - 3600,
      init_principal: '1000',
      init_rate_bps: 500 + id,
      init_duration_days: 30,
      init_principal_unbacked: 0,
      init_terms_unbacked: 0,
      init_lender: A,
      init_borrower: B,
    });
  }
  // B held both loans as borrower and paid interest on the first, so the
  // repayment record has rows in every list it returns.
  for (const id of [1, 2]) {
    insert(h.db, 'loan_participants', { chain_id: CHAIN, loan_id: id, wallet: B, role: 'borrower', from_at: NOW - 3600 * id });
  }
  insert(h.db, 'activity_events', {
    chain_id: CHAIN,
    block_number: 20,
    log_index: 0,
    tx_hash: '0x' + '14'.repeat(32),
    kind: 'LoanInterestPaid',
    loan_id: 1,
    args_json: JSON.stringify({ loanId: '1', asset: USDC, gross: '5' }),
    block_at: NOW - 1800,
  });
  // #3882 — one active rental of NFT to B, so both rental reads have rows.
  insert(h.db, 'rental_rights', {
    chain_id: CHAIN,
    loan_id: 3,
    collection: NFT,
    token_id: '7',
    owner: A,
    user: B,
    expires: NOW + 86_400,
    quantity: '1',
    block_number: 20,
    log_index: 1,
    updated_at: NOW - 1800,
  });
  const sql: string[] = [];
  const d1 = h.d1 as { prepare(s: string): unknown };
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (s: string) => {
    sql.push(s);
    return prepare(s);
  };
  const env = {
    DB: d1,
    PUBLIC_FEED_RATELIMIT: { limit: async () => ({ success: true }) },
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env;
  return { h, env, sql };
}

function withChain(path: string): string {
  return `/public/v1${path}${path.includes('?') ? '&' : '?'}chainId=${CHAIN}`;
}

/**
 * Every key path in a JSON value; array elements are `[]`, and merged. A key
 * that is an address (a per-asset map) is written `{address}`, since the
 * keys are data, not field names.
 */
function fieldPaths(v: unknown, at = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const e of v) fieldPaths(e, `${at}[]`, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, e] of Object.entries(v)) {
      const name = /^0x[0-9a-fA-F]{40}$/.test(k) ? '{address}' : k;
      const p = at ? `${at}.${name}` : name;
      out.add(p);
      fieldPaths(e, p, out);
    }
  }
  return out;
}

describe('(a) each route takes only the parameters it lists', () => {
  // The parameters a handler reads, from its source: direct reads plus the
  // shared parsers each route module uses.
  const SHARED: Record<string, string[]> = {
    parseMarketFilter: ['lendingAsset', 'collateralAsset', 'durationDays'],
  };
  const handlerParams = (name: string): string[] => {
    for (const file of ['offerRoutes.ts', 'loanRoutes.ts', 'repaymentRecord.ts', 'rentalRoutes.ts']) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      const starts = [...src.matchAll(/^export async function (\w+)\(/gm)];
      const i = starts.findIndex((m) => m[1] === name);
      if (i < 0) continue;
      const body = src.slice(starts[i].index, starts[i + 1]?.index ?? src.length);
      const read = [
        ...body.matchAll(/searchParams\.(?:get|getAll|has)\(\s*'(\w+)'/g),
        // rentalRoutes.ts reads each parameter through its one-value helper.
        ...body.matchAll(/\bone\(\s*url,\s*'(\w+)'/g),
      ].map((m) => m[1]);
      for (const [fn, ps] of Object.entries(SHARED)) if (body.includes(`${fn}(`)) read.push(...ps);
      return [...new Set(read)].filter((p) => p !== 'chainId').sort();
    }
    throw new Error(`no handler ${name}`);
  };

  for (const r of FEED_ROUTES) {
    it(`${r.path} lists exactly what ${r.handler.name} reads`, () => {
      // What a caller passes plus what the feed fixes: together, every
      // parameter the handler reads, each from exactly one side.
      const fixed = Object.keys(r.fixed ?? {});
      expect(fixed.filter((k) => r.params.includes(k))).toEqual([]);
      expect([...r.params, ...fixed].sort()).toEqual(handlerParams(r.handler.name));
    });
  }

  it('pins the parameters the feed fixes itself', () => {
    expect(Object.fromEntries(FEED_ROUTES.filter((r) => r.fixed).map((r) => [r.path, r.fixed]))).toEqual({
      '/offers/active': { excludeExpired: '1', excludeUnknownExpiry: '1' },
    });
  });

  it('pins the v1 parameter lists', () => {
    expect(Object.fromEntries(FEED_ROUTES.map((r) => [r.path, [...r.params]]))).toEqual({
      '/offers/active': [
        'limit', 'before', 'lendingAsset', 'collateralAsset', 'durationDays',
        'excludeSaleVehicles', 'excludeOffsetVehicles',
      ],
      '/offers/recent': ['limit', 'before', 'lendingAsset', 'collateralAsset', 'durationDays'],
      '/offers/stats': [],
      '/offers/{id}': [],
      '/loans/active': ['limit', 'before'],
      '/loans/recent': ['limit', 'before', 'lendingAsset', 'collateralAsset', 'durationDays', 'excludeSaleVehicles'],
      '/loans/stats': [],
      '/loans/rate-candles': ['lendingAsset', 'collateralAsset', 'durationDays', 'interval', 'range'],
      '/loans/{id}': [],
      '/repayment-record/{address}': [],
      '/rentals/by-collection': ['collection', 'tokenId', 'cursor'],
      '/rentals/may-use': ['collection', 'user', 'tokenId'],
    });
  });

  it('refuses a parameter the route does not take, naming it', async () => {
    const { env } = seeded();
    const res = await handlePublicFeed(
      new Request(`https://x${withChain('/loans/active?limit=5&wallet=0x1&pending=1&wallet=0x2')}`),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown-parameter',
      parameters: ['wallet', 'pending'],
      allowed: ['chainId', 'limit', 'before'],
    });
  });

  it('forwards the listed parameters', async () => {
    const { env } = seeded();
    const res = await handlePublicFeed(new Request(`https://x${withChain('/loans/active?limit=1')}`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { loans: unknown[] } };
    expect(body.data.loans).toHaveLength(1);
  });
});

describe('(b) each route keeps its v1 field names', () => {
  it('every pinned field is still returned (additions pass)', async () => {
    const actual: Record<string, string[]> = {};
    for (const r of FEED_ROUTES) {
      const { env } = seeded();
      const res = await handlePublicFeed(new Request(`https://x${withChain(SAMPLE[r.path])}`), env);
      expect(res.status, r.path).toBe(200);
      actual[r.path] = [...fieldPaths(await res.json())].sort();
    }
    if (process.env.UPDATE_FEED_FIELDS) {
      writeFileSync(FIELDS_FILE, JSON.stringify(actual, null, 2) + '\n');
    }
    const pinned = JSON.parse(readFileSync(FIELDS_FILE, 'utf8')) as Record<string, string[]>;
    expect(Object.keys(pinned).sort()).toEqual(FEED_ROUTES.map((r) => r.path).sort());
    for (const [path, fields] of Object.entries(pinned)) {
      const missing = fields.filter((f) => !actual[path].includes(f));
      expect(missing, `${path} no longer returns`).toEqual([]);
    }
  });
});

describe('(c) the tables each route reads', () => {
  const { h } = seeded();
  const ALL_TABLES = new Set(
    (h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const CLASSES = CLASSIFICATION as Record<string, { class: string }>;
  const tablesIn = (sql: string[]) =>
    [
      ...new Set(
        sql.flatMap((s) => [...s.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)/gi)].map((m) => m[1])),
      ),
    ]
      .filter((t) => ALL_TABLES.has(t))
      .sort();

  // The routes a design names public that take an address. Adding one
  // here needs that design, in review.
  const ADDRESS_ROUTES = ['/repayment-record/{address}'];
  // The routes a design names public that take ONE address as a parameter
  // (ProjectKitDesign.md §12): the parameter, by route.
  const ADDRESS_PARAMS: Record<string, string> = { '/rentals/may-use': 'user' };
  // One wallet's own-page reads: chain data, but each serves one wallet's
  // own page, so the feed never carries them.
  const OWN_PAGE = [
    /^\/loans\/by-participant\b/,
    /^\/loans\/by-current-holder\b/,
    /^\/claimables\b/,
    /^\/notifications\b/,
    /^\/activity\b/,
    /^\/offers\/by-creator\b/,
  ];

  it('reads only tables classed replay-derived, never born-off-chain or hybrid', async () => {
    const recorded: Record<string, string[]> = {};
    for (const r of FEED_ROUTES) {
      const { env, sql } = seeded();
      const res = await handlePublicFeed(new Request(`https://x${withChain(SAMPLE[r.path])}`), env);
      expect(res.status, r.path).toBe(200);
      recorded[r.path] = tablesIn(sql);
      for (const t of recorded[r.path]) {
        expect(CLASSES[t]?.class, `${r.path} reads ${t}`).toBe('replay-derived');
      }
    }
    // The record. A route that starts reading another table changes this
    // on purpose, in review, and the class check above still applies.
    expect(recorded).toEqual({
      '/offers/active': ['indexer_cursor', 'offers'],
      '/offers/recent': ['indexer_cursor', 'offers'],
      '/offers/stats': ['indexer_cursor', 'offers'],
      '/offers/{id}': ['indexer_cursor', 'offers'],
      '/loans/active': ['indexer_cursor', 'loans', 'protocol_config'],
      '/loans/recent': ['indexer_cursor', 'loans', 'protocol_config'],
      '/loans/stats': ['activity_events', 'indexer_cursor', 'loans'],
      '/loans/rate-candles': ['indexer_cursor', 'loans'],
      '/loans/{id}': [
        'indexer_cursor',
        'loans',
        'offers',
        'position_side_moves',
        'prepay_listings',
        'protocol_config',
        'swap_to_repay_intents',
      ],
      '/repayment-record/{address}': [
        'activity_events',
        'indexer_cursor',
        'indexer_deployment',
        'loan_participants',
        'loans',
      ],
      // #3882 — the event-built rental table and nothing else behind both
      // rental reads (the cursor is the envelope's own read).
      '/rentals/by-collection': ['indexer_cursor', 'rental_rights'],
      '/rentals/may-use': ['indexer_cursor', 'rental_rights'],
    });
  });

  it('knows the classes it relies on', () => {
    // A sanity check that the import is the live classification.
    expect(CLASSES.telegram_links.class).toBe('born-off-chain');
    expect(CLASSES.loan_participants.class).toBe('replay-derived');
  });

  it('carries no own-page read', () => {
    for (const r of FEED_ROUTES) {
      for (const re of OWN_PAGE) expect(re.test(r.target), `${r.path} is an own-page read`).toBe(false);
    }
  });

  it('takes an address only where a design names the route public', () => {
    const takesAddress = FEED_ROUTES.filter((r) => /\{address\}|wallet|holder|participant|creator/i.test(r.path));
    expect(takesAddress.map((r) => r.path)).toEqual(ADDRESS_ROUTES);
    // No route lists, ranks, searches or filters addresses: no route
    // takes an address-shaped parameter, and none returns a list of
    // records keyed by address.
    for (const r of FEED_ROUTES) {
      for (const p of r.params) {
        if (ADDRESS_PARAMS[r.path] === p) continue;
        expect(/wallet|address|user|renter|borrower|lender|holder|creator|owner|rank|sort|order|search|min|max/i.test(p), `${r.path} takes ${p}`).toBe(false);
      }
    }
    for (const [path, p] of Object.entries(ADDRESS_PARAMS)) {
      expect(FEED_ROUTES.find((r) => r.path === path)?.params).toContain(p);
    }
  });
});
describe('the budget', () => {
  it('a 429 states the limit and the period and carries Retry-After', async () => {
    const { env } = seeded();
    const spent = { ...env, PUBLIC_FEED_RATELIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
    const res = await handlePublicFeed(new Request('https://x/public/v1'), spent);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe(String(FEED_RATE_LIMIT.periodSeconds));
    expect(await res.json()).toMatchObject({ error: 'rate-limited', limit: { perIp: 120, periodSeconds: 60 } });
  });

  it('matches the binding wrangler.jsonc declares', () => {
    const src = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('"PUBLIC_FEED_RATELIMIT"'), src.indexOf('"PUBLIC_FEED_RATELIMIT"') + 200);
    expect(block).toContain('"namespace_id": "2005"');
    expect(block).toContain(`"limit": ${FEED_RATE_LIMIT.perIp}, "period": ${FEED_RATE_LIMIT.periodSeconds}`);
  });

  it('states the cache time in about.cacheSeconds', async () => {
    const { env } = seeded();
    const res = await handlePublicFeed(new Request(`https://x${withChain('/loans/stats')}`), env);
    const body = (await res.json()) as { about: { cacheSeconds: number | null } };
    expect(typeof body.about.cacheSeconds).toBe('number');
  });
});

describe('(d) what a route publishes matches what it says it leaves out', () => {
  it('drops expired offers and offers of unknown expiry from the open book, and does not let a caller turn that off', async () => {
    const { h, env } = seeded();
    // Offer 2 has passed its expiry but still reads `active`: expiry is
    // enforced lazily on-chain.
    h.db.prepare('UPDATE offers SET expires_at = ? WHERE offer_id = 2').run(NOW - 60);
    // Offer 1 is a stub: its expiry was never read, so `expires_at` is the
    // default 0, which would otherwise read as "never expires".
    h.db.prepare('UPDATE offers SET is_stub = 1 WHERE offer_id = 1').run();
    insert(h.db, 'offers', {
      chain_id: CHAIN, offer_id: 3, status: 'active', creator: A, offer_type: 0,
      lending_asset: USDC, collateral_asset: WETH, asset_type: 0, collateral_asset_type: 0,
      amount: '1000', interest_rate_bps: 500, collateral_amount: '2', duration_days: 30,
      first_seen_block: 1, first_seen_at: NOW - 100, updated_at: NOW - 100, created_at: NOW - 100,
    });
    const res = await handlePublicFeed(new Request(`https://x${withChain('/offers/active')}`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { offers: Array<{ offerId: number | string }> } };
    expect(body.data.offers.map((o) => Number(o.offerId))).toEqual([3]);
    const refused = await handlePublicFeed(
      new Request(`https://x${withChain('/offers/active?excludeExpired=0')}`),
      env,
    );
    expect(refused.status).toBe(400);
  });
});

describe('the repayment record on the feed', () => {
  it('answers one address with the statements, block, version, unclassified count and fee state', async () => {
    const { env } = seeded();
    const res = await handlePublicFeed(new Request(`https://x${withChain(`/repayment-record/${B}`)}`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.asOf.block).toBe(500);
    expect(body.data.version).toBe(RECORD_VERSION);
    expect(body.data.statements).toEqual([...RECORD_STATEMENTS]);
    expect(body.data.asOf.block).toBe(500);
    expect(typeof body.data.loans.unclassified).toBe('number');
    expect(typeof body.data.rentals.unclassified).toBe('number');
    expect(body.data.feesPaid.stated).toBe(false);
    expect(body.data.loans.openNow).toBe(2);
    expect(body.data.interestPaid).toEqual([{ asset: USDC, total: '5' }]);
  });

  it('answers an address with no history with an empty record, not an error', async () => {
    const { env } = seeded();
    const nobody = '0x' + '99'.repeat(20);
    const res = await handlePublicFeed(new Request(`https://x${withChain(`/repayment-record/${nobody}`)}`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.data.address).toBe(nobody);
    expect(body.data.loans.closed).toBe(0);
    expect(body.data.loans.openNow).toBe(0);
    expect(body.data.interestPaid).toEqual([]);
    expect(body.data.statements).toEqual([...RECORD_STATEMENTS]);
  });

  it('refuses a malformed address with a 400, passed through', async () => {
    const { env } = seeded();
    const res = await handlePublicFeed(new Request(`https://x${withChain('/repayment-record/not-an-address')}`), env);
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Feed-Version')).toBe('v1');
  });
});

describe('the rental reads on the feed (#3882)', () => {
  it('answers each in the envelope with the block and the event-built rows', async () => {
    const { env } = seeded();
    for (const path of ['/rentals/by-collection', '/rentals/may-use']) {
      const res = await handlePublicFeed(new Request(`https://x${withChain(SAMPLE[path])}`), env);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as any;
      expect(body.asOf.block).toBe(500);
      expect(body.data.rentals).toEqual([
        { rentalId: '3', tokenId: '7', user: B, expires: NOW + 86_400, quantity: '1', owner: A },
      ]);
    }
  });

  it('refuses may-use without a collection or a user, and a list or a wildcard in either', async () => {
    const { env } = seeded();
    for (const q of [
      `/rentals/may-use?user=${B}`,
      `/rentals/may-use?collection=${NFT}`,
      `/rentals/may-use?collection=${NFT}&user=${B}&user=${A}`,
      `/rentals/may-use?collection=${NFT}&user=${B},${A}`,
      `/rentals/may-use?collection=${NFT}&user=*`,
      `/rentals/may-use?collection=*&user=${B}`,
      `/rentals/may-use?collection=${NFT}&collection=${USDC}&user=${B}`,
      `/rentals/by-collection?collection=${NFT},${USDC}`,
      `/rentals/by-collection?collection=*`,
      `/rentals/by-collection`,
    ]) {
      const res = await handlePublicFeed(new Request(`https://x${withChain(q)}`), env);
      expect(res.status, q).toBe(400);
    }
    // A parameter neither route lists is refused by the feed itself.
    const res = await handlePublicFeed(new Request(`https://x${withChain(`/rentals/may-use?collection=${NFT}&user=${B}&users=${A}`)}`), env);
    expect(((await res.json()) as any).error).toBe('unknown-parameter');
  });
});
