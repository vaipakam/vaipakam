import { parseUnits } from 'viem';
import { AssetType } from '../types/loan';

/**
 * Schema and normalisation rules for the Create Offer form.
 *
 * The form speaks strings (input values); the Diamond speaks BigInts + enums.
 * Everything that bridges those two worlds lives here so the page component
 * stays focused on JSX and event wiring.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Loan-duration bounds. Single source of truth — both the Create-Offer
 * validator and the Offer Book duration filter inputs read from here so
 * the constraint can't drift between surfaces. Mirrored in the user-
 * facing whitepaper / user guides ("1 day to 365 days"). The contracts
 * don't enforce these on-chain (Phase 1); they are a product convention.
 */
export const MIN_OFFER_DURATION_DAYS = 1;
export const MAX_OFFER_DURATION_DAYS = 365;

export type OfferSide = 'lender' | 'borrower';
export type OfferAssetKind = 'erc20' | 'erc721' | 'erc1155';

/** Raw form state — every field is the string the user typed. */
export interface OfferFormState {
  offerType: OfferSide;
  assetType: OfferAssetKind;
  lendingAsset: string;
  amount: string;
  interestRate: string;
  collateralAsset: string;
  collateralAmount: string;
  durationDays: string;
  tokenId: string;
  quantity: string;
  prepayAsset: string;
  fallbackConsent: boolean;
  keeperAccess: boolean;
  collateralAssetType: OfferAssetKind;
  collateralTokenId: string;
  collateralQuantity: string;
  /** Lender-opt-in gate for borrower-initiated partial repay on the
   *  resulting loan. The acceptor consents implicitly by accepting; the
   *  flag is set by whichever side authored the offer. Snapshotted to
   *  `Loan.allowsPartialRepay` at init and read by `RepayFacet.repayPartial`. */
  allowsPartialRepay: boolean;
}

export const initialOfferForm: OfferFormState = {
  offerType: 'lender',
  assetType: 'erc20',
  lendingAsset: '',
  amount: '',
  interestRate: '',
  collateralAsset: '',
  collateralAmount: '',
  durationDays: '',
  tokenId: '',
  quantity: '1',
  prepayAsset: '',
  fallbackConsent: false,
  keeperAccess: false,
  collateralAssetType: 'erc20',
  collateralTokenId: '',
  collateralQuantity: '0',
  allowsPartialRepay: false,
};

/** Payload shape expected by `Diamond.createOffer`. */
export interface CreateOfferPayload {
  offerType: 0 | 1;
  lendingAsset: string;
  amount: bigint;
  interestRateBps: number;
  collateralAsset: string;
  collateralAmount: bigint;
  durationDays: number;
  assetType: 0 | 1 | 2;
  tokenId: bigint;
  quantity: bigint;
  creatorFallbackConsent: boolean;
  prepayAsset: string;
  collateralAssetType: 0 | 1 | 2;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  allowsPartialRepay: boolean;
}

/**
 * Discriminated error returned by {@link validateOfferForm}. Each `code`
 * maps to an `i18n` key under `createOffer.validate.<code>` so React
 * callers can localise without the schema module needing to import any
 * translator. `durationOutOfRange` carries the bound values as params
 * so the locale string can interpolate them.
 */
export type OfferFormError =
  | { code: 'lendingAssetInvalid' }
  | { code: 'amountNonPositive' }
  | { code: 'rateNegative' }
  | { code: 'durationOutOfRange'; min: number; max: number }
  | { code: 'nftTokenIdRequired' }
  | { code: 'collateralAssetInvalid' }
  | { code: 'prepayAssetInvalid' }
  | { code: 'fallbackConsentRequired' };

/**
 * Shallow field-by-field validation. Returns the first error found, or null
 * when everything looks submittable. We intentionally keep this simple —
 * the contract re-validates everything, so this is purely UX.
 */
export function validateOfferForm(s: OfferFormState): OfferFormError | null {
  if (!ADDRESS_RE.test(s.lendingAsset)) return { code: 'lendingAssetInvalid' };
  if (!s.amount || Number(s.amount) <= 0) return { code: 'amountNonPositive' };
  if (s.interestRate === '' || Number(s.interestRate) < 0) return { code: 'rateNegative' };
  const duration = Number(s.durationDays);
  if (!Number.isFinite(duration) || duration < MIN_OFFER_DURATION_DAYS || duration > MAX_OFFER_DURATION_DAYS) {
    return {
      code: 'durationOutOfRange',
      min: MIN_OFFER_DURATION_DAYS,
      max: MAX_OFFER_DURATION_DAYS,
    };
  }
  if (isNFTRental(s.assetType) && !s.tokenId) return { code: 'nftTokenIdRequired' };
  if (s.collateralAsset && !ADDRESS_RE.test(s.collateralAsset)) {
    return { code: 'collateralAssetInvalid' };
  }
  if (s.prepayAsset && !ADDRESS_RE.test(s.prepayAsset)) {
    return { code: 'prepayAssetInvalid' };
  }
  if (!s.fallbackConsent) {
    return { code: 'fallbackConsentRequired' };
  }
  return null;
}

export function isNFTRental(kind: OfferAssetKind): boolean {
  return kind === 'erc721' || kind === 'erc1155';
}

function kindToEnum(kind: OfferAssetKind): 0 | 1 | 2 {
  if (kind === 'erc20') return AssetType.ERC20;
  if (kind === 'erc721') return AssetType.ERC721;
  return AssetType.ERC1155;
}

/**
 * Converts validated form state into the BigInt/enum payload the Diamond
 * expects. Scaling uses the live on-chain `decimals()` values from each
 * ERC-20 (falls back to 18 for unknown/NFT-only offers) so entering "100"
 * produces 100 whole tokens regardless of whether the token is 6-decimal
 * (USDC) or 18-decimal (WETH). NFT quantities are treated as raw units.
 */
export interface OfferPayloadDecimals {
  lending?: number;
  collateral?: number;
}

export function toCreateOfferPayload(
  s: OfferFormState,
  decimals: OfferPayloadDecimals = {},
): CreateOfferPayload {
  const lendingDecimals = decimals.lending ?? 18;
  const collateralDecimals = decimals.collateral ?? 18;

  const collateralWei = s.collateralAssetType === 'erc20'
    ? parseUnits(s.collateralAmount || '0', collateralDecimals)
    : BigInt(s.collateralAmount || '0');

  const lendingAmount = s.assetType === 'erc20'
    ? parseUnits(s.amount, lendingDecimals)
    : BigInt(s.amount);

  return {
    offerType: s.offerType === 'lender' ? 0 : 1,
    lendingAsset: s.lendingAsset,
    amount: lendingAmount,
    interestRateBps: Math.round(parseFloat(s.interestRate) * 100),
    collateralAsset: s.collateralAsset || ZERO_ADDRESS,
    collateralAmount: collateralWei,
    durationDays: parseInt(s.durationDays, 10),
    assetType: kindToEnum(s.assetType),
    tokenId: BigInt(s.tokenId || '0'),
    quantity: BigInt(s.quantity || '1'),
    creatorFallbackConsent: s.fallbackConsent,
    prepayAsset: s.prepayAsset || ZERO_ADDRESS,
    collateralAssetType: kindToEnum(s.collateralAssetType),
    collateralTokenId: BigInt(s.collateralTokenId || '0'),
    collateralQuantity: BigInt(s.collateralQuantity || '0'),
    allowsPartialRepay: s.allowsPartialRepay,
  };
}

/**
 * Human-readable grace period derived from loan duration. Matches the
 * buckets enforced by `LibVaipakam` on-chain.
 */
export function gracePeriodLabel(days: number): string {
  if (days < 7) return '1 hour';
  if (days < 30) return '1 day';
  if (days < 90) return '3 days';
  if (days < 180) return '1 week';
  return '2 weeks';
}
