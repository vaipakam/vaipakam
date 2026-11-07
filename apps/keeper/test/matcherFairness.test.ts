/**
 * #3242 part 2 — the matcher shares its preview budget across creators, never
 * across offers: one wallet's many offers cannot use up a run's previews
 * before anyone else's are looked at.
 */
import { describe, expect, it, vi } from 'vitest';
import { fairPairs } from '../src/fairPairs';
import {
  MAX_PREVIEW_CALLS_PER_TICK,
  intentFillUnits,
  offerMatchUnits,
  runIntentFillPass,
  type LenderIntentSummary,
  type OfferLite,
} from '../src/matcher';

const LEND = '0x00000000000000000000000000000000000000c1';
const COLL = '0x00000000000000000000000000000000000000c2';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const SPAMMER = addr(0x5bad);
const HONEST = addr(0x600d);
const LENDER = addr(0x1e4d);

function offer(id: number, creator: `0x${string}`, offerType: 0 | 1): OfferLite {
  return {
    id: BigInt(id), creator, offerType, accepted: false, assetType: 0, collateralAssetType: 0,
    lendingAsset: LEND, collateralAsset: COLL, durationDays: 30n, amount: 100n, amountMax: 100n,
    amountFilled: 0n, interestRateBpsMax: 1000n, fillMode: 0, useFullTermInterest: true,
    allowsPartialRepay: false,
  } as unknown as OfferLite;
}

/** The first `n` pairs the walk would preview. */
function firstPairs<A, B>(gen: Iterable<readonly [A, B]>, n: number): (readonly [A, B])[] {
  const out: (readonly [A, B])[] = [];
  for (const p of gen) {
    if (out.length >= n) break;
    out.push(p);
  }
  return out;
}

describe('fairPairs', () => {
  it('takes one pair from every unit per round, and every pair once', () => {
    const units = [
      { as: ['a1', 'a2'], bs: ['x1', 'x2'] },
      { as: ['b1'], bs: ['y1'] },
      { as: ['c1'], bs: ['z1', 'z2', 'z3'] },
    ];
    const pairs = [...fairPairs(units)].map(([a, b]) => `${a}-${b}`);
    expect(pairs).toEqual([
      'a1-x1', 'b1-y1', 'c1-z1', // round 0
      'a1-x2', 'c1-z2', //          round 1
      'a2-x1', 'c1-z3', //          round 2
      'a2-x2', //                   round 3
    ]);
  });

  it('reads the dead and skip rules at each pull, so a change between pulls holds from the next one', () => {
    const dead = new Set<string>();
    const gen = fairPairs([{ as: ['a1', 'a2'], bs: ['x1', 'x2', 'x3'] }], (a) => dead.has(a), (_a, b) => b === 'x2');
    expect(gen.next().value).toEqual(['a1', 'x1']);
    dead.add('a1');
    expect(gen.next().value).toEqual(['a2', 'x1']);
    expect(gen.next().value).toEqual(['a2', 'x3']);
    expect(gen.next().done).toBe(true);
  });

  it('builds units only as the walk reaches them', () => {
    let built = 0;
    function* units() {
      for (let i = 0; i < 1_000_000; i += 1) {
        built += 1;
        yield { as: [i], bs: [i] };
      }
    }
    expect(firstPairs(fairPairs(units()), 5)).toHaveLength(5);
    expect(built).toBeLessThanOrEqual(6);
  });
});

describe('offerMatchUnits — one wallet\'s offers cannot crowd out a genuine match', () => {
  it('reaches an honest borrower on the first round, however many offers a spammer holds ahead of it', () => {
    const spam = Array.from({ length: 3000 }, (_, i) => offer(1000 + i, SPAMMER, 1));
    const lenders = new Map([['k', [offer(1, LENDER, 0)]]]);
    const borrowers = new Map([['k', [...spam, offer(2, HONEST, 1)]]]);
    const pairs = firstPairs(fairPairs(offerMatchUnits(lenders, borrowers, 0)), 2);
    expect(pairs.map(([, b]) => b.creator)).toContain(HONEST);
  });

  it('a spammer on the lender side takes one preview per round, like any other lender', () => {
    const spamLenders = Array.from({ length: 3000 }, (_, i) => offer(1000 + i, SPAMMER, 0));
    const lenders = new Map([['k', [...spamLenders, offer(1, LENDER, 0)]]]);
    const borrowers = new Map([['k', [offer(2, HONEST, 1)]]]);
    const pairs = firstPairs(fairPairs(offerMatchUnits(lenders, borrowers, 0)), 2);
    expect(pairs.map(([l]) => l.creator)).toContain(LENDER);
  });

  it('a spammed bucket does not take the budget from another bucket', () => {
    // 3000 x 3000 spam pairs between two spam wallets in one bucket, one honest
    // pair in another: the honest pair is in round 0.
    const lenders = new Map([
      ['spam', Array.from({ length: 3000 }, (_, i) => offer(10_000 + i, SPAMMER, 0))],
      ['real', [offer(1, LENDER, 0)]],
    ]);
    const borrowers = new Map([
      ['spam', Array.from({ length: 3000 }, (_, i) => offer(20_000 + i, addr(0x5bae), 1))],
      ['real', [offer(2, HONEST, 1)]],
    ]);
    const pairs = firstPairs(fairPairs(offerMatchUnits(lenders, borrowers, 0)), MAX_PREVIEW_CALLS_PER_TICK);
    expect(pairs.some(([l, b]) => l.creator === LENDER && b.creator === HONEST)).toBe(true);
  });

  it('never pairs a creator with itself', () => {
    const lenders = new Map([['k', [offer(1, SPAMMER, 0), offer(2, LENDER, 0)]]]);
    const borrowers = new Map([['k', [offer(3, SPAMMER, 1), offer(4, LENDER, 1)]]]);
    const pairs = [...fairPairs(offerMatchUnits(lenders, borrowers, 0))];
    expect(pairs.every(([l, b]) => l.creator !== b.creator)).toBe(true);
    expect(pairs).toHaveLength(2);
  });

  it('moves which creator is first with the run', () => {
    const lenders = new Map([['k', [offer(1, LENDER, 0)]]]);
    const borrowers = new Map([['k', [offer(2, addr(1), 1), offer(3, addr(2), 1), offer(4, addr(3), 1)]]]);
    const firsts = new Set<string>();
    for (let run = 0; run < 6; run += 1) {
      firsts.add(firstPairs(fairPairs(offerMatchUnits(lenders, borrowers, run)), 1)[0][1].creator);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe('intentFillUnits', () => {
  const intent = (o: `0x${string}`) => ({ owner: o, lendingAsset: LEND, collateralAsset: COLL }) as LenderIntentSummary;

  it('gives every intent a candidate from every borrower creator in round 0', () => {
    const spam = Array.from({ length: 3000 }, (_, i) => offer(1000 + i, SPAMMER, 1));
    const intents = [intent(addr(0xa)), intent(addr(0xb))];
    const pairs = firstPairs(fairPairs(intentFillUnits(intents, [...spam, offer(2, HONEST, 1)], 0)), 4);
    for (const i of intents) {
      expect(pairs.some(([x, b]) => x === i && b.creator === HONEST)).toBe(true);
    }
  });
});

describe('runIntentFillPass — the honest borrower is filled with the last previews of a run', () => {
  it('fills the honest borrower although 50 refused spam offers are ahead of it in the book', async () => {
    const owner = addr(0xa);
    const intentRow = {
      owner, lendingAsset: LEND, collateralAsset: COLL, maxExposure: 10n ** 24n, minRateBps: 0n,
      maxInitLtvBps: 8000, maxDurationDays: 365, minFillAmount: 1n, requiresKeeperAuth: false,
      livePrincipal: 0n, availableCapital: 10n ** 24n,
    };
    const book = [...Array.from({ length: 50 }, (_, i) => offer(1000 + i, SPAMMER, 1)), offer(2, HONEST, 1)];
    const client = {
      readContract: vi.fn(async (req: { functionName: string; args: readonly unknown[] }) => {
        switch (req.functionName) {
          case 'keepersPaused':
            return false;
          case 'getActiveLenderIntents': {
            const [offset, limit] = req.args as readonly [bigint, bigint];
            return [[intentRow].slice(Number(offset), Number(offset + limit)), 1n];
          }
          case 'previewIntent': {
            const id = req.args[5] as bigint;
            // A borrower-specific refusal (BelowMinFill) for every spam offer.
            const e = id >= 1000n ? 9 : 0;
            return {
              ok: e === 0, intentError: e, matchError: 0, riskBlock: 0,
              matchAmount: 100n, matchRateBps: 500n, reqCollateral: 1n, availableCapital: 10n ** 24n,
            };
          }
          default:
            throw new Error(`unexpected read ${req.functionName}`);
        }
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', logs: [] })),
    };
    const wallet = {
      account: { address: addr(0xaa), type: 'local' },
      chain: undefined,
      writeContract: vi.fn(async () => `0x${'ab'.repeat(32)}`),
    };
    const ctx = { client, wallet, diamond: addr(0xd1), chainId: 84532 } as never;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      // Three previews left in the run: before #3242 they went to the first
      // three spam offers.
      const submits = await runIntentFillPass(ctx, book as never, () => false, 0, MAX_PREVIEW_CALLS_PER_TICK - 3, new Set());
      expect(submits).toBe(1);
      expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      log.mockRestore();
    }
  });
});
