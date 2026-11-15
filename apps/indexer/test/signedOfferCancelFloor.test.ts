/**
 * #3327 — `SignedOfferCancelFloorRaised` cancels every active order of the
 * signer whose nonce is below the floor. The nonce column is decimal text of
 * a uint256, so the comparison must hold past 2^63, where a SQLite cast would
 * lose precision.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { createSqliteD1 } from './helpers/sqliteD1';
import { processSignedOfferLogs, type DecodedLog } from '../src/chainIndexer';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const SIGNER = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const BIG = (1n << 200n).toString();

function insert(db: ReturnType<typeof createSqliteD1>['db'], orderHash: string, signer: string, nonce: string, status = 'active') {
  db.prepare(
    `INSERT INTO signed_offers
       (chain_id, order_hash, signer, order_json, signature,
        offer_type, lending_asset, collateral_asset, duration_days,
        asset_type, collateral_asset_type, interest_rate_bps, interest_rate_bps_max,
        amount, amount_max, collateral_amount, collateral_amount_max,
        fill_mode, expires_at, deadline, nonce, status, filled_amount, created_at, updated_at)
     VALUES (84532, ?, ?, '{}', '0xsig', 0, '0xl', '0xc', 30, 0, 0, 500, 500,
             '1', '1', '1', '1', 0, 0, 0, ?, ?, '0', 1, 1)`,
  ).run(orderHash, signer, nonce, status);
}

function floorLog(signer: string, floor: bigint): DecodedLog {
  return {
    eventName: 'SignedOfferCancelFloorRaised',
    args: { signer, floor },
    blockNumber: 10n,
    transactionHash: '0xtx',
    logIndex: 0,
  };
}

describe('SignedOfferCancelFloorRaised (#3327)', () => {
  it('cancels only the signer’s active orders below the floor, comparing as uint256', async () => {
    const { db, d1 } = createSqliteD1(ALL);
    insert(db, 'below', SIGNER, '5');
    insert(db, 'at', SIGNER, '100');
    insert(db, 'above-big', SIGNER, BIG);
    insert(db, 'below-big', SIGNER, (1n << 199n).toString());
    insert(db, 'filled', SIGNER, '1', 'filled');
    insert(db, 'other', OTHER, '1');
    const env = { DB: d1 } as unknown as Env;
    const n = await processSignedOfferLogs(
      [floorLog(SIGNER, 100n), floorLog(SIGNER, 1n << 200n)],
      env,
      84532,
      {} as PublicClient,
      '0x0000000000000000000000000000000000000001',
    );
    expect(n).toBe(3);
    const status = Object.fromEntries(
      (db.prepare('SELECT order_hash, status FROM signed_offers').all() as Array<{ order_hash: string; status: string }>)
        .map((r) => [r.order_hash, r.status]),
    );
    expect(status).toEqual({
      below: 'nonce_burned',
      at: 'nonce_burned', // below the second floor, 2^200
      'above-big': 'active',
      'below-big': 'nonce_burned',
      filled: 'filled',
      other: 'active',
    });
  });
});
