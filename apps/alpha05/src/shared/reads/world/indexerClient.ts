/**
 * The world rail's transport (RB-RAILS): one client per build for the
 * indexer Worker, created from `indexerOrigin` so there is one place a
 * route is appended. A build with no indexer origin has a client that
 * refuses every call with a stated reason, so a world surface renders a
 * degraded-source warning and never a confident empty list (RB-FUNDS).
 */
export type IndexerFailure = 'not-configured' | 'network' | 'status' | 'shape';

export class IndexerUnavailable extends Error {
  readonly why: IndexerFailure;
  constructor(why: IndexerFailure, message: string) {
    super(message);
    this.name = 'IndexerUnavailable';
    this.why = why;
  }
}

export interface IndexerClient {
  /** The origin every route is appended to; `null` when this build has none. */
  readonly origin: string | null;
  /** A JSON GET of `path` (which starts with `/`). Throws {@link IndexerUnavailable}
   *  on every failure, naming which kind, so a caller states it. */
  getJson<T>(path: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
}

/** The indexer's one write the app makes: a JSON POST whose answer the
 *  caller reads by status (a refusal is an answer, not a failure). Kept
 *  apart from {@link IndexerClient} so a reader cannot write. */
export interface IndexerPoster {
  readonly origin: string | null;
  /** POST `body` as JSON to `path`. Returns the status and the parsed body
   *  (null when it was not JSON); throws {@link IndexerUnavailable} only when
   *  there is no origin or no answer at all. */
  postJson(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<{ status: number; body: unknown }>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export function createIndexerClient(origin: string | null, fetchImpl: typeof fetch = fetch): IndexerClient & IndexerPoster {
  return {
    origin,
    async getJson<T>(path: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
      if (origin === null) throw new IndexerUnavailable('not-configured', 'This build has no indexer origin.');
      if (!path.startsWith('/')) throw new Error(`indexer path must start with "/": ${path}`);
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetchImpl(`${origin}${path}`, { signal, headers: { accept: 'application/json' } });
      } catch (e) {
        throw new IndexerUnavailable('network', `The indexer did not answer: ${(e as Error).message}`);
      }
      if (!res.ok) throw new IndexerUnavailable('status', `The indexer answered ${res.status} for ${path}.`);
      try {
        return (await res.json()) as T;
      } catch {
        throw new IndexerUnavailable('shape', `The indexer's answer for ${path} was not JSON.`);
      }
    },
    async postJson(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
      if (origin === null) throw new IndexerUnavailable('not-configured', 'This build has no indexer origin.');
      if (!path.startsWith('/')) throw new Error(`indexer path must start with "/": ${path}`);
      let res: Response;
      try {
        res = await fetchImpl(`${origin}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        throw new IndexerUnavailable('network', `The indexer did not answer: ${(e as Error).message}`);
      }
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    },
  };
}
