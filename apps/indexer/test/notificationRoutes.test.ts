/**
 * Notification-center routes (#1213 / E-11): GET /notifications/:addr
 * (newest-first feed + unread count + cursor) and POST
 * /notifications/:addr/read (recipient-scoped mark-read). Runs against
 * the REAL migrated schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleNotifications, handleNotificationsRead } from '../src/loanRoutes';
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
  const seed = (
    recipient: string,
    kind: string,
    loanId: number,
    createdAt: number,
    readAt: number | null = null,
  ) => {
    auto += 1;
    h.db
      .prepare(
        `INSERT INTO notifications
           (chain_id, recipient, kind, loan_id, event_kind, block_number,
            log_index, created_at, read_at, dedup_key)
         VALUES (84532, ?, ?, ?, 'E', 1, ?, ?, ?, ?)`,
      )
      .run(recipient, kind, loanId, auto, createdAt, readAt, `k${auto}`);
  };
  const getFeed = async (qs = '') => {
    const res = await handleNotifications(
      new Request(`https://idx/notifications/${ME}?chainId=84532${qs}`),
      env,
      ME,
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        notifications: Array<{ id: number; kind: string; loanId: number; read: boolean; createdAt: number }>;
        unreadCount: number;
        nextBefore: string | null;
      },
    };
  };
  const markRead = async (body: unknown, addr = ME) => {
    const res = await handleNotificationsRead(
      new Request(`https://idx/notifications/${addr}/read?chainId=84532`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      env,
      addr,
    );
    return { status: res.status, body: (await res.json()) as { marked?: number; error?: string } };
  };
  return { ...h, env, seed, getFeed, markRead };
}

describe('GET /notifications/:addr', () => {
  it('returns the wallet rows newest-first with the full unread count', async () => {
    const h = makeHarness();
    h.seed(ME, 'loan_matched', 1, 100);
    h.seed(ME, 'loan_repaid', 2, 300); // newest
    h.seed(ME, 'partial_repay', 3, 200);
    h.seed(OTHER, 'loan_matched', 9, 999); // another wallet — excluded
    const { body } = await h.getFeed();
    expect(body.notifications.map((n) => n.loanId)).toEqual([2, 3, 1]);
    expect(body.unreadCount).toBe(3);
  });

  it('unreadOnly filters read rows but the count stays the FULL unread total', async () => {
    const h = makeHarness();
    h.seed(ME, 'loan_matched', 1, 100, 150); // read
    h.seed(ME, 'loan_repaid', 2, 200); // unread
    const all = await h.getFeed();
    expect(all.body.notifications).toHaveLength(2);
    const unread = await h.getFeed('&unreadOnly=1');
    expect(unread.body.notifications.map((n) => n.loanId)).toEqual([2]);
    expect(unread.body.unreadCount).toBe(1);
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

  it('rejects a bad address', async () => {
    const h = makeHarness();
    const res = await handleNotifications(
      new Request('https://idx/notifications/nope?chainId=84532'),
      h.env,
      'nope',
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /notifications/:addr/read', () => {
  it('marks specified ids read, scoped to the recipient', async () => {
    const h = makeHarness();
    h.seed(ME, 'loan_matched', 1, 100);
    h.seed(ME, 'loan_repaid', 2, 200);
    const before = await h.getFeed();
    const ids = before.body.notifications.map((n) => n.id);
    const r = await h.markRead({ ids: [ids[0]] });
    expect(r.body.marked).toBe(1);
    const after = await h.getFeed();
    expect(after.body.unreadCount).toBe(1);
  });

  it('all:true marks every unread row read', async () => {
    const h = makeHarness();
    h.seed(ME, 'loan_matched', 1, 100);
    h.seed(ME, 'loan_repaid', 2, 200);
    const r = await h.markRead({ all: true });
    expect(r.body.marked).toBe(2);
    expect((await h.getFeed()).body.unreadCount).toBe(0);
  });

  it('cannot mark ANOTHER wallet\'s rows read (recipient-scoped)', async () => {
    const h = makeHarness();
    h.seed(OTHER, 'loan_matched', 1, 100);
    // Learn OTHER's row id via a direct read, then try to mark it as ME.
    const otherId = (h.db.prepare('SELECT id FROM notifications').get() as { id: number }).id;
    const r = await h.markRead({ ids: [otherId] }, ME);
    expect(r.body.marked).toBe(0); // ME is not the recipient → no-op
    const stillUnread = (
      h.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }
    ).n;
    expect(stillUnread).toBe(1);
  });

  it('rejects a body with neither ids nor all', async () => {
    const h = makeHarness();
    const r = await h.markRead({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ids-or-all-required');
  });
});
