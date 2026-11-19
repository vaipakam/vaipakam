/**
 * #3774 — the public data feed, executed against the REAL migrated schema:
 * the envelope (version, block, sources, notice), the fixed route list, the
 * refusal of anything outside it, and the per-IP limit.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { FEED_ROUTES, feedCatalogue, handlePublicFeed, isPublicFeedPath } from '../src/publicFeed';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const BASE = 84532;
const OPEN = { limit: async () => ({ success: true }) };
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function env(over: Record<string, unknown> = {}) {
  const h = createSqliteD1(migrations());
  h.db
    .prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)')
    .run(BASE, 'diamond', 12_345, 1_800_000_000);
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower, principal,
         collateral_amount, lending_asset, collateral_asset, duration_days, start_block, start_at, updated_at)
       VALUES (?, 1, 1, 'active', ?, ?, '1000', '2000', ?, ?, 30, 1, 1, 1)`,
    )
    .run(BASE, addr(1), addr(2), addr(3), addr(4));
  return {
    h,
    env: { DB: h.d1, PUBLIC_FEED_RATELIMIT: OPEN, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9', ...over } as unknown as Env,
  };
}

const get = (e: Env, path: string) => handlePublicFeed(new Request(`https://x${path}`), e);

describe('public data feed', () => {
  it('pins the v1 route list (adding is additive; changing or removing one is a v2)', () => {
    expect(FEED_ROUTES.map((r) => r.path)).toEqual([
      '/offers/active',
      '/offers/recent',
      '/offers/stats',
      '/offers/{id}',
      '/loans/active',
      '/loans/recent',
      '/loans/stats',
      '/loans/rate-candles',
      '/loans/{id}',
      '/repayment-record/{address}',
    ]);
    for (const r of FEED_ROUTES) {
      expect(r.about.source.length).toBeGreaterThan(0);
      expect(Array.isArray(r.about.excludes)).toBe(true);
    }
  });

  it('serves no per-wallet or private read', () => {
    const paths = FEED_ROUTES.map((r) => r.path).join(' ');
    for (const word of ['claim', 'notification', 'participant', 'holder', 'creator', 'threshold', 'goal', 'watch', 'telegram', 'activity']) {
      expect(paths).not.toContain(word);
    }
    expect(isPublicFeedPath('/public/v1')).toBe(true);
    expect(isPublicFeedPath('/public/v10')).toBe(false);
  });

  it('wraps a route with its block, sources and notice', async () => {
    const { env: e } = env();
    const res = await get(e, `/public/v1/loans/1?chainId=${BASE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.version).toBe('v1');
    expect(body.chainId).toBe(BASE);
    expect(body.asOf).toEqual({ block: 12_345, scannedAt: 1_800_000_000 });
    expect(body.about.source).toMatch(/events/);
    expect(body.notice).toMatch(/benchmark/);
    expect(body.data).toBeTruthy();
  });

  it('answers the catalogue at the prefix and refuses a route outside the feed', async () => {
    const { env: e } = env();
    const cat = (await (await get(e, '/public/v1')).json()) as any;
    expect(cat.routes.length).toBe(FEED_ROUTES.length);
    expect(cat).toEqual(JSON.parse(JSON.stringify(feedCatalogue())));
    expect((await get(e, `/public/v1/claimables/${addr(1)}`)).status).toBe(404);
    expect((await get(e, '/public/v1/activity')).status).toBe(404);
  });

  it('refuses when the budget is spent or the limiter is missing', async () => {
    expect((await get(env({ PUBLIC_FEED_RATELIMIT: { limit: async () => ({ success: false }) } }).env, '/public/v1')).status).toBe(429);
    expect((await get(env({ PUBLIC_FEED_RATELIMIT: undefined }).env, '/public/v1')).status).toBe(503);
  });

  it('passes a route error through with the feed version', async () => {
    const { env: e } = env();
    const res = await get(e, '/public/v1/loans/active?chainId=999999');
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Feed-Version')).toBe('v1');
  });
});
