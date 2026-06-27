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
 * (The wallet-scoped loan/claimable read routes answer purely from D1 — #749 —
 * so the indexer no longer needs an `ownerOf` / `getUserPositionLoans` ABI here;
 * the authoritative on-chain `getUserPositionLoans` verify lives in the FRONTEND,
 * called with the user's own RPC.)
 *
 * Event signatures parsed via viem's `parseAbi` in `chainIndexer.ts`
 * stay inline because event routing uses topic-hash matching, not
 * positional decode — adding a new field to an event payload wouldn't
 * silently misalign the way struct returns can. (The historical
 * `Offer` tuple drift bug surfaced in ReleaseNotes-2026-05-05.md was
 * specifically a positional-decode issue; events are immune.)
 */

import { OfferCancelFacetABI, LoanFacetABI } from '@vaipakam/contracts/abis';

export const DIAMOND_OFFER_DETAILS_ABI = OfferCancelFacetABI;

export const DIAMOND_LOAN_DETAILS_ABI = LoanFacetABI;
