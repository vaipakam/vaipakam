import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  appSendsReference,
  isRequestReference,
  newRequestReference,
  readRequestReference,
  REQUEST_REF_HEADER,
} from './requestReference';
import {
  pruneServiceErrors,
  routePattern,
  extractRouteWords,
  SERVICE_ERROR_DAILY_CAP,
  SERVICE_ERROR_HOURLY_CAP,
  SERVICE_ERROR_RETENTION_DAYS,
  serviceErrorRetentionDays,
  withRequestReference,
} from './serviceErrors';

const MIGRATION = new URL('../../../apps/indexer/migrations/0131_service_errors.sql', import.meta.url);

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(MIGRATION, 'utf8'));
  type Stmt = { sql: string; v: unknown[]; run(): Promise<unknown> };
  const prepare = (sql: string) => ({
    bind: (...v: unknown[]): Stmt => ({ sql, v, run: async () => raw.prepare(sql).run(...(v as never[])) }),
  });
  const d1 = {
    prepare,
    batch: async (stmts: unknown[]) => {
      raw.exec('BEGIN');
      try {
        for (const s of stmts as Stmt[]) raw.prepare(s.sql).run(...(s.v as never[]));
        raw.exec('COMMIT');
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { d1, raw };
}

const rows = (raw: DatabaseSync) => raw.prepare('SELECT * FROM service_errors ORDER BY id').all() as Record<string, unknown>[];

type Env = { DB: ReturnType<typeof db>['d1'] | null; FRONTEND_ORIGIN?: string };
const APP = 'https://app.vaipakam.com';

function wrap(handler: (req: Request) => Promise<Response> | Response, now = 1_800_000_000_000) {
  const logs: string[] = [];
  const pending: Promise<unknown>[] = [];
  const fetch = withRequestReference<Env, { waitUntil(p: Promise<unknown>): void }>(async (req) => handler(req), {
    service: 'agent',
    routeWords: WORDS,
    db: (env) => env.DB,
    frontendOrigins: (env) => env.FRONTEND_ORIGIN,
    corsOrigin: () => APP,
    version: () => ({ id: 'ver-1', tag: 'abcdef012345' }),
    now: () => now,
    log: (l) => logs.push(l),
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  return {
    logs,
    call: async (env: Env, req: Request) => {
      const res = await fetch(req, env, ctx);
      await Promise.all(pending.splice(0));
      return res;
    },
  };
}

const WORDS: ReadonlySet<string> = new Set(['loans', 'by-participant', 'name', 'telegram', 'phrase']);

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

describe('request reference', () => {
  it('is ten Crockford base32 characters, random each time', () => {
    const a = newRequestReference();
    const b = newRequestReference();
    expect(isRequestReference(a)).toBe(true);
    expect(a).not.toBe(b);
    // Every byte value maps into the alphabet (the low five bits).
    const all = newRequestReference((bytes) => bytes.fill(255));
    expect(all).toBe('ZZZZZZZZZZ');
    expect(isRequestReference('ILOU000000')).toBe(false);
    expect(isRequestReference('abc')).toBe(false);
  });

  it('is sent by the app on writes only', () => {
    expect(appSendsReference('POST')).toBe(true);
    expect(appSendsReference('put')).toBe(true);
    expect(appSendsReference('GET')).toBe(false);
    expect(appSendsReference(undefined)).toBe(false);
    expect(appSendsReference('OPTIONS')).toBe(false);
  });
});

describe('route pattern', () => {
  it('never carries an address, an id or a free-text value', () => {
    expect(routePattern(`/loans/by-participant/${ADDRESS}`, WORDS)).toBe('/loans/by-participant/:hex');
    expect(routePattern('/loans/123', WORDS)).toBe('/loans/:n');
    expect(routePattern('/x/deadbeefcafe', WORDS)).toBe('/:x/:hex');
    expect(routePattern('/name/vitalik.eth', WORDS)).toBe('/name/:x');
    expect(routePattern('/a/b/c/d/e/f/g/h/i/j', WORDS)).toBe('/:hex/:hex/:hex/:hex/:hex/:hex/:x/:x/:more');
    expect(routePattern('/', WORDS)).toBe('/');
    // Only an exact route word survives: a near-match (case, a free-text
    // segment that happens to look like a word) is a placeholder.
    expect(routePattern('/Telegram/Phrase', WORDS)).toBe('/:x/:x');
    expect(routePattern('/repayment-record/alice-smith', WORDS)).toBe('/:x/:x');
  });

  it('takes its words from path literals and path regexes in the source', () => {
    const src = [
      "if (url.pathname === '/telegram/phrase') {}",
      'const m = /^\\/loans\\/by-participant\\/(0x[0-9a-f]{40})$/i.exec(p);',
      "const t = `/name/${x}`;",
    ];
    expect(extractRouteWords(src)).toEqual(['by-participant', 'loans', 'name', 'phrase', 'telegram']);
  });
});

describe('withRequestReference', () => {
  it('returns the app reference on a refusal, and the record holds it and no address', async () => {
    const { d1, raw } = db();
    const { call, logs } = wrap(
      () => new Response('nope', { status: 403, headers: { 'Access-Control-Allow-Origin': APP } }),
    );
    const res = await call(
      { DB: d1, FRONTEND_ORIGIN: APP },
      new Request(`https://agent.example/telegram/phrase/${ADDRESS}?wallet=${ADDRESS}`, {
        method: 'POST',
        headers: { [REQUEST_REF_HEADER]: 'ABCDE12345', Origin: APP },
      }),
    );
    expect(res.status).toBe(403);
    expect(readRequestReference(res)).toBe('ABCDE12345');
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(REQUEST_REF_HEADER);
    const r = rows(raw);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      service: 'agent',
      method: 'POST',
      route: '/telegram/phrase/:hex',
      status: 403,
      reference: 'ABCDE12345',
      reference_source: 'app',
      build: 'abcdef012345',
      version_id: 'ver-1',
      at: 1_800_000_000,
    });
    expect(JSON.stringify(r).toLowerCase()).not.toContain(ADDRESS.slice(2, 12));
    expect(logs.join('\n')).toContain('ABCDE12345');
    expect(logs.join('\n')).not.toContain(ADDRESS.slice(2, 12));
  });

  it('a successful request returns a reference and writes no row and no log line', async () => {
    const { d1, raw } = db();
    const { call, logs } = wrap(() => new Response('ok'));
    const res = await call({ DB: d1, FRONTEND_ORIGIN: APP }, new Request('https://idx.example/offers/active', { headers: { Origin: APP } }));
    expect(res.status).toBe(200);
    expect(isRequestReference(res.headers.get(REQUEST_REF_HEADER))).toBe(true);
    // Not readable cross-origin, so nothing to expose.
    expect(res.headers.get('Access-Control-Expose-Headers')).toBeNull();
    expect(rows(raw)).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('makes its own reference for a read and ignores a malformed one', async () => {
    const { d1, raw } = db();
    const { call } = wrap(() => new Response('gone', { status: 404 }));
    const res = await call(
      { DB: d1, FRONTEND_ORIGIN: APP },
      new Request('https://idx.example/loans/7', { headers: { Origin: APP, [REQUEST_REF_HEADER]: 'not-a-ref' } }),
    );
    const ref = readRequestReference(res);
    expect(ref).not.toBeNull();
    expect(ref).not.toBe('not-a-ref');
    expect(rows(raw)[0]).toMatchObject({ reference: ref, reference_source: 'service', route: '/loans/:n' });
  });

  it('records a 4xx only from the app origin, and every 5xx', async () => {
    const { d1, raw } = db();
    const scan = wrap(() => new Response('no', { status: 404 }));
    await scan.call({ DB: d1, FRONTEND_ORIGIN: APP }, new Request('https://idx.example/wp-admin'));
    await scan.call({ DB: d1, FRONTEND_ORIGIN: APP }, new Request('https://idx.example/wp-admin', { headers: { Origin: 'https://evil.example' } }));
    expect(rows(raw)).toHaveLength(0);
    const broken = wrap(() => new Response('down', { status: 503 }));
    await broken.call({ DB: d1, FRONTEND_ORIGIN: APP }, new Request('https://idx.example/offers/active'));
    expect(rows(raw).map((r) => r.status)).toEqual([503]);
  });

  it('turns a throw into a 500 with CORS and the reference, and records it', async () => {
    const { d1, raw } = db();
    const { call, logs } = wrap(() => {
      throw new Error('boom');
    });
    const res = await call({ DB: d1, FRONTEND_ORIGIN: APP }, new Request('https://agent.example/support/ticket', { method: 'POST' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(REQUEST_REF_HEADER);
    const ref = readRequestReference(res);
    expect(rows(raw)[0]).toMatchObject({ status: 500, reference: ref });
    expect(logs[0]).toContain('threw');
  });

  it('copies a response whose headers are immutable', async () => {
    const { call } = wrap(() => {
      const upstream = new Response('{}', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      Object.defineProperty(upstream, 'headers', { value: Object.freeze(new Proxy(new Headers(upstream.headers), {
        get(target, prop) {
          if (prop === 'set') return () => { throw new TypeError('immutable'); };
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      })) });
      return upstream;
    });
    const res = await call({ DB: null }, new Request('https://agent.example/quote/readiness'));
    expect(isRequestReference(res.headers.get(REQUEST_REF_HEADER))).toBe(true);
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(REQUEST_REF_HEADER);
  });

  it('keeps an existing exposed-header list', async () => {
    const { call } = wrap(() => new Response('x', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Feed-Version' } }));
    const res = await call({ DB: null }, new Request('https://idx.example/public/v1'));
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(`X-Feed-Version, ${REQUEST_REF_HEADER}`);
  });

  it('a database without the table (previous schema) changes nothing in the response', async () => {
    const raw = new DatabaseSync(':memory:');
    const d1 = {
      prepare: (sql: string) => ({ bind: () => ({ sql }) }),
      batch: async (stmts: unknown[]) => {
        for (const s of stmts as { sql: string }[]) raw.prepare(s.sql);
      },
    };
    const { call, logs } = wrap(() => new Response('no', { status: 400 }));
    const res = await call({ DB: d1 as never, FRONTEND_ORIGIN: APP }, new Request('https://agent.example/thresholds', { method: 'PUT', headers: { Origin: APP } }));
    expect(res.status).toBe(400);
    expect(logs.some((l) => l.includes('not written'))).toBe(true);
  });

  it('keeps at most the hourly cap of rows, and counts the rest', async () => {
    const { d1, raw } = db();
    const { call } = wrap(() => new Response('down', { status: 500 }));
    for (let i = 0; i < SERVICE_ERROR_HOURLY_CAP + 3; i++) {
      await call({ DB: d1 }, new Request('https://idx.example/offers/active'));
    }
    expect(rows(raw)).toHaveLength(SERVICE_ERROR_HOURLY_CAP);
    const hour = raw.prepare('SELECT failures FROM service_error_hours').get() as { failures: number };
    expect(hour.failures).toBe(SERVICE_ERROR_HOURLY_CAP + 3);
  });

  it('keeps at most the daily cap of rows across the hours of one day', async () => {
    const { d1, raw } = db();
    const dayStart = Math.floor(1_800_000_000 / 86_400) * 86_400;
    const hours = Math.ceil(SERVICE_ERROR_DAILY_CAP / SERVICE_ERROR_HOURLY_CAP) + 2;
    for (let h = 0; h < hours; h++) {
      const { call } = wrap(() => new Response('down', { status: 500 }), (dayStart + h * 3600) * 1000);
      for (let i = 0; i < SERVICE_ERROR_HOURLY_CAP; i++) {
        await call({ DB: d1 }, new Request('https://idx.example/offers/active'));
      }
    }
    expect(rows(raw)).toHaveLength(SERVICE_ERROR_DAILY_CAP);
    // The next UTC day starts a fresh allowance.
    const { call } = wrap(() => new Response('down', { status: 500 }), (dayStart + 86_400) * 1000);
    await call({ DB: d1 }, new Request('https://idx.example/offers/active'));
    expect(rows(raw)).toHaveLength(SERVICE_ERROR_DAILY_CAP + 1);
    const counted = raw.prepare('SELECT SUM(failures) AS n FROM service_error_hours').get() as { n: number };
    expect(counted.n).toBe(hours * SERVICE_ERROR_HOURLY_CAP + 1);
  });

  it('passes a WebSocket upgrade through untouched', async () => {
    const ws = { status: 101, webSocket: {}, headers: new Headers() } as unknown as Response;
    const { call } = wrap(() => ws);
    expect(await call({ DB: null }, new Request('https://idx.example/ws/chain/1'))).toBe(ws);
  });
});

describe('retention', () => {
  it('reads the setting within bounds and prunes only older rows', async () => {
    expect(serviceErrorRetentionDays(undefined)).toBe(SERVICE_ERROR_RETENTION_DAYS);
    expect(serviceErrorRetentionDays('')).toBe(SERVICE_ERROR_RETENTION_DAYS);
    expect(serviceErrorRetentionDays('abc')).toBe(SERVICE_ERROR_RETENTION_DAYS);
    expect(serviceErrorRetentionDays('1')).toBe(7);
    expect(serviceErrorRetentionDays('9999')).toBe(400);
    expect(serviceErrorRetentionDays('30')).toBe(30);

    const { d1, raw } = db();
    const now = 1_800_000_000;
    const ins = raw.prepare(
      `INSERT INTO service_errors (service, method, route, status, reference, reference_source, build, at)
       VALUES ('agent', 'GET', '/', 500, 'ABCDE12345', 'service', 'unstamped', ?)`,
    );
    const cutoff = now - 90 * 86_400;
    ins.run(cutoff - 1);
    ins.run(cutoff);
    ins.run(now);
    raw.prepare('INSERT INTO service_error_hours VALUES (?, ?, 1)').run('agent', cutoff - 7200);
    raw.prepare('INSERT INTO service_error_hours VALUES (?, ?, 1)').run('agent', now - 3600);
    await pruneServiceErrors(d1, 90, now);
    expect(rows(raw).map((r) => r.at)).toEqual([cutoff, now]);
    expect((raw.prepare('SELECT count(*) AS n FROM service_error_hours').get() as { n: number }).n).toBe(1);
  });
});
