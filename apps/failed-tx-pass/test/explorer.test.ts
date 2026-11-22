import { describe, expect, it } from 'vitest';
import { ExplorerFailure, keyPacer, txlistExplorer, RATE_LIMIT_RETRIES } from '../src/explorer';

/** A fake clock the pacer's sleeps advance, so pacing is measured without waiting. */
function fakeTime() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    clock: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = { status: '0', message: 'No transactions found', result: [] };
const limited = { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' };

describe('explorer pacing and rate limits', () => {
  it('spaces requests made with one key, across networks, at least the gap apart', async () => {
    // Real time with a short gap: the gap is between the moments each request is sent.
    const GAP = 60;
    const pacer = keyPacer(GAP, (ms) => new Promise((r) => setTimeout(r, ms)));
    const sentAt: Array<[string, number]> = [];
    const fetchFor = (tag: string) => (async () => {
      sentAt.push([tag, performance.now()]);
      return json(empty);
    }) as unknown as typeof fetch;
    const mk = (key: string, chainId: number, tag: string) =>
      txlistExplorer({ apiBase: 'https://x.test/api', apiKey: key, chainId, fetch: fetchFor(tag), pacer });
    const a = mk('K', 1, 'a');
    const b = mk('K', 2, 'b');
    const c = mk('OTHER', 3, 'c');
    await Promise.all([a.failedSentTo('0x1', 1, 2), b.failedSentTo('0x1', 1, 2), a.failedSentTo('0x2', 1, 2), c.failedSentTo('0x1', 1, 2)]);
    const sameKey = sentAt.filter(([t]) => t !== 'c').map(([, at]) => at);
    expect(sameKey).toHaveLength(3);
    for (let i = 1; i < sameKey.length; i++) expect(sameKey[i]! - sameKey[i - 1]!).toBeGreaterThanOrEqual(GAP - 5);
    // Another key is not held behind this one.
    const cAt = sentAt.find(([t]) => t === 'c')![1];
    expect(cAt - sameKey[0]!).toBeLessThan(GAP);
  });

  it('retries a rate-limited request within the run, with growing waits, then answers', async () => {
    const time = fakeTime();
    let calls = 0;
    const f = (async () => (++calls <= 2 ? json(limited) : json({ status: '1', message: 'OK', result: [{ hash: '0xAB', blockNumber: '5', isError: '1', txreceipt_status: '0' }] }))) as unknown as typeof fetch;
    const ex = txlistExplorer({ apiBase: 'https://x.test/api', apiKey: 'K', chainId: 1, fetch: f, pacer: keyPacer(0, time.sleep, time.clock), sleep: time.sleep });
    expect(await ex.failedSentTo('0x1', 1, 9)).toEqual([{ hash: '0xab', blockNumber: 5 }]);
    expect(calls).toBe(3);
    expect(time.slept).toEqual([1000, 2000]);
  });

  it('holds (a transient failure) once the retries are spent, and never retries a non-rate-limit refusal', async () => {
    const time = fakeTime();
    let calls = 0;
    const f429 = (async () => (calls++, json({}, 429))) as unknown as typeof fetch;
    const ex = txlistExplorer({ apiBase: 'https://x.test/api', apiKey: 'K', chainId: 1, fetch: f429, pacer: keyPacer(0, time.sleep, time.clock), sleep: time.sleep });
    const e = await ex.failedSentTo('0x1', 1, 9).catch((x) => x);
    expect(e).toBeInstanceOf(ExplorerFailure);
    expect((e as ExplorerFailure).kind).toBe('transient');
    expect(calls).toBe(RATE_LIMIT_RETRIES + 1);

    calls = 0;
    const fBad = (async () => (calls++, json({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }))) as unknown as typeof fetch;
    const ex2 = txlistExplorer({ apiBase: 'https://x.test/api', apiKey: 'K', chainId: 1, fetch: fBad, pacer: keyPacer(0, time.sleep, time.clock), sleep: time.sleep });
    const e2 = await ex2.failedSentTo('0x1', 1, 9).catch((x) => x);
    expect((e2 as ExplorerFailure).kind).toBe('unreadable');
    expect(calls).toBe(1);
  });
});
