export interface IndexedLoan {
  chainId: number;
  loanId: number;
  offerId: number;
  status:
    | 'active'
    | 'repaid'
    | 'defaulted'
    | 'liquidated'
    | 'settled'
    | 'fallback_pending'
    | 'internal_matched';
  lender: string;
  borrower: string;
  principal: string;
  collateralAmount: string;
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
  interestRateBps: number;
  assetType: number;
  collateralAssetType: number;
  tokenId: string;
  collateralTokenId: string;
  startTime: number;
  maturityTime: number;
  updatedAt: number;
}

export interface LoansPage {
  chainId: number;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export interface ClaimableSummary {
  chainId: number;
  loanId: number;
  role: 'lender' | 'borrower';
  claimable: boolean;
  principalAsset?: string;
  principalAmount?: string;
  collateralAsset?: string;
  collateralAmount?: string;
}