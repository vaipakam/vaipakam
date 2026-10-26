/**
 * A legal hold outlasts the retention prune (#2758), against real SQLite
 * running the shared migrations that create the two tables, so the
 * DELETE's hold condition is checked as SQLite evaluates it.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { pruneOldDiagErrors } from '../src/diagRecord';

const MIGRATIONS = ['0003_diag_errors.sql', '0013_diag_erasure.sql'].map((f) =>
  readFileSync(new URL(`../../indexer/migrations/${f}`, import.meta.url), 'utf8'),
);

function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  const d1 = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async run() {
          db.prepare(sql).run(...(args as never[]));
          return { success: true };
        },
      };
      return stmt;
    },
  };
  const columns = (db.prepare('PRAGMA table_info(diag_errors)').all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>).filter((c) => c.notnull && c.dflt_value === null);
  const record = (id: string, walletHash: string | null, recordedAt: number) => {
    // Fill every NOT NULL column the schema demands with a placeholder,
    // so the test does not restate the capture's whole row shape.
    const row: Record<string, unknown> = Object.fromEntries(columns.map((c) => [c.name, 'x']));
    row.id = id;
    row.recorded_at = recordedAt;
    row.wallet_hash = walletHash;
    const names = Object.keys(row);
    db.prepare(
      `INSERT INTO diag_errors (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    ).run(...(Object.values(row) as never[]));
  };
  const hold = (walletHash: string) =>
    db
      .prepare(
        `INSERT INTO diag_legal_holds (wallet_hash, hold_reason, created_at, updated_at)
         VALUES (?, 'court order', 0, 0)`,
      )
      .run(walletHash);
  const ids = () =>
    (db.prepare('SELECT id FROM diag_errors ORDER BY id').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  return { env: { DB: d1, DIAG_RETENTION_DAYS: '90' } as unknown as Env, record, hold, ids };
}

const NOW = 1_800_000_000;
const OLD = NOW - 91 * 86400;
const RECENT = NOW - 10 * 86400;

describe('pruneOldDiagErrors and legal holds (#2758)', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps an old record under legal hold and prunes the rest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
    const t = sqliteD1();
    t.record('held-old', 'hash-held', OLD);
    t.record('free-old', 'hash-free', OLD);
    t.record('nowallet-old', null, OLD);
    t.record('free-recent', 'hash-free', RECENT);
    t.hold('hash-held');

    await pruneOldDiagErrors(t.env);

    expect(t.ids()).toEqual(['free-recent', 'held-old']);
  });
});
