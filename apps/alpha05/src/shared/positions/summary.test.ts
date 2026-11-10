import { describe, expect, it } from 'vitest';
import { LOAN_STATUS_ACTIVE, LOAN_STATUS_FALLBACK_PENDING, type Deadlines, type LiveLoanRow } from './model';
import { bookSummary } from './summary';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;
const NOW = 1_000_000;

function row(id: number, borrowerSide: boolean, over: Partial<LiveLoanRow['loan']> = {}): LiveLoanRow {
  return {
    loan: {
      id: BigInt(id),
      offerId: BigInt(100 + id),
      principal: 1_000n,
      principalAsset: A,
      assetType: 0,
      tokenId: 0n,
      interestRateBps: 500n,
      durationDays: 30n,
      startTime: 0n,
      status: LOAN_STATUS_ACTIVE,
      collateralAsset: B,
      collateralAmount: 1n,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      lenderTokenId: BigInt(2 * id),
      borrowerTokenId: BigInt(2 * id + 1),
      ...over,
    },
    healthFactor: 2n * 10n ** 18n,
    borrowerSide,
  };
}

const dl = (maturity: number, graceEnd: number, periodic: Deadlines['periodic'] = null): Deadlines => ({
  maturity: BigInt(maturity),
  graceEnd: BigInt(graceEnd),
  pauseCredit: 0n,
  periodic,
});

describe('the summary over a wallet’s live loans', () => {
  it('totals principal per token, never across tokens, and counts rentals instead of totalling them', () => {
    const rows = [
      row(1, true),
      row(2, true, { principal: 500n }),
      row(3, true, { principalAsset: B, principal: 7n }),
      row(4, true, { assetType: 1, tokenId: 9n }),
    ];
    const s = bookSummary(rows, () => dl(NOW + 100 * 86_400, NOW + 103 * 86_400), NOW).borrowed!;
    expect(s.loans).toBe(4);
    expect(s.principal).toEqual([
      { asset: A, amount: 1_500n },
      { asset: B, amount: 7n },
    ]);
    expect(s.rentals).toBe(1);
  });

  it('keeps the two sides apart and leaves out a side with no loans', () => {
    const r = bookSummary([row(1, false)], () => dl(NOW + 86_400 * 40, NOW + 86_400 * 43), NOW);
    expect(r.borrowed).toBeNull();
    expect(r.lent?.loans).toBe(1);
  });

  it('names the earliest date still ahead, repayment or interest, with its loan', () => {
    const periodic = { periodEndAt: BigInt(NOW + 5 * 86_400), graceEndsAt: BigInt(NOW + 6 * 86_400), shortfall: 3n, enforced: true };
    const deadlines: Record<string, Deadlines> = {
      '1': dl(NOW + 20 * 86_400, NOW + 23 * 86_400),
      '2': dl(NOW + 30 * 86_400, NOW + 33 * 86_400, periodic),
    };
    const s = bookSummary([row(1, true), row(2, true)], (r) => deadlines[r.loan.id.toString()]!, NOW).borrowed!;
    expect(s.next).toEqual({ loanId: 2n, at: NOW + 5 * 86_400, kind: 'interest' });
  });

  it('names a rental’s date as its close, never as a repayment', () => {
    const deadlines: Record<string, Deadlines> = { '1': dl(NOW + 20 * 86_400, NOW + 23 * 86_400), '2': dl(NOW + 10 * 86_400, NOW + 13 * 86_400) };
    const rows = [row(1, false), row(2, false, { assetType: 1, tokenId: 9n })];
    expect(bookSummary(rows, (r) => deadlines[r.loan.id.toString()]!, NOW).lent!.next).toEqual({ loanId: 2n, at: NOW + 10 * 86_400, kind: 'rental-close' });
    expect(bookSummary([rows[0]!], (r) => deadlines[r.loan.id.toString()]!, NOW).lent!.next?.kind).toBe('repayment');
  });
  it('lists loans in grace, past grace and in fallback by id, each once, and counts undated ones', () => {
    const overdueInterest = { periodEndAt: BigInt(NOW - 10 * 86_400), graceEndsAt: BigInt(NOW - 86_400), shortfall: 1n, enforced: true };
    const deadlines: Record<string, Deadlines | null> = {
      '1': dl(NOW - 86_400, NOW + 86_400),
      '2': dl(NOW - 5 * 86_400, NOW - 86_400),
      // In grace on its final date and past grace on interest: listed once, as past grace.
      '3': dl(NOW - 3600, NOW + 86_400, overdueInterest),
      '4': null,
      '5': dl(NOW + 86_400, NOW + 2 * 86_400),
    };
    const rows = [row(1, true), row(2, true), row(3, true), row(4, true), row(5, true, { status: LOAN_STATUS_FALLBACK_PENDING })];
    const s = bookSummary(rows, (r) => deadlines[r.loan.id.toString()] ?? null, NOW).borrowed!;
    expect(s.inGrace).toEqual([1n]);
    expect(s.pastGrace).toEqual([2n, 3n]);
    expect(s.undated).toEqual([4n]);
    expect(s.fallback).toEqual([5n]);
    expect(s.next).toBeNull();
  });
});
