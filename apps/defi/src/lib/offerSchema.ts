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

/**
 * Bucketed duration presets exposed in the Create-Offer dropdown.
 * Frontend convention only — the contract still accepts any integer
 * `1 ≤ durationDays ≤ MAX_OFFER_DURATION_DAYS` for power users
 * calling the Diamond directly. The product reason for buckets is
 * matching: with seven discrete duration values, exact-equal
 * matches between lender and borrower offers happen frequently
 * enough that the keeper bot's matching pass produces useful
 * pairs without a duration-range model.
 *
 * Spread covers the typical lending window: 1 week → 1 year, with
 * 30-day intervals through the first quarter (where most flow
 * concentrates) and quarterly steps beyond. Adjust here, every
 * surface that imports the constant follows.
 */
export const OFFER_DURATION_BUCKETS_DAYS: readonly number[] = [
  7, 14, 30, 60, 90, 180, 365,
] as const;

/** Default duration selected when the form first renders. Median of
 *  the bucket list — matches the previous placeholder "30". */
export const OFFER_DURATION_DEFAULT_DAYS = 30;

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
  riskAndTermsConsent: boolean;
  keeperAccess: boolean;
  collateralAssetType: OfferAssetKind;
  collateralTokenId: string;
  collateralQuantity: string;
  /** Lender-opt-in gate for borrower-initiated partial repay on the
   *  resulting loan. The acceptor consents implicitly by accepting; the
   *  flag is set by whichever side authored the offer. Snapshotted to
   *  `Loan.allowsPartialRepay` at init and read by `RepayFacet.repayPartial`. */
  allowsPartialRepay: boolean;
  /** Range Orders Phase 1 — upper bound of the amount range. Empty
   *  string ⇒ single-value mode (auto-collapses to `amountMax = 0`
   *  in the payload, which the contract reads as "match exactly
   *  `amount`"). Only populated by the UI when the
   *  `rangeAmountEnabled` master flag is on AND the user is in
   *  Advanced mode. */
  amountMax: string;
  /** Range Orders Phase 1 — upper bound of the interest-rate range
   *  (entered as a percent like the base `interestRate` field, e.g.
   *  "5.5"). Empty ⇒ single-value mode. Gated on `rangeRateEnabled`
   *  + Advanced mode in the UI. */
  interestRateMax: string;
  /** Issue #164 — borrower-side upper bound of the collateral range.
   *  Empty ⇒ single-value mode (auto-collapses to
   *  `collateralAmountMax = 0` in the payload, which the contract
   *  reads as "lock exactly `collateralAmount`"). Lender offers must
   *  leave this empty — the contract rejects a lender offer with
   *  `collateralAmountMax > collateralAmount` regardless of the master
   *  flag. The UI input lands with #165 (basic/advanced parity); for
   *  now the field stays empty everywhere and the contract sees
   *  single-value collateral on every offer. */
  collateralAmountMax: string;
  /** T-034 — lender's chosen Periodic Interest Payment cadence.
   *  Numeric value matches the on-chain enum (0 = None ... 4 = Annual).
   *  Default `0` (None) preserves backward compat. Visible only when
   *  Advanced mode AND both legs are liquid AND
   *  `periodicInterestEnabled` is true on the protocol config. */
  periodicInterestCadence: number;
}

export const initialOfferForm: OfferFormState = {
  offerType: 'lender',
  assetType: 'erc20',
  lendingAsset: '',
  amount: '',
  interestRate: '',
  collateralAsset: '',
  collateralAmount: '',
  durationDays: String(OFFER_DURATION_DEFAULT_DAYS),
  tokenId: '',
  quantity: '1',
  prepayAsset: '',
  riskAndTermsConsent: false,
  keeperAccess: false,
  collateralAssetType: 'erc20',
  collateralTokenId: '',
  collateralQuantity: '0',
  allowsPartialRepay: false,
  amountMax: '',
  interestRateMax: '',
  collateralAmountMax: '',
  periodicInterestCadence: 0, // None
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
  creatorRiskAndTermsConsent: boolean;
  prepayAsset: string;
  collateralAssetType: 0 | 1 | 2;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  allowsPartialRepay: boolean;
  /** Range Orders Phase 1 — upper bound of the amount range.
   *  `0n` ⇒ auto-collapse to single value (the contract reads
   *  `amountMax == 0` as "use `amount`"). Otherwise must be
   *  ≥ `amount`. */
  amountMax: bigint;
  /** Range Orders Phase 1 — upper bound of the interest-rate range
   *  (BPS). `0` ⇒ auto-collapse. Otherwise must be ≥ `interestRateBps`. */
  interestRateBpsMax: number;
  /** Issue #164 — borrower-side upper bound of the collateral range.
   *  `0n` ⇒ auto-collapse (the contract reads `collateralAmountMax ==
   *  0` as "use `collateralAmount`"). Otherwise must be ≥
   *  `collateralAmount`. Lender offers must always pass `0n` here —
   *  the contract rejects ranged collateral on lender offers
   *  unconditionally. */
  collateralAmountMax: bigint;
  /** T-034 — Periodic Interest Payment cadence (0 = None ... 4 = Annual). */
  periodicInterestCadence: number;
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
  | { code: 'riskAndTermsConsentRequired' }
  | { code: 'amountMaxBelowMin' }
  | { code: 'rateMaxBelowMin' }
  | { code: 'collateralAmountMaxBelowMin' };

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
  if (!s.riskAndTermsConsent) {
    return { code: 'riskAndTermsConsentRequired' };
  }
  // Range Orders Phase 1 — when an upper bound is populated it must
  // be ≥ the corresponding minimum. Empty bounds auto-collapse and
  // are not validated. Numeric comparison here is fine because both
  // fields share units and parseFloat tolerates the input shape (the
  // payload-stage `parseUnits` is the integer-precision conversion).
  if (s.amountMax.trim() !== '' && Number(s.amountMax) < Number(s.amount)) {
    return { code: 'amountMaxBelowMin' };
  }
  if (
    s.interestRateMax.trim() !== ''
    && Number(s.interestRateMax) < Number(s.interestRate)
  ) {
    return { code: 'rateMaxBelowMin' };
  }
  // Issue #164 — borrower-side collateral upper bound, when populated,
  // must be ≥ the posted minimum. The contract enforces the same
  // invariant on-chain with `InvalidCollateralAmountRange`; this
  // client-side check exists purely to surface the gap before the user
  // pays gas.
  if (
    s.collateralAmountMax.trim() !== ''
    && Number(s.collateralAmountMax) < Number(s.collateralAmount)
  ) {
    return { code: 'collateralAmountMaxBelowMin' };
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

/**
 * Issue #165 / ADR-0010 §17.1 — canonical limit-order semantic mapping.
 *
 * The frontend translates user-meaningful headline numbers into the
 * contract's floor + ceiling storage fields per role. The user enters
 * ONE value per field per role; this function maps it appropriately.
 *
 *   Lender  "Lend up to X"          ⇒ amount=1wei,  amountMax=X
 *   Lender  "At min P%"             ⇒ interestRateBps=P*100, interestRateBpsMax=MAX_INTEREST_BPS
 *   Lender  "Require at least Z"    ⇒ collateralAmount=Z (single-value lender invariant)
 *   Borrower "Borrow at least Y"    ⇒ amount=Y,     amountMax=0 (contract derives from collateral × init-LTV cap)
 *   Borrower "At max Q%"            ⇒ interestRateBps=0, interestRateBpsMax=Q*100
 *   Borrower "Lock up to W"         ⇒ collateralAmount=0, collateralAmountMax=W (pre-escrowed)
 *
 * MAX_INTEREST_BPS mirrors `LibVaipakam.MAX_INTEREST_BPS = 10_000` (100% APR
 * — the contract's protocol cap). Lender's `amount = 1 wei` is the placeholder
 * described in ADR-0010 §5 (artifact of `params.amount > 0` invariant; behaves
 * as effectively zero against any practical borrower floor).
 *
 * Advanced-mode min/max sliders (the old `s.amountMax` / `s.interestRateMax` /
 * `s.collateralAmountMax` form-state fields) are no longer the canonical
 * input surface. They remain in `OfferFormState` for backwards-compat with
 * any deep-linked URL that still carries them, but the GTC default ignores
 * them entirely.
 */
const MAX_INTEREST_BPS = 10_000;

export function toCreateOfferPayload(
  s: OfferFormState,
  decimals: OfferPayloadDecimals = {},
): CreateOfferPayload {
  const lendingDecimals = decimals.lending ?? 18;
  const collateralDecimals = decimals.collateral ?? 18;
  const isLender = s.offerType === 'lender';

  // Single user-entered numbers (one per field per role).
  const userAmount = s.assetType === 'erc20'
    ? parseUnits(s.amount, lendingDecimals)
    : BigInt(s.amount);
  const userCollateral = s.collateralAssetType === 'erc20'
    ? parseUnits(s.collateralAmount || '0', collateralDecimals)
    : BigInt(s.collateralAmount || '0');
  const userRateBps = s.interestRate === ''
    ? 0
    : Math.round(parseFloat(s.interestRate) * 100);

  // Role-asymmetric routing — the lender's headline number is the
  // CEILING; the borrower's headline number is the FLOOR.
  const amount             = isLender ? 1n           : userAmount;
  const amountMax          = isLender ? userAmount   : 0n;
  const collateralAmount   = isLender ? userCollateral : 0n;
  const collateralAmountMax = isLender ? 0n           : userCollateral;
  const interestRateBps    = isLender ? userRateBps  : 0;
  const interestRateBpsMax = isLender ? MAX_INTEREST_BPS : userRateBps;

  return {
    offerType: isLender ? 0 : 1,
    lendingAsset: s.lendingAsset,
    amount,
    interestRateBps,
    collateralAsset: s.collateralAsset || ZERO_ADDRESS,
    collateralAmount,
    durationDays: parseInt(s.durationDays, 10),
    assetType: kindToEnum(s.assetType),
    tokenId: BigInt(s.tokenId || '0'),
    quantity: BigInt(s.quantity || '1'),
    creatorRiskAndTermsConsent: s.riskAndTermsConsent,
    prepayAsset: s.prepayAsset || ZERO_ADDRESS,
    collateralAssetType: kindToEnum(s.collateralAssetType),
    collateralTokenId: BigInt(s.collateralTokenId || '0'),
    collateralQuantity: BigInt(s.collateralQuantity || '0'),
    allowsPartialRepay: s.allowsPartialRepay,
    amountMax,
    interestRateBpsMax,
    collateralAmountMax,
    periodicInterestCadence: s.periodicInterestCadence,
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
