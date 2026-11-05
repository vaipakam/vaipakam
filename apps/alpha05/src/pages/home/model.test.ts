import { describe, expect, it } from 'vitest';
import {
  DUE_SOON_SECONDS,
  LOAN_STATUS_ACTIVE,
  LOAN_STATUS_FALLBACK_PENDING,
  compareStages,
  exposure,
  groupByOffer,
  loanStage,
  type LiveLoanRow,
} from './model';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;

function row(id: number, over: Partial<LiveLoanRow['loan']> = {}, rest: Partial<Omit<LiveLoanRow, 'loan'>> = {}): LiveLoanRow {
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
      ...over,
    },
    healthFactor: 2n * 10n ** 18n,
    borrowerSide: false,
    ...rest,
  };
}

const NOW = 1_000_000;
const dl = (maturity: number, graceEnd: number) => ({ maturity: BigInt(maturity), graceEnd: BigInt(graceEnd), pauseCredit: 0n });

describe('loanStage', () => {
  it('names a fallback before reading any date', () => {
    expect(loanStage(row(1, { status: LOAN_STATUS_FALLBACK_PENDING }), null, NOW)).toEqual({ kind: 'fallback' });
  });
  it('says the deadline is unknown when it could not be read, never "running"', () => {
    expect(loanStage(row(1), null, NOW)).toEqual({ kind: 'deadline-unknown' });
  });
  it('walks running → due soon → in grace → grace over at the boundaries', () => {
    const due = NOW + DUE_SOON_SECONDS + 1;
    expect(loanStage(row(1), dl(due, due + 100), NOW).kind).toBe('running');
    expect(loanStage(row(1), dl(NOW + DUE_SOON_SECONDS, NOW + DUE_SOON_SECONDS + 100), NOW).kind).toBe('due-soon');
    expect(loanStage(row(1), dl(NOW, NOW + 100), NOW)).toEqual({ kind: 'in-grace', dueAt: NOW, graceEndsAt: NOW + 100 });
    expect(loanStage(row(1), dl(NOW - 100, NOW), NOW)).toEqual({ kind: 'grace-over', graceEndedAt: NOW });
  });
});

describe('compareStages', () => {
  it('puts an ended grace period first and a far due date last, earlier dates first within a stage', () => {
    const stages = [
      { kind: 'running', dueAt: 9 } as const,
      { kind: 'grace-over', graceEndedAt: 5 } as const,
      { kind: 'due-soon', dueAt: 3 } as const,
      { kind: 'running', dueAt: 4 } as const,
      { kind: 'in-grace', dueAt: 1, graceEndsAt: 2 } as const,
      { kind: 'deadline-unknown' } as const,
      { kind: 'fallback' } as const,
    ];
    expect([...stages].sort(compareStages).map((s) => s.kind)).toEqual(['grace-over', 'in-grace', 'fallback', 'deadline-unknown', 'due-soon', 'running', 'running']);
    expect([...stages].sort(compareStages).at(-1)).toEqual({ kind: 'running', dueAt: 9 });
  });
});

describe('groupByOffer', () => {
  it('groups the children of one offer with filled principal, weighted rate and the lowest priced health factor', () => {
    const rows = [
      row(1, { offerId: 7n, principal: 1_000n, interestRateBps: 400n }, { healthFactor: 3n }),
      row(2),
      row(3, { offerId: 7n, principal: 3_000n, interestRateBps: 800n }, { healthFactor: 2n }),
      row(4, { offerId: 7n, principal: 1_000n, interestRateBps: 400n }, { healthFactor: 0n }),
    ];
    const out = groupByOffer(rows);
    expect(out.map((e) => e.kind)).toEqual(['group', 'single']);
    const g = out[0]!.kind === 'group' ? out[0]!.group : null;
    expect(g?.principal).toBe(5_000n);
    // (1000*400 + 3000*800 + 1000*400) / 5000 = 640
    expect(g?.weightedRateBps).toBe(640n);
    expect(g?.minHealthFactor).toBe(2n);
    expect(g?.unpricedChildren).toBe(1);
    expect(g?.rows.map((r) => r.loan.id)).toEqual([1n, 3n, 4n]);
  });
  it('never groups across sides, assets or NFT legs, and leaves a lone child single', () => {
    const rows = [
      row(1, { offerId: 7n }),
      row(2, { offerId: 7n }, { borrowerSide: true }),
      row(3, { offerId: 7n, principalAsset: B }),
      row(4, { offerId: 8n, assetType: 1 }),
      row(5, { offerId: 8n, assetType: 1 }),
    ];
    expect(groupByOffer(rows).every((e) => e.kind === 'single')).toBe(true);
  });
  it('reports no lowest health factor when no child is priced', () => {
    const out = groupByOffer([row(1, { offerId: 7n }, { healthFactor: 0n }), row(2, { offerId: 7n }, { healthFactor: 0n })]);
    expect(out[0]!.kind === 'group' && out[0]!.group.minHealthFactor).toBeNull();
  });
});

describe('exposure', () => {
  const values = (m: Record<number, bigint | null>) => (id: bigint) => m[Number(id)] ?? null;
  it('names the larger side when every loan is valued', () => {
    const e = exposure([row(1), row(2, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n }));
    expect(e).toMatchObject({ lent: 500n, borrowed: 200n, larger: 'lent' });
  });
  it('still names the larger side when the unvalued loans are all on it', () => {
    const e = exposure([row(1), row(3), row(2, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n, 3: null }));
    expect(e).toMatchObject({ larger: 'lent', unvaluedLent: 1 });
  });
  it('refuses to name a side an unvalued loan could overturn', () => {
    const e = exposure([row(1), row(2, {}, { borrowerSide: true }), row(3, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n, 3: null }));
    expect(e).toMatchObject({ larger: 'unknown', unvaluedBorrowed: 1 });
  });
  it('says only one side exists without comparing, and none when there are no loans', () => {
    expect(exposure([row(1, {}, { borrowerSide: true })], values({ 1: null })).larger).toBe('only-borrowed');
    expect(exposure([row(1)], values({})).larger).toBe('only-lent');
    expect(exposure([], values({})).larger).toBe('none');
  });
  it('calls equal totals even only when nothing is unvalued', () => {
    expect(exposure([row(1), row(2, {}, { borrowerSide: true })], values({ 1: 5n, 2: 5n })).larger).toBe('even');
    expect(exposure([row(1), row(3), row(2, {}, { borrowerSide: true })], values({ 1: 5n, 2: 5n, 3: null })).larger).toBe('unknown');
  });
});
