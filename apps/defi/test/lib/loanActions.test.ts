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
    // T-086 step 13 defaults — NFT collateral + lender consent +
    // not-past-grace. Pre-T-086 the factory only seeded the loan-level
    // ERC20-principal fields, but the prepay-listing gate also reads
    // the collateral-side asset type, the lender's consent flag, and
    // the live grace window. Default to "all gates open" so the
    // base-case assertions in this file still pass; per-test
    // overrides via `over` flip individual fields.
    collateralAssetType: AssetType.ERC721,
    allowsPrepayListing: true,
    pastPrepayGrace: false,
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

  describe('prepayListing — T-086 step 13', () => {
    // The Seaport prepay-listing flow targets the active-borrower
    // on an ERC20-principal/NFT-collateral loan when the lender has
    // pre-consented. The cancel path stays callable post-grace, so
    // the availability flag intentionally DOESN'T gate on
    // `!pastPrepayGrace`; the child component switches to cancel-only
    // mode based on the prop. Tests below mirror each on-chain gate.

    it('offers prepayListing to the borrower on an active ERC20 NFT-collateral loan with consent', () => {
      const a = getLoanActionAvailability(mkCtx());
      expect(a.prepayListing).toBe(true);
    });

    it('hides prepayListing when the wallet is disconnected', () => {
      expect(
        getLoanActionAvailability(mkCtx({ walletConnected: false })).prepayListing,
      ).toBe(false);
    });

    it('hides prepayListing from the lender + third parties', () => {
      expect(getLoanActionAvailability(mkCtx({ role: 'lender' })).prepayListing).toBe(false);
      expect(getLoanActionAvailability(mkCtx({ role: 'none' })).prepayListing).toBe(false);
    });

    it('hides prepayListing once the loan transitions away from Active', () => {
      for (const status of [
        LoanStatus.Repaid,
        LoanStatus.Defaulted,
        LoanStatus.Settled,
      ]) {
        expect(getLoanActionAvailability(mkCtx({ status })).prepayListing).toBe(false);
      }
    });

    it('hides prepayListing when the principal is not ERC20', () => {
      // NFT-rental loans (ERC721/ERC1155 principal) can't fill via
      // Seaport prepay — the executor's `_assertOrderContent` rejects.
      expect(
        getLoanActionAvailability(mkCtx({ assetType: AssetType.ERC721 })).prepayListing,
      ).toBe(false);
      expect(
        getLoanActionAvailability(mkCtx({ assetType: AssetType.ERC1155 })).prepayListing,
      ).toBe(false);
    });

    it('hides prepayListing when the collateral is not an NFT', () => {
      // ERC20 collateral has no NFT identifier to list on Seaport.
      expect(
        getLoanActionAvailability(mkCtx({ collateralAssetType: AssetType.ERC20 })).prepayListing,
      ).toBe(false);
    });

    it('hides prepayListing when the lender did not pre-consent', () => {
      // `Offer.allowsPrepayListing = false` → snapshotted onto the
      // loan; the diamond reverts `PrepayListingNotAllowed` on post.
      expect(
        getLoanActionAvailability(mkCtx({ allowsPrepayListing: false })).prepayListing,
      ).toBe(false);
    });

    it('KEEPS prepayListing visible past grace — cancel must stay reachable', () => {
      // `cancelPrepayListing` is callable both pre- and post-grace
      // (only `cancelExpiredPrepayListing` is permissionless-post-grace).
      // The availability flag intentionally ignores `pastPrepayGrace`
      // so a stale listing can always be wound down. The child
      // component handles the post/update vs cancel-only branching.
      const a = getLoanActionAvailability(mkCtx({ pastPrepayGrace: true }));
      expect(a.prepayListing).toBe(true);
    });

    it('hides prepayListing on FallbackPending (only Active loans can list)', () => {
      // The on-chain `postPrepayListing` requires `LoanStatus.Active`.
      expect(
        getLoanActionAvailability(
          mkCtx({ status: LoanStatus.FallbackPending }),
        ).prepayListing,
      ).toBe(false);
    });
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
