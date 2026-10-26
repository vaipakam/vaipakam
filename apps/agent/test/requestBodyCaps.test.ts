/**
 * #2756 — a public endpoint does bounded work before it does expensive work.
 *
 * Two halves: every request body is read only up to a cap (through
 * `@vaipakam/lib/requestBody`, pinned tree-wide in
 * packages/lib/src/publicEndpointRules.test.ts), and a handler gives the
 * answers that cost nothing before it spends an RPC call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { handle1inchQuote, MAX_QUOTE_BODY_BYTES } from '../src/quoteProxy';
import { handleIntentFusionPost } from '../src/intentFusionPost';
import type { Env } from '../src/env';

const ORIGIN = 'https://b.example';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capped request bodies', () => {
  const env = { FRONTEND_ORIGIN: ORIGIN, ONEINCH_API_KEY: 'k' } as unknown as Env;
  const post = (body: string) =>
    new Request('https://agent.example/quote/1inch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body,
    });

  it('refuses a body over the cap with 413 body-too-large, readable by the app', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await handle1inchQuote(post('x'.repeat(MAX_QUOTE_BODY_BYTES + 1)), env, ORIGIN);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'body-too-large' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names malformed JSON with the shared 400 invalid-json', async () => {
    const res = await handle1inchQuote(post('{not json'), env, ORIGIN);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid-json' });
  });
});

describe('Fusion post answers the zero-cost cases before any RPC', () => {
  // Base Sepolia has a deployment and is not a Fusion chain, so the post
  // reaches the unsupported-chain answer with a key and an RPC both held.
  const CHAIN = 84532;
  const diamond = getDeployment(CHAIN)?.diamond as `0x${string}` | undefined;

  it('queues an unsupported chain without touching the RPC', async () => {
    expect(diamond).toBeDefined();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = {
      FRONTEND_ORIGIN: ORIGIN,
      ONEINCH_API_KEY: 'k',
      RPC_BASE_SEPOLIA: 'https://rpc.example',
    } as unknown as Env;
    const body = {
      chainId: CHAIN,
      kind: 'buyback',
      orderHash: `0x${'11'.repeat(32)}`,
      commitTxHash: `0x${'22'.repeat(32)}`,
      order: {
        maker: diamond,
        receiver: diamond,
        makerAsset: `0x${'33'.repeat(20)}`,
        takerAsset: `0x${'44'.repeat(20)}`,
        extension: `0x${'55'.repeat(72)}`,
        makerAmount: '1',
        takerAmount: '1',
        salt: '1',
        makerTraits: '0',
        deadline: 1_900_000_000,
      },
    };
    const res = await handleIntentFusionPost(
      new Request('https://agent.example/intent/fusion/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify(body),
      }),
      env,
      ORIGIN,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'queued' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
