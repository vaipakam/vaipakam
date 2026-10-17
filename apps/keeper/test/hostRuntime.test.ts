/**
 * The always-on machine runtime (host/): the D1 HTTP adapter, the env it
 * builds, and the minute clock. Each is what lets the SAME tick run off
 * Cloudflare, so these tests pin the places the two hosts could differ.
 */
import { describe, expect, it } from 'vitest';
import { D1HttpDatabase, D1HttpError } from '../host/d1Http';
import { buildHostEnv, HOST_SETTINGS } from '../host/hostEnv';
import { createHostTick } from '../host/hostTick';
import { createSchemaGate } from '../../indexer/src/schemaGate';
import { REQUIRED_D1_MIGRATIONS } from '../../indexer/src/requiredMigrations';
import { CUTOVER_TABLES } from '../scripts/lib/keeper-cutover.mjs';
import REQUIRED_KEEPER_MIGRATIONS from '../src/requiredKeeperMigrations.json';
import {
  createTickRunner,
  minuteFloor,
  msUntilNextMinute,
  MINUTE_MS,
} from '../host/scheduler';
import { resolveEnv, SECRET_BINDING_KEYS, type WorkerEnv } from '../src/env';

const ACCOUNT = 'a'.repeat(32);
const DATABASE = 'e5e927cf-56c3-42c7-9820-179a235cc84f';
const TOKEN = 'test-token-not-real';

function api(responses: unknown[]) {
  const sent: { url: string; init: RequestInit; body: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, json } = next as { status?: number; json: unknown };
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  const db = new D1HttpDatabase({ accountId: ACCOUNT, databaseId: DATABASE, apiToken: TOKEN, fetchFn });
  return { db, sent };
}

const ok = (...results: unknown[]) => ({ json: { success: true, errors: [], result: results } });

describe('D1 HTTP adapter', () => {
  it('posts one statement with its bound params to the database query endpoint', async () => {
    const { db, sent } = api([ok({ success: true, results: [{ id: 1 }], meta: { changes: 0 } })]);
    const res = await db.prepare('SELECT id FROM t WHERE a = ? AND b = ?').bind(5, 'x').all();
    expect(res.results).toEqual([{ id: 1 }]);
    expect(sent[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
    );
    expect(sent[0].body).toEqual({ sql: 'SELECT id FROM t WHERE a = ? AND b = ?', params: [5, 'x'] });
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('binds booleans as 1/0 and bigints as decimal strings, and refuses undefined', () => {
    const { db } = api([]);
    expect(db.prepare('x').bind(true, false, 10n ** 20n, null).params).toEqual([1, 0, '100000000000000000000', null]);
    expect(() => db.prepare('x').bind(undefined)).toThrow(/parameter 1 is undefined/);
  });

  it('first() returns the first row, a column of it, or null', async () => {
    const { db } = api([
      ok({ success: true, results: [{ a: 1, b: 2 }] }),
      ok({ success: true, results: [{ a: 1, b: 2 }] }),
      ok({ success: true, results: [] }),
    ]);
    expect(await db.prepare('q').first()).toEqual({ a: 1, b: 2 });
    expect(await db.prepare('q').first('b')).toBe(2);
    expect(await db.prepare('q').first()).toBeNull();
  });

  it('sends a batch as ONE request and returns a result per statement', async () => {
    const { db, sent } = api([
      ok({ success: true, results: [], meta: { changes: 1 } }, { success: true, results: [], meta: { changes: 0 } }),
    ]);
    const out = await db.batch([db.prepare('INSERT a').bind(1), db.prepare('INSERT b').bind(2)]);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ batch: [{ sql: 'INSERT a', params: [1] }, { sql: 'INSERT b', params: [2] }] });
    expect(out.map((r) => r.meta.changes)).toEqual([1, 0]);
  });

  it('refuses a batch answer whose result count does not match', async () => {
    const { db } = api([ok({ success: true, results: [] })]);
    await expect(db.batch([db.prepare('a'), db.prepare('b')])).rejects.toThrow(/batch of 2 returned 1/);
  });

  it('throws the API messages on a failure, and never the token', async () => {
    const { db } = api([{ status: 400, json: { success: false, errors: [{ message: 'no such table: t' }] } }]);
    const err = await db.prepare('SELECT 1 FROM t').all().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D1HttpError);
    expect(String(err)).toMatch(/status 400: no such table: t/);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('says a lost request has no answer, rather than guessing whether it applied', async () => {
    const { db } = api([new Error('socket hang up')]);
    await expect(db.prepare('UPDATE t SET a = 1').run()).rejects.toThrow(/request failed with no answer/);
  });

  it('refuses a malformed account or database id before any request', () => {
    expect(() => new D1HttpDatabase({ accountId: 'nope', databaseId: DATABASE, apiToken: TOKEN })).toThrow(/account id/);
    expect(() => new D1HttpDatabase({ accountId: ACCOUNT, databaseId: '../x', apiToken: TOKEN })).toThrow(/database id/);
  });
});

describe('host env', () => {
  it('treats an empty variable as unset, as an unbound var is on the Worker', () => {
    const env = buildHostEnv({
      KEEPER_ENABLED: 'false',
      LIQ_TIER3_MIN_TVL_USD: '',
      RPC_BASE_SEPOLIA: '',
    }).env as unknown as Record<string, unknown>;
    expect(env.KEEPER_ENABLED).toBe('false');
    expect('LIQ_TIER3_MIN_TVL_USD' in env).toBe(false);
    expect('RPC_BASE_SEPOLIA' in env).toBe(false);
  });

  const full = {
    [HOST_SETTINGS.accountId]: ACCOUNT,
    [HOST_SETTINGS.databaseId]: DATABASE,
    [HOST_SETTINGS.apiToken]: TOKEN,
    KEEPER_ENABLED: 'false',
    RPC_BASE_SEPOLIA: 'https://rpc.example',
    KEEPER_PRIVATE_KEY: '0xabc',
  };

  it('resolves to the same plain env a Worker resolves to', async () => {
    const resolved = await resolveEnv(buildHostEnv(full).env);
    expect(resolved.KEEPER_ENABLED).toBe('false');
    expect(resolved.RPC_BASE_SEPOLIA).toBe('https://rpc.example');
    expect(resolved.KEEPER_PRIVATE_KEY).toBe('0xabc');
    expect(typeof resolved.DB.prepare).toBe('function');
  });

  it('does not copy the D1 API token or the other host settings into the env', () => {
    const env = buildHostEnv(full).env as unknown as Record<string, unknown>;
    for (const key of Object.values(HOST_SETTINGS)) expect(env[key]).toBeUndefined();
  });

  it('leaves both databases absent and names what is missing when the D1 settings are incomplete', () => {
    const { env, missingD1 } = buildHostEnv({ KEEPER_ENABLED: 'false' });
    expect(env.DB).toBeUndefined();
    expect(env.KEEPER_DB).toBeUndefined();
    // The private id has a pinned default, so it is never reported missing.
    expect(missingD1).toEqual([HOST_SETTINGS.accountId, HOST_SETTINGS.databaseId, HOST_SETTINGS.apiToken]);
  });

  it('binds KEEPER_DB to the pinned private database by default, and to an override when set', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ success: true, result: [{ results: [], success: true, meta: {} }] }));
    }) as unknown as typeof fetch;
    const { env, refusedD1 } = buildHostEnv(full, fetchFn);
    expect(refusedD1).toBeNull();
    await env.KEEPER_DB!.prepare('SELECT 1').all();
    expect(urls.at(-1)).toContain('/d1/database/f809ca7a-bc4a-4b17-b5bd-f36c3a3e9095/');
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await buildHostEnv({ ...full, [HOST_SETTINGS.keeperDatabaseId]: other }, fetchFn).env.KEEPER_DB!.prepare('SELECT 1').all();
    expect(urls.at(-1)).toContain(`/d1/database/${other}/`);
  });

  it('refuses a private id that names the shared database, leaving KEEPER_DB unbound', () => {
    const { env, refusedD1 } = buildHostEnv({ ...full, [HOST_SETTINGS.keeperDatabaseId]: DATABASE.toUpperCase() });
    expect(env.KEEPER_DB).toBeUndefined();
    expect(refusedD1).toMatch(/names the shared database/);
  });

  it('wraps every secret resolveEnv reads as a binding, and no other field', async () => {
    // A Proxy env answers every key resolveEnv reads: a binding for the
    // listed secrets, a plain string for the rest. A secret resolveEnv reads
    // through `.get()` but SECRET_BINDING_KEYS omits would arrive as a string
    // and resolve to undefined, so every resolved field must be defined.
    const listed = new Set<string>(SECRET_BINDING_KEYS);
    const raw = new Proxy({} as Record<string, unknown>, {
      get: (_t, key) => {
        if (typeof key !== 'string') return undefined;
        if (key === 'DB' || key === 'KEEPER_DB') return { prepare: () => null };
        return listed.has(key) ? { get: async () => `v:${key}` } : `v:${key}`;
      },
    }) as unknown as WorkerEnv;
    const resolved = (await resolveEnv(raw)) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(resolved)) {
      if (key === 'DB' || key === 'KEEPER_DB') continue;
      expect(value, key).toBe(`v:${key}`);
    }
  });
});

describe('minute clock', () => {
  it('fires on minute boundaries and names the boundary as the scheduled time', () => {
    const t = 1_700_000_000_000 + 12_345;
    expect(minuteFloor(t) % MINUTE_MS).toBe(0);
    expect(minuteFloor(t)).toBeLessThanOrEqual(t);
    expect((t + msUntilNextMinute(t)) % MINUTE_MS).toBe(0);
    expect(msUntilNextMinute(minuteFloor(t))).toBe(MINUTE_MS);
  });

  it('skips a tick while the previous one still has a pass running, naming it', async () => {
    const lines: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const ticks: number[] = [];
    const runner = createTickRunner({
      runTick: async (t, launch) => {
        ticks.push(t);
        if (ticks.length === 1) launch('matcher', slow);
      },
      log: (l) => lines.push(l),
    });
    expect(runner.fire(0)).toBe(true);
    await Promise.resolve();
    expect(runner.fire(MINUTE_MS)).toBe(false);
    expect(lines.at(-1)).toMatch(/skipped: the previous tick is still running \(matcher\)/);
    release();
    await runner.idle();
    expect(runner.fire(2 * MINUTE_MS)).toBe(true);
    await runner.idle();
    expect(ticks).toEqual([0, 2 * MINUTE_MS]);
  });

  it('a tick that throws is logged and does not wedge the clock', async () => {
    const lines: string[] = [];
    const runner = createTickRunner({
      runTick: async () => {
        throw new Error('boom');
      },
      log: (l) => lines.push(l),
    });
    runner.fire(0);
    await runner.idle();
    expect(lines.at(-1)).toMatch(/failed: Error: boom/);
    expect(runner.fire(MINUTE_MS)).toBe(true);
    await runner.idle();
  });
});

describe('host tick schema check', () => {
  const vars = {
    [HOST_SETTINGS.accountId]: ACCOUNT,
    [HOST_SETTINGS.databaseId]: DATABASE,
    [HOST_SETTINGS.apiToken]: TOKEN,
  };
  function setup(applied: string[] | Error) {
    const lines: string[] = [];
    const ran: number[] = [];
    const fetchFn = (async () => {
      if (applied instanceof Error) throw applied;
      return new Response(
        JSON.stringify({ success: true, errors: [], result: [{ success: true, results: applied.map((name) => ({ name })) }] }),
      );
    }) as unknown as typeof fetch;
    const tick = createHostTick({
      vars: () => vars,
      log: (l) => lines.push(l),
      gate: createSchemaGate(['0001_a.sql', '0002_b.sql']),
      privateGate: { check: async () => ({ state: 'current' }) },
      cutover: { check: async () => ({ ok: true }) },
      runTick: async (_env, t) => {
        ran.push(t);
      },
      fetchFn,
    });
    return { tick, lines, ran };
  }

  it('runs the tick once every migration this build carries is recorded', async () => {
    const h = setup(['0001_a.sql', '0002_b.sql']);
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([60_000]);
  });

  it('declines, naming the missing migration, while one is not applied', async () => {
    const h = setup(['0001_a.sql']);
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([]);
    expect(h.lines.at(-1)).toMatch(/0002_b\.sql not applied/);
  });

  it('declines when the schema cannot be read, rather than assuming it', async () => {
    const h = setup(new Error('network down'));
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([]);
    expect(h.lines.at(-1)).toMatch(/could not read d1_migrations/);
  });

  it('leaves the no-database case to the shared tick, which declines it by name', async () => {
    const ran: number[] = [];
    const tick = createHostTick({
      vars: () => ({}),
      log: () => {},
      gate: { check: async () => { throw new Error('must not be asked'); } },
      runTick: async (env, t) => {
        expect(env.DB).toBeUndefined();
        ran.push(t);
      },
    });
    await tick(0, () => {});
    expect(ran).toEqual([0]);
  });
});

describe('host tick private database checks (#2497)', () => {
  const PRIVATE = 'f809ca7a-bc4a-4b17-b5bd-f36c3a3e9095';
  const vars = {
    [HOST_SETTINGS.accountId]: ACCOUNT,
    [HOST_SETTINGS.databaseId]: DATABASE,
    [HOST_SETTINGS.apiToken]: TOKEN,
  };
  const TABLES = CUTOVER_TABLES.map(({ table }) => table);
  /** Answers by database and statement: `shared` and `priv` map a query to its rows (or an Error). */
  function setup(opts: {
    privateApplied: string[];
    sharedRows: number;
    marker: 'none' | 'match' | 'stale';
  }) {
    const lines: string[] = [];
    const ran: number[] = [];
    const fp = { n: opts.sharedRows, at: 100 };
    const answer = (db: string, sql: string): unknown[] => {
      if (db === DATABASE) {
        if (sql.startsWith('SELECT name FROM d1_migrations')) return REQUIRED_D1_MIGRATIONS.map((name) => ({ name }));
        if (sql.includes('sqlite_master')) return TABLES.map((name) => ({ name }));
        return [{ n: fp.n, at: fp.at }];
      }
      if (sql.startsWith('SELECT name FROM d1_migrations')) return opts.privateApplied.map((name) => ({ name }));
      if (sql.includes('keeper_cutover')) {
        if (opts.marker === 'none') return [];
        const at = opts.marker === 'match' ? fp.at : fp.at - 1;
        return [{ completed_at: 1, fingerprint: JSON.stringify(Object.fromEntries(TABLES.map((t) => [t, { n: fp.n, at }]))) }];
      }
      throw new Error(`unexpected private statement: ${sql}`);
    };
    const fetchFn = (async (url: string, init: RequestInit) => {
      const db = String(url).includes(PRIVATE) ? PRIVATE : DATABASE;
      const { sql } = JSON.parse(init.body as string) as { sql: string };
      return new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: answer(db, sql) }] }));
    }) as unknown as typeof fetch;
    const tick = createHostTick({
      vars: () => vars,
      log: (l) => lines.push(l),
      runTick: async (env, t) => {
        expect(env.KEEPER_DB).toBeDefined();
        ran.push(t);
      },
      fetchFn,
    });
    return { tick, lines, ran };
  }

  it('declines, naming the keeper migration, until the private schema is applied', async () => {
    const h = setup({ privateApplied: REQUIRED_KEEPER_MIGRATIONS.slice(0, -1), sharedRows: 0, marker: 'none' });
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([]);
    expect(h.lines.at(-1)).toContain(`${REQUIRED_KEEPER_MIGRATIONS.at(-1)} not applied to vaipakam-keeper-db`);
  });

  it('declines while the shared copies hold rows and no cutover is recorded', async () => {
    const h = setup({ privateApplied: REQUIRED_KEEPER_MIGRATIONS, sharedRows: 3, marker: 'none' });
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([]);
    expect(h.lines.at(-1)).toMatch(/records no cutover: run `pnpm --filter @vaipakam\/keeper run cutover`/);
  });

  it('declines when the shared copies moved since the cutover', async () => {
    const h = setup({ privateApplied: REQUIRED_KEEPER_MIGRATIONS, sharedRows: 3, marker: 'stale' });
    await h.tick(60_000, () => {});
    expect(h.ran).toEqual([]);
    expect(h.lines.at(-1)).toMatch(/no longer matches the cutover copy/);
  });

  it('runs once the cutover is recorded and matches, and on a fresh environment with nothing to move', async () => {
    const recorded = setup({ privateApplied: REQUIRED_KEEPER_MIGRATIONS, sharedRows: 3, marker: 'match' });
    await recorded.tick(60_000, () => {});
    expect(recorded.ran).toEqual([60_000]);
    const fresh = setup({ privateApplied: REQUIRED_KEEPER_MIGRATIONS, sharedRows: 0, marker: 'none' });
    await fresh.tick(60_000, () => {});
    expect(fresh.ran).toEqual([60_000]);
  });
});
