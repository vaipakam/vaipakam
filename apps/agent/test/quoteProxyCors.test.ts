import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle0xQuote, handle1inchQuote } from '../src/quoteProxy';
import type { Env } from '../src/env';

// The proxies echo the origin the index resolved for THIS request, not the
// first `FRONTEND_ORIGIN` entry: a browser rejects any other value, so an
// app served from the second allowed origin could not read a quote (#2471).
const env = { FRONTEND_ORIGIN: 'https://a.example,https://b.example' } as unknown as Env;
const post = (body: unknown) =>
  new Request('https://agent.example/quote/0x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://b.example' },
    body: JSON.stringify(body),
  });

describe('quote proxy CORS', () => {
  it('echoes the resolved origin on error responses from both proxies', async () => {
    for (const handle of [handle0xQuote, handle1inchQuote]) {
      const res = await handle(post({}), env, 'https://b.example');
      expect(res.status).toBe(400);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
    }
  });
});

describe('0x quote proxy', () => {
  afterEach(() => vi.unstubAllGlobals());
  const body = {
    chainId: 8453,
    sellToken: '0x' + '1'.repeat(40),
    buyToken: '0x' + '2'.repeat(40),
    sellAmount: '1000',
    taker: '0x' + '3'.repeat(40),
  };
  const keyed = { ...env, ZEROEX_API_KEY: 'k' } as unknown as Env;

  it('forwards txOrigin when the app names the submitting wallet', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response('{}', { status: 200 });
    });
    const txOrigin = '0x' + '4'.repeat(40);
    await handle0xQuote(post({ ...body, txOrigin }), keyed, 'https://b.example');
    expect(new URL(seen[0]).searchParams.get('txOrigin')).toBe(txOrigin);
  });

  it('refuses a malformed txOrigin', async () => {
    const res = await handle0xQuote(post({ ...body, txOrigin: 'nope' }), keyed, 'https://b.example');
    expect(res.status).toBe(400);
  });
});
