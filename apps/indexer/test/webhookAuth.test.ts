/**
 * #757 Phase A — unit coverage for the `/hooks/chain-event` security
 * boundary (webhookAuth.ts). These helpers were written pure exactly
 * so this file could exist; until now the path shipped with zero
 * automated tests. Everything here runs in plain node — Web Crypto is
 * global in Node 20+.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_WEBHOOK_BODY,
  WebhookBodyTooLargeError,
  parseChainEventPayload,
  readCappedBody,
  sha256Hex,
  verifyAlchemySignature,
} from '../src/webhookAuth';

/** Compute a valid Alchemy-style signature (HMAC-SHA256, hex) the way
 *  the provider does, so the verify path is tested against the real
 *  algorithm rather than a fixture that could drift. */
async function sign(body: string, key: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('verifyAlchemySignature', () => {
  const body = '{"id":"whevt_1","event":{"network":"BASE_SEPOLIA"}}';
  const key = 'whsec_test_signing_key';

  it('accepts a genuine HMAC-SHA256 hex signature', async () => {
    expect(await verifyAlchemySignature(body, await sign(body, key), key)).toBe(true);
  });

  it('rejects a signature made with a different key', async () => {
    const sig = await sign(body, 'some-other-key');
    expect(await verifyAlchemySignature(body, sig, key)).toBe(false);
  });

  it('rejects when the body was tampered with after signing', async () => {
    const sig = await sign(body, key);
    expect(await verifyAlchemySignature(body + ' ', sig, key)).toBe(false);
  });

  it('fails closed on a missing/empty signing key', async () => {
    const sig = await sign(body, key);
    expect(await verifyAlchemySignature(body, sig, undefined)).toBe(false);
    expect(await verifyAlchemySignature(body, sig, '')).toBe(false);
  });

  it('fails closed on a missing or malformed signature header', async () => {
    expect(await verifyAlchemySignature(body, null, key)).toBe(false);
    expect(await verifyAlchemySignature(body, 'not-hex-at-all', key)).toBe(false);
    expect(await verifyAlchemySignature(body, 'abc', key)).toBe(false); // odd length
  });
});

describe('readCappedBody', () => {
  it('returns a small body unchanged', async () => {
    const req = new Request('http://localhost/', { method: 'POST', body: 'hello' });
    expect(await readCappedBody(req)).toBe('hello');
  });

  it('rejects via Content-Length before reading the stream', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      body: 'tiny',
      headers: { 'content-length': String(MAX_WEBHOOK_BODY + 1) },
    });
    await expect(readCappedBody(req)).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
  });

  it('rejects an oversized stream even without a Content-Length hint', async () => {
    const big = 'x'.repeat(MAX_WEBHOOK_BODY + 1024);
    const req = new Request('http://localhost/', {
      method: 'POST',
      // A ReadableStream carries no automatic content-length, so the
      // cap must trip on the streamed bytes themselves.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      // @ts-expect-error — duplex is required by undici for stream bodies
      duplex: 'half',
    });
    await expect(readCappedBody(req)).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
  });
});

describe('sha256Hex', () => {
  it('matches the well-known empty-string vector', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic and hex-shaped', async () => {
    const a = await sha256Hex('{"same":"payload"}');
    expect(a).toBe(await sha256Hex('{"same":"payload"}'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseChainEventPayload', () => {
  it('parses a Custom Webhook shape: provider id, network, block', () => {
    const parsed = parseChainEventPayload(
      JSON.stringify({
        id: 'whevt_abc123',
        event: {
          network: 'BASE_SEPOLIA',
          data: { block: { number: 43733286, logs: [] } },
        },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.providerId).toBe('whevt_abc123');
    expect(parsed!.chainId).toBe(84532);
    expect(parsed!.maxBlock).toBe(43733286n);
  });

  it('parses an Address Activity shape with hex blockNum, picking the MAX', () => {
    const parsed = parseChainEventPayload(
      JSON.stringify({
        id: 'whevt_act1',
        event: {
          network: 'ARB_SEPOLIA',
          activity: [{ blockNum: '0x2a' }, { blockNum: '0x30' }, { blockNum: '0x10' }],
        },
      }),
    );
    expect(parsed!.chainId).toBe(421614);
    expect(parsed!.maxBlock).toBe(0x30n);
  });

  it('degrades a block-less payload to maxBlock 0 (scan-to-safe-head hint)', () => {
    const parsed = parseChainEventPayload(
      JSON.stringify({ id: 'whevt_nb', event: { network: 'BASE_SEPOLIA' } }),
    );
    expect(parsed!.maxBlock).toBe(0n);
    expect(parsed!.chainId).toBe(84532);
  });

  it('maps an unknown network to chainId null (route 200-no-ops)', () => {
    const parsed = parseChainEventPayload(
      JSON.stringify({ id: 'x', event: { network: 'SOLANA_MAINNET' } }),
    );
    expect(parsed!.chainId).toBeNull();
  });

  it('returns null providerId for a missing/non-string id (dedupe falls back to body hash)', () => {
    expect(
      parseChainEventPayload(JSON.stringify({ event: { network: 'BASE_SEPOLIA' } }))!
        .providerId,
    ).toBeNull();
    expect(
      parseChainEventPayload(
        JSON.stringify({ id: 42, event: { network: 'BASE_SEPOLIA' } }),
      )!.providerId,
    ).toBeNull();
  });

  it('returns null for a non-JSON body', () => {
    expect(parseChainEventPayload('not json {')).toBeNull();
  });
});
