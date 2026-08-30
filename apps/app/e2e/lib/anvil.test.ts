/**
 * The fork-usability probe and its error classifier (#1979).
 *
 * These are harness helpers, but the classifier decides whether a
 * failure is RETRIED AS A FLAKE or reported as a real failure — get it
 * wrong in the permissive direction and a genuine bug is laundered into
 * three silent retries and a confusing final message. That is exactly
 * the "driver logic worth trusting belongs here, not in a scratch file"
 * case `vitest.config.ts` describes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertForkUsable, isForkUnusableError } from './anvil';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isForkUnusableError', () => {
  it('recognises the errors the fork backend actually produced', () => {
    // Both verbatim from the #1979 failure: the anvil_setBalance RPC
    // error, and viem's wording for the same cause as seen by the
    // indexer stub moments earlier.
    expect(
      isForkUnusableError(
        new Error(
          'anvil_setBalance: failed to get account for 0xddD5698309507aD7AbB208d967fdD4a6409a1251: ' +
            'HTTP error 400 with body: {"error":{"message":"Unknown block","code":26}}',
        ),
      ),
    ).toBe(true);
    expect(isForkUnusableError(new Error('Block could not be found.'))).toBe(true);
    // A third upstream spelling of the same condition.
    expect(isForkUnusableError(new Error('header not found'))).toBe(true);
  });

  it('is case-insensitive and accepts non-Error values', () => {
    expect(isForkUnusableError(new Error('UNKNOWN BLOCK'))).toBe(true);
    expect(isForkUnusableError('unknown block')).toBe(true);
  });

  it('does NOT claim ordinary failures — a real bug must not become a flake', () => {
    // The permissive direction is the dangerous one: each of these is a
    // genuine failure that must surface, not be retried three times and
    // then reported as a degrading upstream.
    expect(isForkUnusableError(new Error('execution reverted'))).toBe(false);
    expect(isForkUnusableError(new Error('insufficient funds for gas'))).toBe(false);
    expect(isForkUnusableError(new Error('nonce too low'))).toBe(false);
    expect(isForkUnusableError(new Error('connect ECONNREFUSED 127.0.0.1:8545'))).toBe(
      false,
    );
    expect(isForkUnusableError(new Error('invalid opcode'))).toBe(false);
    expect(isForkUnusableError(undefined)).toBe(false);
  });
});

describe('assertForkUsable', () => {
  function stubRpc(respond: (method: string) => unknown) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        calls.push({ method: body.method, params: body.params });
        return new Response(JSON.stringify(respond(body.method)), { status: 200 });
      }),
    );
    return calls;
  }

  it('reads fork state — a call that must reach the upstream', () => {
    // The point of the probe: `eth_chainId` is served from anvil's own
    // config and proves nothing about the fork, so the probe has to be
    // a STATE read. Pinning the method keeps that property from being
    // quietly swapped for a cheaper call that stops testing anything.
    const calls = stubRpc(() => ({ result: '0x0' }));
    return assertForkUsable().then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('eth_getBalance');
      expect(calls[0]!.params[1]).toBe('latest');
    });
  });

  it('propagates the RPC error unchanged for the caller to classify', async () => {
    stubRpc(() => ({ error: { message: 'Unknown block' } }));
    await expect(assertForkUsable()).rejects.toThrow(/Unknown block/);
    // Round-trip: what the probe throws is what the classifier reads.
    await assertForkUsable().catch((e: unknown) => {
      expect(isForkUnusableError(e)).toBe(true);
    });
  });

  it('lets a NON-fork error through as itself', async () => {
    stubRpc(() => ({ error: { message: 'method not supported' } }));
    await assertForkUsable().catch((e: unknown) => {
      expect(isForkUnusableError(e)).toBe(false);
    });
  });
});
