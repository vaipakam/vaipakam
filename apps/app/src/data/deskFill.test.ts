/**
 * #1142 — the desk's tape, last-fill header and chart markers read a loan
 * only through `deskFillOf`, which carries the terms the loan was agreed at
 * and never the live ones an extension, repayment or match rewrites.
 */
import { describe, expect, it } from 'vitest';
import { TAPE_PLACEMENT_RULE, deskFillOf, marketTenorOf, tapeFromPage } from './desk';
import type { IndexedLoan, RecentLoansPage } from './indexer';

function loan(over: Partial<IndexedLoan>): IndexedLoan {
  return {
    loanId: 7,
    status: 'active',
    startAt: 1_000,
    principal: '40',
    interestRateBps: 900,
    durationDays: 60,
    initPrincipal: '100',
    initRateBps: 500,
    initDurationDays: 30,
    ...over,
  } as IndexedLoan;
}

describe('deskFillOf (#1142)', () => {
  it('takes the agreed rate and amount, not the live ones', () => {
    expect(deskFillOf(loan({}))).toEqual({
      loanId: 7,
      status: 'active',
      startAt: 1_000,
      rateBps: 500,
      principal: '100',
    });
  });

  it('says not recorded rather than falling back to the live terms', () => {
    expect(deskFillOf(loan({ initRateBps: null, initDurationDays: null, initPrincipal: null }))).toMatchObject({
      rateBps: null,
      principal: null,
    });
    // An older worker omits the fields entirely: same answer.
    const old = loan({});
    delete old.initRateBps;
    delete old.initDurationDays;
    delete old.initPrincipal;
    expect(deskFillOf(old)).toMatchObject({ rateBps: null, principal: null });
  });
});

describe('marketTenorOf (#1142)', () => {
  it('uses the indexer’s market key, so an extended loan stays in its agreed tenor', () => {
    expect(marketTenorOf(loan({ marketDurationDays: 30 }))).toBe(30);
  });

  it('never stands the live tenor in for a missing key: such a row is in no market', () => {
    expect(marketTenorOf(loan({}))).toBeNull();
  });

  it('keeps a loan the indexer placed in no market out of every tenor', () => {
    expect(marketTenorOf(loan({ marketDurationDays: null }))).toBeNull();
  });
});

describe('tapeFromPage (#1142)', () => {
  const pair = { lendingAsset: '0xAA', collateralAsset: '0xBB' };
  const scope = {
    lendingAsset: '0xaa',
    collateralAsset: '0xbb',
    durationDays: 30,
    placement: TAPE_PLACEMENT_RULE,
    excludeSaleVehicles: true,
  };
  const row = (over: Partial<IndexedLoan>) =>
    loan({ lendingAsset: '0xaa', collateralAsset: '0xbb', marketDurationDays: 30, ...over });
  const page = (loans: IndexedLoan[], s: unknown = scope) =>
    ({ chainId: 1, loans, nextBefore: null, scope: s }) as RecentLoansPage;

  it('returns the fills of a page that echoes this market\'s scope', () => {
    expect(tapeFromPage(page([row({ loanId: 3 })]), pair, 30)).toHaveLength(1);
  });

  it('proves an empty tape only through the echoed scope', () => {
    expect(tapeFromPage(page([]), pair, 30)).toEqual([]);
    // An older worker: no echo, so even an empty page is unavailable.
    const unscoped = { chainId: 1, loans: [], nextBefore: null } as RecentLoansPage;
    expect(tapeFromPage(unscoped, pair, 30)).toBeNull();
    expect(tapeFromPage(page([], null), pair, 30)).toBeNull();
    expect(tapeFromPage(page([], { ...scope, placement: null }), pair, 30)).toBeNull();
    expect(tapeFromPage(page([], { ...scope, durationDays: 60 }), pair, 30)).toBeNull();
    expect(tapeFromPage(page([], { ...scope, collateralAsset: '0xcc' }), pair, 30)).toBeNull();
    expect(tapeFromPage(page([], { ...scope, excludeSaleVehicles: false }), pair, 30)).toBeNull();
  });

  it('is unavailable when a row disagrees with the echoed scope, rather than filtering it', () => {
    expect(tapeFromPage(page([row({}), row({ marketDurationDays: 60 })]), pair, 30)).toBeNull();
    expect(tapeFromPage(page([row({ marketDurationDays: undefined })]), pair, 30)).toBeNull();
    expect(tapeFromPage(page([row({ isSaleVehicle: true })]), pair, 30)).toBeNull();
  });
});
