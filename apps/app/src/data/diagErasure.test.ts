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
import { buildErasureMessage } from '@vaipakam/lib/erasureMessage';
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
    const outcome = await requestDiagErasure(WALLET, async (message) => {
      signed = message;
      return SIG;
    });
    expect(outcome).toBe('processed');
    expect(calls[0]!.path).toBe('/diag/erasure');
    const body = calls[0]!.body;
    // The message the wallet was shown is byte-identical to what the
    // Worker will reconstruct from the body it received.
    expect(signed).toBe(buildErasureMessage(WALLET, body.issuedAt as number));
    expect(body.wallet).toBe(WALLET);
    expect(body.signature).toBe(SIG);
  });

  it('rejects a malformed 2xx — only the service’s own payload confirms', async () => {
    // #2008 round 1 P1: a 204, or a fallback page from an
    // intermediary, is not the erasure handler's acknowledgement —
    // reporting it as processed would falsely confirm a legal-right
    // request the service never saw.
    stubAgent(() => new Response(null, { status: 204 }));
    expect(await requestDiagErasure(WALLET, async () => SIG)).toBe('error');
    stubAgent(() => new Response('<html>gateway</html>', { status: 200 }));
    expect(await requestDiagErasure(WALLET, async () => SIG)).toBe('error');
  });

  it('maps the unconfigured-service 503 to its own honest outcome', async () => {
    stubAgent(
      () =>
        new Response(JSON.stringify({ error: 'erasure_not_configured' }), {
          status: 503,
        }),
    );
    expect(await requestDiagErasure(WALLET, async () => SIG)).toBe('unavailable');
  });

  it('maps any other failure to error', async () => {
    stubAgent(() => new Response('{}', { status: 500 }));
    expect(await requestDiagErasure(WALLET, async () => SIG)).toBe('error');
  });
});

describe('requestDiagErasureStatus', () => {
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
