const TIMEOUT_MS = 4_000;

export function indexerOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  return origin.replace(/\/$/, '');
}

async function getJson<T>(root: string, path: string): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(root + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
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