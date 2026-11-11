/**
 * #3408 — the inclusion fallback of the private submission route: a send the
 * private route accepted, still unmined after the chain's stated time, goes to
 * the ordinary RPC as the same signed bytes, once, while its nonce window
 * lasts, and the operator is told.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { memoryPrivateSendRecords, PUBLIC_COPY_CUTOFF_MS, rebroadcastStalePrivateSends, type RebroadcastDeps } from '../src/privateRebroadcast';
import { PRIVATE_ROUTE_FLOOR_TTL_MS, readSubmissionRoutes } from '../src/submissionRoute';
import { lapsedSendAlertKey, publicFallbackAlertKey, publicFallbackAlertText } from '../src/privateRouteOps';

const ADDR = '0x00000000000000000000000000000000000000aa' as Address;
const H1 = `0x${'01'.repeat(32)}` as Hex;
const H2 = `0x${'02'.repeat(32)}` as Hex;
const RAW1 = '0xf1' as Hex;
const RAW2 = '0xf2' as Hex;
const ETH = [{ id: 1, name: 'Ethereum' }];
const FAR = Number.MAX_SAFE_INTEGER;
const fallbackRoutes = readSubmissionRoutes('1=https://rpc.example.org/', '1', '60');

function deps(over: Partial<RebroadcastDeps> & { mined?: number; t?: number } = {}) {
  const records = memoryPrivateSendRecords();
  const sent: Hex[] = [];
  const alerts: string[] = [];
  const d: RebroadcastDeps & { records: ReturnType<typeof memoryPrivateSendRecords> } = {
    records,
    minedCount: async () => over.mined ?? 0,
    sendPublic: async (_c, raw) => {
      sent.push(raw);
      return H1;
    },
    alert: async (_c, kind, line) => {
      alerts.push(`${kind}: ${line}`);
    },
    now: () => over.t ?? 100_000,
    ...over,
  } as never;
  return { d, records, sent, alerts };
}

async function seed(
  records: ReturnType<typeof memoryPrivateSendRecords>,
  rows: { hash: Hex; raw: Hex; nonce: number; atMs: number; reservedAtMs?: number }[],
) {
  for (const r of rows) {
    await records.write({ chainId: 1, address: ADDR, nonce: r.nonce, hash: r.hash, serialized: r.raw, atMs: r.atMs, reservedAtMs: r.reservedAtMs ?? r.atMs });
  }
}

describe('rebroadcastStalePrivateSends', () => {
  it('sends a public copy of a send still unmined after the stated time, once, and tells the operator', async () => {
    const { d, records, sent, alerts } = deps({ t: 100_000 });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 100_000 - 60_000 }]);
    const lines = await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([RAW1]);
    expect(alerts).toEqual([expect.stringContaining(`public: 1 keeper transaction was still unmined at least 60 s after the private route accepted it, so the same signed bytes went to the public RPC`)]);
    expect(alerts[0]).toContain(H1);
    expect(lines[0]).toContain('1 sent publicly');
    // Once: the row now carries its public time.
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([RAW1]);
  });

  it('leaves a send that has not yet waited the stated time', async () => {
    const { d, records, sent, alerts } = deps({ t: 100_000 });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 100_000 - 59_999 }]);
    expect(await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR)).toEqual([]);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(records.rows.size).toBe(1);
  });

  it('forgets a send whose nonce is mined, sending nothing', async () => {
    const { d, records, sent, alerts } = deps({ t: 100_000, mined: 6 });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0 }]);
    const lines = await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(records.rows.size).toBe(0);
    expect(lines[0]).toContain('1 found mined');
  });

  it('never sends a copy past the cutoff, where a later send may soon hold the nonce, and states it', async () => {
    const t = 10 * PRIVATE_ROUTE_FLOOR_TTL_MS;
    const { d, records, sent, alerts } = deps({ t });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: t - PUBLIC_COPY_CUTOFF_MS }]);
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([expect.stringMatching(/^lapsed: .*neither mined nor sent publicly by the last minute of the private nonce window/)]);
    expect(alerts[0]).toContain('unknown');
    expect(records.rows.size).toBe(0);
    expect(PUBLIC_COPY_CUTOFF_MS).toBeLessThan(PRIVATE_ROUTE_FLOOR_TTL_MS);
  });

  it('measures the cutoff from the nonce reservation, not the later acceptance', async () => {
    const t = 10 * PRIVATE_ROUTE_FLOOR_TTL_MS;
    const { d, records, sent, alerts } = deps({ t });
    // Accepted 61 s ago (due), but reserved long enough ago that the
    // reservation, and with it the nonce, is about to lapse.
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: t - 61_000, reservedAtMs: t - PUBLIC_COPY_CUTOFF_MS }]);
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([expect.stringMatching(/^lapsed: /)]);
  });

  it('reports a copy as sent even when its record cannot be updated', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { d, records, sent, alerts } = deps({ t: 100_000 });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0 }]);
    records.markPublic = async () => {
      throw new Error('D1 unavailable');
    };
    const lines = await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([RAW1]);
    expect(alerts).toEqual([expect.stringMatching(/^public: 1 keeper transaction/)]);
    expect(lines[0]).toContain('1 sent publicly');
    expect(lines[0]).toContain('0 failed');
    vi.restoreAllMocks();
  });

  it('checks the run deadline again after a slow mined-count read, sending nothing past it', async () => {
    let t = 100_000;
    const { d, records, sent } = deps({
      now: () => t,
      minedCount: async () => {
        t = 200_000;
        return 0;
      },
    });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0, reservedAtMs: 100_000 - 1 }]);
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, 150_000);
    expect(sent).toEqual([]);
    expect(records.rows.get(`1:${H1}`)?.publicAtMs).toBeNull();
  });

  it('keeps an uncopied row the run had no time to inspect, and reports it on a later tick', async () => {
    const t = 10 * PRIVATE_ROUTE_FLOOR_TTL_MS;
    let now = t;
    const { d, records, alerts } = deps({ now: () => now });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: t - PRIVATE_ROUTE_FLOOR_TTL_MS - 1 }]);
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, t);
    expect(records.rows.size).toBe(1);
    expect(alerts).toEqual([]);
    now = t + 60_000;
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(alerts).toEqual([expect.stringMatching(/^lapsed: /)]);
    expect(records.rows.size).toBe(0);
  });

  it('reads an answer saying the node holds the bytes as the copy being out, and a mined nonce as mined', async () => {
    const { d, records, sent } = deps({
      t: 100_000,
      sendPublic: async (_c, raw) => {
        throw new Error(raw === RAW1 ? 'already known' : 'nonce too low: next nonce 9');
      },
    });
    await seed(records, [
      { hash: H1, raw: RAW1, nonce: 5, atMs: 0 },
      { hash: H2, raw: RAW2, nonce: 6, atMs: 1 },
    ]);
    const lines = await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([]);
    expect(records.rows.get(`1:${H1}`)?.publicAtMs).toBe(100_000);
    expect(records.rows.has(`1:${H2}`)).toBe(false);
    expect(lines[0]).toContain('1 sent publicly, 1 found mined');
  });

  it('a copy that fails is retried on the next tick while its window lasts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const { d, records, sent } = deps({
      t: 100_000,
      sendPublic: async (_c, raw) => {
        if (fail) throw new Error('socket hang up');
        sent.push(raw);
        return H1;
      },
    });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0 }]);
    const lines = await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(lines[0]).toContain('1 failed');
    expect(records.rows.get(`1:${H1}`)?.publicAtMs).toBeNull();
    fail = false;
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, FAR);
    expect(sent).toEqual([RAW1]);
    vi.restoreAllMocks();
  });

  it('reads nothing on a chain whose route allows no public fallback, or when the settings are unread', async () => {
    const minedCount = vi.fn(async () => 0);
    const { d, records, sent } = deps({ t: 100_000, minedCount });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0 }]);
    await rebroadcastStalePrivateSends(readSubmissionRoutes('1=https://rpc.example.org/', ''), ETH, d, FAR);
    await rebroadcastStalePrivateSends(readSubmissionRoutes('garbage', ''), ETH, d, FAR);
    expect(minedCount).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('stops at the run deadline, leaving the rest for the next tick', async () => {
    const { d, records, sent } = deps({ t: 100_000 });
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 0 }]);
    await rebroadcastStalePrivateSends(fallbackRoutes, ETH, d, 100_000);
    expect(sent).toEqual([]);
    expect(records.rows.get(`1:${H1}`)?.publicAtMs).toBeNull();
  });

  it('a re-accepted send keeps its first time, so a repeat cannot postpone its fallback', async () => {
    const { records } = deps();
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 10 }]);
    await seed(records, [{ hash: H1, raw: RAW1, nonce: 5, atMs: 999 }]);
    expect(records.rows.get(`1:${H1}`)?.atMs).toBe(10);
    expect(records.rows.get(`1:${H1}`)?.reservedAtMs).toBe(10);
  });
});

describe('the public-fallback alert', () => {
  it('names the chain, says what was logged instead of alerted, and is keyed per chain', () => {
    const text = publicFallbackAlertText({ id: 1, name: 'Ethereum' }, 1, 'X happened.');
    expect(text).toContain('Ethereum (1): X happened.');
    expect(text).toContain('logged, not alerted');
    expect(publicFallbackAlertKey(1)).not.toBe(publicFallbackAlertKey(56));
    expect(lapsedSendAlertKey(1)).not.toBe(publicFallbackAlertKey(1));
  });
});

describe('d1PrivateSendRecords, against the keeper\'s real private schema', () => {
  it('records, lists what is due, marks a public copy, forgets, and prunes only copied rows, per network', async () => {
    const { createKeeperD1 } = await import('./helpers/schemas');
    const { d1PrivateSendRecords } = await import('../src/privateRebroadcast');
    const r = d1PrivateSendRecords(createKeeperD1().d1 as never);
    const MIXED = '0xD9257B636E17D5714DD54F260c9F7EB81349E49B' as Address;
    await r.write({ chainId: 1, address: MIXED, nonce: 5, hash: H1, serialized: RAW1, atMs: 100, reservedAtMs: 90 });
    await r.write({ chainId: 1, address: MIXED, nonce: 5, hash: H1, serialized: RAW1, atMs: 500, reservedAtMs: 490 });
    await r.write({ chainId: 1, address: MIXED, nonce: 6, hash: H2, serialized: RAW2, atMs: 300, reservedAtMs: 290 });
    await r.write({ chainId: 56, address: MIXED, nonce: 1, hash: H1, serialized: RAW1, atMs: 100, reservedAtMs: 90 });
    expect(await r.due(1, 200)).toEqual([
      { chainId: 1, address: MIXED.toLowerCase(), nonce: 5, hash: H1, serialized: RAW1, atMs: 100, reservedAtMs: 90, publicAtMs: null },
    ]);
    await r.markPublic(1, H1, 250);
    expect(await r.due(1, 1_000)).toEqual([expect.objectContaining({ hash: H2 })]);
    await r.remove(1, H2);
    expect(await r.due(1, 1_000)).toEqual([]);
    // An uncopied row survives housekeeping, however old: only the sweep,
    // which reports it, may forget it.
    await r.pruneCopied(56, 1_000);
    expect(await r.due(56, 1_000)).toEqual([expect.objectContaining({ hash: H1, chainId: 56 })]);
    // A copied row goes once its window has passed.
    await r.markPublic(56, H1, 200);
    await r.pruneCopied(56, 91);
    expect(await r.due(56, 1_000)).toEqual([]);
  });
});
