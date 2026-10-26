import { describe, expect, it } from 'vitest';
import { handle1inchQuote, handleQuoteReadiness } from '../src/quoteProxy';
import type { Env } from '../src/env';

// The proxies echo the origin the index resolved for THIS request, not the
// first `FRONTEND_ORIGIN` entry: a browser rejects any other value, so an
// app served from the second allowed origin could not read a quote (#2471).
const env = { FRONTEND_ORIGIN: 'https://a.example,https://b.example' } as unknown as Env;
const post = (body: unknown) =>
  new Request('https://agent.example/quote/1inch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://b.example' },
    body: JSON.stringify(body),
  });

describe('quote proxy CORS', () => {
  it('echoes the resolved origin on an error response', async () => {
    const res = await handle1inchQuote(post({}), env, 'https://b.example');
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
  });
});

describe('quote readiness', () => {
  it('reports whether the 1inch key is held, and nothing it does not serve (#2755)', async () => {
    const res = handleQuoteReadiness({ ...env, ONEINCH_API_KEY: 'k' } as unknown as Env, 'https://b.example');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://b.example');
    expect(await res.json()).toEqual({ oneinch: true });
  });
});
