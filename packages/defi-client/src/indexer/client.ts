const TIMEOUT_MS = 4_000;

export class IndexerRequestError extends Error {
  readonly status: number | null;
  readonly path: string;

  constructor(message: string, opts: { status?: number | null; path: string }) {
    super(message);
    this.name = 'IndexerRequestError';
    this.status = opts.status ?? null;
    this.path = opts.path;
  }
}

export function indexerOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  return origin.replace(/\/$/, '');
}

async function getJson<T>(root: string, path: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(root + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new IndexerRequestError(`Indexer request failed (${res.status})`, {
        status: res.status,
        path,
      });
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof IndexerRequestError) throw err;
    const detail = err instanceof Error ? err.message : 'unknown error';
    throw new IndexerRequestError(`Indexer request failed: ${detail}`, { path });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchIndexerJson<T>(
  origin: string | undefined,
  path: string,
): Promise<T | null> {
  const root = indexerOrigin(origin);
  if (!root) return null;
  return getJson<T>(root, path);
}