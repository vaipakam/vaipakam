/**
 * Migration 0082 (#2814): every stored extension-reserve row is filed under
 * its depositor.
 *
 * The Claims page finds a wallet's reserves by the activity rows filed under
 * it, and the actor rule for the three reserve events arrived after some rows
 * were stored. These cases pin what the backfill fills and what it must
 * leave alone: a row already filed, another event kind, and args that are not
 * the expected shape.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const THIS = '0082_extend_reserve_actor_backfill.sql';
const BEFORE = files.filter((f) => f < THIS).map(read);

const HOLDER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const OTHER = '0x1111111111111111111111111111111111111111';

type Db = ReturnType<typeof createSqliteD1>['db'];

function insert(db: Db, logIndex: number, kind: string, argsJson: string, actor: string | null = null) {
  db.prepare(
    `INSERT INTO activity_events
       (chain_id, block_number, log_index, tx_hash, kind, loan_id, offer_id, actor, args_json, block_at)
     VALUES (84532, 100, ?, '0xtx', ?, 7, NULL, ?, ?, 1)`,
  ).run(logIndex, kind, actor, argsJson);
}

function actors(db: Db): Array<{ log_index: number; actor: string | null }> {
  return db
    .prepare('SELECT log_index, actor FROM activity_events ORDER BY log_index')
    .all() as Array<{ log_index: number; actor: string | null }>;
}

describe('migration 0082 — extension-reserve actor backfill (#2814)', () => {
  it('files each reserve row under its lower-cased holder and leaves everything else', () => {
    const { db } = createSqliteD1(BEFORE);
    const args = JSON.stringify({ loanId: '7', holder: HOLDER, asset: OTHER, amount: '5' });
    insert(db, 0, 'ExtendReserveFunded', args);
    insert(db, 1, 'ExtendReserveWithdrawn', args);
    insert(db, 2, 'ExtendChargeDrawn', args);
    insert(db, 3, 'ExtendReserveFunded', args, OTHER); // already filed
    insert(db, 4, 'LoanRepaid', args); // another kind
    insert(db, 5, 'ExtendReserveFunded', JSON.stringify({ holder: 7 })); // not a string
    insert(db, 6, 'ExtendReserveFunded', JSON.stringify({ holder: 'not-an-address' }));
    insert(db, 7, 'ExtendReserveFunded', 'not-json');
    db.exec(read(THIS));
    const h = HOLDER.toLowerCase();
    expect(actors(db)).toEqual([
      { log_index: 0, actor: h },
      { log_index: 1, actor: h },
      { log_index: 2, actor: h },
      { log_index: 3, actor: OTHER },
      { log_index: 4, actor: null },
      { log_index: 5, actor: null },
      { log_index: 6, actor: null },
      { log_index: 7, actor: null },
    ]);
  });

  it('runs twice without change', () => {
    const { db } = createSqliteD1(BEFORE);
    insert(db, 0, 'ExtendReserveFunded', JSON.stringify({ holder: HOLDER }));
    db.exec(read(THIS));
    db.exec(read(THIS));
    expect(actors(db)).toEqual([{ log_index: 0, actor: HOLDER.toLowerCase() }]);
  });
});
