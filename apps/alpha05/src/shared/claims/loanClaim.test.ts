import { describe, expect, it } from 'vitest';
import { claimVerdict, type ClaimInputs } from '../eligibility/claim';
import { claimLanes, extraLiened, sideClaimableStatus, sideOpen, type SideClaim } from './loanClaim';

const A = '0x00000000000000000000000000000000000000aa' as const;
const B = '0x00000000000000000000000000000000000000bb' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const ME = '0x00000000000000000000000000000000000000a3' as const;
const copy = { text: (k: string) => k } as never;

const empty: SideClaim = {
  asset: ZERO,
  amount: 0n,
  claimed: false,
  assetType: 0,
  tokenId: 0n,
  quantity: 0n,
  heldForLender: 0n,
  hasRentalNftReturn: false,
  surplus: null,
  liened: null,
};
const erc20Loan = { assetType: 0, principalAsset: A, prepayAsset: B, tokenId: 0n, quantity: 0n };

describe('sideClaimableStatus', () => {
  it('lets the lender claim in fallback and the borrower only once it has ended', () => {
    expect([1, 2, 5].every((s) => sideClaimableStatus('lender', s) && sideClaimableStatus('borrower', s))).toBe(true);
    expect(sideClaimableStatus('lender', 4)).toBe(true);
    expect(sideClaimableStatus('borrower', 4)).toBe(false);
    expect(sideClaimableStatus('lender', 0) || sideClaimableStatus('lender', 3)).toBe(false);
  });
});

describe('sideOpen and claimLanes', () => {
  it('keeps a lender claim recorded at zero open: it still closes the position', () => {
    const zero = { ...empty, asset: A };
    expect(sideOpen('lender', zero, 0)).toBe(true);
    expect(claimLanes('lender', zero, erc20Loan)).toEqual([]);
    expect(sideOpen('lender', empty, 0)).toBe(false);
  });
  it('lists the lender row, held funds and a rented NFT back, in order', () => {
    const c = { ...empty, asset: A, amount: 9n, heldForLender: 2n };
    expect(claimLanes('lender', c, erc20Loan).map((l) => [l.kind, l.asset, l.amount])).toEqual([
      ['row', A, 9n],
      ['held', A, 2n],
    ]);
    const rental = { assetType: 1, principalAsset: B, prepayAsset: A, tokenId: 4n, quantity: 0n };
    expect(claimLanes('lender', { ...empty, asset: A, amount: 3n }, rental).map((l) => [l.kind, l.asset, l.amount])).toEqual([
      ['row', A, 3n],
      ['rentalReturn', B, 1n],
    ]);
  });
  it('pays each borrower row on its own flag, the liened collateral whenever the claim runs', () => {
    const surplusOnly = { ...empty, asset: A, claimed: true, surplus: { asset: B, amount: 4n }, liened: { asset: B, amount: 1n } };
    expect(sideOpen('borrower', surplusOnly, 0)).toBe(true);
    expect(claimLanes('borrower', surplusOnly, erc20Loan).map((l) => l.kind)).toEqual(['liened', 'surplus']);
    expect(claimLanes('borrower', { ...empty, asset: A, claimed: true }, erc20Loan)).toEqual([]);
    expect(claimLanes('borrower', { ...empty, asset: A, assetType: 1, tokenId: 7n }, erc20Loan).map((l) => [l.kind, l.amount])).toEqual([['row', 1n]]);
  });
  it('counts liened collateral only in another token than the row', () => {
    expect(extraLiened({ asset: A, amount: 5n, released: false }, A)).toBeNull();
    expect(extraLiened({ asset: B, amount: 5n, released: true }, A)).toBeNull();
    expect(extraLiened({ asset: B, amount: 5n, released: false }, A)).toEqual({ asset: B, amount: 5n });
  });
});

describe('claimVerdict', () => {
  const claim: SideClaim = { ...empty, asset: A, amount: 9n };
  const base: ClaimInputs = { side: 'lender', status: 1, loanAssetType: 0, paused: false, holder: ME, claim };
  const code = (i: Partial<ClaimInputs>) => claimVerdict({ ...base, ...i }, ME, copy, 1).refusals[0]?.code ?? 'open';
  it('is open for the holder of a side with something to pay', () => {
    expect(code({})).toBe('open');
  });
  it('names the pause first, then the loan’s state, as the protocol checks them', () => {
    expect(claimVerdict({ ...base, paused: true }, ME, copy, 1).switchClass).toBe('2');
    expect(code({ paused: true, status: 0 })).toBe('EnforcedPause');
    expect(code({ status: 0 })).toBe('InvalidLoanStatus');
    expect(code({ side: 'borrower', status: 4 })).toBe('InvalidLoanStatus');
  });
  it('refuses a claimed or empty side before the holder, and another wallet', () => {
    expect(code({ claim: { ...claim, claimed: true }, holder: null })).toBe('AlreadyClaimed');
    expect(code({ side: 'borrower', claim: empty, holder: null })).toBe('NothingToClaim');
    expect(code({ holder: B })).toBe('NotNFTOwner');
    expect(code({ claim: empty })).toBe('NothingToClaim');
  });
  it('withholds the action while an input is unread', () => {
    expect(claimVerdict({ ...base, paused: null }, ME, copy, 1).state).toBe('unknown');
    expect(claimVerdict({ ...base, claim: null }, ME, copy, 1).state).toBe('unknown');
    expect(claimVerdict({ ...base, holder: null }, ME, copy, 1).state).toBe('unknown');
  });
});
