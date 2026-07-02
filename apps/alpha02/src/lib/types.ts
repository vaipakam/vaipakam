/**
 * Shared numeric-code tables mirroring the contracts' enums.
 * Const objects rather than `enum` — `erasableSyntaxOnly` rejects TS
 * enums but we still want one source of truth for the codes.
 */

export const AssetType = {
  ERC20: 0,
  ERC721: 1,
  ERC1155: 2,
} as const;
export type AssetType = (typeof AssetType)[keyof typeof AssetType];

export const LoanStatus = {
  Active: 0,
  Repaid: 1,
  Defaulted: 2,
  Settled: 3,
  FallbackPending: 4,
  InternalMatched: 5,
} as const;
export type LoanStatus = (typeof LoanStatus)[keyof typeof LoanStatus];
