/**
 * The recycling + loop-closure read layer (#1349 M5): what it accepts,
 * what it refuses, and how narrowly each refusal degrades.
 *
 * The verdict fixtures are produced by the SAME shared function the
 * indexer serves from (`@vaipakam/contracts/recycle-backing`), so these
 * tests check the page against payloads the indexer can actually emit —
 * and pin that every verdict that function can produce passes the page's
 * shape check (a check that refused a real verdict would silently turn a
 * stated answer into "could not be read").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recycleBackingVerdict,
  type RecycleBackingInputs,
} from '@vaipakam/contracts/recycle-backing';
import {
  fetchLoopClosure,
  fetchRecyclingAccount,
  parseBacking,
  parseLoopClosure,
  parseRecyclingSeries,
} from './recycling';

const tok = (n: number) => (BigInt(n) * 10n ** 18n).toString();

const day = (over: Record<string, unknown> = {}) => ({
  dayId: 1,
  stamped: true,
  armed: true,
  estimate: false,
  origin: 'event',
  scheduleFloor: '1000',
  recycledBudget: '250',
  aBar: '10',
  marginBps: 1000,
  freshDrawdown: '900',
  netEmission: '900',
  selfFundingRatio: 0.2,
  absorbedLocal: '5',
  absorbedMirror: '0',
  absorbed: '5',
  ...over,
});

const openDay = (over: Record<string, unknown> = {}) =>
  day({
    stamped: false,
    armed: false,
    estimate: false,
    scheduleFloor: null,
    recycledBudget: null,
    freshDrawdown: null,
    netEmission: null,
    selfFundingRatio: null,
    absorbed: null,
    ...over,
  });

/** A backing block exactly as the indexer builds it, verdict included. */
const backing = (over: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = {
    vpfiBalance: tok(100),
    bucket: tok(40),
    unearmarked: tok(60),
    outstandingRecycled: tok(10),
    paidOutRecycled: tok(2),
    keeperBudget: tok(5),
    platformRetained: tok(25),
    releasedRemitStranded: '0',
    strandedRecoveryReserved: '0',
    recoveryPositionReserved: '0',
    custodyActivated: false,
    holderBalanceKnown: true,
    holderBalance: '0',
    holderAttributed: '0',
    blockNumber: '12345678',
    diamond: '0xd89f0000000000000000000000000000000000ab',
    unavailableReason: null,
    asOf: '2026-08-03T00:00:00.000Z',
    ...over,
  };
  if (!('backed' in over)) {
    try {
      base.backed = recycleBackingVerdict(base as unknown as RecycleBackingInputs);
    } catch {
      // A deliberately corrupt fixture: the indexer could not have built a
      // verdict from it either. The block is refused before the verdict is
      // looked at, so its value here does not matter.
      base.backed = null;
    }
  }
  return base;
};

const series = (over: Record<string, unknown> = {}) => ({
  chainId: 8453,
  days: 30,
  fromDay: 1,
  toDay: 1,
  scope: 'global',
  coverageFromDay: 1,
  daily: [day()],
  cumulative: {
    absorbed: '5',
    absorbedPreLaunch: '0',
    absorbedLocal: '5',
    absorbedMirror: '0',
    freshDrawdown: '900',
    recycledBudget: '250',
    runwayExtensionDays: 3,
    runwayUnavailableReason: null,
    selfFunded: false,
  },
  backing: backing(),
  ...over,
});

describe('parseRecyclingSeries — the series', () => {
  it('accepts a well-formed response and publishes its backing', () => {
    const p = parseRecyclingSeries(series());
    expect(p).not.toBeNull();
    expect(p!.backing.kind).toBe('published');
  });

  it('accepts an open day and an estimate day in their indexer shapes', () => {
    const p = parseRecyclingSeries(
      series({
        daily: [
          openDay({ dayId: 2 }),
          day({ dayId: 3, armed: false, estimate: true, netEmission: null }),
        ],
      }),
    );
    expect(p?.daily).toHaveLength(2);
  });

  it.each([
    ['a non-object', 'nope'],
    ['an unknown scope', series({ scope: 'partial' })],
    ['a malformed cumulative amount', series({ cumulative: { ...series().cumulative, absorbed: '1.5' } })],
    ['a missing cumulative amount', series({ cumulative: { ...series().cumulative, absorbedLocal: undefined } })],
    ['a malformed day amount', series({ daily: [day({ scheduleFloor: '12,34' })] })],
    ['a null live component', series({ daily: [day({ absorbedLocal: null })] })],
    ['a self-funded share above 1', series({ daily: [day({ selfFundingRatio: 1.2 })] })],
    ['a non-finite runway', series({ cumulative: { ...series().cumulative, runwayExtensionDays: Infinity } })],
    ['a non-array daily', series({ daily: {} })],
    ['a fractional day id', series({ daily: [day({ dayId: 1.5 })] })],
  ])('refuses the whole series for %s', (_why, raw) => {
    expect(parseRecyclingSeries(raw)).toBeNull();
  });

  // Each withheld cell NAMES its reason from the day's flags; a row whose
  // nulls contradict its flags would make a cell state a false reason.
  it.each([
    ['an armed finalized day with no net emission', day({ netEmission: null })],
    ['an unarmed day not marked an estimate', day({ armed: false, estimate: false, netEmission: null })],
    ['an unarmed day that publishes a net emission', day({ armed: false, estimate: true })],
    ['a finalized day with no pool', day({ scheduleFloor: null })],
    ['a finalized day with no combined absorption', day({ absorbed: null })],
    ['an open day with a pool', openDay({ scheduleFloor: '1' })],
    ['an open day with a combined sum', openDay({ absorbed: '5' })],
    ['an open day marked armed', openDay({ armed: true })],
    ['a missing ratio on a non-empty pool', day({ selfFundingRatio: null })],
  ])('refuses an inconsistent day: %s', (_why, d) => {
    expect(parseRecyclingSeries(series({ daily: [d] }))).toBeNull();
  });

  it('accepts a finalized day whose pool was empty with no ratio', () => {
    const p = parseRecyclingSeries(
      series({
        daily: [day({ scheduleFloor: '0', recycledBudget: '0', selfFundingRatio: null, netEmission: '0', freshDrawdown: '0' })],
      }),
    );
    expect(p).not.toBeNull();
  });
});

describe('parseBacking — a bad backing block withholds only itself', () => {
  it('a malformed backing amount leaves the series intact', () => {
    const p = parseRecyclingSeries(series({ backing: backing({ platformRetained: 'x' }) }));
    expect(p).not.toBeNull();
    expect(p!.backing).toEqual({ kind: 'withheld', reason: { kind: 'malformed' } });
  });

  it('no backing block at all (an older indexer) is "not served"', () => {
    const s = series();
    delete (s as Record<string, unknown>).backing;
    expect(parseRecyclingSeries(s)!.backing).toEqual({
      kind: 'withheld',
      reason: { kind: 'not-served' },
    });
  });

  it('carries the indexer’s own refusal code through', () => {
    expect(parseBacking({ unavailableReason: 'chain-behind' })).toEqual({
      kind: 'withheld',
      reason: { kind: 'indexer', code: 'chain-behind', pendingMigration: null },
    });
  });

  it.each([
    ['vpfiBalance null', { vpfiBalance: null }],
    ['bucket missing', { bucket: undefined }],
    ['stranded remittance null', { releasedRemitStranded: null }],
    ['no capture moment', { asOf: null }],
    ['an unparseable capture moment', { asOf: 'unknown' }],
    ['no contract', { diamond: null }],
    ['a contract that is not an address', { diamond: '0x1234' }],
  ])('an available reading missing %s is incomplete', (_why, over) => {
    expect(parseBacking(backing(over))).toEqual({
      kind: 'withheld',
      reason: { kind: 'incomplete' },
    });
  });

  it('malformed beats incomplete — a corrupt figure is not reported as a gap', () => {
    expect(parseBacking(backing({ vpfiBalance: null, bucket: 'x' }))).toEqual({
      kind: 'withheld',
      reason: { kind: 'malformed' },
    });
  });

  it.each([
    ['a malformed recovery reservation', { strandedRecoveryReserved: '1.0' }],
    ['a malformed holder balance', { holderBalance: '-5' }],
    ['a non-boolean custody flag', { custodyActivated: 1 }],
    ['a non-boolean holder-known flag', { holderBalanceKnown: 'true' }],
  ])('%s withholds the block as malformed', (_why, over) => {
    expect(parseBacking(backing(over))).toEqual({
      kind: 'withheld',
      reason: { kind: 'malformed' },
    });
  });

  it('newer figures an older reading lacks read as null (not determinable), never zero', () => {
    const b = backing();
    for (const k of [
      'strandedRecoveryReserved',
      'recoveryPositionReserved',
      'custodyActivated',
      'holderBalanceKnown',
      'holderBalance',
      'holderAttributed',
      'backed',
    ]) {
      delete b[k];
    }
    const v = parseBacking(b);
    expect(v.kind).toBe('published');
    if (v.kind !== 'published') return;
    expect(v.backing.strandedRecoveryReserved).toBeNull();
    expect(v.backing.recoveryPositionReserved).toBeNull();
    expect(v.backing.custodyActivated).toBeNull();
    expect(v.backing.holderBalance).toBeNull();
    expect(v.backing.holderAttributed).toBeNull();
    // NOT computed here from balance and bucket — the page says the
    // indexer does not publish it.
    expect(v.backing.verdict).toEqual({ kind: 'not-served' });
  });
});

describe('the verdict shape check accepts everything the shared function emits', () => {
  // A matrix over every branch of `recycleBackingVerdict`: each custody
  // state, readable and unreadable holders, present and missing
  // subtrahends, and balances either side of each line.
  const custody = [null, false, true] as const;
  const balances = [tok(0), tok(39), tok(40), tok(100)];
  const nullable = [null, '0', tok(3)];
  const cases: Record<string, unknown>[] = [];
  for (const custodyActivated of custody) {
    for (const vpfiBalance of balances) {
      for (const stranded of nullable) {
        for (const recovery of nullable) {
          for (const known of [true, false]) {
            for (const attributed of [tok(40), null]) {
              const holderAttributed = custodyActivated === null ? null : attributed;
              const holderBalance = custodyActivated === null || !known ? null : tok(39);
              cases.push({
                vpfiBalance,
                strandedRecoveryReserved: stranded,
                recoveryPositionReserved: recovery,
                custodyActivated,
                holderBalanceKnown: custodyActivated === null ? null : known,
                holderBalance,
                holderAttributed,
              });
            }
          }
        }
      }
    }
  }

  it(`accepts all ${cases.length} generated verdicts as served`, () => {
    for (const over of cases) {
      const v = parseBacking(backing(over));
      expect(v.kind).toBe('published');
      if (v.kind === 'published') expect(v.backing.verdict.kind).toBe('served');
    }
  });

  const served = recycleBackingVerdict({
    vpfiBalance: tok(95),
    bucket: tok(100),
    strandedRecoveryReserved: '0',
    recoveryPositionReserved: '0',
    custodyActivated: false,
    holderBalanceKnown: true,
    holderBalance: '0',
    holderAttributed: '0',
  });

  it.each([
    ['a failing verdict with no shortfall', { ...served, diamondShortfall: null }],
    ['a passing verdict with a shortfall', { ...served, ok: true }],
    ['a shortfall of zero', { ...served, diamondShortfall: '0' }],
    ['a malformed shortfall', { ...served, diamondShortfall: '5e18' }],
    ['a holder shortfall on the Diamond relation', { ...served, holderShortfall: tok(1) }],
    ['a relation that contradicts the custody state', { ...served, relation: 'holder' }],
    ['an unknown relation', { ...served, relation: 'vault' }],
    ['an undetermined verdict with no reason', { ...served, determinable: false, ok: null, diamondShortfall: null, reason: null }],
    ['an unknown reason', { ...served, determinable: false, ok: null, diamondShortfall: null, reason: 'busy' }],
    ['an undetermined verdict still carrying ok', { ...served, determinable: false, diamondShortfall: null, reason: 'subtrahend-unknown' }],
    ['a non-object', 'yes'],
  ])('refuses %s as malformed (verdict only)', (_why, backed) => {
    const v = parseBacking(backing({ vpfiBalance: tok(95), bucket: tok(100), backed }));
    expect(v.kind).toBe('published');
    if (v.kind === 'published') expect(v.backing.verdict).toEqual({ kind: 'malformed' });
  });

  describe('a partial answer on the holder relation, refused by the reading it sits beside', () => {
    // Custody activated, holder balance unreadable, Diamond leg short
    // (30 < 40 stranded). The contract answers this NOT determinable; a
    // per-leg rule would answer "No, short by 10" from the one leg it read,
    // and the page would render only that shortfall. Each refusal below is
    // that partial answer in some form. The check keys on the READING's
    // operands, so no label the verdict carries about itself is needed to
    // catch it.
    const unreadHolder = {
      vpfiBalance: tok(30),
      strandedRecoveryReserved: tok(40),
      custodyActivated: true,
      holderBalanceKnown: false,
      holderBalance: null,
      holderAttributed: tok(625),
    };
    const dLegOnly = {
      determinable: true,
      relation: 'holder',
      ok: false,
      diamondShortfall: tok(10),
      holderShortfall: null,
      reason: null,
    };

    it('serves the shared function\'s answer for it: not determinable, holder reason', () => {
      // The control: the straddle partner of every refusal below, so a
      // refusal is the shape's doing and not the reading's.
      const v = parseBacking(backing(unreadHolder));
      expect(v.kind).toBe('published');
      if (v.kind !== 'published') return;
      expect(v.backing.verdict).toEqual({
        kind: 'served',
        verdict: {
          determinable: false,
          relation: 'holder',
          ok: null,
          diamondShortfall: null,
          holderShortfall: null,
          reason: 'holder-balance-unknown',
        },
      });
    });

    it.each([
      ['the Diamond leg\'s shortfall as the whole answer', unreadHolder, dLegOnly],
      [
        // Holder read, the Diamond leg's subtracted term missing: the holder
        // leg's shortfall offered as the whole answer.
        'the holder leg\'s shortfall with the Diamond leg unread',
        { ...unreadHolder, holderBalanceKnown: true, holderBalance: tok(600), strandedRecoveryReserved: null },
        { ...dLegOnly, diamondShortfall: null, holderShortfall: tok(25) },
      ],
      [
        // Holder read, the holder leg's subtracted term missing.
        'the Diamond leg\'s shortfall with the holder rows unread',
        { ...unreadHolder, holderBalanceKnown: true, holderBalance: tok(600), holderAttributed: null },
        dLegOnly,
      ],
      [
        // Both legs unread: the holder reason takes precedence, so the
        // subtrahend reason names a cause the shared function never reaches.
        'the subtrahend reason where the holder balance was not read',
        { ...unreadHolder, strandedRecoveryReserved: null },
        { ...dLegOnly, determinable: false, ok: null, diamondShortfall: null, reason: 'subtrahend-unknown' },
      ],
      [
        // Every operand present: "not determinable" contradicts the reading.
        'a not-determinable answer beside a complete reading',
        { ...unreadHolder, holderBalanceKnown: true, holderBalance: tok(600) },
        { ...dLegOnly, determinable: false, ok: null, diamondShortfall: null, reason: 'subtrahend-unknown' },
      ],
    ])('refuses %s as malformed (verdict only)', (_why, reading, backed) => {
      const v = parseBacking(backing({ ...reading, backed }));
      expect(v.kind).toBe('published');
      if (v.kind === 'published') expect(v.backing.verdict).toEqual({ kind: 'malformed' });
    });

    it('accepts the same determinable shape once both legs WERE read', () => {
      // Straddle: identical verdict fields, reading flipped to a known
      // balance with every subtrahend present — accepted, so the refusals
      // above key on the reading's operands and nothing else.
      const v = parseBacking(
        backing({
          ...unreadHolder,
          holderBalanceKnown: true,
          holderBalance: tok(700),
          backed: dLegOnly,
        }),
      );
      expect(v.kind === 'published' && v.backing.verdict.kind).toBe('served');
    });

    it('refuses a determinable Diamond answer beside a missing reservation', () => {
      const v = parseBacking(
        backing({
          recoveryPositionReserved: null,
          backed: {
            determinable: true,
            relation: 'diamond',
            ok: true,
            diamondShortfall: null,
            holderShortfall: null,
            reason: null,
          },
        }),
      );
      expect(v.kind === 'published' && v.backing.verdict.kind).toBe('malformed');
    });
  });

  it('refuses a holder-balance reason on the Diamond relation', () => {
    const v = parseBacking(
      backing({
        backed: {
          determinable: false,
          relation: 'diamond',
          ok: null,
          diamondShortfall: null,
          holderShortfall: null,
          reason: 'holder-balance-unknown',
        },
      }),
    );
    expect(v.kind === 'published' && v.backing.verdict.kind).toBe('malformed');
  });

  it('refuses a custody-unknown reason paired with a chosen relation', () => {
    const v = parseBacking(
      backing({
        custodyActivated: null,
        holderBalanceKnown: null,
        holderBalance: null,
        holderAttributed: null,
        backed: {
          determinable: false,
          relation: 'diamond',
          ok: null,
          diamondShortfall: null,
          holderShortfall: null,
          reason: 'custody-state-unknown',
        },
      }),
    );
    expect(v.kind === 'published' && v.backing.verdict.kind).toBe('malformed');
  });
});

describe('parseLoopClosure', () => {
  const loop = (over: Record<string, unknown> = {}) => ({
    chainId: 8453,
    days: 30,
    recordedBefore: '2026-10-07T09:30:00.000Z',
    daily: [
      { dayId: 20730, date: '2026-10-04', status: 'complete', distributed: tok(10), netVaultDelivered: tok(4), absorbed: tok(1), ratio: 0.5 },
      { dayId: 20731, date: '2026-10-05', status: 'complete', distributed: '0', netVaultDelivered: '0', absorbed: '0', ratio: null },
      { dayId: 20732, date: '2026-10-06', status: 'partial', distributed: tok(2), netVaultDelivered: tok(1), absorbed: '0', ratio: null },
      { dayId: 20733, date: '2026-10-07', status: 'unrecorded', distributed: null, netVaultDelivered: null, absorbed: null, ratio: null },
    ],
    cumulative: { cumDistributed: tok(10), cumAbsorbed: tok(1), retainedStock: tok(4), ratio: 0.5 },
    ...over,
  });

  it('accepts a well-formed response: complete, not-applicable, partial and unrecorded days', () => {
    const p = parseLoopClosure(loop());
    expect(p?.daily.map((d) => d.status)).toEqual(['complete', 'complete', 'partial', 'unrecorded']);
    expect(p?.recordedBefore).toBe('2026-10-07T09:30:00.000Z');
  });

  it('accepts no recorded moment when every day is unrecorded and no lifetime figures are stated', () => {
    const p = parseLoopClosure(loop({ recordedBefore: null, daily: [loop().daily[3]], cumulative: null }));
    expect(p?.recordedBefore).toBeNull();
    expect(p?.cumulative).toBeNull();
  });

  it('accepts a lifetime ratio of null while nothing has been distributed', () => {
    expect(
      parseLoopClosure(loop({ cumulative: { cumDistributed: '0', cumAbsorbed: '0', retainedStock: '0', ratio: null } })),
    ).not.toBeNull();
  });

  it.each([
    ['a malformed amount', { daily: [{ ...loop().daily[0], distributed: '1,0' }] }],
    ['a ratio on a zero-distribution day', { daily: [{ ...loop().daily[1], ratio: 0 }] }],
    ['no ratio on a day that distributed', { daily: [{ ...loop().daily[0], ratio: null }] }],
    ['a negative ratio', { daily: [{ ...loop().daily[0], ratio: -0.1 }] }],
    ['a malformed date', { daily: [{ ...loop().daily[0], date: '04/10/2026' }] }],
    ['a lifetime ratio with nothing distributed', { cumulative: { cumDistributed: '0', cumAbsorbed: '0', retainedStock: '0', ratio: 0 } }],
    ['a missing cumulative block', { cumulative: undefined }],
    // #1349 M5 — what a day is known to be.
    ['a day with no status (an indexer that pads unknown days with zeros)', { daily: [{ ...loop().daily[0], status: undefined }] }],
    ['an unknown status', { daily: [{ ...loop().daily[0], status: 'final' }] }],
    ['a ratio on a partial day', { daily: [{ ...loop().daily[2], ratio: 0.5 }] }],
    ['an amount on an unrecorded day', { daily: [{ ...loop().daily[3], distributed: '0' }] }],
    ['a ratio on an unrecorded day', { daily: [{ ...loop().daily[3], ratio: 0 }] }],
    ['a known day after one the record has not reached', { daily: [loop().daily[3], loop().daily[0]] }],
    ['a complete day after a partial one', { daily: [loop().daily[2], loop().daily[0]] }],
    ['two partial days', { daily: [loop().daily[2], loop().daily[2]] }],
    ['a known day with no recorded moment', { recordedBefore: null }],
    // Codex #2521 r1 — lifetime figures beside no recorded moment are a claim
    // nothing substantiates; a recorded moment with none is a missing block.
    ['lifetime figures beside no recorded moment', { recordedBefore: null, daily: [loop().daily[3]] }],
    ['no lifetime figures beside a recorded moment', { cumulative: null }],
    ['a missing recorded moment', { recordedBefore: undefined }],
    ['an unparseable recorded moment', { recordedBefore: 'yesterday' }],
  ])('refuses %s', (_why, over) => {
    expect(parseLoopClosure(loop(over))).toBeNull();
  });
});

describe('fetchers — one GET path, validated', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const stubFetch = (body: unknown, ok = true) => {
    const fetchMock = vi.fn(async () => ({
      ok,
      json: async () => body,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('reads /metrics/recycling for the chain and window, and validates it', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', 'https://indexer.test/');
    const f = stubFetch(series());
    const p = await fetchRecyclingAccount(84532, 30);
    expect(f).toHaveBeenCalledWith(
      'https://indexer.test/metrics/recycling?chainId=84532&days=30',
      expect.anything(),
    );
    expect(p?.scope).toBe('global');
  });

  it('a malformed recycling body is "cannot say" (null), never zeros', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', 'https://indexer.test');
    stubFetch(series({ daily: [day({ absorbedLocal: 'NaN' })] }));
    expect(await fetchRecyclingAccount(84532)).toBeNull();
  });

  it('a non-2xx answer is null', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', 'https://indexer.test');
    stubFetch({ error: 'recycling-series query failed' }, false);
    expect(await fetchRecyclingAccount(84532)).toBeNull();
  });

  it('no configured indexer is null without a request', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', '');
    const f = stubFetch(series());
    expect(await fetchRecyclingAccount(84532)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('reads /metrics/loop-closure for the chain and window', async () => {
    vi.stubEnv('VITE_INDEXER_ORIGIN', 'https://indexer.test');
    const f = stubFetch({
      chainId: 84532,
      days: 30,
      recordedBefore: null,
      daily: [],
      // No recorded moment → no lifetime figures (Codex #2521 r1).
      cumulative: null,
    });
    const p = await fetchLoopClosure(84532, 30);
    expect(f).toHaveBeenCalledWith(
      'https://indexer.test/metrics/loop-closure?chainId=84532&days=30',
      expect.anything(),
    );
    expect(p).not.toBeNull();
    expect(p?.cumulative).toBeNull();
  });
});
