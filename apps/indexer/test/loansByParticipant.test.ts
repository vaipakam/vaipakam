/**
 * GET /loans/by-participant — the `scope` param (#1023).
 *
 * The default ('desk') view keeps the History tab's market-shape
 * scoping: ERC-20 both legs, non-sale-vehicle, healed row shape.
 * `scope=all` is the ALL-history consumer Activity's participation
 * filter uses — every persisted participation row, any asset shape,
 * sale vehicles and not-yet-healed stub rows included, since the
 * consumer only reads loan ids and a hidden id silently drops real
 * feed events. Runs against the real migrated schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleLoansByHistoricalParticipant } from '../src/loanRoutes';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const ME = '0x00000000000000000000000000000000000000aa';

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const seedLoan = (
    loanId: number,
    opts: { assetType?: number; saleVehicle?: number; lendingAsset?: string } = {},
  ) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at, is_sale_vehicle)
         VALUES (84532, ?, 1, 'repaid', ?, '0xb', '100', '200', ?, 0,
           ?, '0x00000000000000000000000000000000000000cc',
           30, '0', '0', '1', '2', '0x0', '0x0', 500, 0, 0, 0, 0, ?)`,
      )
      .run(
        loanId,
        ME,
        opts.assetType ?? 0,
        opts.lendingAsset ?? '0x00000000000000000000000000000000000000dd',
        opts.saleVehicle ?? 0,
      );
  const seedParticipation = (loanId: number, fromAt: number) =>
    h.db
      .prepare(
        `INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at)
         VALUES (84532, ?, ?, 'lender', ?)`,
      )
      .run(loanId, ME, fromAt);
  const call = async (scope?: string) => {
    const res = await handleLoansByHistoricalParticipant(
      new Request(
        `https://idx/loans/by-participant?chainId=84532&wallet=${ME}` +
          (scope !== undefined ? `&scope=${scope}` : ''),
      ),
      env,
    );
    return { status: res.status, body: (await res.json()) as { loans?: Array<{ loanId: number }>; error?: string } };
  };
  return { ...h, seedLoan, seedParticipation, call };
}

describe('GET /loans/by-participant — scope param (#1023)', () => {
  it('scope=all includes NFT-leg, sale-vehicle, and unhealed-stub-shape loans the desk view hides', async () => {
    const h = makeHarness();
    h.seedLoan(1); // desk-shaped
    h.seedLoan(2, { assetType: 1 }); // NFT lending leg
    h.seedLoan(3, { saleVehicle: 1 }); // internal sale vehicle
    h.seedLoan(4, { lendingAsset: '0x' }); // stub row awaiting heal
    for (let i = 1; i <= 4; i++) h.seedParticipation(i, 100 + i);

    const desk = await h.call(); // default scope
    expect(desk.status).toBe(200);
    expect(desk.body.loans!.map((l) => l.loanId)).toEqual([1]);

    const all = await h.call('all');
    expect(all.status).toBe(200);
    expect(all.body.loans!.map((l) => l.loanId)).toEqual([4, 3, 2, 1]); // newest participation first
  });

  it("scope=desk is accepted explicitly and equals the default", async () => {
    const h = makeHarness();
    h.seedLoan(1);
    h.seedParticipation(1, 100);
    const explicit = await h.call('desk');
    expect(explicit.status).toBe(200);
    expect(explicit.body.loans!.map((l) => l.loanId)).toEqual([1]);
  });

  it('rejects an unknown scope with 400 bad-scope', async () => {
    const h = makeHarness();
    const res = await h.call('everything');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad-scope' });
  });
});
