/**
 * T-041 — minimal Diamond ABIs for the worker-side indexer.
 *
 * Only the surface the worker needs: per-domain `get*Details` view
 * functions. We don't import the full per-facet ABI bundle into the
 * worker (the frontend's abi/index.ts is React-coupled). Inline
 * minimal shapes keep the worker bundle lean.
 *
 * Field order MUST match the Solidity struct exactly. A Diamond
 * upgrade that reorders a struct will break the matching read
 * silently — same risk profile as the frontend's per-facet ABI
 * bundle that the abi-export script keeps in sync. Future hardening:
 * regenerate this ABI snippet via the same export script.
 *
 * Range Orders Phase 1: the legacy `amount` and `interestRateBps`
 * fields ARE the range-min; the new `amountMax` /
 * `interestRateBpsMax` fields hold the inclusive max. There is no
 * separate `amountMin` field on-chain.
 *
 * Phase B+ will append additional view function definitions
 * (`getLoanDetails`, etc.) here as new domains land.
 */

/**
 * Minimal `getLoanDetails(uint256)` ABI for bootstrapping the loan's
 * position-NFT token IDs into the indexer at LoanInitiated time. Field
 * order MUST match `LibVaipakam.Loan` exactly. We only destructure
 * `lenderTokenId` + `borrowerTokenId`; the other fields are mostly
 * already captured from the LoanInitiated event payload + the offers
 * JOIN, so re-pulling them is best-effort overhead but doesn't hurt.
 */
export const DIAMOND_LOAN_DETAILS_ABI = [
  {
    type: 'function',
    name: 'getLoanDetails',
    stateMutability: 'view',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'offerId', type: 'uint256' },
          { name: 'lender', type: 'address' },
          { name: 'principalLiquidity', type: 'uint8' },
          { name: 'collateralLiquidity', type: 'uint8' },
          { name: 'status', type: 'uint8' },
          { name: 'assetType', type: 'uint8' },
          { name: 'useFullTermInterest', type: 'bool' },
          { name: 'fallbackConsentFromBoth', type: 'bool' },
          { name: 'collateralAssetType', type: 'uint8' },
          { name: 'fallbackLenderBonusBpsAtInit', type: 'uint16' },
          { name: 'fallbackTreasuryBpsAtInit', type: 'uint16' },
          { name: 'borrower', type: 'address' },
          { name: 'allowsPartialRepay', type: 'bool' },
          { name: 'lenderTokenId', type: 'uint256' },
          { name: 'borrowerTokenId', type: 'uint256' },
          { name: 'principal', type: 'uint256' },
          { name: 'principalAsset', type: 'address' },
          { name: 'interestRateBps', type: 'uint256' },
          { name: 'startTime', type: 'uint256' },
          { name: 'durationDays', type: 'uint256' },
          { name: 'collateralAsset', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'quantity', type: 'uint256' },
          { name: 'prepayAmount', type: 'uint256' },
          { name: 'bufferAmount', type: 'uint256' },
          { name: 'lastDeductTime', type: 'uint256' },
          { name: 'prepayAsset', type: 'address' },
          { name: 'collateralTokenId', type: 'uint256' },
          { name: 'collateralQuantity', type: 'uint256' },
          { name: 'lenderDiscountAccAtInit', type: 'uint256' },
          { name: 'borrowerDiscountAccAtInit', type: 'uint256' },
          { name: 'matcher', type: 'address' },
          { name: 'lenderNotifBilled', type: 'bool' },
          { name: 'borrowerNotifBilled', type: 'bool' },
        ],
      },
    ],
  },
] as const;

/** ERC-721 `ownerOf` — used by the live-ownership multicall in
 *  /loans/by-lender, /loans/by-borrower, /claimables. The Vaipakam
 *  position NFT is a facet on the Diamond, so the diamond address IS
 *  the NFT contract address. Reverts on burned / nonexistent tokens
 *  — caller must catch and treat as "no current holder". */
export const ERC721_OWNER_OF_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export const DIAMOND_OFFER_DETAILS_ABI = [
  {
    type: 'function',
    name: 'getOfferDetails',
    stateMutability: 'view',
    inputs: [{ name: 'offerId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'creator', type: 'address' },
          { name: 'offerType', type: 'uint8' },
          { name: 'principalLiquidity', type: 'uint8' },
          { name: 'collateralLiquidity', type: 'uint8' },
          { name: 'accepted', type: 'bool' },
          { name: 'assetType', type: 'uint8' },
          { name: 'useFullTermInterest', type: 'bool' },
          { name: 'creatorFallbackConsent', type: 'bool' },
          { name: 'collateralAssetType', type: 'uint8' },
          { name: 'allowsPartialRepay', type: 'bool' },
          { name: 'lendingAsset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'interestRateBps', type: 'uint256' },
          { name: 'collateralAsset', type: 'address' },
          { name: 'collateralAmount', type: 'uint256' },
          { name: 'durationDays', type: 'uint256' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'positionTokenId', type: 'uint256' },
          { name: 'quantity', type: 'uint256' },
          { name: 'prepayAsset', type: 'address' },
          { name: 'collateralTokenId', type: 'uint256' },
          { name: 'collateralQuantity', type: 'uint256' },
          { name: 'amountMax', type: 'uint256' },
          { name: 'amountFilled', type: 'uint256' },
          { name: 'interestRateBpsMax', type: 'uint256' },
          { name: 'createdAt', type: 'uint64' },
        ],
      },
    ],
  },
] as const;
