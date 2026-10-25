/**
 * #2230 — the statement that marks a batch's examined loans, run against
 * SQLite itself over the shared database's real migrations.
 *
 * The lane's main suite drives a fake database that recognises this statement
 * by its text and keeps the marks in a map, which is enough to test the lane's
 * decisions and says nothing about whether D1 would apply the statement as
 * intended. D1 executes SQLite, so this runs the exported statement on an
 * in-memory SQLite built from `apps/indexer/migrations`, the single owner of
 * that schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MARK_EXAMINED_SQL } from '../src/periodicPreNotify';

const MIGRATIONS = new URL('../../indexer/migrations/', import.meta.url);

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  return db;
}

function loan(db: DatabaseSync, chainId: number, loanId: number, updatedAt = 111) {
  db.prepare(
    `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
       principal, collateral_amount, asset_type, collateral_asset_type,
       lending_asset, collateral_asset, duration_days, token_id,
       collateral_token_id, lender_token_id, borrower_token_id,
       lender_current_owner, borrower_current_owner, interest_rate_bps,
       start_time, start_block, start_at, updated_at)
     VALUES (?, ?, 1, 'active', '0x1', '0x2', '100', '200', 0, 0, '0xa', '0xc',
       30, '0', '0', '1', '2', '0x1', '0x2', 500, 0, 0, 0, ?)`,
  ).run(chainId, loanId, updatedAt);
}

type Marks = {
  prenotify_examined_lap: number;
  prenotify_examined_checkpoint: number;
  prenotify_examined_at: number;
  updated_at: number;
};

function marksOf(db: DatabaseSync, chainId: number, loanId: number): Marks {
  return db
    .prepare(
      `SELECT prenotify_examined_lap, prenotify_examined_checkpoint,
              prenotify_examined_at, updated_at
         FROM loans WHERE chain_id = ? AND loan_id = ?`,
    )
    .get(chainId, loanId) as Marks;
}

describe('the examination-mark statement (#2230)', () => {
  it('starts every loan unmarked', () => {
    const db = database();
    loan(db, 84532, 1);
    expect(marksOf(db, 84532, 1)).toMatchObject({
      prenotify_examined_lap: 0,
      prenotify_examined_checkpoint: 0,
      prenotify_examined_at: 0,
    });
  });

  it('marks each loan in the batch with this pass, this time and its own period', () => {
    const db = database();
    for (const id of [1, 2, 3]) loan(db, 84532, id);
    const batch = JSON.stringify([
      [1, 1_800_000_001],
      [3, 1_800_000_003],
    ]);
    db.prepare(MARK_EXAMINED_SQL).run(7, 1_790_000_000, 84532, batch);
    expect(marksOf(db, 84532, 1)).toMatchObject({
      prenotify_examined_lap: 7,
      prenotify_examined_checkpoint: 1_800_000_001,
      prenotify_examined_at: 1_790_000_000,
    });
    expect(marksOf(db, 84532, 3)).toMatchObject({
      prenotify_examined_lap: 7,
      prenotify_examined_checkpoint: 1_800_000_003,
    });
    // A loan the batch did not examine keeps no mark.
    expect(marksOf(db, 84532, 2).prenotify_examined_lap).toBe(0);
  });

  it('touches no other chain, and leaves the record-changed time alone', () => {
    const db = database();
    loan(db, 84532, 1, 111);
    loan(db, 421614, 1, 222);
    db.prepare(MARK_EXAMINED_SQL).run(2, 1_790_000_000, 84532, JSON.stringify([[1, 5]]));
    expect(marksOf(db, 421614, 1).prenotify_examined_lap).toBe(0);
    // An examination changes nothing about the loan.
    expect(marksOf(db, 84532, 1).updated_at).toBe(111);
    expect(marksOf(db, 421614, 1).updated_at).toBe(222);
  });

  it('covers a whole batch of a hundred loans in one statement', () => {
    // A hundred loans as separate bound parameters would pass D1's per-query
    // parameter limit; the JSON array keeps the statement at four.
    const db = database();
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    for (const id of ids) loan(db, 84532, id);
    const info = db
      .prepare(MARK_EXAMINED_SQL)
      .run(1, 1_790_000_000, 84532, JSON.stringify(ids.map((id) => [id, 1_800_000_000 + id])));
    expect(Number(info.changes)).toBe(100);
    expect(marksOf(db, 84532, 100).prenotify_examined_checkpoint).toBe(1_800_000_100);
    expect((MARK_EXAMINED_SQL.match(/\?\d/g) ?? []).length).toBeLessThanOrEqual(6);
  });
});
