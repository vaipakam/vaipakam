/**
 * Notification-center feed route (#1213 / E-11): GET /notifications/:addr
 * (newest-first, recipient-scoped, keyset cursor, no-store). Read/unread
 * state is client-side (a per-wallet last-seen cursor), so there is no
 * server mutation route to test. Runs against the REAL migrated schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleNotifications } from '../src/loanRoutes';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const ME = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  let auto = 0;
  const seed = (recipient: string, kind: string, loanId: number, createdAt: number) => {
    auto += 1;
    h.db
      .prepare(
        `INSERT INTO notifications
           (chain_id, recipient, kind, loan_id, event_kind, block_number,
            log_index, created_at, dedup_key)
         VALUES (84532, ?, ?, ?, 'E', 1, ?, ?, ?)`,
      )
      .run(recipient, kind, loanId, auto, createdAt, `k${auto}`);
  };
  const getFeed = async (qs = '', addr = ME) => {
    const res = await handleNotifications(
      new Request(`https://idx/notifications/${addr}?chainId=84532${qs}`),
      env,
      addr,
    );
    return {
      status: res.status,
      cacheControl: res.headers.get('Cache-Control'),
      body: (await res.json()) as {
        notifications: Array<{ id: number; kind: string; loanId: number; createdAt: number }>;
        nextBefore: string | null;
      },
    };
  };
  return { ...h, env, seed, getFeed };
}

describe('GET /notifications/:addr', () => {
  it('returns the wallet rows newest-first, excluding other wallets', async () => {
    const h = makeHarness();
    h.seed(ME, 'loan_matched', 1, 100);
    h.seed(ME, 'loan_repaid', 2, 300); // newest
    h.seed(ME, 'partial_repay', 3, 200);
    h.seed(OTHER, 'loan_matched', 9, 999); // another wallet — excluded
    const { body, cacheControl } = await h.getFeed();
    expect(body.notifications.map((n) => n.loanId)).toEqual([2, 3, 1]);
    // Per-wallet surface must not be shared-cached.
    expect(cacheControl).toBe('no-store');
  });

  it('paginates with the (createdAt:id) cursor', async () => {
    const h = makeHarness();
    for (let i = 1; i <= 3; i++) h.seed(ME, 'loan_matched', i, i * 100);
    const page1 = await h.getFeed('&limit=2');
    expect(page1.body.notifications.map((n) => n.loanId)).toEqual([3, 2]);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await h.getFeed(`&limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.notifications.map((n) => n.loanId)).toEqual([1]);
    expect(page2.body.nextBefore).toBeNull();
  });

  it('breaks a created_at tie by id (keyset cursor, no repeats/skips)', async () => {
    const h = makeHarness();
    // Three rows at the SAME created_at — the cursor must still page
    // them without repeating or skipping.
    h.seed(ME, 'loan_matched', 1, 500);
    h.seed(ME, 'loan_matched', 2, 500);
    h.seed(ME, 'loan_matched', 3, 500);
    const p1 = await h.getFeed('&limit=2');
    const p2 = await h.getFeed(`&limit=2&before=${p1.body.nextBefore}`);
    const seen = [...p1.body.notifications, ...p2.body.notifications].map((n) => n.id);
    expect(new Set(seen).size).toBe(3); // all three, once each
  });

  it('rejects a bad address and a malformed cursor', async () => {
    const h = makeHarness();
    const bad = await handleNotifications(
      new Request('https://idx/notifications/nope?chainId=84532'),
      h.env,
      'nope',
    );
    expect(bad.status).toBe(400);
    const badCursor = await h.getFeed('&before=notacursor');
    expect(badCursor.status).toBe(400);
  });
});
