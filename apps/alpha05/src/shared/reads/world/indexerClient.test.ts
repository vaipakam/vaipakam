import { describe, expect, it } from 'vitest';
import { REQUEST_REF_HEADER, isRequestReference } from '@vaipakam/lib/requestReference';
import { createIndexerClient, IndexerUnavailable } from './indexerClient';

describe('postJson (OFF-59)', () => {
  it('posts JSON and returns the status with the parsed body, a refusal included', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ error: 'bad-signature' }), { status: 400 });
    }) as unknown as typeof fetch;
    const c = createIndexerClient('https://index.test', fake);
    const res = await c.postJson('/signed-offers', { a: 1 });
    expect(res).toMatchObject({ status: 400, body: { error: 'bad-signature' } });
    expect(seen[0]!.url).toBe('https://index.test/signed-offers');
    // #3922 — the write carries a fresh reference, and an answer that does not
    // name one is quoted by the one sent.
    const sent = (seen[0]!.init.headers as Record<string, string>)[REQUEST_REF_HEADER];
    expect(isRequestReference(sent)).toBe(true);
    expect(res.reference).toBe(sent);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.body).toBe('{"a":1}');
  });

  it('reads a body that is not JSON as null, and throws only when nothing answered', async () => {
    const text = (async () => new Response('oops', { status: 502 })) as unknown as typeof fetch;
    expect(await createIndexerClient('https://index.test', text).postJson('/x', {})).toMatchObject({ status: 502, body: null });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(createIndexerClient('https://index.test', down).postJson('/x', {})).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(createIndexerClient(null).postJson('/x', {})).rejects.toMatchObject({ why: 'not-configured', reference: null });
  });

  it('keeps the reference the book answered with, and the one sent when nothing answered (#3922)', async () => {
    const named = (async () => new Response('{}', { status: 503, headers: { [REQUEST_REF_HEADER]: 'ABCDEFGH23' } })) as unknown as typeof fetch;
    expect((await createIndexerClient('https://index.test', named).postJson('/x', {})).reference).toBe('ABCDEFGH23');
    let sent = '';
    const down = (async (_url: string, init: RequestInit) => {
      sent = (init.headers as Record<string, string>)[REQUEST_REF_HEADER]!;
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const err = await createIndexerClient('https://index.test', down)
      .postJson('/x', {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexerUnavailable);
    expect((err as IndexerUnavailable).reference).toBe(sent);
    expect(isRequestReference(sent)).toBe(true);
  });
});

describe('getJson refusals', () => {
  const answering = (body: string, status: number) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const thrown = async (f: typeof fetch) => {
    try {
      await createIndexerClient('https://i', f).getJson('/x');
    } catch (e) {
      return e as IndexerUnavailable;
    }
    throw new Error('did not throw');
  };
  it('keeps the error code a route named, so a stated refusal is told from a missing route', async () => {
    const named = await thrown(answering(JSON.stringify({ error: 'no-vault' }), 404));
    expect([named.status, named.code]).toEqual([404, 'no-vault']);
    const bare = await thrown(answering('Not found', 404));
    expect([bare.status, bare.code]).toEqual([404, null]);
  });
});
