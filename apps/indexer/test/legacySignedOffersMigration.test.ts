/**
 * Migration 0078 (#1481): every stored signed offer is the 31-field order.
 *
 * The book and the market summaries used to filter pre-#1949 rows out with a
 * predicate on `order_json`; the migration deletes them instead, and the
 * readers dropped the predicate. These cases pin what it removes and, as
 * much, what it must keep: a current-shape row whatever its lifecycle.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const THIS = '0078_delete_legacy_signed_offers.sql';
const BEFORE = files.filter((f) => f < THIS).map(read);

function insert(db: ReturnType<typeof createSqliteD1>['db'], orderHash: string, orderJson: string, status = 'active') {
  db.prepare(
    `INSERT INTO signed_offers
       (chain_id, order_hash, signer, order_json, signature,
        offer_type, lending_asset, collateral_asset, duration_days,
        asset_type, collateral_asset_type, interest_rate_bps, interest_rate_bps_max,
        amount, amount_max, collateral_amount, collateral_amount_max,
        fill_mode, expires_at, deadline, nonce, status, filled_amount, created_at, updated_at)
     VALUES (84532, ?, '0xs', ?, '0xsig', 0, '0xl', '0xc', 30, 0, 0, 500, 500,
             '1', '1', '1', '1', 0, 0, 0, '0', ?, '0', 1, 1)`,
  ).run(orderHash, orderJson, status);
}

describe('migration 0078 — legacy signed offers (#1481)', () => {
  it('deletes every row not in the current shape and keeps every row that is', () => {
    const { db } = createSqliteD1(BEFORE);
    insert(db, 'current-active', '{"creatorFull":false}');
    insert(db, 'current-filled', '{"creatorFull":true}', 'filled');
    insert(db, 'legacy-active', '{"useFullTermInterest":false}');
    insert(db, 'legacy-cancelled', '{}', 'cancelled');
    insert(db, 'not-json', 'not-json');
    db.exec(read(THIS));
    const left = (db.prepare('SELECT order_hash FROM signed_offers ORDER BY order_hash').all() as Array<{ order_hash: string }>)
      .map((r) => r.order_hash);
    expect(left).toEqual(['current-active', 'current-filled']);
  });

  it('is a no-op on a table with nothing to remove, and runs twice', () => {
    const { db } = createSqliteD1(BEFORE);
    insert(db, 'current-active', '{"creatorFull":false}');
    db.exec(read(THIS));
    db.exec(read(THIS));
    expect(db.prepare('SELECT COUNT(*) AS n FROM signed_offers').get()).toEqual({ n: 1 });
  });
});
