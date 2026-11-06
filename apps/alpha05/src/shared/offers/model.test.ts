import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFER_BORROWER } from './acceptTerms';
import { offer } from './testOffer';
import { acceptFigures, borrowFit, interestAtDue, listFee, movedBetween, notTakeable, rankForBorrower, shortfall } from './model';
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

  it('fits only someone else’s ERC-20 lender offer', () => {
    expect(borrowFit(offer(), ME)).toBe('fits');
    expect(borrowFit(offer({ creator: ME }), ME)).toBe('own');
    expect(borrowFit(offer({ offerType: OFFER_BORROWER }), ME)).toBe('not-lender');
    expect(borrowFit(offer({ collateralAssetType: 1 }), ME)).toBe('not-erc20');
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
    expect(rankForBorrower(rows).map((r) => r.offer.id)).toEqual([4n, 5n, 3n, 2n, 1n]);
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
