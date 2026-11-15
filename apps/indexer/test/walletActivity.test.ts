/**
 * #3677 — `/activity?wallet=`: one wallet's history served by the indexer.
 *
 * Run against the REAL migrations in SQLite, because the behaviour is the
 * SQL: the union of the loan leg and the participant leg, ordered and cut to
 * the page's limit, the cursor, the pending lane's inline match, and the
 * backfill that fills the participant index from history already stored.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { handleActivity } from '../src/loanRoutes';
import { walletRepairObservationsPage } from '../src/repairObservations';
import {
  PARTICIPANT_BACKFILL_PAGE,
  PARTICIPANT_BACKFILL_ROWS,
  ensureActivityParticipantsBackfill,
  eventParticipants,
  inlineParticipants,
  walletEventsPage,
} from '../src/walletActivity';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const BASE = 84532;
const ME = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';

type Row = { block: number; log?: number; kind: string; loanId?: number | null; actor?: string | null; args?: Record<string, unknown> };

function db() {
  return createSqliteD1(migrations());
}

function seed(h: ReturnType<typeof db>, rows: Row[], opts: { index?: boolean } = {}) {
  for (const r of rows) {
    const args = r.args ?? {};
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, actor, args_json, block_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(BASE, r.block, r.log ?? 0, `0x${r.block.toString(16)}`, r.kind, r.loanId ?? null, r.actor ?? null, JSON.stringify(args), 1000 + r.block);
    if (opts.index !== false) {
      for (const w of eventParticipants(r.kind, args, r.actor ?? null)) {
        h.db
          .prepare('INSERT OR IGNORE INTO activity_participants (chain_id, block_number, log_index, wallet) VALUES (?, ?, ?, ?)')
          .run(BASE, r.block, r.log ?? 0, w);
      }
    }
  }
}

function participates(h: ReturnType<typeof db>, loanId: number, wallet: string) {
  h.db
    .prepare('INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at) VALUES (?, ?, ?, ?, ?)')
    .run(BASE, loanId, wallet, 'lender', 1);
}

function markDone(h: ReturnType<typeof db>) {
  h.db.prepare('INSERT INTO activity_participants_state (chain_id, through_block, through_log, done) VALUES (?, 0, 0, 1)').run(BASE);
}

type Page = {
  wallet: string;
  events: Array<{ blockNumber: number; kind: string }>;
  walletComplete: boolean | null;
  nextBefore: string | null;
  pending?: { events: Array<{ blockNumber: number }> } | null;
  repairObservations?: unknown[] | null;
};

async function get(h: { d1: unknown }, query: string): Promise<{ status: number; body: Page & { error?: string } }> {
  const res = await handleActivity(new Request(`https://x/activity?chainId=${BASE}&${query}`), {
    DB: h.d1,
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env);
  return { status: res.status, body: (await res.json()) as Page & { error?: string } };
}

describe('/activity?wallet=', () => {
  it('serves the events on the wallet’s loans and the events naming it, newest first, and nothing else', async () => {
    const h = db();
    participates(h, 7, ME);
    participates(h, 8, OTHER);
    seed(h, [
      // On the wallet's loan, with no actor (a keeper-triggered default).
      { block: 10, kind: 'LoanDefaulted', loanId: 7 },
      // Another wallet's loan.
      { block: 11, kind: 'LoanDefaulted', loanId: 8 },
      // The wallet acted, outside any loan (an offer it created).
      { block: 12, kind: 'OfferCreated', actor: ME, args: { creator: ME } },
      // Another wallet's offer.
      { block: 13, kind: 'OfferCreated', actor: OTHER, args: { creator: OTHER } },
    ]);
    markDone(h);
    const { status, body } = await get(h, `wallet=${ME.toUpperCase().replace('0X', '0x')}`);
    expect(status).toBe(200);
    expect(body.wallet).toBe(ME);
    expect(body.events.map((e) => e.blockNumber)).toEqual([12, 10]);
    expect(body.walletComplete).toBe(true);
    expect(body.nextBefore).toBeNull();
  });

  it('counts an event both legs find once, and pages exactly with the cursor', async () => {
    const h = db();
    participates(h, 7, ME);
    const rows: Row[] = [];
    for (let b = 1; b <= 5; b++) rows.push({ block: b, kind: 'OfferCreated', loanId: 7, actor: ME, args: { creator: ME } });
    seed(h, rows);
    markDone(h);
    const first = await get(h, `wallet=${ME}&limit=2`);
    expect(first.body.events.map((e) => e.blockNumber)).toEqual([5, 4]);
    expect(first.body.nextBefore).toBe('4:0');
    const second = await get(h, `wallet=${ME}&limit=2&before=4:0`);
    expect(second.body.events.map((e) => e.blockNumber)).toEqual([3, 2]);
    const third = await get(h, `wallet=${ME}&limit=2&before=2:0`);
    expect(third.body.events.map((e) => e.blockNumber)).toEqual([1]);
    expect(third.body.nextBefore).toBeNull();
  });

  it('pages past participant rows whose event is no longer stored', async () => {
    const h = db();
    seed(h, [
      { block: 1, kind: 'OfferCreated', actor: ME, args: { creator: ME } },
      { block: 2, kind: 'OfferCreated', actor: ME, args: { creator: ME } },
      { block: 3, kind: 'OfferCreated', actor: ME, args: { creator: ME } },
      { block: 4, kind: 'OfferCreated', actor: ME, args: { creator: ME } },
    ]);
    // A withdrawn phantom loan's events are deleted; their participant rows stay.
    h.db.prepare('DELETE FROM activity_events WHERE block_number IN (3, 4)').run();
    markDone(h);
    const { body } = await get(h, `wallet=${ME}&limit=2`);
    expect(body.events.map((e) => e.blockNumber)).toEqual([2, 1]);
  });

  it('reads only the wallet’s own rows, whatever the chain’s history (each event by its key)', () => {
    const h = db();
    let sql = '';
    const capture = { prepare: (q: string) => ((sql = q), { bind: () => ({}) }) } as unknown as D1Database;
    walletEventsPage(capture, BASE, ME, undefined, 50);
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(BASE, ME, null, null, 50) as Array<{ detail: string }>).map((r) => r.detail);
    const events = plan.filter((d) => /^(SCAN|SEARCH) (pe|le|e)\b/.test(d));
    expect(events).toHaveLength(3);
    // No leg walks the chain's events: the participant check and the final
    // read are primary-key lookups, the loan leg reads each loan's events.
    expect(events.every((d) => d.startsWith('SEARCH'))).toBe(true);
    expect(events.filter((d) => d.includes('(chain_id=? AND block_number=? AND log_index=?)'))).toHaveLength(2);
    expect(events.filter((d) => d.includes('(chain_id=? AND loan_id=?)'))).toHaveLength(1);
  });

  it('reads the repaired endings of the wallet’s own loans only, each loan by its key', () => {
    const h = db();
    let sql = '';
    const capture = { prepare: (q: string) => ((sql = q), { bind: () => ({}) }) } as unknown as D1Database;
    walletRepairObservationsPage(capture, BASE, ME, undefined, 50);
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(BASE, ME, null, 0, 50) as Array<{ detail: string }>).map((r) => r.detail);
    const loans = plan.filter((d) => /^(SCAN|SEARCH) l\b/.test(d));
    expect(loans).toHaveLength(1);
    expect(loans[0]).toMatch(/^SEARCH l USING .*\(chain_id=\? AND loan_id=\?\)/);
  });

  it('refuses a wallet filter combined with another filter, and a malformed wallet', async () => {
    const h = db();
    expect((await get(h, `wallet=${ME}&kind=OfferCreated`)).body.error).toBe('wallet-filter-alone');
    expect((await get(h, `wallet=${ME}&loanId=1`)).status).toBe(400);
    expect((await get(h, 'wallet=0x12')).body.error).toBe('bad-wallet');
  });

  it('says the answer may be incomplete until the backfill has read every stored event', async () => {
    const h = db();
    expect((await get(h, `wallet=${ME}`)).body.walletComplete).toBe(false);
  });

  it('shows a repaired ending only for the wallet’s own loans', async () => {
    const h = db();
    participates(h, 7, ME);
    for (const id of [7, 8]) {
      h.db
        .prepare(
          `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
             principal, collateral_amount, asset_type, collateral_asset_type,
             lending_asset, collateral_asset, duration_days, token_id,
             collateral_token_id, lender_token_id, borrower_token_id,
             lender_current_owner, borrower_current_owner, interest_rate_bps,
             start_time, start_block, start_at, updated_at,
             repair_observed_status, repair_observed_block, repair_observed_at)
           VALUES (?, ?, 1, 'repaid', ?, ?, '100', '200', 0, 0, '0xasset', '0xcoll', 30, '0', '0', '1', '2', ?, ?,
             500, 0, 0, 0, 0, 'repaid', 20, 2000)`,
        )
        .run(BASE, id, ME, OTHER, ME, OTHER);
    }
    markDone(h);
    const { body } = await get(h, `wallet=${ME}&repairObservations=1`);
    expect(body.repairObservations).toHaveLength(1);
  });
});

describe('the participant backfill', () => {
  it('fills the index from stored events within a fixed write budget per call, then reports itself done', async () => {
    const h = db();
    const rows: Row[] = [];
    const n = PARTICIPANT_BACKFILL_PAGE + 3;
    for (let b = 1; b <= n; b++) rows.push({ block: b, kind: 'OfferCreated', actor: b % 2 ? ME : OTHER, args: { creator: b % 2 ? ME : OTHER } });
    seed(h, rows, { index: false });
    const env = { DB: h.d1 } as unknown as Env;
    const count = () => (h.db.prepare('SELECT COUNT(*) AS c FROM activity_participants').get() as { c: number }).c;
    let passes = 0;
    while ((await get(h, `wallet=${ME}&limit=1`)).body.walletComplete !== true) {
      const before = count();
      await ensureActivityParticipantsBackfill(env, BASE);
      // Each call writes at most its row budget, and always moves forward.
      expect(count() - before).toBeGreaterThan(0);
      expect(count() - before).toBeLessThanOrEqual(PARTICIPANT_BACKFILL_ROWS);
      passes++;
      expect(passes).toBeLessThan(10);
    }
    expect(passes).toBe(Math.ceil(n / PARTICIPANT_BACKFILL_ROWS));
    const mine = (h.db.prepare('SELECT COUNT(*) AS c FROM activity_participants WHERE wallet = ?').get(ME) as { c: number }).c;
    expect(mine).toBe(Math.ceil(n / 2));
    // Done: a further call reads nothing and changes nothing.
    await ensureActivityParticipantsBackfill(env, BASE);
    expect(count()).toBe(n);
  });
});

describe('participants', () => {
  it('drops the zero address and lower-cases, and inlines with a space on each side', () => {
    expect(eventParticipants('OfferCreated', { creator: ME }, '0x0000000000000000000000000000000000000000')).toEqual([ME]);
    expect(inlineParticipants([ME, OTHER])).toBe(` ${ME} ${OTHER} `);
    expect(inlineParticipants([])).toBeNull();
  });
});
