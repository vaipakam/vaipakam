/**
 * The keeper's D1 database, reached over Cloudflare's D1 HTTP API.
 *
 * On a Worker the database is a binding. Off Cloudflare there is no binding,
 * but the database has to stay the SAME one: the keeper shares its tables
 * with the indexer and the agent (the agent writes the alert thresholds the
 * watcher reads, the indexer owns the schema), so a local database on the
 * machine would split that state. This adapter gives the passes the subset
 * of `D1Database` they use, backed by
 * `POST /accounts/{account}/d1/database/{database}/query`:
 *
 *   - `prepare(sql).bind(...).all() / first() / run() / raw()` — one request
 *     each, `{ sql, params }`.
 *   - `batch([...])` — one request, `{ batch: [{ sql, params }, ...] }`,
 *     which the API runs as one batch, as the binding does.
 *   - `exec(sql)` — one request, `{ sql }`.
 *
 * What it does NOT do, stated so nobody relies on it: it does not retry. A
 * write whose answer is lost may or may not have applied, and only the
 * caller knows whether repeating it is safe — exactly as with the binding,
 * whose failures the passes already handle. Every request has a timeout, so
 * a stalled API cannot hold a tick open.
 *
 * The API token never appears in an error or a log line.
 */

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  /** A Cloudflare API token with D1 edit permission on the account. */
  apiToken: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-request timeout. Default 20 s. */
  timeoutMs?: number;
  /** Defaults to Cloudflare's public API. */
  apiBase?: string;
}

/** One statement's result, in the shape the binding returns. */
interface D1HttpResult {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

const DEFAULT_API = 'https://api.cloudflare.com/client/v4';
const ID = /^[0-9a-f-]{32,36}$/i;

/** A D1 failure from the HTTP API, carrying the API's own messages. */
export class D1HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'D1HttpError';
  }
}

/**
 * Turn a bound value into what the HTTP API accepts. Mirrors the binding:
 * booleans bind as 1/0, `null` stays null, and `undefined` is refused, as
 * the binding refuses it, rather than silently written as null. A bigint
 * is sent as its decimal string; SQLite's column affinity stores it as an
 * integer in an INTEGER column.
 */
function encodeParam(v: unknown, index: number): unknown {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  if (v === undefined) {
    throw new D1HttpError(`D1_TYPE_ERROR: parameter ${index + 1} is undefined`);
  }
  throw new D1HttpError(
    `D1_TYPE_ERROR: parameter ${index + 1} has type ${typeof v}, which the D1 HTTP adapter does not send`,
  );
}

class HttpStatement {
  constructor(
    private readonly db: D1HttpDatabase,
    readonly sql: string,
    readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): HttpStatement {
    return new HttpStatement(this.db, this.sql, values.map(encodeParam));
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const [r] = await this.db.send({ sql: this.sql, params: this.params });
    return { results: (r?.results ?? []) as T[], success: true, meta: r?.meta ?? {} };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const { results } = await this.all<Record<string, unknown>>();
    const row = results[0];
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new D1HttpError(`D1_COLUMN_NOTFOUND: column ${column} is not in the result`);
    return (row[column] ?? null) as T;
  }

  async run(): Promise<{ results: unknown[]; success: true; meta: Record<string, unknown> }> {
    return this.all();
  }

  /** Rows as arrays, in the column order the API returned them. */
  async raw<T = unknown[]>(): Promise<T[]> {
    const { results } = await this.all<Record<string, unknown>>();
    return results.map((row) => Object.values(row) as T);
  }
}

export class D1HttpDatabase {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: D1HttpConfig) {
    if (!ID.test(config.accountId)) throw new D1HttpError('D1 HTTP: account id is not an id');
    if (!ID.test(config.databaseId)) throw new D1HttpError('D1 HTTP: database id is not an id');
    if (config.apiToken.length === 0) throw new D1HttpError('D1 HTTP: API token is empty');
    this.url = `${config.apiBase ?? DEFAULT_API}/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  prepare(sql: string): HttpStatement {
    return new HttpStatement(this, sql);
  }

  async batch(statements: readonly HttpStatement[]): Promise<{ results: unknown[]; success: true; meta: Record<string, unknown> }[]> {
    if (statements.length === 0) return [];
    const results = await this.send({
      batch: statements.map((s) => ({ sql: s.sql, params: s.params })),
    });
    if (results.length !== statements.length) {
      throw new D1HttpError(
        `D1 HTTP: batch of ${statements.length} returned ${results.length} results`,
      );
    }
    return results.map((r) => ({ results: r.results ?? [], success: true, meta: r.meta ?? {} }));
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const results = await this.send({ sql });
    return { count: results.length, duration: 0 };
  }

  /** @internal One request; throws on any HTTP, API or per-statement failure. */
  async send(body: unknown): Promise<D1HttpResult[]> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // The request may or may not have reached the API; say so.
      throw new D1HttpError(`D1 HTTP: request failed with no answer: ${(err as Error)?.message ?? String(err)}`);
    }
    let payload: { success?: boolean; errors?: { message?: string }[]; result?: D1HttpResult[] };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new D1HttpError(`D1 HTTP: status ${res.status} with a body that is not JSON`, res.status);
    }
    if (!res.ok || payload.success !== true) {
      const messages = (payload.errors ?? []).map((e) => e.message).filter(Boolean).join('; ');
      throw new D1HttpError(`D1 HTTP: status ${res.status}: ${messages || 'no error message'}`, res.status);
    }
    const results = payload.result ?? [];
    const failed = results.findIndex((r) => r.success === false);
    if (failed !== -1) throw new D1HttpError(`D1 HTTP: statement ${failed + 1} failed`, res.status);
    return results;
  }
}

/** The adapter, typed as the binding the passes are written against. */
export function createD1HttpDatabase(config: D1HttpConfig): D1Database {
  return new D1HttpDatabase(config) as unknown as D1Database;
}
