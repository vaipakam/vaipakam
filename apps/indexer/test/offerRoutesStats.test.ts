/**
 * GET /offers/stats — how a row's STATUS becomes a published bucket.
 *
 * This endpoint is what the public transparency dashboard prints as the
 * deployment's offer counts, and #2069 changed its classification four
 * times over as many review rounds: bookkeeping vehicles excluded,
 * lazily-expired offers reclassified, every persisted status named so
 * the buckets sum to the published total, and stub rows separated from
 * genuinely open ones. Every one of those was verified by reading the
 * SQL and by what the live endpoint happened to return that day — which
 * is not a test, and would not have caught a reordered CASE.
 *
 * The behaviour under test IS the SQL, so these run against a real
 * in-memory SQLite database with a minimal projection of the `offers`
 * columns the aggregate touches. Two of the rules are only observable
 * in combination and are pinned as such:
 *
 *   - `expires_at = 0` means GTC (never expires) and must NOT be swept
 *     into `expired` by a `<=` against now;
 *   - a STUB's `expires_at` is also 0, because the ingest inserts the
 *     row without that column and it takes the default — so a stub is
 *     indistinguishable from GTC on that field alone, and the stub
 *     branch has to be decided first.
 *
 * The second rule is the one with a trap: reorder the CASE and every
 * unhealed stub silently reappears as an open, fillable offer.
 */
import { describe, expect, it } from 'vitest';
import { handleOffersStats } from '../src/offerRoutes';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const CHAIN_ID = 84532;
const NOW = Math.floor(Date.now() / 1000);

/** Minimal `offers` projection — the columns the stats aggregate reads. */
const OFFERS_DDL = `
CREATE TABLE offers (
  chain_id          INTEGER NOT NULL,
  offer_id          INTEGER NOT NULL,
  status            TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL DEFAULT 0,
  is_stub           INTEGER NOT NULL DEFAULT 0,
  is_sale_vehicle   INTEGER NOT NULL DEFAULT 0,
  is_offset_vehicle INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, offer_id)
);`;

const INDEXER_CURSOR_DDL = `
CREATE TABLE indexer_cursor (
  chain_id   INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  last_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, kind)
);`;

let nextOfferId = 1;

function insert(
  h: SqliteD1,
  o: {
    status: string;
    /** Omitted = the column default of 0, exactly as the stub INSERT leaves it. */
    expiresAt?: number;
    isStub?: boolean;
    saleVehicle?: boolean;
    offsetVehicle?: boolean;
    chainId?: number;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO offers
         (chain_id, offer_id, status, expires_at, is_stub, is_sale_vehicle, is_offset_vehicle)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.chainId ?? CHAIN_ID,
      nextOfferId++,
      o.status,
      o.expiresAt ?? 0,
      o.isStub ? 1 : 0,
      o.saleVehicle ? 1 : 0,
      o.offsetVehicle ? 1 : 0,
    );
}

async function stats(h: SqliteD1): Promise<Record<string, number>> {
  const env = { DB: h.d1 } as unknown as Env;
  const res = await handleOffersStats(
    new Request(`https://x/offers/stats?chainId=${CHAIN_ID}`),
    env,
  );
  return (await res.json()) as Record<string, number>;
}

function fresh(): SqliteD1 {
  nextOfferId = 1;
  return createSqliteD1([OFFERS_DDL, INDEXER_CURSOR_DDL]);
}

describe('GET /offers/stats — bucket classification', () => {
  it('treats expires_at = 0 as GTC, not as long-expired', async () => {
    const h = fresh();
    insert(h, { status: 'active', expiresAt: 0 });
    const s = await stats(h);
    expect(s.active).toBe(1);
    expect(s.expired).toBe(0);
  });

  it('reclassifies an active offer past its deadline as expired', async () => {
    const h = fresh();
    insert(h, { status: 'active', expiresAt: NOW - 60 });
    const s = await stats(h);
    expect(s.active).toBe(0);
    expect(s.expired).toBe(1);
  });

  it('leaves an active offer with a future deadline alone', async () => {
    const h = fresh();
    insert(h, { status: 'active', expiresAt: NOW + 3600 });
    const s = await stats(h);
    expect(s.active).toBe(1);
    expect(s.expired).toBe(0);
  });

  it('does not count an unhealed stub as an open offer', async () => {
    // The trap this test exists for: the stub INSERT omits `expires_at`,
    // so the row carries the column default of 0 — the same value that
    // means GTC. Decide the expiry branch first and every unhealed stub
    // reappears as fillable liquidity, indefinitely.
    const h = fresh();
    insert(h, { status: 'active', isStub: true });
    const s = await stats(h);
    expect(s.activeUnknownExpiry).toBe(1);
    expect(s.active).toBe(0);
    expect(s.expired).toBe(0);
  });

  it('keeps a stub out of the open bucket even with a past deadline', async () => {
    // `is_stub` means "expiry unknown" whatever the column happens to
    // hold, because the heal path writes the real value and clears the
    // flag together. Neither branch may claim this row.
    const h = fresh();
    insert(h, { status: 'active', expiresAt: NOW - 60, isStub: true });
    const s = await stats(h);
    expect(s.activeUnknownExpiry).toBe(1);
    expect(s.active).toBe(0);
    expect(s.expired).toBe(0);
  });

  it('excludes sale and offset vehicles from every bucket', async () => {
    const h = fresh();
    insert(h, { status: 'active', saleVehicle: true });
    insert(h, { status: 'active', offsetVehicle: true });
    insert(h, { status: 'active' });
    const s = await stats(h);
    expect(s.active).toBe(1);
    expect(s.total).toBe(1);
  });

  it('publishes every counted status, so the buckets sum to the total', async () => {
    // The reconciliation rule: a reader adding up what the page shows
    // must reach the Total beside it. `fullyFilled` and the catch-all
    // exist because the table holds statuses the response did not name,
    // and those rows were counted in `total` regardless.
    const h = fresh();
    insert(h, { status: 'active' });
    insert(h, { status: 'accepted' });
    insert(h, { status: 'cancelled' });
    insert(h, { status: 'expired' });
    insert(h, { status: 'consumed_by_sale' });
    insert(h, { status: 'fullyFilled' });
    insert(h, { status: 'active', isStub: true });
    insert(h, { status: 'some_future_status' });

    const s = await stats(h);
    const named =
      s.active +
      s.accepted +
      s.cancelled +
      s.expired +
      s.consumedBySale +
      s.fullyFilled +
      s.activeUnknownExpiry +
      s.other;
    expect(named).toBe(s.total);
    expect(s.total).toBe(8);
    // The unrecognised status is visible rather than absorbed silently.
    expect(s.other).toBe(1);
  });

  it('counts only the requested chain', async () => {
    const h = fresh();
    insert(h, { status: 'active' });
    insert(h, { status: 'active', chainId: 8453 });
    const s = await stats(h);
    expect(s.total).toBe(1);
  });
});
