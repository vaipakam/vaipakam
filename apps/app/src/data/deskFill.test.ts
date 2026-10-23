/**
 * #1142 — the desk's tape, last-fill header and chart markers read a loan
 * only through `deskFillOf`, which carries the terms the loan was agreed at
 * and never the live ones an extension, repayment or match rewrites.
 */
import { describe, expect, it } from 'vitest';
import { deskFillOf, marketTenorOf } from './desk';
import type { IndexedLoan } from './indexer';

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

  it('falls back to the live tenor for an older worker, which scoped on it', () => {
    expect(marketTenorOf(loan({}))).toBe(60);
  });
});
