/**
 * #2194 — the cron tick's passes no longer race the scan for one allowance.
 *
 * Two properties, and they need two kinds of test:
 *
 *  - The listing sweep ASKS the live budget before each row, so a tick ingest
 *    has already spent does not start one. Behavioural, against a real schema.
 *  - The snapshot and the sweep run AFTER ingest has settled, one after the
 *    other in one queue, so neither's check races the other's spend. That is a
 *    property of where the calls sit in `scheduled()`, which no test of either
 *    pass alone can establish, so it is checked structurally — the same way
 *    `offerCollateralRange.test.ts` pins where the heal lanes run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { sweepUnpublishedListings } from '../src/chainIndexer';
import { createBudget } from '../src/subrequestBudget';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

function seedUnpublished(h: ReturnType<typeof createSqliteD1>, loanId: number): void {
  h.db
    .prepare(
      `INSERT INTO prepay_listings
         (chain_id, loan_id, order_hash, ask_price, conduit, lister, posted_at, updated_at,
          grace_period_end, block_number, tx_hash, log_index, conduit_key, salt, executor)
       VALUES (84532, ?, ?, '100', '0xc0', '0xl1', 1, 1, 9999999999, 10, ?, 0, '0xk', '1', '0xe')`,
    )
    .run(loanId, `0xorder${loanId}`, `0x${String(loanId).padStart(64, '0')}`);
}

describe('the listing sweep asks before each row (#2194)', () => {
  const run = async (external: number) => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedUnpublished(h, 1);
    const budget = createBudget('test', { external });
    // Every outbound request fails: what is measured is whether the row was
    // STARTED, not whether it published. Stubbed at the global, because the
    // sweep meters the env it is given and its sender wraps the global fetch.
    const sent = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', sent);
    // Base Sepolia is not an OpenSea chain, so a STARTED row ends at the
    // terminal "unsupported chain" marker (published_at = 0) without any
    // request — the observable that tells a started row from a skipped one.
    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'https://rpc.invalid', OPENSEA_API_KEY: 'k' } as unknown as Env;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await sweepUnpublishedListings(env, budget).catch(() => {});
      const marker = (h.db.prepare('SELECT opensea_published_at AS p FROM prepay_listings WHERE loan_id = 1').get() as { p: number | null }).p;
      return { sent: sent.mock.calls.length, marker, warned: warn.mock.calls.map((c) => String(c[0])) };
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  };

  it('does not start a row the invocation cannot finish — seven external requests', async () => {
    const r = await run(6);
    expect(r.sent).toBe(0);
    expect(r.marker).toBeNull();
    expect(r.warned.some((w) => w.includes('listing sweep stopped at loan 1'))).toBe(true);
  });

  it('starts it when the seven are there', async () => {
    const r = await run(7);
    expect(r.marker).toBe(0);
  });
});

describe('the cron tick runs ingest first (#2194)', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const tick = src.slice(src.indexOf('async scheduled('), src.indexOf('async fetch('));

  it('queues the snapshot and the sweep behind the settled ingest, one after the other', () => {
    const settled = tick.indexOf('const ingestSettled = Promise.allSettled(ingest);');
    expect(settled).toBeGreaterThan(-1);
    // One serial queue, seeded with the settled ingest: each consumer's
    // `affords` check then sees what the earlier ones spent (#2647 r1).
    expect(tick).toContain('let afterIngest: Promise<unknown> = ingestSettled;');
    expect(tick).toContain('afterIngest = afterIngest.then(pass, pass);');
    // Nothing else starts directly off the settled ingest — a second
    // `ingestSettled.then(` would be a consumer running beside the queue.
    expect(tick.split('ingestSettled.then(').length - 1).toBe(0);
    let last = settled;
    for (const call of ['captureBackingSnapshot(resolved', 'sweepUnpublishedListings(resolved']) {
      const at = tick.indexOf(call);
      expect(at, call).toBeGreaterThan(last);
      // The nearest registration before the call is the queue.
      const before = tick.slice(0, at);
      expect(before.lastIndexOf('afterIngestPass(')).toBeGreaterThan(before.lastIndexOf('runPass('));
      last = at;
    }
  });

  it('asks the budget before the snapshot', () => {
    const at = tick.indexOf('captureBackingSnapshot(resolved');
    const gate = tick.lastIndexOf('affords(budget, BACKING_SNAPSHOT_COST)', at);
    expect(gate).toBeGreaterThan(tick.lastIndexOf('afterIngestPass(', at));
  });

  it('charges the Durable Object pings to the internal meter', () => {
    expect(tick).toContain("meterFetch(budget, stub.fetch.bind(stub), 'internal')");
  });
});
