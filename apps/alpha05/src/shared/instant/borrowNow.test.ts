import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import type { StoredOffer } from '../offers/acceptTerms';
import type { IntentSummary } from '../offers/intents';
import { allowanceKey, candidateSlots } from '../tx/allowanceOverride';
import {
  borrowNowLogs,
  coverage,
  DEFAULT_BORROW_NOW,
  INSTANT_MARKET,
  instantRequest,
  MAX_SOURCES,
  offerCandidate,
  orderSources,
  parseBorrowNow,
  planFrom,
  restOf,
  restRequestInput,
  slotCandidates,
  type BorrowNowTerms,
  type Candidate,
} from './borrowNow';

type Hex = `0x${string}`;
const USDC: Hex = '0x00000000000000000000000000000000000000a1';
const WETH: Hex = '0x00000000000000000000000000000000000000b2';
const ME: Hex = '0x00000000000000000000000000000000000000c3';
const L1: Hex = '0x00000000000000000000000000000000000000d4';
const DIAMOND: Hex = '0x00000000000000000000000000000000000000e5';

const intent = (p: Partial<IntentSummary> = {}): IntentSummary => ({
  owner: L1,
  lendingAsset: USDC,
  collateralAsset: WETH,
  slot: 0,
  maxExposure: 1000n,
  minRateBps: 500n,
  maxInitLtvBps: 7000,
  maxDurationDays: 90,
  minFillAmount: 10n,
  requiresKeeperAuth: false,
  livePrincipal: 0n,
  availableCapital: 800n,
  lendUntil: 0n,
  acceptsProRata: true,
  ...p,
});

const offer = (p: Partial<StoredOffer> = {}): StoredOffer =>
  ({
    id: 7n,
    creator: L1,
    offerType: 0,
    assetType: 0,
    lendingAsset: USDC,
    collateralAsset: WETH,
    amount: 300n,
    amountMax: 0n,
    amountFilled: 0n,
    interestRateBps: 600n,
    useFullTermInterest: false,
    accepted: false,
    ...p,
  }) as StoredOffer;

const terms: BorrowNowTerms = { lending: USDC, collateral: WETH, amount: 1000n, collateralOffered: 5n, termDays: 30, maxRateBps: 800n, allowsPartialRepay: true };

describe('slotCandidates', () => {
  it('keeps a slot that fits, with its room the lower of exposure room and capital', () => {
    const c = slotCandidates([intent()], USDC, WETH, 0n, ME, 30, 800n);
    expect(c).toEqual([{ source: { kind: 0, owner: L1, slot: 0, offerId: 0n }, rateBps: 500n, room: 800n }]);
  });
  it('leaves out the borrower’s own, keeper-only, full-term-only, dearer, too-short and too-small slots', () => {
    const out = [
      intent({ owner: ME }),
      intent({ requiresKeeperAuth: true }),
      intent({ acceptsProRata: false }),
      intent({ minRateBps: 900n }),
      intent({ maxDurationDays: 20 }),
      intent({ availableCapital: 5n }),
      intent({ collateralAsset: USDC }),
    ];
    expect(slotCandidates(out, USDC, WETH, 0n, ME, 30, 800n)).toEqual([]);
  });
});

describe('offerCandidate', () => {
  it('takes an open lender offer that charges by time, at or under the limit', () => {
    expect(offerCandidate(7n, offer(), USDC, WETH, ME, 800n)).toEqual({
      source: { kind: 1, owner: '0x0000000000000000000000000000000000000000', slot: 0, offerId: 7n },
      rateBps: 600n,
      room: 300n,
    });
  });
  it('refuses a full-term, accepted, own, dearer or borrower offer', () => {
    expect(offerCandidate(7n, offer({ useFullTermInterest: true }), USDC, WETH, ME, 800n)).toBeNull();
    expect(offerCandidate(7n, offer({ accepted: true }), USDC, WETH, ME, 800n)).toBeNull();
    expect(offerCandidate(7n, offer({ creator: ME }), USDC, WETH, ME, 800n)).toBeNull();
    expect(offerCandidate(7n, offer({ interestRateBps: 900n }), USDC, WETH, ME, 800n)).toBeNull();
    expect(offerCandidate(7n, offer({ offerType: 1 }), USDC, WETH, ME, 800n)).toBeNull();
  });
  it('counts a range’s room from its ceiling less what is filled', () => {
    expect(offerCandidate(7n, offer({ amountMax: 500n, amountFilled: 200n }), USDC, WETH, ME, 800n)?.room).toBe(300n);
  });
});

describe('orderSources', () => {
  it('orders by rate, then by room, and caps at the protocol’s limit', () => {
    const mk = (rate: bigint, room: bigint, slot: number): Candidate => ({ source: { kind: 0, owner: L1, slot, offerId: 0n }, rateBps: rate, room });
    const out = orderSources([mk(600n, 10n, 1), mk(500n, 5n, 2), mk(500n, 50n, 3)]);
    expect(out.map((c) => c.source.slot)).toEqual([3, 2, 1]);
    expect(orderSources(Array.from({ length: 20 }, (_, i) => mk(500n, 1n, i)))).toHaveLength(MAX_SOURCES);
  });
});

describe('the plan', () => {
  const sources = [
    { kind: 0 as const, owner: L1, slot: 0, offerId: 0n },
    { kind: 1 as const, owner: '0x0000000000000000000000000000000000000000' as Hex, slot: 0, offerId: 7n },
  ];
  const plan = planFrom(
    [
      1n,
      [
        { sourceIndex: 1n, loanId: 4n, amount: 300n, rateBps: 600n, collateral: 2n },
        { sourceIndex: 0n, loanId: 5n, amount: 400n, rateBps: 500n, collateral: 2n },
      ],
    ],
    sources,
  );
  it('reads each fill against its source and totals them', () => {
    expect(plan.total).toBe(700n);
    expect(plan.collateralLocked).toBe(4n);
    expect(plan.fills[0]!.source.offerId).toBe(7n);
  });
  it('states the coverage and exactly the rest', () => {
    expect(coverage(plan, 1000n)).toBe('part');
    expect(coverage(plan, 700n)).toBe('all');
    expect(coverage(null, 700n)).toBe('none');
    expect(restOf(terms, plan)).toEqual({ amount: 300n, collateral: 1n });
  });
  it('fills the request form with the rest and the same limits, interest by time', () => {
    const input = restRequestInput(terms, { amount: 300_000_000n, collateral: 10n ** 17n }, { lending: 6, collateral: 18 });
    expect(input).toMatchObject({ amount: '300', collateral: '0.1', rate: '8', customTerm: true, termDays: '30', fullTerm: false, allowsPartialRepay: true });
  });
  it('carries the shown figure as the least the transaction borrows', () => {
    expect(instantRequest(terms, 700n, 99n)).toMatchObject({ minTotal: 700n, validUntil: 99n, amountWanted: 1000n, kind: 0 });
  });
});

describe('parseBorrowNow', () => {
  it('parses exact figures', () => {
    const r = parseBorrowNow({ ...DEFAULT_BORROW_NOW, amount: '100', collateral: '0.5', rate: '7.5' }, USDC, WETH, { lending: 6, collateral: 18 }, 365);
    expect(r).toEqual({
      ok: true,
      terms: { lending: USDC, collateral: WETH, amount: 100_000_000n, collateralOffered: 5n * 10n ** 17n, termDays: 30, maxRateBps: 750n, allowsPartialRepay: true },
    });
  });
  it('names each field it cannot read; the rate is never filled in', () => {
    const r = parseBorrowNow({ ...DEFAULT_BORROW_NOW, amount: '1.0000001', days: '999' }, USDC, WETH, { lending: 6, collateral: 18 }, 365);
    expect(r).toEqual({ ok: false, errors: { amount: 'decimals', collateral: 'empty', days: 'high', rate: 'empty' } });
  });
});

describe('borrowNowLogs', () => {
  const ev = (name: string, args: Record<string, unknown>): Log => {
    const item = (INSTANT_MARKET as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean; components?: unknown }[] }[]).find(
      (x) => x.type === 'event' && x.name === name,
    )!;
    const topics = (encodeEventTopics as (p: unknown) => Hex[])({ abi: [item], eventName: name, args }) as Hex[];
    const plain = item.inputs!.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
    return { address: DIAMOND, topics, data } as unknown as Log;
  };
  it('reads the total, the loans and the skipped count for this borrower', () => {
    const borrowed = (INSTANT_MARKET as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; components?: unknown }[] }[]).find(
      (x) => x.name === 'InstantBorrowed',
    )!;
    const args: Record<string, unknown> = {};
    for (const i of borrowed.inputs!) {
      if (i.name === 'borrower') args[i.name] = ME;
      else if (i.type === 'address') args[i.name] = USDC;
      else if (i.name === 'totalBorrowed') args[i.name] = 700n;
      else if (i.name === 'collateralLocked') args[i.name] = 4n;
      else if (i.name === 'fromWallet') args[i.name] = 1n;
      else if (i.type.endsWith('[]')) args[i.name] = [];
      else args[i.name] = 2n;
    }
    const opened = (INSTANT_MARKET as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string }[] }[]).find((x) => x.name === 'InstantLoanOpened')!;
    const oargs: Record<string, unknown> = {};
    for (const i of opened.inputs!) oargs[i.name] = i.name === 'loanId' ? 42n : 1n;
    const out = borrowNowLogs([ev('InstantLoanOpened', oargs), ev('InstantBorrowed', args)], DIAMOND, ME);
    expect(out).toEqual({ total: 700n, collateralLocked: 4n, fromWallet: 1n, loans: [42n], skipped: 0 });
    expect(borrowNowLogs([ev('InstantBorrowed', { ...args, borrower: L1 })], DIAMOND, ME)).toBeNull();
  });
});

describe('allowance override', () => {
  it('keys a plain mapping the Solidity way and tries the common slots first', () => {
    expect(allowanceKey(ME, DIAMOND, 1n)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(allowanceKey(ME, DIAMOND, 1n)).not.toBe(allowanceKey(ME, DIAMOND, 2n));
    const slots = candidateSlots();
    expect(slots.slice(0, 2)).toEqual([1n, 2n]);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
