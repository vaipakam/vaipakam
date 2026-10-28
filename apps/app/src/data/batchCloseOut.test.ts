/**
 * #126 — the pure half of the batch close-out: which loans group, and
 * what the ready loans take per token. Grouping decides what the card
 * offers, so its exclusions are pinned one case each.
 */
import { describe, expect, it } from 'vitest';
import { AssetType } from '../lib/types';
import { borrowerOfferGroups, pullTotals, withHeldGroups, type GroupableLoan } from './batchCloseOut';
import type { CloseOutPlan } from './closeOutPlan';

const USDC = '0x00000000000000000000000000000000000000a1' as const;
const DAI = '0x00000000000000000000000000000000000000a2' as const;

const row = (loanId: number, offerId: number, over: Partial<GroupableLoan> = {}): GroupableLoan => ({
  loanId,
  offerId,
  role: 'borrower',
  status: 'active',
  assetType: AssetType.ERC20,
  lendingAsset: USDC,
  ...over,
});

describe('borrowerOfferGroups', () => {
  it('groups live borrower ERC-20 loans by offer, two or more per group, ordered', () => {
    const groups = borrowerOfferGroups([row(9, 5), row(3, 2), row(4, 5), row(1, 2), row(7, 8)]);
    expect(groups.map((g) => g.offerId)).toEqual([2, 5]);
    expect(groups[0].loans.map((l) => l.loanId)).toEqual([1, 3]);
    expect(groups[1].loans.map((l) => l.loanId)).toEqual([4, 9]);
  });

  it('leaves out lender rows, settled loans, rentals and offer 0', () => {
    const groups = borrowerOfferGroups([
      row(1, 2),
      row(2, 2, { role: 'lender' }),
      row(3, 2, { status: 'repaid' }),
      row(4, 2, { assetType: AssetType.ERC721 }),
      row(5, 0),
      row(6, 0),
    ]);
    expect(groups).toEqual([]);
  });

  it('counts a loan delivered twice once', () => {
    expect(borrowerOfferGroups([row(1, 2), row(1, 2)])).toEqual([]);
    const [g] = borrowerOfferGroups([row(1, 2), row(1, 2), row(3, 2)]);
    expect(g.loans.map((l) => l.loanId)).toEqual([1, 3]);
  });
});

describe('pullTotals', () => {
  const ready = (loanId: number, token: `0x${string}`, due: bigint, approve: bigint): CloseOutPlan => ({
    kind: 'ready',
    loanId,
    action: 'repay',
    functionName: 'repayLoan',
    pull: { token, due, approve },
    liveStatus: 0,
  });

  it('sums due and approval per token, case-insensitively, and skips refusals', () => {
    const totals = pullTotals([
      ready(1, USDC, 100n, 110n),
      ready(2, USDC.toUpperCase().replace('0X', '0x') as `0x${string}`, 50n, 55n),
      ready(3, DAI, 7n, 8n),
      { kind: 'refused', loanId: 4, action: 'repay', reason: 'no' },
    ]);
    expect(totals).toEqual([
      { token: USDC, due: 150n, approve: 165n },
      { token: DAI, due: 7n, approve: 8n },
    ]);
  });

  it('is empty when nothing is ready', () => {
    expect(pullTotals([{ kind: 'refused', loanId: 1, action: 'repay', reason: 'x' }])).toEqual([]);
  });
});

describe('withHeldGroups', () => {
  it('keeps a held group after it leaves the live list, and the held copy wins', () => {
    const live = borrowerOfferGroups([row(1, 2), row(3, 2), row(5, 9), row(6, 9)]);
    const heldFour = { offerId: 4, loans: [row(7, 4), row(8, 4)] };
    const heldNine = { offerId: 9, loans: [row(5, 9)] };
    const shown = withHeldGroups(live, new Map([[4, heldFour], [9, heldNine]]));
    expect(shown.map((g) => g.offerId)).toEqual([2, 4, 9]);
    expect(shown[2]).toBe(heldNine);
  });

  it('is the live list when nothing is held', () => {
    const live = borrowerOfferGroups([row(1, 2), row(3, 2)]);
    expect(withHeldGroups(live, new Map())).toEqual(live);
  });
});
