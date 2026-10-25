/**
 * #2230 — the statements that mark a batch's examined loans, record the
 * chain's pass and read both back, run against SQLite itself over the shared
 * database's real migrations.
 *
 * The lane's main suite drives a fake database that recognises this statement
 * by its text and keeps the marks in a map, which is enough to test the lane's
 * decisions and says nothing about whether D1 would apply the statements as
 * intended. D1 executes SQLite, so this runs the exported statement on an
 * in-memory SQLite built from `apps/indexer/migrations`, the single owner of
 * that schema. The exported statements are the ones the lane runs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  BEGIN_PASS_SQL,
  COMPLETE_PASS_SQL,
  DROP_PASS_SQL,
  MARK_EXAMINED_SQL,
  PRENOTIFY_CANDIDATES_SQL,
  PRENOTIFY_PASS_SQL,
  readPassRecord,
} from '../src/periodicPreNotify';

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
       start_time, start_block, start_at, updated_at,
       periodic_interest_cadence, last_period_settled_at)
     VALUES (?, ?, 1, 'active', '0x1', '0x2', '100', '200', 0, 0, '0xa', '0xc',
       30, '0', '0', '1', '2', '0x1', '0x2', 500, 0, 0, 0, ?, 1, 1_700_000_000)`,
  ).run(chainId, loanId, updatedAt);
}

type Marks = {
  prenotify_examined_lap: number;
  prenotify_examined_checkpoint: number;
  updated_at: number;
};

function marksOf(db: DatabaseSync, chainId: number, loanId: number): Marks {
  return db
    .prepare(
      `SELECT prenotify_examined_lap, prenotify_examined_checkpoint, updated_at
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
    });
  });

  it('marks each loan in the batch with this pass and its own period', () => {
    const db = database();
    for (const id of [1, 2, 3]) loan(db, 84532, id);
    const batch = JSON.stringify([
      [1, 1_800_000_001],
      [3, 1_800_000_003],
    ]);
    db.prepare(MARK_EXAMINED_SQL).run(7, 84532, batch);
    expect(marksOf(db, 84532, 1)).toMatchObject({
      prenotify_examined_lap: 7,
      prenotify_examined_checkpoint: 1_800_000_001,
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
    db.prepare(MARK_EXAMINED_SQL).run(2, 84532, JSON.stringify([[1, 5]]));
    expect(marksOf(db, 421614, 1).prenotify_examined_lap).toBe(0);
    // An examination changes nothing about the loan.
    expect(marksOf(db, 84532, 1).updated_at).toBe(111);
    expect(marksOf(db, 421614, 1).updated_at).toBe(222);
  });

  it('covers a whole batch of a hundred loans in one statement', () => {
    // A hundred loans as separate bound parameters would pass D1's per-query
    // parameter limit; the JSON array keeps the statement at three.
    const db = database();
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    for (const id of ids) loan(db, 84532, id);
    const info = db
      .prepare(MARK_EXAMINED_SQL)
      .run(1, 84532, JSON.stringify(ids.map((id) => [id, 1_800_000_000 + id])));
    expect(Number(info.changes)).toBe(100);
    expect(marksOf(db, 84532, 100).prenotify_examined_checkpoint).toBe(1_800_000_100);
    expect((MARK_EXAMINED_SQL.match(/\?\d/g) ?? []).length).toBeLessThanOrEqual(6);
  });
});

type PassRow = { lap: unknown; started_at: unknown; completed_at: unknown };

function passOf(db: DatabaseSync, chainId: number): PassRow | undefined {
  return db.prepare(PRENOTIFY_PASS_SQL).get(chainId) as PassRow | undefined;
}

describe('the candidate query (#2230)', () => {
  it('returns each active periodic loan with its examination mark', () => {
    const db = database();
    for (const id of [1, 2]) loan(db, 84532, id);
    db.prepare(MARK_EXAMINED_SQL).run(5, 84532, JSON.stringify([[1, 9]]));
    const rows = db.prepare(PRENOTIFY_CANDIDATES_SQL).all(84532) as {
      loan_id: number;
      prenotify_examined_lap: number;
    }[];
    expect(rows.map((r) => [Number(r.loan_id), Number(r.prenotify_examined_lap)])).toEqual([
      [1, 5],
      [2, 0],
    ]);
  });
});

describe('the pass record (#2230, Codex #2845 r1 and r2)', () => {
  it('is absent until a pass begins, which reads as no pass', () => {
    const db = database();
    expect(passOf(db, 84532)).toBeUndefined();
    expect(readPassRecord(passOf(db, 84532))).toEqual({ state: 'none' });
  });

  it('opens when a pass begins, for that chain only', () => {
    const db = database();
    db.prepare(BEGIN_PASS_SQL).run(84532, 3, 1_790_000_000);
    expect(readPassRecord(passOf(db, 84532))).toEqual({
      state: 'open',
      lap: 3,
      startedAt: 1_790_000_000,
    });
    expect(passOf(db, 421614)).toBeUndefined();
  });

  it('keeps its start while the pass marks loans, however many', () => {
    // THE DEFECT r1 FOUND: a pass dated from its marks moved forward as marked
    // loans left the window. Marks never touch the record.
    const db = database();
    for (const id of [1, 2]) loan(db, 84532, id);
    db.prepare(BEGIN_PASS_SQL).run(84532, 5, 1_790_000_000);
    db.prepare(MARK_EXAMINED_SQL).run(5, 84532, JSON.stringify([[1, 9], [2, 9]]));
    expect(readPassRecord(passOf(db, 84532))).toEqual({
      state: 'open',
      lap: 5,
      startedAt: 1_790_000_000,
    });
  });

  it('closes once, and only the pass it names', () => {
    // THE DEFECT r2 FOUND: a finished pass was never closed, so a loan
    // arriving days later joined it. Closing names the pass, so a late close
    // can never end the pass that began after it.
    const db = database();
    db.prepare(BEGIN_PASS_SQL).run(84532, 5, 1_790_000_000);
    db.prepare(COMPLETE_PASS_SQL).run(84532, 4, 1_790_000_500);
    expect(readPassRecord(passOf(db, 84532)).state).toBe('open');
    db.prepare(COMPLETE_PASS_SQL).run(84532, 5, 1_790_000_600);
    db.prepare(COMPLETE_PASS_SQL).run(84532, 5, 1_790_009_999);
    expect(passOf(db, 84532)?.completed_at).toBe(1_790_000_600);
    expect(readPassRecord(passOf(db, 84532))).toEqual({
      state: 'closed',
      lap: 5,
      startedAt: 1_790_000_000,
    });
  });

  it('is replaced, not added to, when the next pass begins, which reopens it', () => {
    const db = database();
    db.prepare(BEGIN_PASS_SQL).run(84532, 3, 1_790_000_000);
    db.prepare(COMPLETE_PASS_SQL).run(84532, 3, 1_790_000_100);
    db.prepare(BEGIN_PASS_SQL).run(84532, 4, 1_790_086_400);
    expect(readPassRecord(passOf(db, 84532))).toEqual({
      state: 'open',
      lap: 4,
      startedAt: 1_790_086_400,
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM prenotify_pass').get() as { n: number };
    expect(Number(count.n)).toBe(1);
  });

  it('cannot hold a figure that is not a whole number: the table is STRICT', () => {
    const db = database();
    expect(() =>
      db.prepare('INSERT INTO prenotify_pass (chain_id, lap, started_at) VALUES (?, ?, ?)').run(
        84532,
        'six',
        1,
      ),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
  });

  it('reads a stored figure it cannot use as unreadable, and is removed by the drop', () => {
    // STRICT keeps text out; a negative number or a pass of 0 still gets in
    // by hand, and is reported rather than mistaken for no pass.
    const db = database();
    db.prepare('INSERT INTO prenotify_pass (chain_id, lap, started_at) VALUES (?, ?, ?)').run(84532, 0, 1);
    expect(readPassRecord(passOf(db, 84532))).toEqual({ state: 'unreadable' });
    db.prepare(DROP_PASS_SQL).run(84532);
    expect(passOf(db, 84532)).toBeUndefined();
  });
});
