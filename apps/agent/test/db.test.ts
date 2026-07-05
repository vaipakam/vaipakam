import { describe, it, expect } from 'vitest';
import { OptOutStorageUnavailableError, upsertThresholds } from '../src/db';

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
      throw new Error(
        'D1_ERROR: no such column: notify_maturity_approaching',
      );
    }
    this.db.executed.push({ sql: this.sql, args: this.args });
  }
}

class FakeD1 {
  migrated = true;
  failWith: string | null = null;
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
