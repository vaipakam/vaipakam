import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { LENDER, TLIQ, WETH } from '../offers/testOffer';
import type { LiveLoanRow, LoanSummary } from '../positions/model';
import { HISTORY_PAGE, historyRowFrom, readHistoryPage } from './history';
import { loansInMarket } from './markets';

const WALLET = getAddress(LENDER);

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    loanId: 7,
    status: 'repaid',
    lendingAsset: WETH.toLowerCase(),
    collateralAsset: TLIQ.toLowerCase(),
    durationDays: 30,
    assetType: 0,
    collateralAssetType: 0,
    isSaleVehicle: false,
    participatedAt: 1_000,
    roles: ['lender'],
    ...over,
  };
}

function indexer(answers: unknown[]): IndexerClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    origin: 'https://index.test',
    paths,
    getJson: async <T>(path: string) => {
      paths.push(path);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
}

describe('the desk history (OFF-76)', () => {
  it('reads a desk loan the wallet held a side of, with the status the index recorded', () => {
    const r = historyRowFrom(row({ roles: ['borrower', 'lender'], status: 'liquidated' }));
    expect(r).toEqual({
      loanId: 7n,
      lending: WETH.toLowerCase(),
      collateral: TLIQ.toLowerCase(),
      durationDays: 30,
      lent: true,
      borrowed: true,
      status: 'liquidated',
      participatedAt: 1_000,
    });
    expect(historyRowFrom(row({ status: 'something_new' })).status).toBe('unknown');
  });

  it('refuses rows outside the desk scope or with no side held', () => {
    expect(() => historyRowFrom(row({ assetType: 1 }))).toThrow();
    expect(() => historyRowFrom(row({ collateralAssetType: 2 }))).toThrow();
    expect(() => historyRowFrom(row({ isSaleVehicle: true }))).toThrow();
    expect(() => historyRowFrom(row({ lendingAsset: '0x' }))).toThrow();
    expect(() => historyRowFrom(row({ durationDays: 0 }))).toThrow();
    expect(() => historyRowFrom(row({ roles: [] }))).toThrow();
    expect(() => historyRowFrom(row({ participatedAt: 'soon' }))).toThrow();
  });

  it('asks for the desk scope one row past the page, and counts what it could not read', async () => {
    const ix = indexer([{ wallet: WALLET.toLowerCase(), loans: [row({ loanId: 9 }), row({ loanId: 8, assetType: 1 })], nextBefore: null }]);
    const p = await readHistoryPage(ix, 84532, WALLET, null);
    expect(ix.paths[0]).toContain('/loans/by-participant?');
    expect(ix.paths[0]).toContain('scope=desk');
    expect(ix.paths[0]).toContain(`limit=${HISTORY_PAGE + 1}`);
    expect(ix.paths[0]).toContain(`wallet=${WALLET.toLowerCase()}`);
    expect(ix.paths[0]).not.toContain('before=');
    expect(p.rows.map((r) => r.loanId)).toEqual([9n]);
    expect(p.unread).toBe(1);
    expect(p.next).toBeNull();
  });

  it('offers an older page only when the index returns a row past this one, from the last shown row', async () => {
    const full = Array.from({ length: HISTORY_PAGE }, (_, i) => row({ loanId: 100 - i, participatedAt: 5_000 - i }));
    const exact = await readHistoryPage(indexer([{ wallet: WALLET.toLowerCase(), loans: full, nextBefore: '4981_81' }]), 84532, WALLET, null);
    expect(exact.next).toBeNull();
    const more = [...full, row({ loanId: 1, participatedAt: 10 })];
    const ix = indexer([{ wallet: WALLET.toLowerCase(), loans: more, nextBefore: '10_1' }]);
    const p = await readHistoryPage(ix, 84532, WALLET, '6000_200');
    expect(ix.paths[0]).toContain('before=6000_200');
    expect(p.rows).toHaveLength(HISTORY_PAGE);
    expect(p.next).toBe(`${5_000 - HISTORY_PAGE + 1}_${100 - HISTORY_PAGE + 1}`);
  });

  it('refuses an answer for another wallet or without a list', async () => {
    await expect(readHistoryPage(indexer([{ wallet: '0x' + '9'.repeat(40), loans: [] }]), 84532, WALLET, null)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readHistoryPage(indexer([{ wallet: WALLET.toLowerCase() }]), 84532, WALLET, null)).rejects.toBeInstanceOf(IndexerUnavailable);
  });
});

describe('the viewer’s live loans in a market (OFF-76)', () => {
  const MARKET = { lending: getAddress(WETH), collateral: getAddress(TLIQ), durationDays: 30 };
  function live(over: Partial<LoanSummary>, borrowerSide = false): LiveLoanRow {
    const loan: LoanSummary = {
      id: 1n,
      offerId: 1n,
      principal: 10n,
      principalAsset: WETH,
      assetType: 0,
      tokenId: 0n,
      interestRateBps: 500n,
      durationDays: 30n,
      startTime: 0n,
      status: 0,
      collateralAsset: TLIQ,
      collateralAmount: 100n,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      lenderTokenId: 1n,
      borrowerTokenId: 2n,
      ...over,
    };
    return { loan, healthFactor: 0n, borrowerSide };
  }

  it('keeps only token loans in the market’s two tokens and term', () => {
    const rows = [
      live({ id: 1n }),
      live({ id: 2n }, true),
      live({ id: 3n, durationDays: 14n }),
      live({ id: 4n, collateralAsset: WETH }),
      live({ id: 5n, assetType: 1 }),
      live({ id: 6n, collateralAssetType: 1 }),
    ];
    expect(loansInMarket(rows, MARKET).map((r) => [r.loan.id, r.borrowerSide])).toEqual([
      [1n, false],
      [2n, true],
    ]);
  });
});
