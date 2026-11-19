/**
 * #3021 — GET /positions/:tokenId: the position-token ledger (0115) and the
 * route the NFT verifier reads for a retired token's history. Runs against
 * the real migrated schema, so the triggers are the ones a deploy applies.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handlePositionHistory, parseTokenId } from '../src/positionHistoryRoute';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;

function harness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const offer = (offerId: number, tokenId: string, offerType: 0 | 1, status = 'active') =>
    h.db
      .prepare(
        `INSERT INTO offers (chain_id, offer_id, status, creator, creator_current_owner, offer_type,
           asset_type, collateral_asset_type, lending_asset, collateral_asset, amount,
           interest_rate_bps, collateral_amount, duration_days, position_token_id,
           first_seen_block, first_seen_at, updated_at)
         VALUES (?, ?, ?, '0xc0', '0xc0', ?, 0, 0, '0xa1', '0xb1', '1000', 500, '150', 30, ?, 1, 1, 1)`,
      )
      .run(CHAIN, offerId, status, offerType, tokenId);
  const loan = (
    loanId: number,
    offerId: number,
    lenderToken: string,
    borrowerToken: string,
    opts: { status?: string; backed?: boolean; terminalAt?: number | null } = {},
  ) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at,
           init_principal, init_principal_unbacked, init_rate_bps,
           init_duration_days, init_terms_unbacked, terminal_at)
         VALUES (?, ?, ?, ?, '0xl', '0xb', '900', '200', 0, 0, '0xa1', '0xb1',
           45, '0', '0', ?, ?, '0xl', '0xb', 650, 100, 10, 100, 100,
           '1000', ?, 500, 30, ?, ?)`,
      )
      .run(
        CHAIN,
        loanId,
        offerId,
        opts.status ?? 'active',
        lenderToken,
        borrowerToken,
        opts.backed === false ? 1 : 0,
        opts.backed === false ? 1 : 0,
        opts.terminalAt ?? null,
      );
  const retire = (tokenId: string, block: number) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind,
           actor, args_json, block_at)
         VALUES (?, ?, 0, ?, 'PositionRetired', NULL, ?, ?)`,
      )
      .run(CHAIN, block, `0x${block.toString(16).padStart(64, '0')}`, JSON.stringify({ tokenId }), block * 12);
  const get = async (tokenId: string) => {
    const res = await handlePositionHistory(
      new Request(`https://x/positions/${tokenId}?chainId=${CHAIN}`),
      env,
      tokenId,
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { h, offer, loan, retire, get };
}

describe('parseTokenId', () => {
  it('takes a decimal uint256 and nothing else', () => {
    expect(parseTokenId('0')).toBe('0');
    expect(parseTokenId('42')).toBe('42');
    expect(parseTokenId('042')).toBeNull();
    expect(parseTokenId('-1')).toBeNull();
    expect(parseTokenId('0x2a')).toBeNull();
    expect(parseTokenId((1n << 256n).toString())).toBeNull();
    expect(parseTokenId(((1n << 256n) - 1n).toString())).toBe(((1n << 256n) - 1n).toString());
  });
});

describe('GET /positions/:tokenId (#3021)', () => {
  it('answers no record for a token the index never saw', async () => {
    const { get } = harness();
    const { status, body } = await get('7');
    expect(status).toBe(200);
    expect(body).toEqual({ chainId: CHAIN, tokenId: '7', record: null, retirement: null, reason: null });
  });

  it('refuses a malformed token id', async () => {
    const { get } = harness();
    expect((await get('01')).status).toBe(400);
  });

  it("serves a cancelled offer's token as the offer, with its retirement", async () => {
    const t = harness();
    t.offer(3, '11', 0, 'cancelled');
    t.retire('11', 50);
    const { body } = await t.get('11');
    expect(body.record).toMatchObject({
      kind: 'offer',
      offerId: 3,
      side: 'lender',
      status: 'cancelled',
      amount: '1000',
      amountMax: null,
      interestRateBps: 500,
      interestRateBpsMax: null,
      durationDays: 30,
    });
    expect(body.retirement).toMatchObject({ blockNumber: 50, at: 600 });
    expect(body.reason).toBe('offer-cancelled');
  });

  it("lets the loan win over the offer once the offer's token becomes the loan's", async () => {
    const t = harness();
    t.offer(4, '20', 1, 'accepted');
    t.loan(9, 4, '21', '20', { status: 'repaid', terminalAt: 777 });
    t.retire('20', 60);
    const { body } = await t.get('20');
    expect(body.record).toMatchObject({
      kind: 'loan',
      loanId: 9,
      fromOfferId: 4,
      side: 'borrower',
      status: 'repaid',
      isCurrentToken: true,
      agreed: { principal: '1000', interestRateBps: 500, durationDays: 30 },
      lastCollateralAmount: '200',
      closedAt: 777,
    });
    expect(body.reason).toBe('loan-closed');
    // The acceptor's token was minted for the loan, with no offer behind it.
    expect((await t.get('21')).body.record).toMatchObject({ kind: 'loan', side: 'lender', fromOfferId: null });
  });

  it('withholds agreed terms the ledger does not back, never the live ones in their place', async () => {
    const t = harness();
    t.loan(10, 1, '30', '31', { backed: false });
    const { body } = await t.get('30');
    expect(body.record.agreed).toEqual({ principal: null, interestRateBps: null, durationDays: null });
    expect(body.record.closedAt).toBeNull();
    expect(body.retirement).toBeNull();
    expect(body.reason).toBeNull();
  });

  it('keeps a sold position token on its loan after the side moves to a new token', async () => {
    const t = harness();
    t.loan(11, 1, '40', '41');
    // A sale retires the lender token and repoints the row (LoanSold).
    t.h.db
      .prepare(`UPDATE loans SET lender_token_id = '42' WHERE chain_id = ? AND loan_id = 11`)
      .run(CHAIN);
    t.retire('40', 70);
    const old = await t.get('40');
    expect(old.body.record).toMatchObject({ kind: 'loan', loanId: 11, side: 'lender', isCurrentToken: false });
    expect(old.body.reason).toBe('position-moved');
    expect((await t.get('42')).body.record).toMatchObject({ loanId: 11, side: 'lender', isCurrentToken: true });
  });

  it('records a token an offer heal fills in after the stub was inserted', async () => {
    const t = harness();
    t.offer(5, '0', 0);
    expect((await t.get('0')).body.record).toBeNull();
    t.h.db
      .prepare(`UPDATE offers SET position_token_id = '55' WHERE chain_id = ? AND offer_id = 5`)
      .run(CHAIN);
    expect((await t.get('55')).body.record).toMatchObject({ kind: 'offer', offerId: 5 });
  });

  it('names no reason for a retirement the record does not explain', async () => {
    const t = harness();
    t.loan(12, 1, '60', '61');
    t.retire('60', 80);
    const { body } = await t.get('60');
    expect(body.retirement).not.toBeNull();
    expect(body.reason).toBeNull();
  });
});
