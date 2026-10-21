/**
 * The machine host's keeper-private database gate (host/privateDbGate.ts,
 * #2450): a machine tick runs only once `KEEPER_DB` records every keeper
 * migration. Since #2560 it reads nothing else: the shared copies it used to
 * watch are dropped. Real SQL on in-memory SQLite, built from the real
 * migrations.
 */
import { describe, expect, it } from 'vitest';
import { checkPrivateDb, createPrivateDbGate } from '../host/privateDbGate';
import { PRIVATE_DB_ID } from '../scripts/lib/keeper-databases.mjs';
import { buildHostEnv } from '../host/hostEnv';
import REQUIRED from '../src/requiredKeeperMigrations.json';
import { createSqliteD1 } from './helpers/sqliteD1';
import { KEEPER_MIGRATIONS, KEEPER_MIGRATIONS_DIR, migrationFiles } from './helpers/schemas';

const D1_MIGRATIONS = 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)';

function privateDb(applied: readonly string[] = REQUIRED) {
  const h = createSqliteD1([...KEEPER_MIGRATIONS, D1_MIGRATIONS]);
  for (const name of applied) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  return h;
}
const d1 = (h: { d1: unknown }) => h.d1 as D1Database;

describe('requiredKeeperMigrations.json', () => {
  it('lists exactly the files in apps/keeper/migrations', () => {
    expect([...REQUIRED]).toEqual(migrationFiles(KEEPER_MIGRATIONS_DIR));
  });
});

describe('checkPrivateDb', () => {
  it('passes once every keeper-private migration is applied', async () => {
    expect(await checkPrivateDb(d1(privateDb()))).toEqual({ ok: true });
  });

  it('declines, naming them, while a keeper-private migration is missing — and never applies it', async () => {
    const priv = privateDb([REQUIRED[0]]);
    const r = await checkPrivateDb(d1(priv));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.line).toContain(REQUIRED[1]);
    expect(!r.ok && r.line).toContain('pnpm --filter @vaipakam/keeper run migrate');
    const n = priv.db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('fails closed when the private database cannot be read', async () => {
    const broken = { prepare: () => { throw new Error('boom'); } } as unknown as D1Database;
    const r = await checkPrivateDb(broken);
    expect(r.ok).toBe(false);
  });
});

describe('createPrivateDbGate — the full check on every tick, never cached', () => {
  it('passes, then declines the next tick once the build requires a migration the database lacks', async () => {
    const priv = privateDb();
    expect((await createPrivateDbGate().check(d1(priv))).ok).toBe(true);
    const gate = createPrivateDbGate([...REQUIRED, '9999_next.sql']);
    const r = await gate.check(d1(priv));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.line).toContain('9999_next.sql');
    priv.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('9999_next.sql');
    expect((await gate.check(d1(priv))).ok, 'resumes by itself once applied').toBe(true);
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
