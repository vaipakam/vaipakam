/**
 * The keeper's off-Workers host (docs/DesignsAndPlans/KeeperHostPortability.md):
 * the D1 HTTP adapter, the env built from process variables, and the minute
 * loop. None of it touches the network — `fetch` and the clock are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { D1HttpDatabase } from '../machine/d1Http';
import { KNOB_NAMES, SECRET_NAMES, rawEnvFromProcess } from '../machine/envFromProcess';
import { nextMinute, runLoop } from '../machine/run';
import { resolveEnv } from '../src/env';

const TOKEN = 'secret-token-value';

/** A fetch that answers like the D1 query API and records each body. */
function d1Api(answer: (body: { sql?: string; params?: unknown[]; batch?: unknown[] }) => unknown) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body });
    const payload = answer(body);
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const ok = (...sets: Array<{ results?: unknown[]; meta?: unknown }>) => ({ success: true, errors: [], result: sets });
const db = (fetchFn: typeof fetch) =>
  new D1HttpDatabase({ accountId: 'acct', databaseId: 'dbid', apiToken: TOKEN, fetchFn });

describe('D1HttpDatabase — the binding surface the keeper uses, over the HTTP API', () => {
  it('sends one statement with positional parameters to the database query endpoint', async () => {
    const api = d1Api(() => ok({ results: [{ a: 7 }], meta: { changes: 0 } }));
    const rows = await db(api.fetchFn).prepare('SELECT ?1 AS a').bind(7).all();
    expect(rows.results).toEqual([{ a: 7 }]);
    expect(api.calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/d1/database/dbid/query');
    expect(api.calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(api.calls[0].body).toEqual({ sql: 'SELECT ?1 AS a', params: [7] });
  });

  it('first() returns the first row, one column of it, or null', async () => {
    const api = d1Api((b) => ok({ results: b.sql === 'EMPTY' ? [] : [{ x: 1, y: 'two' }] }));
    const d = db(api.fetchFn);
    expect(await d.prepare('Q').first()).toEqual({ x: 1, y: 'two' });
    expect(await d.prepare('Q').first('y')).toBe('two');
    expect(await d.prepare('EMPTY').first()).toBeNull();
    await expect(d.prepare('Q').first('nope')).rejects.toThrow(/D1_COLUMN_NOTFOUND/);
  });

  it('run() reports changes and last_row_id as numbers, as the binding does', async () => {
    const api = d1Api(() => ok({ results: [], meta: { changes: 3, last_row_id: 42, duration: 1 } }));
    const r = await db(api.fetchFn).prepare('UPDATE t SET a = 1').run();
    expect(r.meta.changes).toBe(3);
    expect(r.meta.last_row_id).toBe(42);
  });

  it('bind() returns a NEW statement and converts booleans to 1/0', async () => {
    const api = d1Api(() => ok({ results: [] }));
    const base = db(api.fetchFn).prepare('INSERT INTO t VALUES (?, ?, ?)');
    const bound = base.bind(true, false, null);
    expect(bound).not.toBe(base);
    await bound.run();
    expect(api.calls[0].body.params).toEqual([1, 0, null]);
  });

  it('refuses a bigint, as the binding does, rather than sending a lossy number', async () => {
    const api = d1Api(() => ok({ results: [] }));
    await expect(db(api.fetchFn).prepare('Q').bind(10n ** 30n).run()).rejects.toThrow(/bigint/);
    expect(api.calls).toHaveLength(0);
  });

  it('batch() sends every statement in ONE request and returns one result each, in order', async () => {
    const api = d1Api(() => ok({ results: [{ a: 1 }], meta: { changes: 0 } }, { results: [], meta: { changes: 2 } }));
    const d = db(api.fetchFn);
    const out = await d.batch([d.prepare('SELECT 1 AS a'), d.prepare('UPDATE t SET b = ?').bind(5)]);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].body).toEqual({ batch: [{ sql: 'SELECT 1 AS a', params: [] }, { sql: 'UPDATE t SET b = ?', params: [5] }] });
    expect(out.map((r) => r.meta.changes)).toEqual([0, 2]);
  });

  it('throws the API’s own message on failure, and never the token', async () => {
    const api = d1Api(() => ({ success: false, errors: [{ code: 7500, message: 'no such table: nope' }] }));
    const err = await db(api.fetchFn).prepare('SELECT * FROM nope').all().catch((e: Error) => e);
    expect(String(err)).toMatch(/no such table: nope/);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('refuses to construct without its credentials', () => {
    expect(() => new D1HttpDatabase({ accountId: '', databaseId: 'd', apiToken: 't' })).toThrow(/accountId/);
  });
});

describe('rawEnvFromProcess — the Worker env shape, from process variables', () => {
  const base = { CLOUDFLARE_ACCOUNT_ID: 'acct', KEEPER_D1_API_TOKEN: TOKEN };

  it('presents secrets as bindings and knobs as strings, so resolveEnv reads them as on the Worker', async () => {
    const api = d1Api(() => ok({ results: [] }));
    const raw = rawEnvFromProcess(
      { ...base, RPC_BASE_SEPOLIA: 'https://rpc.example', KEEPER_PRIVATE_KEY: '0xabc', KEEPER_ENABLED: 'false', GRACE_DEFAULT_ENABLED: 'true' },
      api.fetchFn,
    );
    const env = await resolveEnv(raw);
    expect(env.RPC_BASE_SEPOLIA).toBe('https://rpc.example');
    expect(env.KEEPER_PRIVATE_KEY).toBe('0xabc');
    expect(env.KEEPER_ENABLED).toBe('false');
    expect(env.GRACE_DEFAULT_ENABLED).toBe('true');
  });

  it('treats an unset or EMPTY variable as an absent binding — the chain or pass skips, as on the Worker', async () => {
    const raw = rawEnvFromProcess({ ...base, RPC_BASE: '', KEEPER_ENABLED: '' });
    const env = await resolveEnv(raw);
    expect(env.RPC_BASE).toBeUndefined();
    expect(env.RPC_ETH).toBeUndefined();
    expect(env.KEEPER_ENABLED).toBeUndefined();
  });

  it('requires its own database credentials, and names the missing one', () => {
    expect(() => rawEnvFromProcess({ KEEPER_D1_API_TOKEN: TOKEN })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => rawEnvFromProcess({ CLOUDFLARE_ACCOUNT_ID: 'a' })).toThrow(/KEEPER_D1_API_TOKEN/);
  });

  it('covers every secret and knob the Worker env declares', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/env.ts', import.meta.url), 'utf8'));
    const block = (start: RegExp) => {
      const from = src.search(start);
      return src.slice(from, src.indexOf('\n}', from));
    };
    const fields = (text: string) => [...text.matchAll(/^ {2}([A-Z][A-Z_0-9]+)\??:/gm)].map((m) => m[1]);
    const secrets = fields(block(/export interface WorkerEnv extends BaseEnv \{/)).filter((f) => f !== 'DB');
    const knobs = fields(block(/interface BaseEnv \{/));
    expect([...SECRET_NAMES].sort()).toEqual(secrets.sort());
    expect([...KNOB_NAMES].sort()).toEqual(knobs.sort());
  });

  it('the shipped .env.machine.example names exactly the variables the runner reads', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(new URL('../machine/.env.machine.example', import.meta.url), 'utf8');
    const named = [...text.matchAll(/^([A-Z][A-Z_0-9]*)=/gm)].map((m) => m[1]);
    expect(new Set(named).size).toBe(named.length);
    const machineOwn = ['CLOUDFLARE_ACCOUNT_ID', 'KEEPER_D1_API_TOKEN', 'KEEPER_D1_DATABASE_ID'];
    expect(named.sort()).toEqual([...SECRET_NAMES, ...KNOB_NAMES, ...machineOwn].sort());
  });
});

describe('runLoop — every UTC minute, never overlapping, stopping cleanly', () => {
  /** A fake clock: `sleep` advances time; a tick may take `cost` ms. */
  function harness(ticks: number, costOf: (n: number) => number = () => 1_000) {
    let t = 1_700_000_012_345; // mid-minute
    let n = 0;
    const ran: number[] = [];
    const logs: string[] = [];
    const deps = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      tick: async (scheduled: number) => {
        ran.push(scheduled);
        t += costOf(n++);
      },
      log: (l: string) => logs.push(l),
      stopping: () => ran.length >= ticks,
    };
    return { deps, ran, logs };
  }

  it('aligns to the next whole minute and passes the minute each tick is FOR', async () => {
    const h = harness(3);
    await runLoop(h.deps);
    expect(h.ran).toHaveLength(3);
    for (const s of h.ran) expect(s % 60_000).toBe(0);
    expect(h.ran[1] - h.ran[0]).toBe(60_000);
    expect(h.ran[0]).toBe(nextMinute(1_700_000_012_345));
  });

  it('a tick that overruns SKIPS the minutes it covered — the next never starts early or alongside', async () => {
    const h = harness(2, (n) => (n === 0 ? 150_000 : 1_000)); // the first tick runs 2.5 min
    await runLoop(h.deps);
    expect(h.ran[1] - h.ran[0]).toBe(180_000);
    expect(h.logs.some((l) => /skipped 2 minute\(s\), never overlapped/.test(l))).toBe(true);
  });

  it('keeps ticking after a tick fails before its passes, and says so', async () => {
    const h = harness(2);
    const tick = h.deps.tick;
    let first = true;
    h.deps.tick = vi.fn(async (s: number) => {
      if (first) {
        first = false;
        h.ran.push(s);
        throw new Error('env would not resolve');
      }
      await tick(s);
    });
    await runLoop(h.deps);
    expect(h.ran).toHaveLength(2);
    expect(h.logs.some((l) => /failed before its passes: env would not resolve/.test(l))).toBe(true);
  });

  it('stops without starting a tick once a stop is requested', async () => {
    const h = harness(0);
    await runLoop(h.deps);
    expect(h.ran).toEqual([]);
    expect(h.logs.at(-1)).toMatch(/stopped/);
  });
});
