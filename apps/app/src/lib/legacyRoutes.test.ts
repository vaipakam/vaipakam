import { describe, expect, it } from 'vitest';
import {
  LEGACY_LOAN_SUBPAGE_ANCHORS,
  legacyCreateOfferTarget,
  legacyLoanTarget,
  parseLegacyOfferId,
} from './legacyRoutes';

describe('legacy loan sub-pages (#2076)', () => {
  it('lands each retired sub-page on the card that replaced it', () => {
    expect(legacyLoanTarget('7', 'early-withdrawal')).toBe('/positions/7#lender-exit-options');
    expect(legacyLoanTarget('7', 'preclose')).toBe('/positions/7#early-repay-options');
    expect(legacyLoanTarget('7', 'refinance')).toBe('/positions/7#refinance-card');
  });

  it('matches the sub-page case-insensitively, as the router does', () => {
    expect(legacyLoanTarget('7', 'PreClose')).toBe('/positions/7#early-repay-options');
  });

  it('still lands an unknown sub-page on the position, without an anchor', () => {
    expect(legacyLoanTarget('7', 'whatever')).toBe('/positions/7');
    expect(legacyLoanTarget('7')).toBe('/positions/7');
  });

  it('does not treat an inherited property name as a sub-page', () => {
    expect(legacyLoanTarget('7', 'constructor')).toBe('/positions/7');
    expect(Object.keys(LEGACY_LOAN_SUBPAGE_ANCHORS)).toEqual([
      'early-withdrawal',
      'preclose',
      'refinance',
    ]);
  });
});

describe('legacy create-offer (#2076)', () => {
  it('sends a refinance or offset deep link back to its loan', () => {
    expect(legacyCreateOfferTarget('?from=refinance&loanId=12&offerType=borrower')).toBe(
      '/positions/12#refinance-card',
    );
    expect(legacyCreateOfferTarget('?from=offset&loanId=12')).toBe(
      '/positions/12#early-repay-options',
    );
  });

  it('ignores a loan id that is not a number', () => {
    expect(legacyCreateOfferTarget('?from=offset&loanId=12x&offerType=lender')).toBe('/lend');
  });

  it('opens the form the side names, from either parameter', () => {
    expect(legacyCreateOfferTarget('?from=market-widget&side=lender')).toBe('/lend');
    expect(legacyCreateOfferTarget('?side=borrower')).toBe('/borrow');
    expect(legacyCreateOfferTarget('?offerType=lender')).toBe('/lend');
  });

  it('asks the home page question when nothing says which side', () => {
    expect(legacyCreateOfferTarget('')).toBe('/');
    expect(legacyCreateOfferTarget('?side=renter')).toBe('/');
  });
});

describe('legacy offer ids (#2076)', () => {
  it('accepts a decimal id and nothing else', () => {
    expect(parseLegacyOfferId('42')).toBe(42);
    expect(parseLegacyOfferId('0')).toBe(0);
    for (const bad of [undefined, '', '-1', '1.5', '0x2a', '42abc', '99999999999999999999']) {
      expect(parseLegacyOfferId(bad), String(bad)).toBeUndefined();
    }
  });
});
