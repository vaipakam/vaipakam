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
  const seed = (
    loanId: number,
    status: string,
    lenderOwner: string,
    borrowerOwner: string,
    updatedAt = 0,
    terminalAt: number | null = null,
  ) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at, terminal_at)
         VALUES (84532, ?, 1, ?, ?, ?, '100', '200', 0, 0, '0xlend', '0xcoll',
           30, '0', '0', '1', '2', ?, ?, 500, 0, 0, 0, ?, ?)`,
      )
      .run(
        loanId,
        status,
        lenderOwner,
        borrowerOwner,
        lenderOwner,
        borrowerOwner,
        updatedAt,
        terminalAt,
      );
  const call = async () => {
    const res = await handleClaimables(
      new Request(`https://idx/claimables/${ME}?chainId=84532`),
      env,
      ME,
    );
    return (await res.json()) as {
      asLender: Array<{ loanId: number; status: string }>;
      asBorrower: Array<{ loanId: number; status: string }>;
      truncated: boolean;
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

  // #1247 PAG-007 — the candidate scan is capped at the 200
  // most-recently-terminal loans (updated_at DESC, loan_id tiebreak),
  // with `truncated` saying depth was dropped. A wallet with more
  // terminal history than the cap must see its newest candidates,
  // never a silent full-table scan.
  it('caps candidates at the 200 newest terminal loans and flags truncation', async () => {
    const h = makeHarness();
    h.db.exec('BEGIN');
    for (let i = 1; i <= 201; i++) h.seed(i, 'repaid', ME, OTHER);
    h.db.exec('COMMIT');
    const body = await h.call();
    expect(body.truncated).toBe(true);
    expect(body.asLender).toHaveLength(200);
    // All updated_at tie at 0 → loan_id DESC decides: newest ids kept
    // (201 down to 2), the single oldest falls off.
    expect(body.asLender[0].loanId).toBe(201);
    expect(body.asLender[199].loanId).toBe(2);
    expect(body.asLender.map((l) => l.loanId)).not.toContain(1);
  });

  it('an OLD loan that just went terminal survives the cut (recency = terminal time, not loan_id)', async () => {
    // Codex #1269 r2 — ids are assigned at initiation; loan 1 repaid
    // TODAY is the newest terminal event even though its id is lowest.
    // (terminal_at NULL here → the COALESCE falls back to updated_at.)
    const h = makeHarness();
    h.db.exec('BEGIN');
    h.seed(1, 'repaid', ME, OTHER, 9_999); // freshly terminal
    for (let i = 2; i <= 202; i++) h.seed(i, 'repaid', ME, OTHER);
    h.db.exec('COMMIT');
    const body = await h.call();
    expect(body.truncated).toBe(true);
    expect(body.asLender).toHaveLength(200);
    expect(body.asLender[0].loanId).toBe(1); // most recent terminal first
    // The tie-broken tail drops the two lowest ids among updated_at=0.
    expect(body.asLender.map((l) => l.loanId)).not.toContain(2);
    expect(body.asLender.map((l) => l.loanId)).not.toContain(3);
  });

  it('a later updated_at bump (transfer / counterparty claim) cannot jump the recency window', async () => {
    // Codex #1269 r3 — recency is terminal_at when stamped: loan 1
    // went terminal FIRST (terminal_at 100) and only its updated_at
    // moved later (ownership churn at 9_999); loan 2 went terminal
    // at 200 and must still rank ahead of loan 1.
    const h = makeHarness();
    h.seed(1, 'repaid', ME, OTHER, 9_999, 100);
    h.seed(2, 'repaid', ME, OTHER, 200, 200);
    const body = await h.call();
    expect(body.asLender.map((l) => l.loanId)).toEqual([2, 1]);
  });

  it('a stale-projection CLAIMED row cannot consume a window slot (Codex r4)', async () => {
    // 201 lender-side terminal loans; the NEWEST one's claim already
    // fired but the owner projection is stale (owner still ME). The
    // SQL-side exclusion must evict it BEFORE the cap so the OLDEST
    // unclaimed loan stays reachable — the r3 shape clipped first and
    // filtered after, silently dropping loan 1.
    const h = makeHarness();
    h.db.exec('BEGIN');
    for (let i = 1; i <= 201; i++) h.seed(i, 'repaid', ME, OTHER);
    h.db.exec('COMMIT');
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index,
           tx_hash, kind, loan_id, actor, args_json, block_at)
         VALUES (84532, 1, 0, '0xabc', 'LenderFundsClaimed', 201, ?, '{}', 0)`,
      )
      .run(ME);
    const body = await h.call();
    expect(body.truncated).toBe(false); // 200 unclaimed exactly fill the window
    expect(body.asLender).toHaveLength(200);
    expect(body.asLender.map((l) => l.loanId)).toContain(1);
    expect(body.asLender.map((l) => l.loanId)).not.toContain(201);
  });

  it('a wallet holding BOTH sides of one loan is deduped across the per-side scans', async () => {
    // The r3 per-side query split must not double-count a both-sides
    // loan in the merged window (or its truncation math).
    const h = makeHarness();
    h.seed(1, 'repaid', ME, ME);
    const body = await h.call();
    expect(body.truncated).toBe(false);
    expect(body.asLender.map((l) => l.loanId)).toEqual([1]);
    expect(body.asBorrower.map((l) => l.loanId)).toEqual([1]);
  });

  it('reports truncated: false when the candidate set fits the cap', async () => {
    const h = makeHarness();
    h.seed(1, 'repaid', ME, OTHER);
    const body = await h.call();
    expect(body.truncated).toBe(false);
    expect(body.asLender.map((l) => l.loanId)).toEqual([1]);
  });

  it('reports truncated: false on the empty-result short-circuit too', async () => {
    const h = makeHarness();
    const body = await h.call();
    expect(body).toMatchObject({ asLender: [], asBorrower: [], truncated: false });
  });
});
