import { describe, expect, it } from 'vitest';
import {
  DUE_SOON_SECONDS,
  LOAN_STATUS_ACTIVE,
  LOAN_STATUS_FALLBACK_PENDING,
  compareStages,
  loanObligations,
  mostUrgent,
  exposure,
  groupByOffer,
  isLiveStatus,
  loanStage,
  positionKey,
  type Deadlines,
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
      lenderTokenId: BigInt(2 * id),
      borrowerTokenId: BigInt(2 * id + 1),
      ...over,
    },
    healthFactor: 2n * 10n ** 18n,
    borrowerSide: false,
    ...rest,
  };
}

const NOW = 1_000_000;
const dl = (maturity: number, graceEnd: number, periodic: Deadlines['periodic'] = null): Deadlines => ({
  maturity: BigInt(maturity),
  graceEnd: BigInt(graceEnd),
  pauseCredit: 0n,
  periodic,
});
const cp = (periodEndAt: number, graceEndsAt: number, shortfall = 10n, enforced = true) => ({
  periodEndAt: BigInt(periodEndAt),
  graceEndsAt: BigInt(graceEndsAt),
  shortfall,
  enforced,
});

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

describe('loanObligations', () => {
  const far = NOW + 100 * 86_400;
  const ob = (d: Deadlines | null) => loanObligations(row(1), d, NOW);
  it('keeps an owed checkpoint beside the due date, never instead of it', () => {
    expect(ob(dl(far, far + 100, cp(NOW - 200, NOW - 1)))).toEqual({
      stage: { kind: 'running', dueAt: far },
      interest: { kind: 'interest-overdue', graceEndedAt: NOW - 1, shortfall: 10n },
    });
    expect(ob(dl(far, far + 100, cp(NOW - 1, NOW + 50))).interest?.kind).toBe('interest-in-grace');
    expect(ob(dl(far, far + 100, cp(NOW + 60, NOW + 99))).interest?.kind).toBe('interest-soon');
    expect(ob(dl(far, far + 100, cp(NOW + 10 * 86_400, NOW + 11 * 86_400))).interest).toEqual({ kind: 'interest-later', dueAt: NOW + 10 * 86_400, shortfall: 10n });
  });
  it('keeps both when the due date is in grace and a checkpoint just after it sells first', () => {
    // Due NOW-100, grace to NOW+3 days; the next checkpoint is tomorrow, its grace a day later.
    const o = ob(dl(NOW - 100, NOW + 3 * 86_400, cp(NOW + 86_400, NOW + 2 * 86_400)));
    expect(o.stage.kind).toBe('in-grace');
    expect(o.interest?.kind).toBe('interest-soon');
  });
  it("keeps a checkpoint on the due date, whose shorter grace ends before the loan's", () => {
    const o = ob(dl(NOW - 100, NOW + 7 * 86_400, cp(NOW - 100, NOW - 1)));
    expect(o).toMatchObject({ stage: { kind: 'in-grace' }, interest: { kind: 'interest-overdue' } });
    expect(mostUrgent(o).kind).toBe('interest-overdue');
  });
  it('drops a checkpoint with nothing owed, one switched off, and any on a fallback loan', () => {
    expect(ob(dl(far, far + 100, cp(NOW - 200, NOW - 1, 0n))).interest).toBeNull();
    expect(ob(dl(far, far + 100, cp(NOW - 200, NOW - 1, 10n, false))).interest).toBeNull();
    expect(loanObligations(row(1, { status: LOAN_STATUS_FALLBACK_PENDING }), dl(far, far + 100, cp(NOW - 200, NOW - 1)), NOW).interest).toBeNull();
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
  const values = (m: Record<number, bigint | null>) => (r: LiveLoanRow) => m[Number(r.loan.id)] ?? null;
  it('names the larger side when every loan is valued', () => {
    const e = exposure([row(1), row(2, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n }), true);
    expect(e).toMatchObject({ lent: 500n, borrowed: 200n, larger: 'lent' });
  });
  it('still names the larger side when the unvalued loans are all on it', () => {
    const e = exposure([row(1), row(3), row(2, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n, 3: null }), true);
    expect(e).toMatchObject({ larger: 'lent', unvaluedLent: 1 });
  });
  it('refuses to name a side an unvalued loan could overturn', () => {
    const e = exposure([row(1), row(2, {}, { borrowerSide: true }), row(3, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n, 3: null }), true);
    expect(e).toMatchObject({ larger: 'unknown', unvaluedBorrowed: 1 });
  });
  it('says only one side exists without comparing, and none when there are no loans', () => {
    expect(exposure([row(1, {}, { borrowerSide: true })], values({ 1: null }), true).larger).toBe('only-borrowed');
    expect(exposure([row(1)], values({}), true).larger).toBe('only-lent');
    expect(exposure([], values({}), true).larger).toBe('none');
  });
  it('draws no whole-book conclusion from a walk that stopped before the end', () => {
    expect(exposure([row(1)], values({ 1: 5n }), false)).toMatchObject({ larger: 'partial', lent: 5n });
    expect(exposure([row(1), row(2, {}, { borrowerSide: true })], values({ 1: 500n, 2: 200n }), false).larger).toBe('partial');
    expect(exposure([], values({}), false).larger).toBe('partial');
  });
  it('calls equal totals even only when nothing is unvalued', () => {
    expect(exposure([row(1), row(2, {}, { borrowerSide: true })], values({ 1: 5n, 2: 5n }), true).larger).toBe('even');
    expect(exposure([row(1), row(3), row(2, {}, { borrowerSide: true })], values({ 1: 5n, 2: 5n, 3: null }), true).larger).toBe('unknown');
  });
});

describe('positions', () => {
  it('counts Active and FallbackPending as live, and nothing else', () => {
    expect([0, 1, 2, 3, 4, 5, 6].filter(isLiveStatus)).toEqual([0, 4]);
  });
  it('keys a wallet holding both sides of one loan as two positions', () => {
    expect(positionKey(row(7))).not.toBe(positionKey(row(7, {}, { borrowerSide: true })));
  });
});
