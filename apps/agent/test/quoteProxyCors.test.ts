import { describe, expect, it } from 'vitest';
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
