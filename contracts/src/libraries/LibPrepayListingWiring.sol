// src/libraries/LibPrepayListingWiring.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPositionNFT} from "./LibPositionNFT.sol";
import {LibProtectedAccount} from "./LibProtectedAccount.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {FeeLeg} from "../seaport/PrepayTypes.sol";

/**
 * @title LibPrepayListingWiring
 * @author Vaipakam Developer Team
 * @notice T-086 Round-6 / Block D (#345): two `internal` entry
 *         points that wire / un-wire the borrower's vault for a
 *         prepay-collateral listing. Extracted from
 *         `NFTPrepayListingFacet`'s previously-`private`
 *         `_wireVaultForListing` body + the cleanup half of
 *         `_cancel:1111-1120` so the new sibling facet
 *         `NFTPrepayListingAtomicFacet` can share the exact same
 *         wiring without duplicating it.
 *
 *         See the Round-6 design doc §17.11 step 5 (`wire`) and
 *         step 0(f) (`unwire`) for the protocol-level walkthrough.
 *
 * @dev    Both entry points are `internal`, so consumers compile a
 *         direct jump into the call site — no external `delegatecall`
 *         surface, no new selector to wire into the diamond cut. The
 *         storage pointer is passed in (rather than re-read inside
 *         the helper) so the diamond-storage pattern stays
 *         compile-time-bound to the caller's storage slot.
 *
 *         **v1 behavior preserved byte-for-byte**. v1's
 *         `_wireVaultForListing` did exactly what `wire` does;
 *         v1's `_cancel:1111-1120` vault-cleanup half did exactly
 *         what `unwire` does. The refactor moves the bodies to the
 *         library; v1 callers + the new atomic facet both invoke
 *         the same paths.
 */
library LibPrepayListingWiring {
    /// @dev Bubbled by `wire` when the borrower's vault hasn't been
    ///      deployed for the loan's owner. Mirrors v1's
    ///      `_wireVaultForListing` revert at the same precondition.
    error VaultNotDeployed(address borrower);

    /**
     * @notice Grant Seaport-conduit operator approval on the
     *         vault for the loan's collateral asset AND pin the
     *         (orderHash → executor) binding on the vault's
     *         ERC-1271 mapping. After this call Seaport can pull
     *         the collateral NFT into a fill (the conduit holds
     *         the operator approval), and Seaport's sign-time
     *         signature query against the orderHash resolves to
     *         the executor's `isOrderValid` check (which returns
     *         true iff the executor still has `orderContext[orderHash]`
     *         populated).
     *
     * @dev    Asset-type aware: ERC721 uses the per-token
     *         `setCollateralOperatorApproval`; ERC1155 uses the
     *         operator-wide `setCollateralOperatorApprovalERC1155`
     *         (ERC1155 has no per-token approval surface). The
     *         operator-wide approval's blast radius is bounded by
     *         the executor's `FULL_RESTRICTED` order type + the
     *         #306 canonical-order construction (a different-shape
     *         order would have a different orderHash and the vault's
     *         ERC-1271 would return INVALID for it).
     *
     *         Reverts {VaultNotDeployed} if the borrower has no
     *         deployed vault for the loan's owner.
     */
    function wire(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bytes32 orderHash,
        address conduit,
        address executor,
        bool holderAuthenticated
    ) internal {
        // #3205 — the ONE place a collateral listing arms its route.
        // `holderAuthenticated` is explicit at every caller: true only for a
        // post or update the CURRENT borrower-position holder authenticated
        // with fresh terms, which may rebind a dead listing route as theirs.
        // The permissionless auto-list paths pass false: they never revive a
        // former holder's listing (#3318 Codex r3); `openRoute` refuses that.
        LibPositionNFT.openRoute(loan.borrowerTokenId, LibPositionNFT.RouteReason.PrepayCollateralListing, holderAuthenticated);
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) revert VaultNotDeployed(loan.borrower);
        VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
        _grantConduitApproval(vault, loan, conduit);
        vault.registerListingOrderHash(orderHash, executor);
    }

    /**
     * @notice Reverse `wire`: revoke the vault's ERC-1271 binding
     *         for `orderHash` AND, for ERC721 collateral only,
     *         clear the per-token operator approval. ERC1155
     *         deliberately leaves the operator-wide approval in
     *         place — the orderHash-binding revoke is the
     *         authoritative safety primitive (without the vault
     *         saying "yes, this hash is mine" via ERC-1271, no
     *         Seaport fill can succeed regardless of operator
     *         approval state). This matches the shipped Seaport
     *         ERC1155 conduit pattern + v1's `_cancel` behaviour.
     *
     * @dev    If the borrower's vault hasn't been deployed (e.g.,
     *         a defensive call on a never-wired loan) the function
     *         silently no-ops. v1's `_cancel:1111-1120` runs the
     *         same `vaultAddr != address(0)` guard.
     */
    function unwire(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        bytes32 orderHash
    ) internal {
        address vaultAddr = s.userVaipakamVaults[loan.borrower];
        if (vaultAddr == address(0)) return;
        VaipakamVaultImplementation vault = VaipakamVaultImplementation(vaultAddr);
        // #3205 part 2 — an ERC-721 listing holds no approval between
        // transactions, so there is nothing to clear here.
        // Both asset types: invalidate the vault's ERC-1271 binding
        // for `orderHash`. After this the vault's `isValidSignature`
        // returns INVALID for any Seaport replay attempt against the
        // canceled order.
        vault.revokeListingOrderHash(orderHash);
    }

    /// @dev Asset-type-aware conduit-approval grant. ERC721 uses
    ///      per-token `approve`; ERC1155's only approval surface is
    ///      operator-wide `setApprovalForAll`. Shared by both posting
    ///      paths via `wire`. The FULL_RESTRICTED order type + the
    ///      executor's content gate bound the operator-wide ERC1155
    ///      approval's blast radius.
    function _grantConduitApproval(
        VaipakamVaultImplementation vault,
        LibVaipakam.Loan storage loan,
        address conduit
    ) private {
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            // #3205 part 2 — granted only inside the fill (the executor's
            // authorizeOrder asks the Diamond for it), never here.
            conduit;
        } else {
            // ERC1155 — supported per T-086 step 15.
            vault.setCollateralOperatorApprovalERC1155(
                loan.collateralAsset,
                conduit,
                true
            );
        }
    }

    /// @dev The listing-author rule, run before a prepay or parallel-sale
    ///      listing is built or recorded. Two screens, one per concern:
    ///      - #818 / #825-r2 (P1) sanctions: every fee-leg recipient is Tier-1
    ///        screened. `LibPrepayOrder` appends each leg as a Seaport
    ///        consideration item payable to `feeLegs[i].recipient`, and the
    ///        fee-leg validators only reject a ZERO recipient, so without this
    ///        a clean holder could route proceeds to a flagged wallet on fill.
    ///      - Protected account mode: a fee leg is a payment the marketplace
    ///        makes straight from the sale, outside the payout queue, so a
    ///        protected seller may not open a listing while locked or retired
    ///        ({LibProtectedAccount.requireCanOpen}), and may name only its
    ///        own wallet or an allowlisted destination as a fee recipient
    ///        ({LibProtectedAccount.listingLegAllowed}). The executor applies
    ///        the same rule again at fill.
    ///      (The atomic / auto-list paths take no caller-supplied fee legs —
    ///      atomic passes empty, auto-list reuses the recorded ones — so the
    ///      manual entry points are the only surface; the fill-time check
    ///      covers every path.)
    function assertListingAuthorized(address seller, FeeLeg[] calldata feeLegs)
        internal
        view
    {
        LibProtectedAccount.requireCanOpen(seller);
        for (uint256 i; i < feeLegs.length; i++) {
            address recipient = feeLegs[i].recipient;
            LibVaipakam._assertNotSanctioned(recipient);
            if (!LibProtectedAccount.listingLegAllowed(seller, recipient)) {
                revert LibProtectedAccount.RecipientNotAllowlisted(seller, recipient);
            }
        }
    }
}
