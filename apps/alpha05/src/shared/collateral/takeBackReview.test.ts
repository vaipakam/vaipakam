import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { destination, takeBackReceipt } from './takeBackReceipt';
import { takeBackBlockers, takeBackChanged, type TakeBackReview } from './takeBackReview';

const copy = { text: (k: string) => k, format: (k: string, v?: Record<string, string>) => (v?.max ? `${k}#${v.max}` : v?.reason ? `${k}#${v.reason}` : k) } as never;
const A = '0x00000000000000000000000000000000000000aa' as const;
const amountText = (v: bigint) => v.toString();

const review: TakeBackReview = {
  identity: '1:0xaa',
  loanId: 7n,
  amount: 5n,
  loan: { status: 0, assetType: 0, collateralAsset: A, collateralAmount: 100n, principal: 10n, principalAsset: A, borrowerTokenId: 2n } as unknown as LoanDetails,
  borrowerHolder: A,
  borrowerLock: 0,
  paused: false,
  refinanceLive: false,
  collateralLiquid: true,
  maxWithdrawable: 20n,
  healthFactor: 2n * 10n ** 18n,
  ltvBps: 4000n,
  protection: { enabled: false, locked: false, delaySeconds: 0, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const },
  route: 'wallet',
  amountCheck: { ok: true },
  dryRun: null,
  verdict: OPEN,
  readAt: 1,
};

describe('takeBackBlockers', () => {
  it('is empty when the rule, the amount and the dry run all pass', () => {
    expect(takeBackBlockers(review, copy, amountText)).toEqual([]);
  });
  it('names an amount above the limit now', () => {
    expect(takeBackBlockers({ ...review, amountCheck: { ok: false, why: 'over-limit' } }, copy, amountText)).toEqual(['takeBack.overLimit#20']);
  });
  it('blocks on a dry run that could not be run, and names its refusal', () => {
    expect(takeBackBlockers({ ...review, dryRun: 'unread' }, copy, amountText)).toEqual(['takeBack.dryRunUnread']);
    expect(takeBackBlockers({ ...review, dryRun: { code: 'SaleListingActive', reason: 'listed', reopensAt: null, remedy: null } }, copy, amountText)).toEqual([
      'repay.dryRunRefused#listed',
    ]);
  });
});

describe('takeBackChanged', () => {
  it('reopens on a stated loan field or a hold, not on the limit or figures moving with prices', () => {
    expect(takeBackChanged(review, { ...review, maxWithdrawable: 3n, healthFactor: 1n, ltvBps: 1n }, copy)).toBeNull();
    expect(takeBackChanged(review, { ...review, loan: { ...review.loan, collateralAmount: 90n } }, copy)).toBe('repay.changedLoan');
    expect(takeBackChanged(review, { ...review, refinanceLive: true }, copy)).toBe('repay.changedHolders');
  });
});

describe('takeBackReceipt', () => {
  it('states the collateral after and an unread limit as unknown', () => {
    const rows = takeBackReceipt({ ...review, maxWithdrawable: null }, null, copy).rows;
    expect(rows.find((r) => r.label === 'addColl.rowAfter')?.value).toEqual({ kind: 'amount', asset: A, amount: 95n });
    expect(rows.find((r) => r.label === 'takeBack.rowMax')?.value.kind).toBe('unknown');
  });
  it('asks one prompt and states the consequences', () => {
    const r = takeBackReceipt(review, null, copy);
    expect(r.prompts).toBe(1);
    expect(r.consequences.map(String)).toEqual(['takeBack.closer', 'takeBack.limitMoves', 'takeBack.afterFigures', 'takeBack.pauseHolds']);
  });
});

describe('takeBack protected account mode', () => {
  const lines = (r: TakeBackReview) => takeBackReceipt(r, null, copy).consequences.map(String);
  const on = { enabled: true, locked: false, delaySeconds: 86_400, requireCosign: false, retired: false, controller: '0x0000000000000000000000000000000000000000' as const };
  const queued: TakeBackReview = { ...review, protection: on, route: 'queued' };
  it('sends to the wallet at once when the mode is off', () => {
    expect(destination(review, copy)).toBe('takeBack.to');
    expect(lines(review)).not.toContain('payout.queuedNote');
    expect(lines(review)).not.toContain('payout.protectionUnread');
  });
  it('states the payout queue for the borrower’s own withdrawal, and the unknown when unread', () => {
    expect(destination(queued, copy)).toBe('payout.toQueued');
    expect(lines(queued)).toContain('payout.queuedNote');
    expect(lines(queued)).not.toContain('payout.cosignNote');
    const unread: TakeBackReview = { ...review, protection: null, route: 'unknown' };
    expect(destination(unread, copy)).toBeNull();
    expect(takeBackReceipt(unread, null, copy).rows.find((r) => r.label === 'takeBack.rowTo')?.value.kind).toBe('unknown');
    expect(lines(unread)).toContain('payout.protectionUnread');
  });
  it('states that a release needs a secondary signer while the account requires it', () => {
    const cosign: TakeBackReview = { ...queued, protection: { ...on, requireCosign: true } };
    expect(destination(cosign, copy)).toBe('payout.toQueuedCosign');
    expect(lines(cosign)).toContain('payout.cosignNote');
  });
  it('reopens the review when the route, the delay or the secondary signer changes', () => {
    expect(takeBackChanged(review, queued, copy)).toBe('payout.changed');
    expect(takeBackChanged(queued, { ...queued, protection: { ...on, delaySeconds: 3600 } }, copy)).toBe('payout.changed');
    expect(takeBackChanged(queued, { ...queued, protection: { ...on, requireCosign: true } }, copy)).toBe('payout.changed');
    expect(takeBackChanged(review, { ...review, protection: { ...review.protection!, delaySeconds: 3600 } }, copy)).toBeNull();
  });
});
