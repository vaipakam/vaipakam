// src/libraries/LibPrepayCleanup.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibERC721} from "./LibERC721.sol";
import {IListingExecutorRecorder} from "../seaport/IListingExecutorRecorder.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";

/**
 * @title LibPrepayCleanup
 * @author Vaipakam Developer Team
 * @notice T-086 step 10: shared cleanup helper for terminal paths
 *         that close a loan while a prepay-collateral-listing is
 *         live. Called from every loan-terminal path:
 *           • `DefaultedFacet.triggerDefault`
 *           • `RiskFacet.triggerLiquidation*` (three HF-liquidation entry points)
 *           • `RepayFacet.repayLoan` (T-086 follow-up to step 14)
 *           • `PrecloseFacet.precloseDirect` (ERC20 path, follow-up to step 14)
 *           • `PrecloseFacet.offsetCompleted` (defensive, follow-up to step 14)
 *           • `RefinanceFacet.refinanceLoan` (follow-up to step 14)
 *
 *         The design-doc §5.4 directive is "default-flow lock-
 *         bypass": markDefaulted / triggerLiquidation must NOT
 *         deadlock if a borrower has an active prepay listing —
 *         they must atomically release the borrower-position NFT
 *         lock + clear the diamond / vault / executor bookkeeping
 *         as their first state mutation, BEFORE the loan's
 *         lifecycle flips to Defaulted / Liquidated. Otherwise
 *         the strict `LibERC721._lock` overwrite-protection
 *         (step 6 round 2) would block any subsequent flow that
 *         needs to re-lock the same token.
 *
 *         Idempotent: safe to call when no active listing exists
 *         (early-return when the orderHash mapping is zero); the
 *         entry-point facet doesn't need to know whether a
 *         listing is live before calling.
 */
library LibPrepayCleanup {
    /// @notice Clear any active prepay-listing for `loanId`.
    ///         Safe to call unconditionally — early-returns if
    ///         no listing is live.
    /// @dev    Five mutations when a listing IS live:
    ///           1. Read the pinned (orderHash, executor) from
    ///              diamond storage.
    ///           2. Tell the executor to clear its `orderContext`
    ///              (idempotent on the executor side).
    ///           3. Tell the borrower's vault to revoke the
    ///              conduit's per-token approval + the orderHash
    ///              → executor binding (the vault's ERC-1271
    ///              delegate will then reject sign-time
    ///              verification for that hash).
    ///           4. Clear the diamond's per-loan bookkeeping.
    ///           5. Release the borrower-position NFT lock.
    ///
    ///         Steps 2 + 3 are external calls (executor + vault);
    ///         steps 1 + 4 + 5 are storage writes. Per the
    ///         effects-before-interactions guideline, we do the
    ///         storage clears FIRST so a re-entrant executor /
    ///         vault couldn't observe an inconsistent intermediate
    ///         state. The executor + vault are governance-
    ///         configured singletons that don't re-enter today;
    ///         this is defense-in-depth.
    function clearActiveListing(LibVaipakam.Loan storage loan, uint256 loanId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // T-086 Round-7 (Issue #355) — reset the per-loan auto-list
        // state on every terminal regardless of whether there's a live
        // listing right now. The opt-out flag is sticky and may have
        // been set by an earlier `cancelPrepayListing` mid-grace
        // BEFORE this terminal cleanup runs; without an unconditional
        // reset here the flag would persist into a future re-use of
        // the loanId slot. The nonce is similarly per-loan and gets
        // returned to its zero baseline. Both writes are idempotent
        // (zero → zero is a cheap no-op SSTORE).
        delete s.prepayListingAutoListOptedOut[loanId];
        delete s.prepayListingAutoListNonce[loanId];

        bytes32 orderHash = s.prepayListingOrderHash[loanId];
        if (orderHash == bytes32(0)) return; // no live listing — no-op.

        address pinnedExecutor = s.prepayListingExecutor[loanId];

        // 1. Effects.
        delete s.prepayListingOrderHash[loanId];
        delete s.prepayListingExecutor[loanId];
        LibERC721._unlock(loan.borrowerTokenId);

        // 2. Interactions.
        // Executor clear — guarded for the unusual case where the
        // pinned executor is zero (should be impossible by the
        // post/update invariant, but defensive).
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOrder(orderHash);
        }

        // Vault clear — same defensive guard for a borrower whose
        // vault hasn't been deployed (should be impossible if a
        // listing was posted, but defensive).
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr != address(0)) {
            VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
            // T-086 step 15 + #306 fix — branch on asset type.
            // ERC721 explicitly revokes the per-token approval;
            // ERC1155 leaves the operator-wide approval in place
            // (orderHash invalidation via `revokeListingOrderHash`
            // is the authoritative safety primitive, matching the
            // standard Seaport ERC1155 conduit pattern).
            if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
                vault.setCollateralOperatorApproval(
                    loan.collateralAsset, loan.collateralTokenId, address(0), false
                );
            }
            vault.revokeListingOrderHash(orderHash);
        }
    }

    /// @notice T-086 Round-8 (#358) §19.7c — clear any active
    ///         parallel-sale (pre-loan) listing for `offerId`. Safe
    ///         to call unconditionally — early-returns if no listing
    ///         is live. Mirror of {clearActiveListing} for the
    ///         offer-keyed surface; called from five sites per
    ///         round-3.9 §19.7c inventory:
    ///           - the no-loan-branch sale-fill terminal (after
    ///             `markOfferConsumedBySale` + `recordOfferSaleProceeds`)
    ///           - the §19.3 offer-accept teardown (Scenario B)
    ///           - `OfferCancelFacet.cancelOffer` (borrower-driven
    ///             destructive teardown)
    ///           - `cancelExpiredOffer` (permissionless cleanup)
    ///           - `releaseParallelSaleLock(offerId)` non-destructive
    ///             unlock (§19.7f)
    /// @dev    Full 5-slot clear per round-3.8 against Codex round-8
    ///         P2 line 5074 (+ round-3.9 against P2 line 5085):
    ///           1. `s.offerPrepayListingOrderHash[offerId]`
    ///           2. `s.offerPrepayListingExecutor[offerId]` (without
    ///              this, the §19.7d executor-gate on the 3 new
    ///              diamond callbacks would still authorize the OLD
    ///              executor against a released offer)
    ///           3. `s.offers[offerId].parallelSaleOrderHash` (the
    ///              Offer struct mirror — indexers / lenders reading
    ///              the offer's terms would otherwise see a stale
    ///              orderHash)
    ///           4. `IListingExecutorRecorder.clearOfferOrder(hash)`
    ///              on the executor (also wipes `_offerFeeLegs[hash]`
    ///              per §19.7e; MUST forward `Seaport.cancel` per
    ///              round-3.9 P3 line 4724 for the §19.4 Scenario C
    ///              two-layer rejection claim)
    ///           5. `vault.revokeListingOrderHash(hash)` (ERC-1271
    ///              returns INVALID)
    ///
    ///         Effects-before-interactions: storage clears first, then
    ///         executor + vault external calls. Same defense-in-depth
    ///         shape as {clearActiveListing} above. Idempotent.
    ///
    ///         Distinct from {clearActiveListing} because:
    ///           - There is no loan (no `loan.borrowerTokenId` to
    ///             unlock — the NFT lock is offer-create-time only
    ///             on the borrower's wallet, not the borrower-position
    ///             NFT inside the diamond).
    ///           - There are no per-loan auto-list slots to reset.
    ///           - The vault `setCollateralOperatorApproval` revoke
    ///             is NOT run (the pre-loan path doesn't grant
    ///             per-token approval the same way; the
    ///             `revokeListingOrderHash` invalidation is the
    ///             authoritative safety primitive).
    function clearOfferListing(uint96 offerId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        bytes32 orderHash = s.offerPrepayListingOrderHash[offerId];
        if (orderHash == bytes32(0)) return; // no live listing — no-op.

        address pinnedExecutor = s.offerPrepayListingExecutor[offerId];
        // Read the borrower address from the offer row so we can
        // resolve the user's vault. The offer struct is still in
        // storage at this point (clearOfferListing is called BEFORE
        // any `s.offers[offerId]` delete in the destructive paths).
        address borrower = s.offers[uint256(offerId)].creator;

        // 1. Effects — clear all three diamond-side mirror slots.
        //    Round-3.8 against Codex round-8 P2 line 5074 + round-3.9
        //    P2 line 5085 — push the full slot clear into the shared
        //    primitive so every call site gets identical teardown.
        delete s.offerPrepayListingOrderHash[offerId];
        delete s.offerPrepayListingExecutor[offerId];
        delete s.offers[uint256(offerId)].parallelSaleOrderHash;

        // 2. Interactions — executor clear (also wipes _offerFeeLegs +
        //    forwards best-effort Seaport.cancel via
        //    _tryCancelOnSeaportOffer per round-3.9 P3 #4724).
        if (pinnedExecutor != address(0)) {
            IListingExecutorRecorder(pinnedExecutor).clearOfferOrder(orderHash);
        }

        // 3. Vault clear — ERC-1271 returns INVALID for the now-
        //    cancelled hash. Defensive guard for a borrower whose
        //    vault never existed (should be impossible if a listing
        //    was posted, but defensive).
        if (borrower != address(0)) {
            address vaultAddr = s.userVaipakamVaults[borrower];
            if (vaultAddr != address(0)) {
                VaipakamVaultImplementation(vaultAddr).revokeListingOrderHash(orderHash);
            }
        }
    }
}
