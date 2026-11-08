import { describe, expect, it } from 'vitest';
import { OPEN } from '../eligibility/types';
import type { LoanDetails } from '../positions/loanView';
import { claimDestination, loanClaimReceipt } from './loanClaimReceipt';
import { loanClaimBlockers, loanClaimChanged, type LoanClaimReview } from './loanClaimReview';

const A = '0x00000000000000000000000000000000000000aa' as const;
const copy = { text: (k: string) => k, format: (k: string) => k } as never;
const on = { enabled: true, locked: false, delaySeconds: 3600, requireCosign: false };

const review: LoanClaimReview = {
  identity: '1:0xaa',
  loanId: 7n,
  side: 'borrower',
  loan: { status: 1, assetType: 0, principalAsset: A, collateralAsset: A, lender: A, borrower: A, lenderTokenId: 1n, borrowerTokenId: 2n } as unknown as LoanDetails,
  holder: A,
  paused: false,
  claim: null,
  lanes: [{ kind: 'row', asset: A, assetType: 0, tokenId: 0n, amount: 5n }],
  sellersShare: null,
  protection: { ...on, enabled: false },
  route: 'wallet',
  frozen: null,
  dryRun: null,
  verdict: OPEN,
  readAt: 1,
};
const lines = (r: LoanClaimReview) => loanClaimReceipt(r, null, copy).consequences.map(String);

describe('loanClaimReceipt payout route', () => {
  it('pays the wallet with no route note when the mode is off', () => {
    expect(claimDestination(review, copy)).toBe('loanClaim.toWallet');
    expect(lines(review).some((l) => l.startsWith('payout.'))).toBe(false);
  });
  it('states a queued payout, its secondary signer and a full queue with the shared words', () => {
    const queued: LoanClaimReview = { ...review, protection: { ...on, requireCosign: true }, route: 'queued' };
    expect(claimDestination(queued, copy)).toBe('payout.toQueuedCosign');
    expect(lines(queued)).toEqual(expect.arrayContaining(['payout.queuedNote', 'payout.cosignNote', 'loanClaim.queueFullNote']));
  });
  it('states the vault, a locked account and an unread mode', () => {
    expect(claimDestination({ ...review, protection: on, route: 'vault' }, copy)).toBe('payout.toVault');
    expect(lines({ ...review, protection: { ...on, locked: true }, route: 'held' })).toContain('payout.heldNote');
    const unread: LoanClaimReview = { ...review, protection: null, route: 'unknown' };
    expect(claimDestination(unread, copy)).toBeNull();
    expect(lines(unread)).toContain('payout.protectionUnread');
  });
  it('reopens when a queued payout’s signer requirement changes', () => {
    const queued: LoanClaimReview = { ...review, protection: on, route: 'queued' };
    expect(loanClaimChanged(queued, { ...queued, protection: { ...on, requireCosign: true } }, copy)).toBe('payout.changed');
    expect(loanClaimChanged(queued, queued, copy)).toBeNull();
  });
});

describe('loanClaimReceipt payout amount', () => {
  const amountRow = (r: LoanClaimReview) => loanClaimReceipt(r, null, copy).rows.find((x) => x.label === 'loanClaim.rowReceive')?.value;
  const open = { asset: A, amount: 0n, claimed: false, assetType: 0, tokenId: 0n, quantity: 0n, heldForLender: 0n, hasRentalNftReturn: false, surplus: null, liened: null };
  it('states an unread claim as unknown, never as zero', () => {
    expect(amountRow({ ...review, claim: null, lanes: [] })?.kind).toBe('unknown');
  });
  it('states zero only for a claim read open with nothing in it', () => {
    expect(amountRow({ ...review, claim: open, lanes: [] })).toEqual({ kind: 'text', text: 'loanClaim.zeroClaim' });
    expect(amountRow({ ...review, claim: { ...open, claimed: true }, lanes: [] })).toBeUndefined();
  });
});

describe('loanClaimReceipt seller share', () => {
  const lender: LoanClaimReview = { ...review, side: 'lender' };
  const sellers = (r: LoanClaimReview) => loanClaimReceipt(r, null, copy).rows.find((x) => x.label === 'loanClaim.rowSellers')?.value;
  it('states an unread seller share as unknown, with what it may take', () => {
    expect(sellers(lender)?.kind).toBe('unknown');
    expect(lines(lender)).toContain('loanClaim.sellersUnreadNote');
  });
  it('says nothing of sellers owed nothing, and nothing on the borrower side', () => {
    expect(sellers({ ...lender, sellersShare: 0n })).toBeUndefined();
    expect(lines({ ...lender, sellersShare: 0n })).not.toContain('loanClaim.sellersUnreadNote');
    expect(sellers(review)).toBeUndefined();
  });
});

describe('loanClaimBlockers frozen refusals (RB-FROZEN)', () => {
  const refused = (code: string) => ({ code, reason: 'raw', reopensAt: null, remedy: null });
  it('says a dry-run sanctions refusal in the frozen-proceeds words', () => {
    expect(loanClaimBlockers({ ...review, dryRun: refused('SanctionedAddress') }, copy)).toEqual(['frozen.claimRecorded']);
    expect(loanClaimBlockers({ ...review, dryRun: refused('SanctionsOracleUnavailable') }, copy)).toEqual(['frozen.claimOutage']);
    expect(loanClaimBlockers({ ...review, dryRun: refused('EnforcedPause') }, copy)).toEqual(['repay.dryRunRefused']);
  });
  it('reopens the review when the wallet’s standing changed', () => {
    expect(loanClaimChanged(review, { ...review, frozen: 'flagged' }, copy)).toBe('repay.changedVerdict');
  });
});
