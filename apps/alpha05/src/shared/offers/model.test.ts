import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFER_BORROWER } from './acceptTerms';
import { offer } from './testOffer';
import { acceptFigures, gateBlock, interestAtDue, listFee, movedBetween, notTakeable, rankFor, lenderFigures, acceptorRole, offerFit, payLeg, shortfall } from './model';
import { ACCEPT_ERRORS, type AcceptPreview } from './reads';

const ME = '0x2222222222222222222222222222222222222222' as const;
const E18 = 10n ** 18n;

const preview = (over: Partial<AcceptPreview> = {}): AcceptPreview => ({
  effectivePrincipal: 2n * E18,
  interestRateBps: 500n,
  collateralAmount: 5000n * E18,
  lifEstimate: 4n * 10n ** 15n,
  collateralResidualRefund: 0n,
  error: 'None',
  ...over,
});

describe('the accept refusals', () => {
  it('name every AcceptError the contract declares, in order', () => {
    const sol = readFileSync(new URL('../../../../../contracts/src/facets/OfferAcceptFacet.sol', import.meta.url), 'utf8');
    const body = sol.slice(sol.indexOf('enum AcceptError {') + 18, sol.indexOf('}', sol.indexOf('enum AcceptError {')));
    const names = body
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .join('')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect([...ACCEPT_ERRORS]).toEqual(names);
  });
});

describe('interest at the due date', () => {
  it('follows principal × rate × term ÷ (365 days × 10,000), rounded down', () => {
    expect(interestAtDue(365n * E18, 1000n, 365n)).toBe((365n * E18) / 10n);
    expect(interestAtDue(2n * E18, 500n, 30n)).toBe((2n * E18 * 500n * 30n) / (365n * 10_000n));
    expect(interestAtDue(1n, 1n, 1n)).toBe(0n);
  });
});

describe('whether an offer can be taken', () => {
  it('puts a read failure and the offer state ahead of the preview', () => {
    expect(notTakeable('open', preview(), 'rpc down')).toEqual({ kind: 'unread', reason: 'rpc down' });
    expect(notTakeable('expired', preview({ error: 'OfferExpired' as AcceptPreview['error'] }), null)).toEqual({ kind: 'state', state: 'expired' });
    expect(notTakeable('open', preview({ error: 'KYCRequired' as AcceptPreview['error'] }), null)).toEqual({ kind: 'refused', error: 'KYCRequired' });
    expect(notTakeable('open', preview(), null)).toBeNull();
    expect(notTakeable(null, null, null)?.kind).toBe('unread');
  });

  it('fits only someone else’s ERC-20 offer from the other side', () => {
    expect(offerFit(offer(), ME, 'borrower')).toBe('fits');
    expect(offerFit(offer({ creator: ME }), ME, 'borrower')).toBe('own');
    expect(offerFit(offer({ offerType: OFFER_BORROWER }), ME, 'borrower')).toBe('other-side');
    expect(offerFit(offer({ collateralAssetType: 1 }), ME, 'borrower')).toBe('not-erc20');
    expect(offerFit(offer({ offerType: OFFER_BORROWER }), ME, 'lender')).toBe('fits');
    expect(offerFit(offer(), ME, 'lender')).toBe('other-side');
    expect(offerFit(offer({ offerType: OFFER_BORROWER, creator: ME }), ME, 'lender')).toBe('own');
  });

  it('names the acceptor by the offer’s side and what it pays', () => {
    expect(acceptorRole(offer())).toBe('borrower');
    expect(acceptorRole(offer({ offerType: OFFER_BORROWER }))).toBe('lender');
    const p = preview();
    expect(payLeg('borrower', offer(), p)).toEqual({ asset: offer().collateralAsset, amount: p.collateralAmount });
    expect(payLeg('lender', offer(), p)).toEqual({ asset: offer().lendingAsset, amount: p.effectivePrincipal });
  });
});

describe('the suggested order', () => {
  it('puts takeable offers first, then the lower rate, the larger amount, the older id', () => {
    const rows = [
      { offer: offer({ id: 1n, interestRateBps: 300n }), blocked: { kind: 'state' } },
      { offer: offer({ id: 2n, interestRateBps: 700n }), blocked: null },
      { offer: offer({ id: 3n, interestRateBps: 500n, amountMax: E18 }), blocked: null },
      { offer: offer({ id: 4n, interestRateBps: 500n }), blocked: null },
      { offer: offer({ id: 5n, interestRateBps: 500n }), blocked: null },
    ];
    expect(rankFor('borrower', rows).map((r) => r.offer.id)).toEqual([4n, 5n, 3n, 2n, 1n]);
  });
});

describe('the suggested order for a lender', () => {
  it('puts takeable requests first, then the higher rate, the larger amount, the older id', () => {
    const req = (o: Parameters<typeof offer>[0]) => offer({ offerType: OFFER_BORROWER, ...o });
    const rows = [
      { offer: req({ id: 1n, interestRateBpsMax: 900n }), blocked: { kind: 'state' } },
      { offer: req({ id: 2n, interestRateBpsMax: 300n }), blocked: null },
      { offer: req({ id: 3n, interestRateBpsMax: 500n, amount: 1n }), blocked: null },
      { offer: req({ id: 4n, interestRateBpsMax: 500n }), blocked: null },
      { offer: req({ id: 5n, interestRateBpsMax: 700n }), blocked: null },
    ];
    expect(rankFor('lender', rows).map((r) => r.offer.id)).toEqual([5n, 4n, 3n, 2n, 1n]);
  });
});

describe('the lender figures', () => {
  it('fund the whole principal, return the fee share, and keep the protocol share out of interest', () => {
    const p = preview();
    const f = lenderFigures(p, 365n, 100n, 200n);
    expect(f.principal).toBe(p.effectivePrincipal);
    expect(f.feeBack).toBe((p.lifEstimate * 100n) / 10_000n);
    expect(f.interest).toBe((p.effectivePrincipal * p.interestRateBps) / 10_000n);
    expect(f.protocolShare).toBe((f.interest * 200n) / 10_000n);
    expect(f.backAtDue).toBe(p.effectivePrincipal + f.interest - f.protocolShare);
  });
});

describe('the acceptance figures', () => {
  it('net the initiation fee from the principal and add interest at due', () => {
    const f = acceptFigures(preview(), 30n, 0n);
    expect(f.received).toBe(2n * E18 - 4n * 10n ** 15n);
    // The sender's share of the fee (1% here) reaches the wallet too.
    const g = acceptFigures(preview(), 30n, 100n);
    expect(g.feeBack).toBe(4n * 10n ** 13n);
    expect(g.received).toBe(2n * E18 - 4n * 10n ** 15n + 4n * 10n ** 13n);
    expect(f.owedAtDue).toBe(2n * E18 + interestAtDue(2n * E18, 500n, 30n));
    expect(listFee(2n * E18, 20n)).toBe(4n * 10n ** 15n);
    expect(shortfall(10n, 4n)).toBe(0n);
    expect(shortfall(3n, 4n)).toBe(1n);
  });

  it('name the first figure that moved between two reads', () => {
    expect(movedBetween(preview(), preview())).toBeNull();
    expect(movedBetween(preview(), preview({ interestRateBps: 501n }))).toBe('rate');
    expect(movedBetween(preview(), preview({ lifEstimate: 0n }))).toBe('fee');
    expect(movedBetween(preview(), preview({ error: 'ProtocolPaused' as AcceptPreview['error'] }))).toBe('refusal');
  });
});

describe('gateBlock', () => {
  it('blocks on the lender\'s code first, on this wallet\'s codes 1-3 and unknown ones, never on the acknowledgement-covered 4', () => {
    expect(gateBlock(2, 2)).toEqual({ creator: true, code: 2 });
    expect(gateBlock(1, 0)).toEqual({ creator: false, code: 1 });
    expect(gateBlock(9, 0)).toEqual({ creator: false, code: 9 });
    // The soft illiquid-pair code blocks too: only a pair consent clears it.
    expect(gateBlock(4, 0)).toEqual({ creator: false, code: 4 });
    expect(gateBlock(0, 0)).toBeNull();
  });
  it('marks a row the review would block as not takeable', () => {
    expect(notTakeable('open', preview(), null, gateBlock(3, 0))).toEqual({ kind: 'gate', block: { creator: false, code: 3 } });
    expect(notTakeable('open', preview(), null, gateBlock(4, 0))).toEqual({ kind: 'gate', block: { creator: false, code: 4 } });
  });
});
