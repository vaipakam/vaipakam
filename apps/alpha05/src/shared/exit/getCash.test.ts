import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Abi, type Log } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { StoredOffer } from '../offers/acceptTerms';
import type { IntentSummary } from '../offers/intents';
import { buyOfferCandidate, cashLogs, getCashKey, searchedAll, handoverCandidates, netFromProbe, routeState, type CashLoan, type GetCash } from './getCash';

type Hex = `0x${string}`;
const USDC: Hex = '0x00000000000000000000000000000000000000a1';
const WETH: Hex = '0x00000000000000000000000000000000000000b2';
const ME: Hex = '0x00000000000000000000000000000000000000c3';
const L1: Hex = '0x00000000000000000000000000000000000000d4';
const BORROWER: Hex = '0x00000000000000000000000000000000000000f6';
const DIAMOND: Hex = '0x00000000000000000000000000000000000000e5';

const err = (name: string, args: readonly unknown[] = []) => encodeErrorResult({ abi: DIAMOND_ABI_VIEM, errorName: name, args } as never) as Hex;

const loan: CashLoan = { loanId: 9n, lending: USDC, collateral: WETH, principal: 1000n, rateBps: 800n, fullTermInterest: false, borrower: BORROWER };

const intent = (p: Partial<IntentSummary> = {}): IntentSummary => ({
  owner: L1,
  lendingAsset: USDC,
  collateralAsset: WETH,
  slot: 0,
  maxExposure: 5000n,
  minRateBps: 500n,
  maxInitLtvBps: 7000,
  maxDurationDays: 90,
  minFillAmount: 10n,
  requiresKeeperAuth: false,
  livePrincipal: 0n,
  availableCapital: 2000n,
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
    amount: 1000n,
    amountMax: 0n,
    amountFilled: 0n,
    interestRateBps: 900n,
    accepted: false,
    ...p,
  }) as StoredOffer;

describe('routeState', () => {
  it('is open when the verdict lists no refusal', () => {
    expect(routeState([])).toEqual({ kind: 'open' });
  });
  it('names each refusal and reopens when the last one lifts', () => {
    const s = routeState([
      { reason: err('SaleOfferAlreadyExists'), reopensAt: 100n },
      { reason: err('EnforcedPause'), reopensAt: 300n },
    ]);
    expect(s.kind).toBe('closed');
    if (s.kind !== 'closed') return;
    expect(s.refusals.map((r) => r.code)).toEqual(['SaleOfferAlreadyExists', 'EnforcedPause']);
    expect(s.reopensAt).toBe(300);
  });
  it('states no time when any refusal waits on a decision', () => {
    const s = routeState([
      { reason: err('SaleOfferAlreadyExists'), reopensAt: 100n },
      { reason: err('EnforcedPause'), reopensAt: 0n },
    ]);
    expect(s.kind === 'closed' && s.reopensAt).toBeNull();
  });
  it('keeps an error this build cannot name as a stated refusal', () => {
    const s = routeState([{ reason: '0xdeadbeef', reopensAt: 0n }]);
    expect(s.kind === 'closed' && s.refusals[0]!.code).toBe('0xdeadbeef');
  });
});

describe('handoverCandidates', () => {
  it('keeps a slot on the pair that takes the rate and holds the principal', () => {
    expect(handoverCandidates([intent()], loan, ME)).toHaveLength(1);
  });
  it('leaves out the lender’s own, the borrower’s, a dearer slot, one short of capital and another pair', () => {
    const out = [intent({ owner: ME }), intent({ owner: BORROWER }), intent({ minRateBps: 900n }), intent({ availableCapital: 999n }), intent({ collateralAsset: USDC })];
    expect(handoverCandidates(out, loan, ME)).toEqual([]);
  });
});

describe('buyOfferCandidate', () => {
  it('takes a single-valued lender offer for exactly the principal, by someone else', () => {
    expect(buyOfferCandidate(offer(), loan, ME)).toBe(true);
  });
  it('refuses a ranged, part-filled, accepted, borrower-side, own or other-amount offer', () => {
    for (const o of [
      offer({ amountMax: 2000n }),
      offer({ amountFilled: 1n }),
      offer({ accepted: true }),
      offer({ offerType: 1 }),
      offer({ creator: ME }),
      offer({ amount: 999n }),
      offer({ lendingAsset: WETH }),
    ])
      expect(buyOfferCandidate(o, loan, ME)).toBe(false);
  });
});

describe('netFromProbe', () => {
  it('reads the sale’s own net from its refusal of an unreachable floor', () => {
    const raw = err('SaleNetBelowReviewed', [940n, (1n << 256n) - 1n]);
    expect(netFromProbe({ cause: { raw } })).toBe(940n);
    expect(netFromProbe({ cause: { data: { errorName: 'SaleNetBelowReviewed', args: [941n, 0n] } } })).toBe(941n);
  });
  it('answers nothing for any other refusal', () => {
    expect(netFromProbe({ cause: { raw: err('EnforcedPause') } })).toBeNull();
    expect(netFromProbe(new Error('network'))).toBeNull();
  });
});

describe('cashLogs', () => {
  const log = (name: string, args: Record<string, unknown>): Log => {
    const item = (DIAMOND_ABI_VIEM as readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean }[] }[]).find(
      (x) => x.type === 'event' && x.name === name,
    )!;
    const topics = (encodeEventTopics as (p: unknown) => Hex[])({ abi: [item] as Abi, eventName: name, args });
    const plain = item.inputs!.filter((i) => !i.indexed);
    const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
    return { address: DIAMOND, topics, data } as unknown as Log;
  };
  it('reads the handover’s payment, the sale and the listing for this loan only', () => {
    const logs = [
      log('InstantTakenOver', { loanId: 9n, outgoingLender: ME, incomingLender: L1, slot: 0, principalPaid: 1000n, interestLeftAsSellerClaim: 5n }),
      log('LoanSaleOfferLinked', { loanId: 9n, saleOfferId: 3n }),
      log('LoanSaleOfferLinked', { loanId: 8n, saleOfferId: 4n }),
    ];
    expect(cashLogs(logs, DIAMOND, 9n)).toEqual({ takenOverPaid: 1000n, sold: false, listed: true });
    expect(cashLogs(logs, DIAMOND, 7n)).toEqual({ takenOverPaid: null, sold: false, listed: false });
  });
});

describe('getCashKey', () => {
  it('changes when a route’s figure changes', () => {
    const base: GetCash = {
      direct: { kind: 'open' },
      listing: { kind: 'open' },
      reach: 'not-instant',
      handover: { kind: 'out-of-reach', why: 'not-instant' },
      sale: { kind: 'ready', offerId: 1n, rateBps: 900n, net: 990n },
      principal: 1000n,
      readAt: 0,
    };
    expect(getCashKey(base)).not.toBe(getCashKey({ ...base, sale: { kind: 'ready', offerId: 1n, rateBps: 900n, net: 980n } }));
    // A part repayment since the page loaded lowers what the handover pays.
    expect(getCashKey(base)).not.toBe(getCashKey({ ...base, principal: 900n }));
  });
  it('changes when a route found nothing but the search was bounded', () => {
    const base: GetCash = {
      direct: { kind: 'open' },
      listing: { kind: 'open' },
      reach: 'yes',
      handover: { kind: 'none', complete: true },
      sale: { kind: 'none', complete: true },
      principal: 1000n,
      readAt: 0,
    };
    expect(getCashKey(base)).not.toBe(getCashKey({ ...base, sale: { kind: 'none', complete: false } }));
  });
});

describe('searchedAll', () => {
  const none = (h: boolean, s: boolean): GetCash => ({
    direct: { kind: 'open' },
    listing: { kind: 'open' },
    reach: 'yes',
    handover: { kind: 'none', complete: h },
    sale: { kind: 'none', complete: s },
    principal: 1000n,
    readAt: 0,
  });
  it('says none only when every search that found nothing was complete', () => {
    expect(searchedAll(none(true, true))).toBe(true);
    expect(searchedAll(none(false, true))).toBe(false);
    expect(searchedAll(none(true, false))).toBe(false);
  });
  it('does not count a route that found something', () => {
    expect(searchedAll({ ...none(true, false), sale: { kind: 'ready', offerId: 1n, rateBps: 900n, net: 990n } })).toBe(true);
  });
});
