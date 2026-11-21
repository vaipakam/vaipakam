/**
 * #3836 — newest-first order for signed settings saves, against real SQLite
 * running the shared migrations that shape `user_thresholds`, so the upsert's
 * conditional conflict arm behaves as D1's SQLite does rather than as a fake
 * says it would.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SettingsOrderUnavailableError, upsertThresholds } from '../src/db';

const MIGRATIONS = [
  '0001_init.sql',
  '0002_user_locale.sql',
  '0027_notify_maturity_opt_in.sql',
  '0034_test_alert_cooldown.sql',
  '0116_settings_issued_at.sql',
];

function migration(name: string): string {
  return readFileSync(new URL(`../../indexer/migrations/${name}`, import.meta.url), 'utf8');
}

/** The slice of D1 the upsert uses — prepare / bind / run — over an
 *  in-memory SQLite database. */
function sqliteD1(withOrderColumn = true) {
  const db = new DatabaseSync(':memory:');
  for (const name of MIGRATIONS) {
    if (!withOrderColumn && name.startsWith('0116')) continue;
    db.exec(migration(name));
  }
  const d1 = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async run() {
          const r = db.prepare(sql).run(...(args as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  };
  const row = () =>
    db
      .prepare(
        'SELECT warn_hf, notify_maturity_approaching AS due, settings_issued_at AS at FROM user_thresholds',
      )
      .all() as Array<{ warn_hf: number; due: number; at: number | null }>;
  return { d1: d1 as unknown as D1Database, row, db };
}

const BASE = { wallet: '0x1DAefA360ED370285f003Fa2d92DB75628088282', chain_id: 84532 };
const BANDS = (warn: number) => ({ warn_hf: warn, alert_hf: 1.2, critical_hf: 1.05 });

describe('upsertThresholds order (#3836)', () => {
  it('applies a save signed later and refuses one signed earlier, writing nothing', async () => {
    const { d1, row } = sqliteD1();
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(1.5), issued_at: 200 })).toBe('applied');
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(1.9), issued_at: 300 })).toBe('applied');
    // A slow approval signed between the two lands last: refused.
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(1.7), issued_at: 250 })).toBe('superseded');
    expect(row()).toEqual([{ warn_hf: 1.9, due: 1, at: 300 }]);
  });

  it('holds for every statement shape, the due-date flag included', async () => {
    const { d1, row } = sqliteD1();
    await upsertThresholds(d1, { ...BASE, notify_maturity_approaching: false, issued_at: 300 });
    expect(await upsertThresholds(d1, { ...BASE, notify_maturity_approaching: true, issued_at: 299 })).toBe(
      'superseded',
    );
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(2), issued_at: 299 })).toBe('superseded');
    expect(row()).toEqual([{ warn_hf: 1.5, due: 0, at: 300 }]);
  });

  it('takes a save signed in the same second, and any save on a row no save wrote', async () => {
    const { d1, row, db } = sqliteD1();
    // The link handshake makes rows without a signed time.
    db.prepare(
      `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, created_at, updated_at)
       VALUES (?, ?, 1.5, 1.2, 1.05, 0, 0)`,
    ).run(BASE.wallet.toLowerCase(), BASE.chain_id);
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(1.6), issued_at: 1 })).toBe('applied');
    expect(await upsertThresholds(d1, { ...BASE, ...BANDS(1.8), issued_at: 1 })).toBe('applied');
    expect(row()).toEqual([{ warn_hf: 1.8, due: 1, at: 1 }]);
  });

  it('refuses rather than applying unordered while the column is missing', async () => {
    const { d1 } = sqliteD1(false);
    await expect(upsertThresholds(d1, { ...BASE, ...BANDS(1.6), issued_at: 1 })).rejects.toBeInstanceOf(
      SettingsOrderUnavailableError,
    );
    await expect(
      upsertThresholds(d1, { ...BASE, notify_maturity_approaching: false, issued_at: 1 }),
    ).rejects.toBeInstanceOf(SettingsOrderUnavailableError);
  });
});
