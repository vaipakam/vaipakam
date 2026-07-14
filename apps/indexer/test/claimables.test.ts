/**
 * GET /claimables/:address — the defi claim surface's indexer
 * candidate layer, pinned (#1234). Runs against the REAL migrated
 * schema (the route SELECTs *, so a trimmed DDL would drift), seeding
 * only the columns the filters and the JSON mapper touch.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleClaimables } from '../src/loanRoutes';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort() // wrangler applies in filename order
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const ME = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const seed = (loanId: number, status: string, lenderOwner: string, borrowerOwner: string) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at)
         VALUES (84532, ?, 1, ?, ?, ?, '100', '200', 0, 0, '0xlend', '0xcoll',
           30, '0', '0', '1', '2', ?, ?, 500, 0, 0, 0, 0)`,
      )
      .run(loanId, status, lenderOwner, borrowerOwner, lenderOwner, borrowerOwner);
  const call = async () => {
    const res = await handleClaimables(
      new Request(`https://idx/claimables/${ME}?chainId=84532`),
      env,
      ME,
    );
    return (await res.json()) as {
      asLender: Array<{ loanId: number; status: string }>;
      asBorrower: Array<{ loanId: number; status: string }>;
    };
  };
  return { ...h, seed, call };
}

describe('GET /claimables/:address', () => {
  it('includes internal_matched terminal loans (#1234)', async () => {
    const h = makeHarness();
    h.seed(1, 'internal_matched', ME, OTHER);
    h.seed(2, 'repaid', OTHER, ME);
    const body = await h.call();
    expect(body.asLender.map((l) => [l.loanId, l.status])).toEqual([
      [1, 'internal_matched'],
    ]);
    expect(body.asBorrower.map((l) => l.loanId)).toEqual([2]);
  });

  it('still excludes non-terminal and fully-consumed statuses', async () => {
    const h = makeHarness();
    h.seed(1, 'active', ME, ME);
    h.seed(2, 'settled', ME, ME);
    h.seed(3, 'fallback_pending', ME, ME);
    const body = await h.call();
    expect(body.asLender).toEqual([]);
    expect(body.asBorrower).toEqual([]);
  });

  it('drops a side whose claim already fired (activity belt-and-suspenders)', async () => {
    const h = makeHarness();
    h.seed(1, 'internal_matched', ME, ME);
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index,
           tx_hash, kind, loan_id, actor, args_json, block_at)
         VALUES (84532, 1, 0, '0xabc', 'LenderFundsClaimed', 1, ?, '{}', 0)`,
      )
      .run(ME);
    const body = await h.call();
    expect(body.asLender).toEqual([]); // claimed side dropped
    expect(body.asBorrower.map((l) => l.loanId)).toEqual([1]); // other side stays
  });
});
