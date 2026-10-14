/**
 * A D1 database reached over Cloudflare's HTTP API, presenting the subset of
 * the Workers `D1Database` binding the keeper's passes use: `prepare`,
 * `bind`, `first`, `all`, `run` and `batch`.
 *
 * Why HTTP: off Workers there is no binding, and the keeper reads tables the
 * indexer and agent own, so it stays on the shared database rather than a
 * local copy (docs/DesignsAndPlans/KeeperHostPortability.md).
 *
 * Verified against the live API (2026-10-14, read-only): `{sql, params}`
 * runs one statement with positional parameters; `{batch: [{sql, params}…]}`
 * runs several and returns one result set each. Whether a REST batch is
 * ATOMIC like the binding's is an open check in the design document — it is
 * not assumed here, and nothing here makes it so.
 *
 * Errors throw, as the binding's do. There is no retry: every pass already
 * treats a failed read as "try again next tick".
 */

/** What a statement can be bound to — the binding's accepted value types. */
export type D1Value = string | number | boolean | null | ArrayBuffer;

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  /** A Cloudflare API token with D1 access to this database. */
  apiToken: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
}

interface ApiResult {
  results?: Record<string, unknown>[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

interface ApiEnvelope {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result?: ApiResult[];
}

/** The binding converts booleans to 1/0; the JSON body must do it explicitly. */
function wireValue(v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') {
    // The binding refuses a bigint too; say so rather than send a lossy number.
    throw new TypeError('D1 cannot bind a bigint — convert it to a string or a safe number first');
  }
  if (v instanceof ArrayBuffer) return Array.from(new Uint8Array(v));
  return v ?? null;
}

export class D1HttpDatabase {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: D1HttpConfig) {
    for (const k of ['accountId', 'databaseId', 'apiToken'] as const) {
      if (!cfg[k]) throw new Error(`D1HttpDatabase: ${k} is required`);
    }
    this.url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
    this.fetchFn = cfg.fetchFn ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  prepare(sql: string): D1HttpStatement {
    return new D1HttpStatement(this, sql, []);
  }

  /** Several statements in ONE request; one result per statement, in order. */
  async batch(statements: D1HttpStatement[]): Promise<D1HttpResult[]> {
    const out = await this.request({
      batch: statements.map((s) => ({ sql: s.sql, params: s.params.map(wireValue) })),
    });
    if (out.length !== statements.length) {
      throw new Error(`D1 batch returned ${out.length} result(s) for ${statements.length} statement(s)`);
    }
    return out.map(toResult);
  }

  /** @internal */
  async request(body: unknown): Promise<ApiResult[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let env: ApiEnvelope;
    try {
      env = (await res.json()) as ApiEnvelope;
    } catch {
      throw new Error(`D1 HTTP ${res.status}: the response was not JSON`);
    }
    if (!res.ok || !env.success) {
      const why = (env.errors ?? []).map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
      // The token never appears in an error: only the API's own messages do.
      throw new Error(`D1 query failed: ${why}`);
    }
    return env.result ?? [];
  }
}

export interface D1HttpResult<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; [k: string]: unknown };
}

function toResult(r: ApiResult): D1HttpResult {
  const meta = r.meta ?? {};
  return {
    results: r.results ?? [],
    success: true,
    meta: {
      ...meta,
      changes: Number(meta.changes ?? 0),
      last_row_id: Number(meta.last_row_id ?? 0),
    },
  };
}

export class D1HttpStatement {
  constructor(
    private readonly db: D1HttpDatabase,
    readonly sql: string,
    readonly params: unknown[],
  ) {}

  /** Returns a NEW statement, as the binding does. */
  bind(...values: unknown[]): D1HttpStatement {
    return new D1HttpStatement(this.db, this.sql, values);
  }

  private async one(): Promise<D1HttpResult> {
    const out = await this.db.request({ sql: this.sql, params: this.params.map(wireValue) });
    // A single statement returns one result set; a trailing empty one (from a
    // terminating `;`) is ignored, as the binding ignores it.
    return toResult(out[0] ?? {});
  }

  async all<T = Record<string, unknown>>(): Promise<D1HttpResult<T>> {
    return (await this.one()) as D1HttpResult<T>;
  }

  async run(): Promise<D1HttpResult> {
    return this.one();
  }

  /** The first row, or one column of it; `null` when there is no row. */
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.one()).results[0];
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: column '${column}' is not in the result`);
    return row[column] as T;
  }
}
