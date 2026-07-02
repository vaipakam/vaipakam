export type OfferSide = 'lender' | 'borrower';
export type OfferAssetKind = 'erc20' | 'erc721' | 'erc1155';

export const OFFER_TYPE_LENDER = 0;
export const OFFER_TYPE_BORROWER = 1;
export const ASSET_TYPE_ERC20 = 0;
export const ASSET_TYPE_ERC721 = 1;
export const ASSET_TYPE_ERC1155 = 2;

export interface IndexedOffer {
  chainId: number;
  offerId: number;
  status: 'active' | 'accepted' | 'cancelled' | 'expired' | 'consumed_by_sale';
  creator: string;
  offerType: number;
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
  amount: string;
  amountMax: string;
  interestRateBps: number;
  interestRateBpsMax: number;
  collateralAmount: string;
  durationDays: number;
  tokenId: string;
  collateralTokenId: string;
  quantity: string;
  collateralQuantity: string;
  prepayAsset: string;
  useFullTermInterest: boolean;
  creatorRiskAndTermsConsent: boolean;
  allowsPartialRepay: boolean;
  createdAt?: number;
  expiresAt?: number;
  fillMode?: number;
}

export interface ActiveOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export interface CreatorOffersPage {
  chainId: number;
  creator: string;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export interface CreateOfferForm {
  offerType: OfferSide;
  assetType: OfferAssetKind;
  lendingAsset: string;
  amount: string;
  interestRate: string;
  collateralAsset: string;
  collateralAmount: string;
  durationDays: string;
  riskAndTermsConsent: boolean;
}