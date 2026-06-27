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
 *   - `MetricsFacet` hosts
 *     `getUserPositionLoans(address) returns (uint256[] loanIds,
 *     uint256[] tokenIds)` — the AUTHORITATIVE live-ownership
 *     enumeration (ERC721Enumerable + `loanIdByPositionTokenId`)
 *     that /loans/by-lender, /loans/by-borrower, /claimables call
 *     (#749). One wallet-scoped call replaces the old per-loan
 *     `ownerOf` fan-out, and being on-chain it has none of the
 *     indexer `*_current_owner` projection's gaps (burns, token-id
 *     migration, pre-accept offer-NFT transfer, pre-backfill rows).
 *
 * Event signatures parsed via viem's `parseAbi` in `chainIndexer.ts`
 * stay inline because event routing uses topic-hash matching, not
 * positional decode — adding a new field to an event payload wouldn't
 * silently misalign the way struct returns can. (The historical
 * `Offer` tuple drift bug surfaced in ReleaseNotes-2026-05-05.md was
 * specifically a positional-decode issue; events are immune.)
 */

import {
  OfferCancelFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
} from '@vaipakam/contracts/abis';

export const DIAMOND_OFFER_DETAILS_ABI = OfferCancelFacetABI;

export const DIAMOND_LOAN_DETAILS_ABI = LoanFacetABI;

/** `MetricsFacet` — hosts `getUserPositionLoans(address)`, the authoritative
 *  on-chain live-ownership enumeration backing the wallet-scoped loan/claimable
 *  read routes (#749). Full facet ABI re-exported (viem's `readContract` accepts
 *  any ABI containing the function). */
export const DIAMOND_USER_POSITION_ABI = MetricsFacetABI;
