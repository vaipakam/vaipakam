import { parseUnits } from 'viem';
import { AssetType } from './types';

/**
 * COPIED VERBATIM from apps/defi/src/lib/offerSchema.ts (only the
 * AssetType import path changed). The role-asymmetric floor/ceiling
 * mapping in `toCreateOfferPayload` is subtle and battle-tested — do
 * not re-derive it here; if the wire shape changes, re-copy from the
 * defi original (or promote the module to packages/lib and delete
 * this copy — tracked as an alpha02 follow-up).
 *
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
  /** T-086 Round-8 (#358) §19.5 — borrower opt-in for parallel-sale
   *  listing on OpenSea / Seaport-conformant marketplaces. Only valid
   *  on Borrower offers with NFT collateral; the contract rejects the
   *  flag on lender / non-NFT-collateral offers. Visible only in
   *  Advanced mode when offerType=borrower AND collateralAssetType is
   *  erc721 or erc1155. */
  allowsParallelSale: boolean;
  /** T-092 #511 sub (#523) — refinance target loan id. Empty string
   *  ⇒ standard borrower offer (no refinance intent). When set, the
   *  offer is created with the intent to refinance the named loan;
   *  the contract enforces `params.fillMode == Aon` and the
   *  borrower's per-loan `autoRefinanceCaps` at both create and
   *  accept. Only valid on Borrower offers; the form auto-hides on
   *  Lender. */
  refinanceTargetLoanId: string;
  /** #408 / #410 / #413 (2026-06-12) — lender's election for the
   *  full-term floor interest settlement model. When `true` (the
   *  default), early repay charges the floor: `max(elapsed, duration)
   *  - interestSettled`. When `false`, falls back to pure pro-rata-
   *  elapsed. */
  useFullTermInterest: boolean;
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
  allowsParallelSale: false, // T-086 Round-8 #358 — explicit opt-in
  refinanceTargetLoanId: '', // T-092 #511 sub (#523) — standard offer; non-empty enables refinance-tagged flow
  useFullTermInterest: true, // #408 — default true; lenders opt OUT for "soft" pro-rata loans
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
  /** T-086 Round-8 (#358) §19.5 — borrower opt-in for parallel-sale
   *  listing on OpenSea / Seaport-conformant marketplaces. Wired
   *  through the createOffer ABI in commit `1938ba79`; the contract
   *  rejects the flag on lender / non-NFT-collateral offers. */
  allowsParallelSale: boolean;
  /** #125 — DEX-style fill mode flavour
   *    0 = Partial (default; today's behaviour)
   *    1 = Aon (all-or-nothing)
   *    2 = Ioc (immediate-or-cancel; paired with expiresAt)
   *  Round-8 Codex round-8 P2 #4 forces Aon on parallel-sale offers —
   *  partial / IOC fills create multiple loans against a single
   *  offer's collateral, incompatible with parallel-sale's single-loan
   *  split-on-fill assumption. {@link toCreateOfferPayload} sets this
   *  automatically based on `allowsParallelSale`. */
  fillMode: number;
  /** #195 — Good-Til-Time deadline as a uint64 unix-seconds stamp.
   *  `0n` ⇒ Good-Til-Cancelled (GTC; today's default). The contract
   *  enforces `expiresAt > block.timestamp` when non-zero. Surfaced
   *  on the payload so the createOffer ABI tuple matches the
   *  contract's `CreateOfferParams` shape exactly; the form has no
   *  UI for it yet, so we always pass `0n`. */
  expiresAt: bigint;
  /** T-086 step 4 — lender opt-in for borrower-initiated prepay
   *  collateral listing during the loan (distinct from the Round-8
   *  borrow-OR-sell parallel-sale opt-in `allowsParallelSale` above).
   *  See `LibVaipakam.CreateOfferParams.allowsPrepayListing` for
   *  full semantics. Default `false` is the safe behaviour; the form
   *  has no UI for it yet (Round-8 deferred; future enhancement). */
  allowsPrepayListing: boolean;
  /** T-092 Phase 2b (#506) — refinance-target loan id. When non-
   *  zero, the offer is created with the intent to refinance the
   *  named loan; the contract validates the offer's terms against
   *  `autoRefinanceCaps[refinanceTargetLoanId]` at both create AND
   *  accept. `0n` ⇒ standard borrower offer (no refinance intent).
   *  Standard create flow passes `0n`; the keeper-driven auto-
   *  refinance UX sets this when constructing the offer. */
  refinanceTargetLoanId: bigint;
  /** #408 — see `OfferFormState.useFullTermInterest`. Wire passes
   *  through unchanged to the on-chain `CreateOfferParams.
   *  useFullTermInterest` field. */
  useFullTermInterest: boolean;
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
 * Issue #165 Phase 1 — role-asymmetric UI LABELS over single-value
 * payloads.
 *
 * The user enters ONE value per field; the form labels in
 * `CreateOffer.tsx` are role-asymmetric per ADR-0010 §17.1 (lender
 * thinks "Lend up to X", borrower thinks "Borrow at least Y"), but the
 * **contract payload ships single-value** with the user's headline
 * number in the floor field and the `*Max` ceilings auto-collapsed to
 * zero. The contract reads `*Max == 0` as "treat as single-value at
 * the floor".
 *
 * Why NOT the ADR-0010 §17.1 split-floor/ceiling mapping yet:
 *
 * ADR-0010's mapping table (lender's `amount = 1 wei` + `amountMax = X`;
 * borrower's `collateralAmount = 0` + `collateralAmountMax = W`;
 * borrower's `interestRateBps = 0`; etc.) was written assuming the
 * `OfferMatchFacet.matchOffers` path is the canonical match flow.
 * The contract still exposes `OfferAcceptFacet.acceptOffer` for
 * single-match direct accepts — that path reads `offer.amount`,
 * `offer.interestRateBps`, and `offer.collateralAmount` DIRECTLY (see
 * `_acceptOffer`'s `matchOverride.active == false` branch). Shipping
 * the ADR split-mapping breaks the direct-accept path: e.g., a lender
 * offer with `amount = 1 wei` lets a borrower call `acceptOffer` and
 * walk away with a 1-wei loan; a borrower offer with `interestRateBps
 * = 0` is accepted at 0 % APR; a borrower offer with `collateralAmount
 * = 0` is direct-accepted without pulling any collateral. Codex
 * round-1 on PR #175 caught all of these as P1s.
 *
 * Phase 1 of #165 (this code) ships:
 *   - role-asymmetric LABELS in the form (the UX shift)
 *   - single-value payloads (the safe contract shape — both
 *     match paths land at the same loan terms)
 *
 * Phase 2 of #165 (now landed as #183 / PR #184) ships the role-aware
 * `_acceptOffer` reads + drops the create-time auto-collapse. The
 * frontend now ships **canonical role-asymmetric values**:
 *
 *   - Lender posts "I'll lend up to X" → `amountMax = X`,
 *     `amount = max(1, X × 10 / 100)` (the minPartialFillAmount default
 *     per design §2.3).
 *   - Lender posts "rate ≥ Y%" → `interestRateBps = Y`,
 *     `interestRateBpsMax = MAX_INTEREST_BPS` (no upper limit).
 *   - Lender collateral stays single-value (`collateralAmount ==
 *     collateralAmountMax`) — see #164 design "Lender side stays
 *     single-value because the lender's collateralAmount IS their
 *     derived requirement".
 *   - Borrower posts "need at least X" → `amount = X`. `amountMax`
 *     ships equal to `amount` for Phase 2 (single-value direct-accept
 *     locks at the borrower's floor; range borrower offers will lift
 *     this when the frontend exposes range inputs).
 *   - Borrower posts "rate ≤ Y%" → `interestRateBpsMax = Y`,
 *     `interestRateBps = 0` (no lower limit — borrower accepts any
 *     rate below their ceiling).
 *   - Borrower collateral: `collateralAmount = X`, `collateralAmountMax
 *     = X` (single-value; Phase 2 frontend doesn't yet expose the max
 *     commit range — borrowers post a single value).
 *
 * The `_acceptOffer` role-aware reads (LoanFacet §3 of the design)
 * give the loan the right terms whichever side direct-accepts. The
 * canonical mapping is now safe.
 */
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

  const rateBps = s.interestRate === ''
    ? 0
    : Math.round(parseFloat(s.interestRate) * 100);

  // #183 — canonical role-aware mapping. See doc-block above for the
  // full mapping table. `MAX_INTEREST_BPS` mirrors
  // `LibVaipakam.MAX_INTEREST_BPS` (10_000 = 100% APR) — the protocol's
  // upper-sanity cap on rates. Hard-coded here for now; if the contract
  // ever raises it, this constant follows.
  const MAX_INTEREST_BPS = 10_000;

  const isLender = s.offerType === 'lender';

  // For lender ERC-20 offers, `minPartialFillAmount` defaults to 10%
  // of `lendingAmount` per design §2.3. Floor at 1 wei so the `> 0`
  // invariant holds even for tiny offers. NFT-lending offers (rentals)
  // ship `amount == amountMax` (single-value — the daily rental fee).
  const lenderMinPartial = s.assetType === 'erc20'
    ? (lendingAmount / 10n > 0n ? lendingAmount / 10n : 1n)
    : lendingAmount;

  return {
    offerType: isLender ? 0 : 1,
    lendingAsset: s.lendingAsset,
    // Storage `amount` field:
    //   - Lender: `minPartialFillAmount` (= 10% default, floored at 1 wei).
    //   - Borrower: the floor headline (what `_acceptOffer` reads on direct-accept).
    amount: isLender ? lenderMinPartial : lendingAmount,
    // Storage `interestRateBps` field:
    //   - Lender: their rate input — the floor / limit (DEX taker-favoring).
    //   - Borrower: 0 — no lower limit on what they'd pay.
    interestRateBps: isLender ? rateBps : 0,
    collateralAsset: s.collateralAsset || ZERO_ADDRESS,
    collateralAmount: collateralWei,
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
    // Storage `amountMax` field:
    //   - Lender: their headline `lendingAmount` (max provide).
    //   - Borrower: equals `amount` for Phase 2 frontend (single-
    //     value direct-accept). Future range-borrower UI will raise
    //     this past `amount`.
    amountMax: isLender ? lendingAmount : lendingAmount,
    // Storage `interestRateBpsMax` field:
    //   - Lender: MAX_INTEREST_BPS (no upper limit on rates they'd accept).
    //   - Borrower: their rate input — the ceiling / limit.
    interestRateBpsMax: isLender ? MAX_INTEREST_BPS : rateBps,
    // Storage `collateralAmountMax` field: single-value on both sides
    // for Phase 2 (lender by structural invariant per #164; borrower
    // until the frontend exposes a max-commit range).
    collateralAmountMax: collateralWei,
    periodicInterestCadence: s.periodicInterestCadence,
    // T-086 Round-8 (#358) §19.5 — wire the borrower opt-in through.
    // Contract gate (`OfferCreateFacet`) refuses lender + non-NFT-
    // collateral cases at create time; UI surface enforces the same.
    allowsParallelSale: s.allowsParallelSale,
    // #125 + Round-8 Codex round-8 P2 #4 — force Aon (1) when
    // `allowsParallelSale` is on; default to Partial (0) otherwise.
    // T-092 #511 sub (#523) — refinance-tagged offers MUST also be
    // Aon (the contract reverts `InvalidRefinanceTarget` otherwise).
    fillMode:
      s.allowsParallelSale || s.refinanceTargetLoanId !== ''
        ? 1
        : 0,
    // Codex round-14 P1 — add the remaining createOffer tuple fields
    // so the payload matches the contract's `CreateOfferParams` shape
    // exactly. `expiresAt = 0n` ⇒ GTC (today's behaviour);
    // `allowsPrepayListing = false` ⇒ no borrower-initiated prepay
    // listing during the loan (today's default). Form UI for both is
    // a future enhancement; the explicit zeros here just keep the wire
    // shape matching the ABI tuple instead of relying on the encoder
    // to default missing keys.
    expiresAt: 0n,
    allowsPrepayListing: false,
    // T-092 #511 sub (#523) — when the form's refinance-tag input
    // is filled, thread the loan id through. Standard offers leave
    // the field empty and the payload sees `0n`.
    refinanceTargetLoanId:
      s.refinanceTargetLoanId !== ''
        ? BigInt(s.refinanceTargetLoanId)
        : 0n,
    // #408 — carry the form's election unchanged.
    useFullTermInterest: s.useFullTermInterest,
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
  if (days < 365) return '2 weeks';
  return '30 days'; // LibVaipakam.gracePeriod: >=365d falls in the 30-day bucket
}
