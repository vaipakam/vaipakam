/**
 * The claim payout, composed. Every rule here is a pure function so it is
 * tested rather than read:
 * - UX3-005 (revised #2373 r1) — the line beside a defaulted lender claim
 *   never states a figure: the amount owed at default is not available, and
 *   the loan's current principal is not what the current holder lent.
 * - #2373 r3–r5 — every lane the claim transaction pays appears; a lane
 *   whose token details are loading or unreadable says so instead of
 *   vanishing or being replaced by another lane.
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import {
  amountPhrase,
  borrowerPayoutWhat,
  defaultRecoveryNote,
  laneAmount,
  lenderPayoutWhat,
  nftClaimLabel,
  rentalPayoutWhat,
  type LaneAmount,
} from './useClaimPayout';

const labels = copy.claims.row;
const known = (text: string): LaneAmount => ({ kind: 'known', text });
const loading: LaneAmount = { kind: 'loading' };
const unreadable: LaneAmount = { kind: 'unreadable' };

describe('defaultRecoveryNote', () => {
  it('says an in-kind recovery is the collateral itself, not cash', () => {
    expect(defaultRecoveryNote({ hasHeld: false, inKind: true, labels })).toBe(labels.compareInKind);
  });

  it('does not call an in-kind recovery with held cash beside it "the collateral itself"', () => {
    expect(defaultRecoveryNote({ hasHeld: true, inKind: true, labels })).toBe(labels.recoveryNotComparable);
  });

  it('states the unknown for a cash recovery instead of computing a shortfall', () => {
    expect(defaultRecoveryNote({ hasHeld: false, inKind: false, labels })).toBe(labels.recoveryNotComparable);
  });

  // The #2373 r1 P1 defect: the note told a holder "the 500 WETH you lent",
  // computed from the loan's current principal. No case may claim the
  // holder lent anything, or state a number.
  it('never tells the holder what they lent, and never states a figure, in any case', () => {
    for (const hasHeld of [false, true]) {
      for (const inKind of [false, true]) {
        const note = defaultRecoveryNote({ hasHeld, inKind, labels });
        expect(note).not.toMatch(/you lent/i);
        expect(note).not.toMatch(/\d/);
      }
    }
  });
});

describe('laneAmount', () => {
  it('is nothing for a zero amount', () => {
    expect(laneAmount(0n, { data: { decimals: 6, symbol: 'USDC' }, isError: false })).toBeNull();
  });
  it('formats an amount whose token details loaded', () => {
    expect(laneAmount(5_000_000n, { data: { decimals: 6, symbol: 'USDC' }, isError: false })).toEqual(
      known('5 USDC'),
    );
  });
  it('is loading while the token details are being read', () => {
    expect(laneAmount(1n, { isError: false })).toEqual(loading);
  });
  // #2373 r5 — a token whose symbol/decimals revert must not read as
  // "loading" forever.
  it('is unreadable once the token details failed', () => {
    expect(laneAmount(1n, { isError: true })).toEqual(unreadable);
  });
  it('words each state for use inside a sentence', () => {
    expect(amountPhrase(known('5 USDC'), labels)).toBe('5 USDC');
    expect(amountPhrase(loading, labels)).toBe(labels.amountLoadingInline);
    expect(amountPhrase(unreadable, labels)).toBe(labels.amountUnreadableInline);
  });
});

describe('borrowerPayoutWhat', () => {
  const base = {
    status: 'defaulted' as const,
    base: null,
    returnedNft: null,
    rebate: null,
    surplus: null,
    extraCollateral: null,
    collateral: '1 WETH',
    labels,
  };

  it('keeps the base amount while its token details load, beside a rebate, in every status', () => {
    for (const status of ['repaid', 'defaulted', 'liquidated', 'internal_matched'] as const) {
      const what = borrowerPayoutWhat({ ...base, status, base: loading, rebate: '2 VPFI rebate' });
      expect(what.toLowerCase()).toContain(labels.amountLoadingInline.toLowerCase());
      expect(what).toContain('2 VPFI rebate');
    }
  });

  it('says a base amount is unreadable rather than loading forever', () => {
    const what = borrowerPayoutWhat({ ...base, base: unreadable });
    expect(what.toLowerCase()).toBe(labels.amountUnreadableInline.toLowerCase());
  });

  it('states every lane the claim pays', () => {
    const what = borrowerPayoutWhat({
      ...base,
      status: 'repaid',
      base: known('5 USDC'),
      rebate: '2 VPFI rebate',
      surplus: known('1 USDC'),
      extraCollateral: known('0.5 WETH'),
    });
    expect(what).toBe(
      [
        labels.collateralBackWithAmount('5 USDC', ''),
        '2 VPFI rebate',
        labels.swapSurplus('1 USDC'),
        labels.extraCollateral('0.5 WETH'),
      ].join(' + '),
    );
  });

  it('keeps a lane that is loading or unreadable rather than dropping it', () => {
    const what = borrowerPayoutWhat({ ...base, base: known('5 USDC'), surplus: loading, extraCollateral: unreadable });
    expect(what).toContain(labels.swapSurplus(labels.amountLoadingInline));
    expect(what).toContain(labels.extraCollateral(labels.amountUnreadableInline));
  });

  it('keeps a returned NFT when a rebate is also paid', () => {
    const what = borrowerPayoutWhat({
      ...base,
      status: 'repaid',
      returnedNft: 'NFT 0xab…cd #7',
      rebate: '2 VPFI rebate',
    });
    expect(what).toBe(`${labels.collateralBack('NFT 0xab…cd #7')} + 2 VPFI rebate`);
  });

  it('opens with a capital when the only lane is written as a continuation', () => {
    const what = borrowerPayoutWhat({ ...base, surplus: loading });
    expect(what.charAt(0)).toBe(what.charAt(0).toUpperCase());
  });

  it('falls back to a plain description only when no lane names anything', () => {
    expect(borrowerPayoutWhat(base)).toBe(labels.surplusAfterLiquidation);
    expect(borrowerPayoutWhat({ ...base, status: 'internal_matched' })).toBe(labels.residualAfterMatch);
    expect(borrowerPayoutWhat({ ...base, status: 'repaid' })).toBe(labels.collateralBack('1 WETH'));
  });
});

describe('lenderPayoutWhat', () => {
  const base = {
    base: null,
    nftClaim: null,
    held: null,
    principalPlusInterest: null,
    collateral: '1 WETH',
    labels,
  };

  it('keeps a non-fungible default recovery beside held proceeds', () => {
    const what = lenderPayoutWhat({ ...base, kind: 'default', nftClaim: 'NFT 0xab…cd #7', held: known('3 USDC') });
    expect(what).toBe(labels.recoveredFromDefault('NFT 0xab…cd #7', ` + ${labels.heldFor('3 USDC')}`));
  });

  // #2373 r5 — held proceeds are one asset (the loan's payment asset), so
  // their amount is stated, not hidden behind "held proceeds".
  it('states the held amount', () => {
    for (const kind of ['proper', 'fallback', 'default'] as const) {
      expect(lenderPayoutWhat({ ...base, kind, base: known('5 USDC'), held: known('3 USDC') })).toContain(
        labels.heldFor('3 USDC'),
      );
    }
  });

  it('keeps a loading amount beside held proceeds, in every kind', () => {
    for (const kind of ['proper', 'fallback', 'default'] as const) {
      const what = lenderPayoutWhat({ ...base, kind, base: loading, held: known('3 USDC') });
      expect(what.toLowerCase()).toContain(labels.amountLoadingInline.toLowerCase());
      expect(what).toContain(labels.heldFor('3 USDC'));
    }
  });

  it('names held proceeds alone only when the claim row names nothing', () => {
    expect(lenderPayoutWhat({ ...base, kind: 'default', held: known('3 USDC') })).toBe(labels.heldFor('3 USDC'));
    expect(lenderPayoutWhat({ ...base, kind: 'proper', held: known('3 USDC') })).toBe(labels.heldFor('3 USDC'));
  });

  it('marks every fallback payout as provisional', () => {
    for (const args of [{ base: known('2 WETH') }, { base: loading }, {}, { nftClaim: 'NFT 0xab…cd #7' }]) {
      const what = lenderPayoutWhat({ ...base, kind: 'fallback', ...args });
      expect(what).toBe(labels.provisionalAmount(what.slice(0, what.lastIndexOf(' ('))));
    }
  });

  it('states a repaid amount, or describes principal plus interest when none is named', () => {
    expect(lenderPayoutWhat({ ...base, kind: 'proper', base: known('5 USDC') })).toBe('5 USDC');
    expect(lenderPayoutWhat({ ...base, kind: 'proper', principalPlusInterest: '5 USDC + interest' })).toBe(
      '5 USDC + interest',
    );
    expect(lenderPayoutWhat({ ...base, kind: 'proper' })).toBe(labels.repaidFunds);
  });
});

describe('rentalPayoutWhat', () => {
  const nft = 'NFT 0xab…cd #7';
  // #2373 r5 — the fee amount is stated as loading, not dropped to the
  // amount-less "Rental fees" wording.
  it('keeps the lender fee amount while it loads', () => {
    const what = rentalPayoutWhat({ role: 'lender', base: loading, held: null, nft, labels });
    expect(what.toLowerCase()).toContain(labels.amountLoadingInline.toLowerCase());
    expect(what).not.toBe(labels.rentalFeesNftBack(nft));
  });
  it('states lender fees and held proceeds together', () => {
    expect(rentalPayoutWhat({ role: 'lender', base: known('4 USDC'), held: known('1 USDC'), nft, labels })).toBe(
      `${labels.feesNftBack('4 USDC', nft)} + ${labels.heldFor('1 USDC')}`,
    );
  });
  it('describes rental fees without an amount only when the claim names none', () => {
    expect(rentalPayoutWhat({ role: 'lender', base: null, held: null, nft, labels })).toBe(
      labels.rentalFeesNftBack(nft),
    );
  });
  it('states the borrower buffer, or says it is loading', () => {
    expect(rentalPayoutWhat({ role: 'borrower', base: known('2 USDC'), held: null, nft, labels })).toBe(
      labels.bufferBack('2 USDC'),
    );
    expect(rentalPayoutWhat({ role: 'borrower', base: loading, held: null, nft, labels }).toLowerCase()).toContain(
      labels.amountLoadingInline.toLowerCase(),
    );
  });
});

describe('nftClaimLabel', () => {
  const nftAddr = '0x00000000000000000000000000000000000000ab';
  it('is null for a fungible claim', () => {
    expect(nftClaimLabel({ asset: nftAddr, assetType: 0, tokenId: 0n, quantity: 0n })).toBeNull();
  });
  it('names an ERC-721 claim by token id', () => {
    expect(nftClaimLabel({ asset: nftAddr, assetType: 1, tokenId: 7n, quantity: 1n })).toMatch(/^NFT .+ #7$/);
  });
  it('adds the quantity for a multi-unit ERC-1155 claim', () => {
    expect(nftClaimLabel({ asset: nftAddr, assetType: 2, tokenId: 7n, quantity: 3n })).toMatch(/#7 ×3$/);
  });
  it('is null when the claim names no asset', () => {
    expect(nftClaimLabel({ asset: null, assetType: 1, tokenId: 7n, quantity: 1n })).toBeNull();
  });
});
