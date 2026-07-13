import { describe, it, expect } from 'vitest';
import {
  getTelegramChatId,
  OptOutStorageUnavailableError,
  recordTestAlertSent,
  upsertThresholds,
} from '../src/db';

// ─── Minimal D1 fake for the thresholds upsert ─────────────────────
//
// Simulates the one schema condition under test: pre-migration-0027
// the `notify_maturity_approaching` column does not exist, so any
// statement referencing it throws D1's missing-column error.

class FakeStmt {
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  private args: unknown[] = [];
  bind(...a: unknown[]): this {
    this.args = a;
    return this;
  }
  async run(): Promise<void> {
    if (this.db.failWith) throw new Error(this.db.failWith);
    if (!this.db.migrated && this.sql.includes('notify_maturity_approaching')) {
      // The exact phrasing the real INSERT path produces (verified
      // live on the staging D1) — SQLite's INSERT-column-list error,
      // NOT the "no such column:" expression form.
      throw new Error(
        'D1_ERROR: table user_thresholds has no column named notify_maturity_approaching: SQLITE_ERROR',
      );
    }
    if (this.db.testAlertColumnMissing && this.sql.includes('last_test_alert_at')) {
      throw new Error('D1_ERROR: no such column: last_test_alert_at: SQLITE_ERROR');
    }
    this.db.executed.push({ sql: this.sql, args: this.args });
  }
  // For SELECTs (getTelegramChatId) — returns whatever the fake was
  // seeded with, recording the bound args so a test can assert the
  // wallet was lower-cased. When `testAlertColumnMissing` is set, a
  // SELECT/UPDATE referencing `last_test_alert_at` throws SQLite's
  // missing-column error, so the pre-0034 rollout fallback can be
  // exercised.
  async first<T>(): Promise<T | null> {
    if (this.db.testAlertColumnMissing && this.sql.includes('last_test_alert_at')) {
      throw new Error('D1_ERROR: no such column: last_test_alert_at: SQLITE_ERROR');
    }
    this.db.executed.push({ sql: this.sql, args: this.args });
    return (this.db.firstResult as T) ?? null;
  }
}

class FakeD1 {
  migrated = true;
  failWith: string | null = null;
  firstResult: unknown = null;
  testAlertColumnMissing = false;
  executed: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string) {
    return new FakeStmt(this, sql);
  }
}

const BASE = {
  wallet: '0x1DAefA360ED370285f003Fa2d92DB75628088282',
  chain_id: 84532,
  warn_hf: 1.5,
  alert_hf: 1.2,
  critical_hf: 1.05,
};

describe('upsertThresholds rollout-window fallback (#1056 round 8)', () => {
  it('writes the column-bearing statement once migrated', async () => {
    const db = new FakeD1();
    await upsertThresholds(db as unknown as D1Database, {
      ...BASE,
      notify_maturity_approaching: false,
    });
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]!.sql).toContain('notify_maturity_approaching');
  });

  it('falls back to the legacy write for an opted-IN save pre-migration', async () => {
    // true equals the column default, so the legacy write loses
    // nothing and the visible save succeeds.
    const db = new FakeD1();
    db.migrated = false;
    await upsertThresholds(db as unknown as D1Database, {
      ...BASE,
      notify_maturity_approaching: true,
    });
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]!.sql).not.toContain('notify_maturity_approaching');
  });

  it('surfaces an OPT-OUT save pre-migration instead of dropping it', async () => {
    // Silently writing the legacy column set would make the toggle
    // theater — the caller must see a distinct error.
    const db = new FakeD1();
    db.migrated = false;
    await expect(
      upsertThresholds(db as unknown as D1Database, {
        ...BASE,
        notify_maturity_approaching: false,
      }),
    ).rejects.toBeInstanceOf(OptOutStorageUnavailableError);
    expect(db.executed).toHaveLength(0);
  });

  it('propagates unrelated D1 errors untouched', async () => {
    const db = new FakeD1();
    db.failWith = 'D1_ERROR: database is locked';
    await expect(
      upsertThresholds(db as unknown as D1Database, {
        ...BASE,
        notify_maturity_approaching: true,
      }),
    ).rejects.toThrow('database is locked');
  });

  it('uses the column-omitting statement when the flag is absent', async () => {
    const db = new FakeD1();
    await upsertThresholds(db as unknown as D1Database, { ...BASE });
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]!.sql).not.toContain('notify_maturity_approaching');
  });
});

describe('getTelegramChatId (UX-012 test-alert lookup)', () => {
  it('returns the chat id + locale + last test timestamp when a link exists (wallet lower-cased)', async () => {
    const db = new FakeD1();
    db.firstResult = { tg_chat_id: '9876', locale: 'ta', last_test_alert_at: 1700 };
    const res = await getTelegramChatId(
      db as unknown as D1Database,
      BASE.wallet,
      BASE.chain_id,
    );
    expect(res).toEqual({ chatId: '9876', locale: 'ta', lastTestAt: 1700 });
    // The wallet is bound lower-cased so a checksummed spelling still
    // matches the stored row.
    expect(db.executed[0]!.args[0]).toBe(BASE.wallet.toLowerCase());
  });

  it('returns null when the row exists but has no chat id (handshake unfinished)', async () => {
    const db = new FakeD1();
    db.firstResult = { tg_chat_id: null, locale: 'en', last_test_alert_at: 0 };
    const res = await getTelegramChatId(
      db as unknown as D1Database,
      BASE.wallet,
      BASE.chain_id,
    );
    expect(res).toBeNull();
  });

  it('returns null when no row exists at all', async () => {
    const db = new FakeD1();
    db.firstResult = null;
    const res = await getTelegramChatId(
      db as unknown as D1Database,
      BASE.wallet,
      BASE.chain_id,
    );
    expect(res).toBeNull();
  });

  it('defaults locale to en and lastTestAt to 0 when those are null/absent', async () => {
    const db = new FakeD1();
    db.firstResult = { tg_chat_id: '42', locale: null };
    const res = await getTelegramChatId(
      db as unknown as D1Database,
      BASE.wallet,
      BASE.chain_id,
    );
    expect(res).toEqual({ chatId: '42', locale: 'en', lastTestAt: 0 });
  });

  it('falls back to the pre-0034 column set (lastTestAt 0) when last_test_alert_at is missing', async () => {
    const db = new FakeD1();
    db.testAlertColumnMissing = true;
    db.firstResult = { tg_chat_id: '55', locale: 'en' };
    const res = await getTelegramChatId(
      db as unknown as D1Database,
      BASE.wallet,
      BASE.chain_id,
    );
    // The first SELECT (with the column) threw; the fallback SELECT
    // (without it) succeeded — so the feature still works pre-migration
    // with no cooldown enforced.
    expect(res).toEqual({ chatId: '55', locale: 'en', lastTestAt: 0 });
    expect(db.executed[db.executed.length - 1]!.sql).not.toContain(
      'last_test_alert_at',
    );
  });
});

describe('recordTestAlertSent (UX-012 cooldown stamp)', () => {
  it('stamps last_test_alert_at with the timestamp + lower-cased wallet', async () => {
    const db = new FakeD1();
    await recordTestAlertSent(db as unknown as D1Database, BASE.wallet, BASE.chain_id, 1800);
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]!.sql).toContain('last_test_alert_at');
    expect(db.executed[0]!.args).toEqual([1800, BASE.wallet.toLowerCase(), BASE.chain_id]);
  });

  it('no-ops (does not throw) when the column is missing pre-0034', async () => {
    const db = new FakeD1();
    db.testAlertColumnMissing = true;
    await expect(
      recordTestAlertSent(db as unknown as D1Database, BASE.wallet, BASE.chain_id, 1800),
    ).resolves.toBeUndefined();
    // The UPDATE threw missing-column and was swallowed — nothing recorded.
    expect(db.executed).toHaveLength(0);
  });
});
