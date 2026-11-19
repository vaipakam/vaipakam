/**
 * #3744 — `/offers/held-refunds/:address` lists offer escrow the event log
 * shows as held for a wallet's offer position tokens. It is a list of
 * candidates with a log figure; the app reads the amount and the holder live.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { foldHeldRefunds, handleOfferHeldRefunds } from '../src/offerHeldRefundsRoute';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const HOLDER = '0x' + '11'.repeat(20);
const OTHER = '0x' + '22'.repeat(20);
const USDC = '0x' + 'aa'.repeat(20);

const returned = (token: string, amount: string, held: boolean, holder = HOLDER) =>
  JSON.stringify({ offerId: '9', positionToken: token, holder, asset: USDC, tokenId: '0', amount, held });
const collected = (token: string, amount: string, holder = HOLDER) =>
  JSON.stringify({ positionToken: token, holder, asset: USDC, tokenId: '0', amount });

describe('held offer refunds (#3744)', () => {
  it('adds held returns, subtracts collections and ignores paid returns', () => {
    const lines = foldHeldRefunds(
      [
        { kind: 'OfferEscrowReturned', args_json: returned('5', '100', true), offer_id: 9 },
        { kind: 'OfferEscrowReturned', args_json: returned('5', '50', false), offer_id: 9 },
        { kind: 'OfferEscrowReturned', args_json: returned('5', '30', true), offer_id: 9 },
        { kind: 'OfferRefundCollected', args_json: collected('5', '100'), offer_id: null },
        { kind: 'OfferEscrowReturned', args_json: returned('6', '10', true), offer_id: 10 },
        { kind: 'OfferRefundCollected', args_json: collected('6', '10'), offer_id: null },
      ],
      new Map([[9, { offer_id: 9, lending_asset: USDC, asset_type: 0, collateral_asset: OTHER, collateral_asset_type: 1 }]]),
    );
    expect(lines).toEqual([
      { positionToken: '5', asset: USDC, tokenId: '0', indexedRemaining: '30', offerIds: [9], assetKind: 0 },
    ]);
  });

  it('serves the lines named for the wallet or for a token it holds now', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const ev = (block: number, kind: string, actor: string, args: string, offerId: number | null) =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, offer_id, actor, args_json, block_at)
           VALUES (?, ?, 0, '0x01', ?, ?, ?, ?, 1)`,
        )
        .run(CHAIN, block, kind, offerId, actor, args);
    // Token 5: held for HOLDER by name. Token 7: held for OTHER, but the
    // token moved to HOLDER since. Token 8: held for OTHER, still OTHER's.
    ev(1, 'OfferEscrowReturned', HOLDER, returned('5', '100', true), 9);
    ev(2, 'OfferEscrowReturned', OTHER, returned('7', '40', true, OTHER), 9);
    ev(3, 'OfferEscrowReturned', OTHER, returned('8', '60', true, OTHER), 9);
    h.db
      .prepare(
        `INSERT INTO offers (chain_id, offer_id, status, creator, creator_current_owner, offer_type, asset_type,
           collateral_asset_type, lending_asset, collateral_asset, amount, interest_rate_bps, collateral_amount,
           duration_days, position_token_id, first_seen_block, first_seen_at, updated_at)
         VALUES (?, 9, 'active', '0xc0', ?, 0, 0, 0, ?, '0xb1', '1000', 500, '150', 30, '7', 1, 1, 1)`,
      )
      .run(CHAIN, HOLDER, USDC);
    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    const res = await handleOfferHeldRefunds(
      new Request(`https://x/offers/held-refunds/${HOLDER}?chainId=${CHAIN}`),
      env,
      HOLDER,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { positionToken: string; indexedRemaining: string }[]; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.lines.map((l) => [l.positionToken, l.indexedRemaining]).sort()).toEqual([
      ['5', '100'],
      ['7', '40'],
    ]);
  });

  it('refuses a malformed address', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    const res = await handleOfferHeldRefunds(new Request(`https://x/offers/held-refunds/0x12?chainId=${CHAIN}`), env, '0x12');
    expect(res.status).toBe(400);
  });
});
