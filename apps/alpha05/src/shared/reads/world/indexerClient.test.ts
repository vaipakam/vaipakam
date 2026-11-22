import { describe, expect, it } from 'vitest';
import { createIndexerClient, IndexerUnavailable } from './indexerClient';

describe('postJson (OFF-59)', () => {
  it('posts JSON and returns the status with the parsed body, a refusal included', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ error: 'bad-signature' }), { status: 400 });
    }) as unknown as typeof fetch;
    const c = createIndexerClient('https://index.test', fake);
    expect(await c.postJson('/signed-offers', { a: 1 })).toEqual({ status: 400, body: { error: 'bad-signature' } });
    expect(seen[0]!.url).toBe('https://index.test/signed-offers');
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.body).toBe('{"a":1}');
  });

  it('reads a body that is not JSON as null, and throws only when nothing answered', async () => {
    const text = (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch;
    expect(await createIndexerClient('https://index.test', text).postJson('/x', {})).toEqual({ status: 502, body: null });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(createIndexerClient('https://index.test', down).postJson('/x', {})).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(createIndexerClient(null).postJson('/x', {})).rejects.toMatchObject({ why: 'not-configured' });
  });
});
