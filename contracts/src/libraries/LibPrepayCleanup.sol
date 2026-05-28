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
 *         live (DefaultedFacet.triggerDefault, RiskFacet.triggerLiquidation*,
 *         and — eventually — RepayFacet.repayLoan / PrecloseFacet
 *         direct-close / RefinanceFacet, when those bring the same
 *         integration in).
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
}
