/**
 * #2195 (ledger half) — a repaired loan's ending on the Activity feed, and
 * #2196 — a push lost between a pass's commit and its broadcast.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { handleActivity } from '../src/loanRoutes';
import { REPAIR_OBSERVATION_LOG_INDEX_BASE } from '../src/repairObservations';
import {
  closeBroadcastWindow,
  invalidationFrameKeys,
  openBroadcastWindow,
  type LoopStateStorage,
} from '../src/chainIngestDO';
import type { ChainIndexerResult } from '../src/chainIndexer';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const CHAIN = 84532;
const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = (upTo?: string) =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && (upTo === undefined || f < upTo))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

function seedLoan(h: SqliteD1, loanId: number, observed?: { status: string; block: number; at: number | null }) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, ?, '0xl', '0xb', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', '0xl', '0xb',
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId, observed?.status ?? 'active');
  if (observed) {
    h.db
      .prepare(
        `UPDATE loans SET repair_observed_status = ?, repair_observed_block = ?, repair_observed_at = ?
          WHERE chain_id = ? AND loan_id = ?`,
      )
      .run(observed.status, observed.block, observed.at, CHAIN, loanId);
  }
}

function seedEvent(h: SqliteD1, block: number, logIndex: number, loanId: number, kind = 'LoanInitiated') {
  h.db
    .prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(CHAIN, block, logIndex, `0x${block.toString(16)}${logIndex}`, kind, loanId, block * 10);
}

type Page = {
  events: Array<{ blockNumber: number; logIndex: number; loanId: number }>;
  repairObservations: Array<Record<string, unknown>> | null;
  nextBefore: string | null;
};
const page = async (h: SqliteD1, query: string): Promise<Page> => {
  const res = await handleActivity(new Request(`https://x/activity?chainId=${CHAIN}&repairObservations=1&${query}`), {
    DB: h.d1,
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
};

describe('/activity serves a repaired loan’s ending as an observation, never as an event', () => {
  it('merges it into the feed order, saying what it observed and nothing it did not', async () => {
    const h = createSqliteD1(migrations());
    seedLoan(h, 7, { status: 'repaid', block: 500, at: 1_700_000_000 });
    seedEvent(h, 100, 0, 7);
    seedEvent(h, 600, 2, 8);
    const p = await page(h, 'limit=10');
    expect(p.events.map((e) => e.blockNumber)).toEqual([600, 100]);
    expect(p.repairObservations).toEqual([
      {
        chainId: CHAIN,
        loanId: 7,
        observedStatus: 'repaid',
        observedBlock: 500,
        observedAt: 1_700_000_000,
        feedLogIndex: REPAIR_OBSERVATION_LOG_INDEX_BASE + 7,
        provenance: 'reconciliation',
      },
    ]);
    // No invented event: nothing about it entered the log index.
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM activity_events WHERE loan_id = 7').get(),
    ).toEqual({ n: 1 });
    expect(p.nextBefore).toBeNull();
  });

  it('pages across observations at one block without dropping any', async () => {
    const h = createSqliteD1(migrations());
    for (const id of [3, 4, 5]) seedLoan(h, id, { status: 'defaulted', block: 900, at: null });
    seedEvent(h, 900, 4, 9);
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 5; i++) {
      const p: Page = await page(h, `limit=1${before ? `&before=${before}` : ''}`);
      seen.push(
        ...p.events.map((e) => `event:${e.loanId}`),
        ...(p.repairObservations ?? []).map((o) => `observed:${o.loanId}`),
      );
      if (p.nextBefore === null) break;
      before = p.nextBefore;
    }
    // Every observation sorts after the block's events, newest loan first.
    expect(seen).toEqual(['observed:5', 'observed:4', 'observed:3', 'event:9']);
  });

  it('filters by loan, and a page filtered on actor, offer or kind carries none', async () => {
    const h = createSqliteD1(migrations());
    seedLoan(h, 7, { status: 'repaid', block: 500, at: null });
    seedLoan(h, 8, { status: 'liquidated', block: 501, at: null });
    expect((await page(h, 'loanId=7')).repairObservations?.map((o) => o.loanId)).toEqual([7]);
    expect((await page(h, `actor=0x${'1'.repeat(40)}`)).repairObservations).toEqual([]);
    expect((await page(h, 'kind=LoanRepaid')).repairObservations).toEqual([]);
  });

  it('is opt-in: a reader that does not ask gets the events-only page it always got', async () => {
    const h = createSqliteD1(migrations());
    seedLoan(h, 7, { status: 'repaid', block: 500, at: null });
    seedEvent(h, 100, 0, 7);
    seedEvent(h, 600, 0, 8);
    const res = await handleActivity(new Request(`https://x/activity?chainId=${CHAIN}&limit=2`), {
      DB: h.d1,
      RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
    } as unknown as Env);
    const body = (await res.json()) as Record<string, unknown>;
    // Both events, no slot given to an entry the reader would not render.
    expect((body.events as Array<{ blockNumber: number }>).map((e) => e.blockNumber)).toEqual([600, 100]);
    expect('repairObservations' in body).toBe(false);
  });

  it('says NOT KNOWN on a database before 0066, and still serves the events', async () => {
    const h = createSqliteD1(migrations('0066'));
    seedEvent(h, 100, 0, 7);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await page(h, 'limit=10');
    warn.mockRestore();
    expect(p.events).toHaveLength(1);
    expect(p.repairObservations).toBeNull();
  });
});

function memoryStorage(): LoopStateStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>) {
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    async delete(key: string) {
      return data.delete(key);
    },
  };
}

const quietResult = { scannedFrom: 0n, scannedTo: 0n, newOffers: 0, statusUpdates: 0, detailRefreshes: 0, newLoans: 0, loanStatusUpdates: 0, loanDetailRefreshes: 0, activityEvents: 0 } as ChainIndexerResult;

describe('a push lost between commit and broadcast is recovered (#2196)', () => {
  it('a pass that never reached its broadcast leaves the marker, and the next one recovers', async () => {
    const storage = memoryStorage();
    // Pass 1 opens its window, commits, and its isolate dies: no close.
    expect(await openBroadcastWindow(storage)).toBe(false);
    expect(storage.data.get('pendingBroadcast')).toBe(true);
    // Pass 2 sees it.
    expect(await openBroadcastWindow(storage)).toBe(true);
    await closeBroadcastWindow(storage);
    // Pass 3: nothing outstanding.
    expect(await openBroadcastWindow(storage)).toBe(false);
  });

  it('a recovery frame carries every key and no hints, even when the pass has keys of its own', () => {
    const busy = { ...quietResult, activityEvents: 3, hints: { loanIds: [1] } } as unknown as ChainIndexerResult;
    const r = invalidationFrameKeys(busy, true);
    expect(r.hintable).toBe(false);
    expect(new Set(r.keys)).toEqual(
      new Set(['offer.created', 'offer.changed', 'loan.created', 'loan.updated', 'ownership.changed', 'notification.created', 'activity.appended']),
    );
    expect(invalidationFrameKeys(busy, false)).toEqual({ keys: ['activity.appended'], hintable: true });
  });
});
