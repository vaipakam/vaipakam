/**
 * Shared types for loan-related data pulled off-chain via the Diamond.
 *
 * These mirror the tuples returned by `LoanFacet.getLoanDetails` and
 * `RiskFacet.getClaimableAmount` so every page can share the same mental
 * model instead of passing untyped `any` around.
 */

// Const objects rather than `enum` — `erasableSyntaxOnly` rejects TS enums
// but we still want a single source of truth for the numeric codes.

export const LoanStatus = {
  Active: 0,
  Repaid: 1,
  Defaulted: 2,
  Settled: 3,
  FallbackPending: 4,
} as const;
export type LoanStatus = (typeof LoanStatus)[keyof typeof LoanStatus];

export const AssetType = {
  ERC20: 0,
  ERC721: 1,
  ERC1155: 2,
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const Liquidity = {
  Liquid: 0,
  Illiquid: 1,
} as const;
export type Liquidity = (typeof Liquidity)[keyof typeof Liquidity];

export const LOAN_STATUS_LABELS: Record<LoanStatus, string> = {
  [LoanStatus.Active]: 'Active',
  [LoanStatus.Repaid]: 'Repaid',
  [LoanStatus.Defaulted]: 'Defaulted',
  [LoanStatus.Settled]: 'Settled',
  [LoanStatus.FallbackPending]: 'Fallback Pending',
};

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  [AssetType.ERC20]: 'ERC-20',
  [AssetType.ERC721]: 'ERC-721',
  [AssetType.ERC1155]: 'ERC-1155',
};

export const LIQUIDITY_LABELS: Record<Liquidity, string> = {
  [Liquidity.Liquid]: 'Liquid',
  [Liquidity.Illiquid]: 'Illiquid',
};

/**
 * Raw tuple shape returned by `getLoanDetails`. Every numeric field is a
 * `bigint` because ethers v6 returns `uint256` as bigint; enums come in as
 * bigint too and are narrowed via `Number(...)` at read sites.
 */
export interface LoanDetails {
  id: bigint;
  offerId: bigint;
  lender: string;
  borrower: string;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
  principal: bigint;
  principalAsset: string;
  interestRateBps: bigint;
  durationDays: bigint;
  startTime: bigint;
  status: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  collateralAssetType: bigint;
  assetType: bigint;
  principalLiquidity: bigint;
  collateralLiquidity: bigint;
  // Phase 6: per-loan keeper access is now per-keeper via
  // `loanKeeperEnabled[loanId][keeper]` on-chain. No per-side bool on the
  // Loan struct anymore. Frontend per-loan picker queries `isLoanKeeperEnabled`
  // per keeper over the user's whitelist.
  // Asset-continuity fields required by refinance / offset flows. Each must
  // match between original loan and the replacement offer or the contract
  // reverts — the frontend uses them to prefill Create Offer.
  tokenId: bigint;
  quantity: bigint;
  prepayAsset: string;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  /** Lender-opt-in gate snapshotted from the source offer at loan
   *  init. Gates `RepayFacet.repayPartial` — when false, partial-repay
   *  attempts revert with `PartialRepayNotAllowed`. */
  allowsPartialRepay: boolean;
}

export type LoanRole = 'lender' | 'borrower';

/**
 * Projected view used by list pages (Dashboard). Narrows the raw tuple to the
 * subset actually rendered and attaches the caller's role on the loan.
 */
export interface LoanSummary {
  id: bigint;
  principal: bigint;
  principalAsset: string;
  /** Principal asset type (0 = ERC20, 1 = ERC721, 2 = ERC1155). Drives
   *  the row's `<PrincipalCell>` rendering — ERC721/1155 principals
   *  (rental loans) need `principalTokenId` to render `NFT #N`. */
  assetType: number;
  /** NFT id when `assetType` is ERC721 or ERC1155. Zero on ERC20. */
  principalTokenId: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  startTime: bigint;
  status: LoanStatus;
  role: LoanRole;
  collateralAsset: string;
  collateralAmount: bigint;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
  /** Whether the lender opted in to allow borrower-initiated partial
   *  repayment on this loan. Snapshotted from `Offer.allowsPartialRepay`
   *  at loan init; immutable thereafter. Drives the partial-repay
   *  projection slider on `<LiquidationProjection>` and the
   *  partial-repay action button (when re-enabled). Default false. */
  allowsPartialRepay: boolean;
}

/**
 * Per-side claim payload for a settled / repaid / defaulted loan. Matches
 * the full tuple returned by `getClaimable` (not the legacy three-field
 * `getClaimableAmount`), because NFT claims carry `amount == 0` but encode
 * the real payload in `tokenId` / `quantity` with the matching `assetType`.
 * The Claim Center uses `assetType` to pick an ERC-20 / 721 / 1155 renderer.
 */
export interface ClaimableEntry {
  loanId: bigint;
  role: LoanRole;
  status: LoanStatus;
  claimableAmount: bigint;
  claimableAsset: string;
  assetType: AssetType;
  tokenId: bigint;
  quantity: bigint;
  // Lender-only: principal-asset amount held inside the diamond awaiting
  // the lender's claim (e.g. repayment path). Zero for borrower rows.
  heldForLender: bigint;
  // Borrower-only: VPFI rebate credited at proper settlement for Phase 5
  // loans that took the VPFI-fee LIF path. Zero for lender rows and for
  // loans that paid LIF in the lending asset or forfeited on default.
  // Paid out alongside the main claim inside `claimAsBorrower`.
  lifRebate: bigint;
}
