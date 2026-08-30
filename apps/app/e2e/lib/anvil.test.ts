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
import {
  ForkProbeTimeoutError,
  assertForkUsable,
  childHasExited,
  isForkUnusableError,
} from './anvil';

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

  it('recognises the probe\u2019s OWN deadline, by class not by phrase', () => {
    // The timeout is its own class deliberately: "timed out" is far too
    // generic to sit in the message regex — a timed-out contract call or
    // a slow unrelated fetch would start being retried as a fork flake.
    expect(isForkUnusableError(new ForkProbeTimeoutError(30_000))).toBe(true);
    expect(isForkUnusableError(new Error('request timed out'))).toBe(false);
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

  it('is BOUNDED — a hanging upstream fails instead of hanging the run', async () => {
    // The probe is the only harness call that reaches THROUGH anvil to a
    // service we do not control, and it sits on the critical path of
    // every fork-tier run. Unbounded, an upstream outage would replace a
    // red run with a job that sits until Playwright kills it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    );
    const err = await assertForkUsable(25).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForkProbeTimeoutError);
    expect(isForkUnusableError(err)).toBe(true);
    expect(String(err)).toMatch(/25ms/);
  });
});

describe('childHasExited', () => {
  // Decides whether a PID is dropped from the teardown list. The
  // dangerous direction is claiming a LIVE child is dead — its PID
  // leaves the file, teardown never kills it, and the orphan squats the
  // port for every later run. The other mistake costs a stale signal
  // that lands on ESRCH.
  it('reports a running child as running', () => {
    expect(childHasExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it('reports an exited child, by code or by signal', () => {
    expect(childHasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(childHasExited({ exitCode: 1, signalCode: null })).toBe(true);
    expect(childHasExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true);
  });

  it('treats exit code 0 as exited — not as a falsy \u201cno code\u201d', () => {
    // The obvious `if (child.exitCode)` spelling reads a clean exit as
    // still-running, which is precisely the dangerous direction.
    expect(childHasExited({ exitCode: 0, signalCode: null })).toBe(true);
  });
});
