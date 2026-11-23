/**
 * #2784 — every indexer read reports why it went unserved to a live-review
 * driver, while its callers still see only a value or `null`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson } from './indexer';
import { READ_PROBE_BINDING, type ReadProbeEvent } from '../lib/readProbe';

const ORIGIN = 'https://indexer.example';

function installDriver(): ReadProbeEvent[] {
  const events: ReadProbeEvent[] = [];
  vi.stubGlobal(READ_PROBE_BINDING, (e: ReadProbeEvent) => events.push(e));
  return events;
}

const settled = (events: ReadProbeEvent[]) => events.filter((e) => e.kind === 'indexer-settled');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('getJson reports each indexer read (#2784)', () => {
  it('returns the body and reports a served read', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', async () => new Response('{"n":1}', { status: 200 }));
    const events = installDriver();
    expect(await getJson('/loans/stats?chainId=84532')).toEqual({ n: 1 });
    expect(settled(events)).toEqual([expect.objectContaining({ ok: true, route: '/loans/stats?chainId=' })]);
  });

  it.each([
    ['http', async () => new Response('nope', { status: 503 }), 503],
    ['body', async () => new Response('<html>', { status: 200 }), undefined],
    ['network', async () => Promise.reject(new TypeError('Failed to fetch')), undefined],
  ] as const)('returns null and reports a %s failure', async (failure, answer, status) => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', answer);
    const events = installDriver();
    expect(await getJson('/activity?chainId=84532')).toBeNull();
    expect(settled(events)).toEqual([
      expect.objectContaining({ ok: false, failure, ...(status ? { status } : {}) }),
    ]);
  });

  it('reports a read that ran out of time as a timeout, not a network failure', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal(
      'fetch',
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    const events = installDriver();
    const read = getJson('/offers/markets?chainId=84532');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toBeNull();
    expect(settled(events)).toEqual([expect.objectContaining({ ok: false, failure: 'timeout' })]);
  });

  it('reports a build with no indexer origin as unconfigured, sending nothing', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const events = installDriver();
    expect(await getJson('/activity?chainId=84532')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(settled(events)).toEqual([expect.objectContaining({ ok: false, failure: 'unconfigured' })]);
  });
});

describe('getJson tells its caller the failed read\'s reference (#3922)', () => {
  const REF = '0123456789';
  const withRef = (status: number, body = 'nope') =>
    async () => new Response(body, { status, headers: { 'x-request-ref': REF } });

  it.each([
    ['an HTTP error', withRef(503)],
    ['a body that was not JSON', withRef(200, '<html>')],
  ] as const)('passes the reference of %s', async (_label, answer) => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', answer);
    const events = installDriver();
    const onFailure = vi.fn();
    expect(await getJson('/loans/7?chainId=84532', onFailure)).toBeNull();
    expect(onFailure).toHaveBeenCalledWith(REF);
    // The probe never carries the reference.
    expect(JSON.stringify(events)).not.toContain(REF);
  });

  it('passes null when the answer carried no valid reference', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', async () => new Response('x', { status: 500, headers: { 'x-request-ref': 'not-a-ref' } }));
    const onFailure = vi.fn();
    await getJson('/loans/7?chainId=84532', onFailure);
    expect(onFailure).toHaveBeenCalledWith(null);
  });

  it('passes null when nothing answered', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('Failed to fetch')));
    const onFailure = vi.fn();
    await getJson('/loans/7?chainId=84532', onFailure);
    expect(onFailure).toHaveBeenCalledWith(null);
  });

  it('reports nothing for a served read or a build with no indexer', async () => {
    const onFailure = vi.fn();
    vi.stubEnv('VITE_INDEXER_ORIGIN', ORIGIN);
    vi.stubGlobal('fetch', async () => new Response('{"n":1}', { status: 200 }));
    await getJson('/loans/7?chainId=84532', onFailure);
    vi.stubEnv('VITE_INDEXER_ORIGIN', '');
    await getJson('/loans/7?chainId=84532', onFailure);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
