import { describe, expect, it } from 'vitest';
import { parsePositionHistory } from './positionHistory';

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b1'.repeat(20);
const TX = '0x' + 'cd'.repeat(32);

const loanBody = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  tokenId: '20',
  record: {
    kind: 'loan',
    loanId: 9,
    fromOfferId: 4,
    side: 'borrower',
    status: 'repaid',
    isCurrentToken: true,
    agreed: { principal: '1000', interestRateBps: 500, durationDays: 30 },
    lastCollateralAmount: '200',
    lendingAsset: A,
    collateralAsset: B,
    assetType: 0,
    collateralAssetType: 0,
    lentTokenId: '0',
    collateralTokenId: '0',
    startAt: 100,
    closedAt: 777,
  },
  retirement: { blockNumber: 60, logIndex: 0, txHash: TX, at: 720 },
  reason: 'loan-closed',
  ...over,
});

describe('parsePositionHistory (#3021)', () => {
  it('takes a loan record with its retirement and reason', () => {
    const h = parsePositionHistory(loanBody(), 84532, '20');
    expect(h?.record).toMatchObject({ kind: 'loan', loanId: 9, side: 'borrower', closedAt: 777 });
    expect(h?.retirement).toEqual({ blockNumber: 60, txHash: TX, at: 720 });
    expect(h?.reason).toBe('loan-closed');
  });

  it('keeps unconfirmed terms as null', () => {
    const body = loanBody();
    (body.record as Record<string, unknown>).agreed = {
      principal: null,
      interestRateBps: null,
      durationDays: null,
    };
    expect(parsePositionHistory(body, 84532, '20')?.record).toMatchObject({
      agreed: { principal: null, interestRateBps: null, durationDays: null },
    });
  });

  it('renders nothing for no record, another chain or token, or a malformed body', () => {
    expect(parsePositionHistory(loanBody({ record: null }), 84532, '20')).toBeNull();
    expect(parsePositionHistory(loanBody(), 1, '20')).toBeNull();
    expect(parsePositionHistory(loanBody(), 84532, '21')).toBeNull();
    expect(parsePositionHistory(null, 84532, '20')).toBeNull();
    const bad = loanBody();
    (bad.record as Record<string, unknown>).lendingAsset = 'not-an-address';
    expect(parsePositionHistory(bad, 84532, '20')).toBeNull();
    const badTx = loanBody({ retirement: { blockNumber: 1, txHash: '0x12', at: 1 } });
    expect(parsePositionHistory(badTx, 84532, '20')).toBeNull();
  });

  it('names no reason without a retirement, and none it does not know', () => {
    expect(parsePositionHistory(loanBody({ retirement: null }), 84532, '20')?.reason).toBeNull();
    expect(parsePositionHistory(loanBody({ reason: 'burned-by-admin' }), 84532, '20')?.reason).toBeNull();
  });

  it('takes an offer record, ranges included', () => {
    const h = parsePositionHistory(
      {
        chainId: 84532,
        tokenId: '11',
        record: {
          kind: 'offer',
          offerId: 3,
          side: 'lender',
          status: 'cancelled',
          amount: '1000',
          amountMax: '2000',
          interestRateBps: 500,
          interestRateBpsMax: 700,
          collateralAmount: '150',
          durationDays: 30,
          lendingAsset: A,
          collateralAsset: B,
          assetType: 0,
          collateralAssetType: 0,
        },
        retirement: { blockNumber: 50, logIndex: 0, txHash: TX, at: 600 },
        reason: 'offer-cancelled',
      },
      84532,
      '11',
    );
    expect(h?.record).toMatchObject({ kind: 'offer', offerId: 3, amountMax: '2000', interestRateBpsMax: 700 });
    expect(h?.reason).toBe('offer-cancelled');
  });
});
