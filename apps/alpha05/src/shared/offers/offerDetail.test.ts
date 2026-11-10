import { describe, expect, it } from 'vitest';
import { OFFER_BORROWER } from './acceptTerms';
import { detailAction, purposeOf, type OfferDetail } from './offerDetail';
import { BORROWER, LENDER, offer } from './testOffer';
import { parseOfferId } from '../../pages/offers/OfferPage';

type Found = Extract<OfferDetail, { kind: 'offer' }>;

function detail(over: Partial<Found> = {}, o = offer()): Found {
  return { kind: 'offer', id: o.id, offer: o, state: 'open', purpose: 'plain', linkedLoanId: 0n, block: 1n, ...over };
}

describe('an offer’s page', () => {
  it('names what an offer is for from the chain', () => {
    expect(purposeOf(offer(), 0n)).toBe('plain');
    expect(purposeOf(offer(), 5n)).toBe('offset');
    expect(purposeOf(offer({ offerType: OFFER_BORROWER }), 5n)).toBe('loan-sale');
    expect(purposeOf(offer({ offerType: OFFER_BORROWER, refinanceTargetLoanId: 3n }), 0n)).toBe('refinance');
    // Only a request can refinance.
    expect(purposeOf(offer({ refinanceTargetLoanId: 3n }), 0n)).toBe('plain');
  });
  it('offers taking an open ERC-20 loan offer, and asks for a wallet first', () => {
    expect(detailAction(detail(), BORROWER)).toEqual({ kind: 'accept' });
    expect(detailAction(detail(), null)).toEqual({ kind: 'connect' });
    expect(detailAction(detail({ purpose: 'refinance' }, offer({ offerType: OFFER_BORROWER, creator: BORROWER })), LENDER)).toEqual({ kind: 'accept' });
  });
  it('lets the creator cancel and anyone clean up an expired offer', () => {
    expect(detailAction(detail(), LENDER)).toEqual({ kind: 'cancel' });
    expect(detailAction(detail({ state: 'expired' }), BORROWER)).toEqual({ kind: 'clean-up' });
    expect(detailAction(detail({ state: 'expired' }), null)).toEqual({ kind: 'connect' });
  });
  it('says where a kind this app does not take yet is taken', () => {
    // An owner's listing is rented here, and a renter's request is taken here.
    expect(detailAction(detail({}, offer({ assetType: 1 })), BORROWER)).toEqual({ kind: 'rent' });
    expect(detailAction(detail({}, offer({ assetType: 2 })), null)).toEqual({ kind: 'connect' });
    expect(detailAction(detail({}, offer({ assetType: 1, offerType: OFFER_BORROWER, creator: BORROWER })), LENDER)).toEqual({ kind: 'take-request' });
    expect(detailAction(detail({}, offer({ assetType: 1, offerType: OFFER_BORROWER, creator: BORROWER })), null)).toEqual({ kind: 'connect' });
    expect(detailAction(detail({}, offer({ collateralAssetType: 1 })), BORROWER)).toEqual({ kind: 'elsewhere', why: 'nft' });
    expect(detailAction(detail({ purpose: 'loan-sale', linkedLoanId: 2n }), BORROWER)).toEqual({ kind: 'elsewhere', why: 'loan-sale' });
    expect(detailAction(detail({ purpose: 'offset', linkedLoanId: 2n }), null)).toEqual({ kind: 'elsewhere', why: 'offset' });
  });
  it('offers nothing on an ended offer', () => {
    for (const state of ['accepted', 'cancelled', 'sale-consumed'] as const) expect(detailAction(detail({ state }), BORROWER)).toEqual({ kind: 'none' });
  });
  it('reads an offer number from the address bar and nothing else', () => {
    expect(parseOfferId('42')).toBe(42n);
    expect(parseOfferId('0')).toBeNull();
    expect(parseOfferId('4x')).toBeNull();
    expect(parseOfferId(undefined)).toBeNull();
  });
});
