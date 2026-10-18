/**
 * The machine host's keeper-private database gate (host/privateDbGate.ts,
 * #2450): a machine tick runs only once `KEEPER_DB` records every keeper
 * migration AND the one-time cutover verdict — the deploy's own rule — passes.
 * Real SQL on in-memory SQLite, built from the real migrations.
 */
import { describe, expect, it } from 'vitest';
import { checkPrivateDb, createPrivateDbGate } from '../host/privateDbGate';
import { CUTOVER_TABLES, PRIVATE_DB_ID, fingerprintFromReads, fingerprintSql, rowsSql } from '../scripts/lib/keeper-cutover.mjs';
import { buildHostEnv } from '../host/hostEnv';
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
    // The marker the cutover would record: every table's fingerprint as read now.
    const fingerprint = Object.fromEntries(
      CUTOVER_TABLES.map((t) => [
        t.table,
        fingerprintFromReads(shared.db.prepare(fingerprintSql(t)).all(), shared.db.prepare(rowsSql(t)).all()),
      ]),
    );
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

describe('createPrivateDbGate — the full check on every tick, never cached (#2497 r4, r8)', () => {
  it('passes, then declines the tick after an old keeper writes a shared copy', async () => {
    const shared = sharedDb();
    const priv = privateDb();
    const gate = createPrivateDbGate();
    expect((await gate.check(d1(shared), d1(priv))).ok, 'fresh: nothing to move').toBe(true);
    // A legacy keeper restarted after startup writes the OLD shared copy.
    shared.db.prepare('INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (1, 1, ?, 1000, ?, 100)').run('warn', '0xabc');
    const moved = await gate.check(d1(shared), d1(priv));
    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.line).toMatch(/cutover/);
  });

  it('catches a same-second rewrite of an existing row: count and latest write time unchanged, content not', async () => {
    const shared = sharedDb();
    shared.db.prepare('INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (1, 1, ?, 1000, ?, 100)').run('warn', '0xabc');
    const fingerprint = Object.fromEntries(
      CUTOVER_TABLES.map((t) => [t.table, fingerprintFromReads(shared.db.prepare(fingerprintSql(t)).all(), shared.db.prepare(rowsSql(t)).all())]),
    );
    const priv = privateDb();
    priv.db.prepare('INSERT INTO keeper_cutover (id, completed_at, fingerprint) VALUES (1, 200, ?)').run(JSON.stringify(fingerprint));
    const gate = createPrivateDbGate();
    expect((await gate.check(d1(shared), d1(priv))).ok).toBe(true);
    shared.db.prepare("UPDATE hf_band_state SET last_band = 'critical'").run(); // updated_at stays 100
    const r = await gate.check(d1(shared), d1(priv));
    expect(r.ok, 'the digest is re-read every tick').toBe(false);
    expect(!r.ok && r.line).toMatch(/no longer matches the cutover copy/);
  });
});

describe('buildHostEnv — the private database', () => {
  const base = {
    CLOUDFLARE_ACCOUNT_ID: 'f8d28a27e95d4eab69364d7b3341fa7d',
    D1_DATABASE_ID: 'e5e927cf-56c3-42c7-9820-179a235cc84f',
    CLOUDFLARE_D1_API_TOKEN: 't',
  };
  /** A fetch that records each URL and answers an empty D1 result. */
  const capture = () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ success: true, errors: [], result: [{ results: [], meta: {} }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { urls, fetchFn };
  };

  it("binds KEEPER_DB to the PINNED private database, whatever the host env says (#2497 r4)", async () => {
    const { urls, fetchFn } = capture();
    const { env, missingD1 } = buildHostEnv(
      { ...base, KEEPER_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000' }, // a retired setting: ignored
      fetchFn,
      () => 'h',
    );
    expect(env.DB).toBeDefined();
    expect(env.KEEPER_DB).toBeDefined();
    expect(missingD1).toEqual([]);
    await env.KEEPER_DB!.prepare('SELECT 1').all();
    expect(urls.at(-1)).toContain(`/d1/database/${PRIVATE_DB_ID}/query`);
  });

  it('binds no KEEPER_DB without the account and token', () => {
    const { env } = buildHostEnv({ D1_DATABASE_ID: base.D1_DATABASE_ID }, undefined, () => 'h');
    expect(env.KEEPER_DB).toBeUndefined();
  });

  it("refuses a shared setting that names the private database — no database is bound", () => {
    const { env, refusedD1 } = buildHostEnv({ ...base, D1_DATABASE_ID: PRIVATE_DB_ID.toUpperCase() }, undefined, () => 'h');
    expect(env.DB).toBeUndefined();
    expect(env.KEEPER_DB).toBeUndefined();
    expect(refusedD1).toMatch(/private database/);
  });
});
