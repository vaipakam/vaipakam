/**
 * #2760 — the matcher's walks are bounded by the work they pay for:
 *  - each listed offer id is hydrated once, so each lender × borrower pair is
 *    visited once per run without a set of tried pairs;
 *  - a creator on both sides of a bucket is passed over per group, not per pair;
 *  - the intent fill-size search does not take a dust fill's refusal as proof
 *    that no fill is viable.
 */
import { describe, expect, it } from 'vitest';
import {
  INTENT_SIZE_DOWN_MAX_PROBES,
  groupByCreator,
  intentProbeVerdict,
  listActiveOffers,
  searchIntentFill,
  type IntentProbeVerdict,
} from '../src/matcher';

const rawOffer = (id: bigint) =>
  new Proxy({} as Record<string, unknown>, { get: (_t, k) => (k === 'id' ? id : 0) });

describe('listActiveOffers', () => {
  it('hydrates an id once when a later page repeats it', async () => {
    const hydrated: bigint[] = [];
    const pages: bigint[][] = [
      [1n, 2n, 3n],
      [3n, 4n], // id 3 moved into a freed slot between the two page reads
    ];
    let page = 0;
    const client = {
      readContract: async (req: { functionName: string }) => {
        if (req.functionName === 'getActiveOffersCount') return 400n;
        if (req.functionName === 'getActiveOffersPaginated') return pages[page++] ?? [];
        throw new Error(`unexpected read ${req.functionName}`);
      },
      multicall: async (req: { contracts: { args: readonly [bigint] }[] }) =>
        req.contracts.map((c) => {
          hydrated.push(c.args[0]);
          return { status: 'success', result: rawOffer(c.args[0]) };
        }),
    };
    const ctx = { client, diamond: '0x0000000000000000000000000000000000000001', chainId: 84532 };
    const { offers, listed } = await listActiveOffers(ctx as never, 0, () => page >= 2);
    expect(listed).toBe(5);
    expect(hydrated).toEqual([1n, 2n, 3n, 4n]);
    expect(offers.map((o) => o.id)).toEqual([1n, 2n, 3n, 4n]);
  });
});

describe('groupByCreator', () => {
  it('groups by lower-cased creator in first-appearance order', () => {
    const o = (id: bigint, creator: string) => ({ id, creator }) as never;
    const groups = groupByCreator([
      o(1n, '0xAbC0000000000000000000000000000000000001'),
      o(2n, '0x0000000000000000000000000000000000000002'),
      o(3n, '0xabc0000000000000000000000000000000000001'),
    ]);
    expect([...groups.keys()]).toEqual([
      '0xabc0000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000002',
    ]);
    expect(groups.get('0xabc0000000000000000000000000000000000001')!.map((x: { id: bigint }) => x.id)).toEqual([
      1n,
      3n,
    ]);
  });
});

describe('intentProbeVerdict', () => {
  it('reads a collateral refusal as too big and any other refusal as below the window', () => {
    expect(intentProbeVerdict(null)).toBe('unread');
    expect(intentProbeVerdict({ ok: true, matchError: 0 })).toBe('ok');
    expect(intentProbeVerdict({ ok: false, matchError: 6 })).toBe('tooBig');
    expect(intentProbeVerdict({ ok: false, matchError: 0 })).toBe('belowWindow');
  });
});

/** A modelled preview: fills below `floor` fail on rounding, fills above
 *  `ceiling` fail on collateral, the rest pass. */
function model(floor: bigint, ceiling: bigint) {
  const sent: bigint[] = [];
  const probe = async (fill: bigint) => {
    sent.push(fill);
    const verdict: IntentProbeVerdict = fill < floor ? 'belowWindow' : fill > ceiling ? 'tooBig' : 'ok';
    return { verdict, preview: fill };
  };
  return { sent, probe };
}

describe('searchIntentFill', () => {
  it('finds the largest viable fill above a viable lo', async () => {
    const m = model(0n, 700n);
    const r = await searchIntentFill(10n, 1000n, m.probe, 20);
    expect(r?.fill).toBe(700n);
    expect(m.sent[0]).toBe(10n);
  });

  it('a lo refused for collateral proves no fill is viable', async () => {
    const m = model(0n, 5n);
    expect(await searchIntentFill(10n, 1000n, m.probe)).toBeNull();
    expect(m.sent).toEqual([10n]);
  });

  it('a dust lo refused on rounding does not end the search (#2760 item 4)', async () => {
    // lo = 1 fails on rounding; fills 200..700 pass; hi = 1000 failed on collateral.
    const m = model(200n, 700n);
    const r = await searchIntentFill(1n, 1000n, m.probe);
    expect(r).not.toBeNull();
    expect(r!.fill).toBeGreaterThanOrEqual(200n);
    expect(r!.fill).toBeLessThanOrEqual(700n);
    expect(m.sent.length).toBeLessThanOrEqual(1 + INTENT_SIZE_DOWN_MAX_PROBES);
  });

  it('a refusal at every size spends the bounded probes and returns nothing', async () => {
    const m = model(10_000n, 10_000n);
    expect(await searchIntentFill(1n, 1000n, m.probe)).toBeNull();
    expect(m.sent.length).toBe(1 + INTENT_SIZE_DOWN_MAX_PROBES);
  });

  it('stops when the budget is spent or a read fails, keeping what it found', async () => {
    let calls = 0;
    const r = await searchIntentFill(10n, 1000n, async (fill) => {
      calls += 1;
      if (calls > 2) return null; // budget spent
      return { verdict: 'ok' as const, preview: fill };
    });
    expect(calls).toBe(3);
    expect(r?.fill).toBe(505n);

    const unread = await searchIntentFill(10n, 1000n, async (fill) =>
      fill === 10n ? { verdict: 'ok' as const, preview: fill } : { verdict: 'unread' as const, preview: fill },
    );
    expect(unread?.fill).toBe(10n);
  });

  it('an empty range sends nothing', async () => {
    const m = model(0n, 0n);
    expect(await searchIntentFill(1000n, 1000n, m.probe)).toBeNull();
    expect(m.sent).toEqual([]);
  });
});
