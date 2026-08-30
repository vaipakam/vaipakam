/**
 * The signed diagnostics-erasure client (#2002).
 *
 * Two properties carry the feature: the SIGNED MESSAGE must be the
 * canonical `@vaipakam/lib` bytes (the Worker reconstructs them to
 * recover the signer — a drifted character rejects every request),
 * and the client must surface exactly the distinctions the service
 * makes and NO others — the uniform `processed` is never decorated
 * into claims about what was deleted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildErasureMessage,
  buildErasureStatusMessage,
} from '@vaipakam/lib/erasureMessage';
import {
  requestDiagErasure,
  requestDiagErasureStatus,
} from './diagErasure';

const WALLET = '0x1DAefA360ED370285f003Fa2d92DB75628088282' as const;
const SIG = `0x${'ab'.repeat(65)}`;

function stubAgent(responder: (path: string) => Response) {
  vi.stubEnv('VITE_AGENT_ORIGIN', 'https://agent.test');
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return responder(path);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('requestDiagErasure', () => {
  it('signs the CANONICAL message and posts wallet/issuedAt/signature', async () => {
    const calls = stubAgent(
      () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
    );
    let signed = '';
    const res = await requestDiagErasure(WALLET, async (message) => {
      signed = message;
      return SIG;
    });
    expect(res.outcome).toBe('processed');
    expect(calls[0]!.path).toBe('/diag/erasure');
    const body = calls[0]!.body;
    // The message the wallet was shown is byte-identical to what the
    // Worker will reconstruct from the body it received.
    expect(signed).toBe(buildErasureMessage(WALLET, body.issuedAt as number));
    expect(body.wallet).toBe(WALLET);
    expect(body.signature).toBe(SIG);
  });

  it('maps a chain-scoped processed response to its own honest outcome (#2013 r5)', async () => {
    // A chain-verified smart-account signature authorizes ONE chain,
    // and the service says so with `scope: 'chain'` — the client must
    // surface that as the scoped confirmation, never the wallet-wide
    // one. A missing/other scope stays the uniform wallet answer.
    stubAgent(
      () =>
        new Response(
          JSON.stringify({ status: 'processed', scope: 'chain', chainId: 84532 }),
          { status: 200 },
        ),
    );
    // The confirming chain is the SERVICE's echo (#2013 r6) — the
    // banner names it, so the confirmation stays true even after the
    // wallet switches networks.
    expect(await requestDiagErasure(WALLET, async () => SIG)).toEqual({
      outcome: 'processedChainOnly',
      chainId: 84532,
    });
    // A chain-scoped answer that names no usable chain still reports
    // the honest scope — with a null chain for the nameless banner.
    stubAgent(
      () =>
        new Response(JSON.stringify({ status: 'processed', scope: 'chain' }), {
          status: 200,
        }),
    );
    expect(await requestDiagErasure(WALLET, async () => SIG)).toEqual({
      outcome: 'processedChainOnly',
      chainId: null,
    });
    stubAgent(
      () =>
        new Response(JSON.stringify({ status: 'processed', scope: 'wallet' }), {
          status: 200,
        }),
    );
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('processed');
  });

  it('rejects a malformed 2xx — only the service’s own payload confirms', async () => {
    // #2008 round 1 P1: a 204, or a fallback page from an
    // intermediary, is not the erasure handler's acknowledgement —
    // reporting it as processed would falsely confirm a legal-right
    // request the service never saw.
    stubAgent(() => new Response(null, { status: 204 }));
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('error');
    stubAgent(() => new Response('<html>gateway</html>', { status: 200 }));
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('error');
  });

  it('maps the unconfigured-service 503 to its own honest outcome', async () => {
    stubAgent(
      () =>
        new Response(JSON.stringify({ error: 'erasure_not_configured' }), {
          status: 503,
        }),
    );
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('unavailable');
  });

  it('maps any other failure to error', async () => {
    stubAgent(() => new Response('{}', { status: 500 }));
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('error');
  });

  it('reports EXPIRED — and sends nothing — when approval outlives the window', async () => {
    // #2008 round 3 P2: the wallet prompt is unbounded and `issuedAt`
    // starts aging when it opens. A signature approved after the
    // service's replay window can only be rejected as stale, so it is
    // never sent, and the user gets an outcome they can act on.
    vi.useFakeTimers();
    try {
      const calls = stubAgent(
        () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
      );
      const res = await requestDiagErasure(WALLET, async () => {
        // The user takes eleven minutes to approve.
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        return SIG;
      });
      expect(res.outcome).toBe('expired');
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds back a signature with no transport margin left (#2008 round 4 P2)', async () => {
    // Approved INSIDE the ten-minute window, but so close to its end
    // that the request cannot reach the Worker's clock before the
    // window closes there. Sending it can only produce a stale
    // rejection — so it is not sent.
    vi.useFakeTimers();
    try {
      const calls = stubAgent(
        () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
      );
      const res = await requestDiagErasure(WALLET, async () => {
        // 9m45s: 15 seconds of nominal validity left — less than the
        // reserved margin.
        vi.setSystemTime(Date.now() + (9 * 60 + 45) * 1000);
        return SIG;
      });
      expect(res.outcome).toBe('expired');
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the wallet chain as an UNSIGNED verification hint (#2009)', async () => {
    // The frozen message has no chain field; the connected chain
    // rides in the body so the service knows where a smart account's
    // contract lives for ERC-1271 verification. Omitted when the
    // wallet reports none.
    let calls = stubAgent(
      () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
    );
    await requestDiagErasure(WALLET, async () => SIG, 84532);
    expect(calls[0]!.body.chainId).toBe(84532);
    calls = stubAgent(
      () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
    );
    await requestDiagErasure(WALLET, async () => SIG);
    expect('chainId' in calls[0]!.body).toBe(false);
  });

  it('maps the service’s cannot-verify 503 to unverifiable — not invalid, not generic (#2009)', async () => {
    stubAgent(
      () =>
        new Response(
          JSON.stringify({
            error: 'verification_failed',
            reason: 'signature verification temporarily unavailable',
          }),
          { status: 503 },
        ),
    );
    expect((await requestDiagErasure(WALLET, async () => SIG, 84532)).outcome).toBe(
      'unverifiable',
    );
    expect(await requestDiagErasureStatus(WALLET, async () => SIG, 84532)).toEqual({
      status: 'unverifiable',
    });
  });

  it('maps the WORKER’s stale rejection to expired — skew no margin can cover', async () => {
    // A skewed local clock stamps an `issuedAt` the Worker's clock
    // already considers stale; the pre-send check here sees nothing
    // wrong. The service's own rejection body is the honest signal,
    // and it means "try again", not "something failed".
    stubAgent(
      () =>
        new Response(
          JSON.stringify({
            error: 'verification_failed',
            reason: 'request timestamp is stale',
          }),
          { status: 400 },
        ),
    );
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('expired');
    expect(await requestDiagErasureStatus(WALLET, async () => SIG)).toEqual({
      status: 'expired',
    });
    // Any OTHER verification failure stays the generic error — a bad
    // signature is not a retryable expiry.
    stubAgent(
      () =>
        new Response(
          JSON.stringify({
            error: 'verification_failed',
            reason: 'signature does not match wallet',
          }),
          { status: 400 },
        ),
    );
    expect((await requestDiagErasure(WALLET, async () => SIG)).outcome).toBe('error');
  });
});

describe('requestDiagErasureStatus', () => {
  it('signs the STATUS message — never the erasure capability (#2008 round 2 P1)', () => {
    // A user who asks only to LOOK must not sign bytes that could be
    // replayed as authority to DELETE: the two operations sign
    // different frozen messages, verified per endpoint.
    const calls = stubAgent(
      () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
    );
    let signed = '';
    return requestDiagErasureStatus(WALLET, async (message) => {
      signed = message;
      return SIG;
    }).then(() => {
      const body = calls[0]!.body;
      expect(signed).toBe(buildErasureStatusMessage(WALLET, body.issuedAt as number));
      expect(signed).not.toBe(buildErasureMessage(WALLET, body.issuedAt as number));
    });
  });

  it('passes the operator-disclosed retention note through, verbatim', async () => {
    stubAgent(
      () =>
        new Response(
          JSON.stringify({ status: 'retained_by_law', note: 'kept by court order' }),
          { status: 200 },
        ),
    );
    expect(await requestDiagErasureStatus(WALLET, async () => SIG)).toEqual({
      status: 'retained_by_law',
      note: 'kept by court order',
    });
  });

  it('reports the uniform answer as processed — never a finer claim', async () => {
    // A gagged hold and no hold at all arrive as the SAME payload by
    // the service's design; the client must not invent a distinction.
    stubAgent(
      () => new Response(JSON.stringify({ status: 'processed' }), { status: 200 }),
    );
    expect(await requestDiagErasureStatus(WALLET, async () => SIG)).toEqual({
      status: 'processed',
    });
  });

  it('an unknown 2xx body is a failure, not a green light', async () => {
    stubAgent(() => new Response('{}', { status: 200 }));
    expect(await requestDiagErasureStatus(WALLET, async () => SIG)).toEqual({
      status: 'error',
    });
  });

  it('never fires a request when the backend is not configured', async () => {
    // The dev .env.local sets a real agent origin for the whole test
    // process — stub it EMPTY so this test exercises the unconfigured
    // build rather than the developer's environment.
    vi.stubEnv('VITE_AGENT_ORIGIN', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(requestDiagErasureStatus(WALLET, async () => SIG)).rejects.toThrow(
      'not configured',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
