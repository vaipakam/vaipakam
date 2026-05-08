/**
 * Diamond ABIs for the indexer Worker.
 *
 * Sourced from `@vaipakam/contracts/abis` — the same per-facet
 * JSONs the frontend reads, regenerated post-deploy by
 * `contracts/script/exportFrontendAbis.sh`. Stage 3 PR3 of the
 * Worker split (see `docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`)
 * dropped the local `./abis/` copy that ops/hf-watcher carried in
 * favour of this single source of truth.
 *
 * Why these two facets specifically:
 *
 *   - `OfferCancelFacet` hosts
 *     `getOfferDetails(uint256) returns (LibVaipakam.Offer)`. The
 *     full facet ABI is re-exported (not just the one method)
 *     because viem's `readContract({ abi, functionName })` accepts
 *     any ABI containing the function; trimming would just be one
 *     more thing to forget on a future facet edit.
 *   - `LoanFacet` hosts
 *     `getLoanDetails(uint256) returns (LibVaipakam.Loan)` plus the
 *     loan-list helpers the indexer's catch-up walk relies on.
 *
 * Inline ABIs that survive in this file:
 *
 *   - `ERC721_OWNER_OF_ABI` — single-method, never going to change.
 *   - Event signatures parsed via viem's `parseAbi` in
 *     `chainIndexer.ts` stay inline because event routing uses
 *     topic-hash matching, not positional decode — adding a new
 *     field to an event payload wouldn't silently misalign the way
 *     struct returns can. (The historical `Offer` tuple drift bug
 *     surfaced in ReleaseNotes-2026-05-05.md was specifically a
 *     positional-decode issue; events are immune.)
 */

import { OfferCancelFacetABI, LoanFacetABI } from '@vaipakam/contracts/abis';

export const DIAMOND_OFFER_DETAILS_ABI = OfferCancelFacetABI;

export const DIAMOND_LOAN_DETAILS_ABI = LoanFacetABI;

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
