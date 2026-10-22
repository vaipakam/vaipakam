/**
 * #2080 — `/loans/stats` and `/offers/stats` read their counters and the
 * ingest cursor they cite from ONE D1 batch, which D1 runs as a single
 * transaction, so a response can never pair pre-ingest counters with a
 * post-ingest cursor.
 *
 * Pinned by refusing every read made outside a batch: the database below
 * answers `batch()` and throws on a lone `first()` / `all()`. A handler that
 * goes back to reading the cursor (or any counter) on its own fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleLoansStats } from '../src/loanRoutes';
import { handleOffersStats } from '../src/offerRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;

function snapshotOnlyEnv(): Env {
  const h = createSqliteD1(ALL_MIGRATIONS);
  h.db
    .prepare(`INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', 777, 1700000000)`)
    .run(CHAIN);
  const inner = h.d1 as {
    prepare: (sql: string) => { bind: (...a: unknown[]) => Record<string, unknown> };
    batch: (s: unknown[]) => Promise<unknown>;
  };
  const outside = () => {
    throw new Error('read outside the snapshot batch');
  };
  const d1 = {
    prepare(sql: string) {
      const stmt = inner.prepare(sql);
      return {
        first: outside,
        all: outside,
        bind: (...args: unknown[]) => ({ ...stmt.bind(...args), first: outside, all: outside }),
      };
    },
    batch: (s: unknown[]) => inner.batch(s),
  };
  return { DB: d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
}

describe('stats read counters and cursor in one snapshot (#2080)', () => {
  it('/loans/stats', async () => {
    const res = await handleLoansStats(new Request(`https://x/loans/stats?chainId=${CHAIN}`), snapshotOnlyEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; indexer: { lastBlock: number } | null };
    expect(body.total).toBe(0);
    expect(body.indexer?.lastBlock).toBe(777);
  });

  it('/offers/stats', async () => {
    const res = await handleOffersStats(new Request(`https://x/offers/stats?chainId=${CHAIN}`), snapshotOnlyEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; indexer: { lastBlock: number } | null };
    expect(body.total).toBe(0);
    expect(body.indexer?.lastBlock).toBe(777);
  });
});
