/**
 * Migration 0093 (#3327): every stored signed offer is the 35-field order.
 *
 * The four maker-protection fields changed the typehash, so a row stored
 * before them can never fill. These cases pin what the migration removes and
 * what it must keep: a current-shape row whatever its lifecycle.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const THIS = '0093_delete_pre_3327_signed_offers.sql';
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

const ZERO = '0x0000000000000000000000000000000000000000';

describe('migration 0093 — pre-#3327 signed offers', () => {
  it('deletes every row not in the current shape and keeps every row that is', () => {
    const { db } = createSqliteD1(BEFORE);
    insert(db, 'current-active', `{"creatorFull":false,"coSigner":"${ZERO}"}`);
    insert(db, 'current-filled', `{"creatorFull":true,"coSigner":"${ZERO}"}`, 'filled');
    insert(db, 'old-active', '{"creatorFull":false}');
    insert(db, 'old-cancelled', '{"creatorFull":true}', 'cancelled');
    insert(db, 'not-json', 'not-json');
    db.exec(read(THIS));
    const left = (db.prepare('SELECT order_hash FROM signed_offers ORDER BY order_hash').all() as Array<{ order_hash: string }>)
      .map((r) => r.order_hash);
    expect(left).toEqual(['current-active', 'current-filled']);
  });

  it('is a no-op on a table with nothing to remove, and runs twice', () => {
    const { db } = createSqliteD1(BEFORE);
    insert(db, 'current-active', `{"coSigner":"${ZERO}"}`);
    db.exec(read(THIS));
    db.exec(read(THIS));
    expect(db.prepare('SELECT COUNT(*) AS n FROM signed_offers').get()).toEqual({ n: 1 });
  });
});
