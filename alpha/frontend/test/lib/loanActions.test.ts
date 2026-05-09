import { describe, it, expect } from 'vitest';
import {
  getLoanActionAvailability,
  type LoanActionContext,
} from '../../src/lib/loanActions';
import { LoanStatus, AssetType } from '../../src/types/loan';

function mkCtx(over: Partial<LoanActionContext> = {}): LoanActionContext {
  return {
    status: LoanStatus.Active,
    role: 'borrower',
    isOverdue: false,
    assetType: AssetType.ERC20,
    showAdvanced: true,
    walletConnected: true,
    ...over,
  };
}

describe('getLoanActionAvailability', () => {
  it('hides everything when the wallet is disconnected', () => {
    const a = getLoanActionAvailability(mkCtx({ walletConnected: false }));
    expect(a.repay).toBe(false);
    expect(a.addCollateral).toBe(false);
    expect(a.preclose).toBe(false);
    expect(a.refinance).toBe(false);
    expect(a.earlyWithdrawal).toBe(false);
    // triggerDefault is public; the JSX still hides it behind wallet-gate
    // because the button needs a signer. We mirror that via `isActive` only.
    expect(a.triggerDefault).toBe(false);
  });

  it('offers repay to a connected borrower on an active loan', () => {
    const a = getLoanActionAvailability(mkCtx({ role: 'borrower' }));
    expect(a.repay).toBe(true);
  });

  it('offers repay to a connected non-holder too (anyone can repay in full)', () => {
    const a = getLoanActionAvailability(mkCtx({ role: 'none' }));
    expect(a.repay).toBe(true);
    expect(a.addCollateral).toBe(false);
    expect(a.preclose).toBe(false);
  });

  it('hides repay from the lender — lenders cannot repay their own loan', () => {
    // Mirrors the contract guard `LenderCannotRepayOwnLoan` in
    // RepayFacet.repayLoan: repaying your own loan is economically
    // degenerate (lender pays themselves principal+interest minus the
    // 1% treasury cut), so the action is removed from the lender side.
    const a = getLoanActionAvailability(mkCtx({ role: 'lender' }));
    expect(a.repay).toBe(false);
  });

  it('hides repay once the loan is Repaid / Defaulted / Settled', () => {
    for (const status of [LoanStatus.Repaid, LoanStatus.Defaulted, LoanStatus.Settled]) {
      const a = getLoanActionAvailability(mkCtx({ status }));
      expect(a.repay).toBe(false);
      expect(a.addCollateral).toBe(false);
      expect(a.preclose).toBe(false);
      expect(a.refinance).toBe(false);
      expect(a.earlyWithdrawal).toBe(false);
    }
  });

  it('allows repay + addCollateral while FallbackPending (borrower can still cure)', () => {
    const a = getLoanActionAvailability(
      mkCtx({ status: LoanStatus.FallbackPending, role: 'borrower' }),
    );
    expect(a.repay).toBe(true);
    expect(a.addCollateral).toBe(true);
    // preclose/refinance/earlyWithdrawal require `isActive` (not FallbackPending).
    expect(a.preclose).toBe(false);
    expect(a.refinance).toBe(false);
    expect(a.earlyWithdrawal).toBe(false);
  });

  it('offers addCollateral only to the borrower in advanced mode', () => {
    expect(getLoanActionAvailability(mkCtx({ role: 'borrower', showAdvanced: true })).addCollateral).toBe(true);
    expect(getLoanActionAvailability(mkCtx({ role: 'borrower', showAdvanced: false })).addCollateral).toBe(false);
    expect(getLoanActionAvailability(mkCtx({ role: 'lender' })).addCollateral).toBe(false);
    expect(getLoanActionAvailability(mkCtx({ role: 'none' })).addCollateral).toBe(false);
  });

  it('exposes triggerDefault publicly once the loan is overdue', () => {
    expect(
      getLoanActionAvailability(mkCtx({ role: 'none', isOverdue: true })).triggerDefault,
    ).toBe(true);
    // Not yet overdue → hidden.
    expect(
      getLoanActionAvailability(mkCtx({ role: 'none', isOverdue: false })).triggerDefault,
    ).toBe(false);
    // Overdue but already Defaulted → hidden.
    expect(
      getLoanActionAvailability(
        mkCtx({ role: 'lender', isOverdue: true, status: LoanStatus.Defaulted }),
      ).triggerDefault,
    ).toBe(false);
  });

  it('offers earlyWithdrawal only to the lender on a non-overdue ERC-20 active loan', () => {
    expect(
      getLoanActionAvailability(mkCtx({ role: 'lender' })).earlyWithdrawal,
    ).toBe(true);
    expect(
      getLoanActionAvailability(mkCtx({ role: 'borrower' })).earlyWithdrawal,
    ).toBe(false);
    expect(
      getLoanActionAvailability(mkCtx({ role: 'lender', isOverdue: true })).earlyWithdrawal,
    ).toBe(false);
    expect(
      getLoanActionAvailability(mkCtx({ role: 'lender', assetType: AssetType.ERC721 }))
        .earlyWithdrawal,
    ).toBe(false);
  });

  it('offers preclose + refinance only to the borrower on ERC-20 active loans in advanced mode', () => {
    const advBorrowerErc20 = mkCtx({ role: 'borrower', showAdvanced: true, assetType: AssetType.ERC20 });
    const a = getLoanActionAvailability(advBorrowerErc20);
    expect(a.preclose).toBe(true);
    expect(a.refinance).toBe(true);

    // Basic mode hides both.
    const basic = getLoanActionAvailability(mkCtx({ role: 'borrower', showAdvanced: false }));
    expect(basic.preclose).toBe(false);
    expect(basic.refinance).toBe(false);

    // Lender never sees them.
    const lender = getLoanActionAvailability(mkCtx({ role: 'lender' }));
    expect(lender.preclose).toBe(false);
    expect(lender.refinance).toBe(false);

    // NFT-rental asset hides them.
    const nft = getLoanActionAvailability(
      mkCtx({ role: 'borrower', assetType: AssetType.ERC721 }),
    );
    expect(nft.preclose).toBe(false);
    expect(nft.refinance).toBe(false);

    // Overdue hides them.
    const overdue = getLoanActionAvailability(mkCtx({ role: 'borrower', isOverdue: true }));
    expect(overdue.preclose).toBe(false);
    expect(overdue.refinance).toBe(false);
  });
});
