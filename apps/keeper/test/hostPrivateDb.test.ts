/**
 * The machine host's keeper-private database gate (host/privateDbGate.ts,
 * #2450): a machine tick runs only once `KEEPER_DB` records every keeper
 * migration AND the one-time cutover verdict — the deploy's own rule — passes.
 * Real SQL on in-memory SQLite, built from the real migrations.
 */
import { describe, expect, it } from 'vitest';
import { checkPrivateDb, createPrivateDbGate } from '../host/privateDbGate';
import { buildHostEnv, HOST_SETTINGS } from '../host/hostEnv';
import REQUIRED from '../src/requiredKeeperMigrations.json';
import { createSqliteD1 } from './helpers/sqliteD1';
import { KEEPER_MIGRATIONS, KEEPER_MIGRATIONS_DIR, SHARED_MIGRATIONS, migrationFiles } from './helpers/schemas';

const D1_MIGRATIONS = 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)';

function privateDb(applied: readonly string[] = REQUIRED) {
  const h = createSqliteD1([...KEEPER_MIGRATIONS, D1_MIGRATIONS]);
  for (const name of applied) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  return h;
}
const sharedDb = () => createSqliteD1(SHARED_MIGRATIONS);
const d1 = (h: { d1: unknown }) => h.d1 as D1Database;

describe('requiredKeeperMigrations.json', () => {
  it('lists exactly the files in apps/keeper/migrations', () => {
    expect([...REQUIRED]).toEqual(migrationFiles(KEEPER_MIGRATIONS_DIR));
  });
});

describe('checkPrivateDb', () => {
  it('passes on a fresh environment: every migration applied, the shared copies empty', async () => {
    expect(await checkPrivateDb(d1(sharedDb()), d1(privateDb()))).toEqual({ ok: true });
  });

  it('declines, naming them, while a keeper-private migration is missing — and never applies it', async () => {
    const priv = privateDb([REQUIRED[0]]);
    const r = await checkPrivateDb(d1(sharedDb()), d1(priv));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.line).toContain(REQUIRED[1]);
    expect(!r.ok && r.line).toContain('pnpm --filter @vaipakam/keeper run migrate');
    const n = priv.db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('declines while the shared copies hold rows and no cutover is recorded', async () => {
    const shared = sharedDb();
    shared.db.prepare('INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (1, 1, ?, 1000, ?, 100)').run('warn', '0xabc');
    const r = await checkPrivateDb(d1(shared), d1(privateDb()));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.line).toMatch(/hf_band_state/);
    expect(!r.ok && r.line).toMatch(/cutover/);
  });

  it('passes once the recorded cutover matches every shared table, and declines again if the old copy moved', async () => {
    const shared = sharedDb();
    shared.db.prepare('INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (1, 1, ?, 1000, ?, 100)').run('warn', '0xabc');
    const zero = { n: 0, at: 0 };
    const fingerprint = {
      keeper_remit_ack: zero,
      keeper_remit_ack_frontier: zero,
      keeper_commitment_scan: zero,
      keeper_commitment_day: zero,
      hf_band_state: { n: 1, at: 100 },
    };
    const priv = privateDb();
    priv.db.prepare('INSERT INTO keeper_cutover (id, completed_at, fingerprint) VALUES (1, 200, ?)').run(JSON.stringify(fingerprint));
    expect(await checkPrivateDb(d1(shared), d1(priv))).toEqual({ ok: true });
    shared.db.prepare('UPDATE hf_band_state SET updated_at = 300').run();
    const r = await checkPrivateDb(d1(shared), d1(priv));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.line).toMatch(/no longer matches the cutover copy/);
  });

  it('fails closed when the private database cannot be read', async () => {
    const broken = { prepare: () => { throw new Error('boom'); } } as unknown as D1Database;
    const r = await checkPrivateDb(d1(sharedDb()), broken);
    expect(r.ok).toBe(false);
  });
});

describe('createPrivateDbGate', () => {
  it('caches only ok, so a fixed condition is noticed next tick', async () => {
    let calls = 0;
    const answers = [{ ok: false as const, line: 'x' }, { ok: true as const }];
    const gate = createPrivateDbGate(async () => answers[Math.min(calls++, 1)]);
    const db = {} as D1Database;
    expect((await gate.check(db, db)).ok).toBe(false);
    expect((await gate.check(db, db)).ok).toBe(true);
    expect((await gate.check(db, db)).ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('buildHostEnv — the private database', () => {
  const base = {
    CLOUDFLARE_ACCOUNT_ID: 'f8d28a27e95d4eab69364d7b3341fa7d',
    D1_DATABASE_ID: 'e5e927cf-56c3-42c7-9820-179a235cc84f',
    CLOUDFLARE_D1_API_TOKEN: 't',
  };
  it('binds KEEPER_DB from KEEPER_D1_DATABASE_ID, with the same account and token', () => {
    const { env, missingD1 } = buildHostEnv({ ...base, [HOST_SETTINGS.keeperDatabaseId]: 'f809ca7a-bc4a-4b17-b5bd-f36c3a3e9095' }, undefined, () => 'h');
    expect(env.DB).toBeDefined();
    expect(env.KEEPER_DB).toBeDefined();
    expect(missingD1).toEqual([]);
  });
  it('leaves KEEPER_DB absent, and names the setting, until it is set', () => {
    const { env, missingD1 } = buildHostEnv(base, undefined, () => 'h');
    expect(env.KEEPER_DB).toBeUndefined();
    expect(missingD1).toContain(HOST_SETTINGS.keeperDatabaseId);
  });
});
