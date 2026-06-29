// src/libraries/LibPrepayListingWiring.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
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
        address executor
    ) internal {
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
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            // ERC721 only: clear the per-token approval the matching
            // `wire` granted. ERC1155 has no per-token approval, and
            // its operator-wide approval is bounded by the ERC-1271
            // revoke below + FULL_RESTRICTED.
            vault.setCollateralOperatorApproval(
                loan.collateralAsset,
                loan.collateralTokenId,
                address(0),
                false
            );
        }
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
            vault.setCollateralOperatorApproval(
                loan.collateralAsset,
                loan.collateralTokenId,
                conduit,
                true
            );
        } else {
            // ERC1155 — supported per T-086 step 15.
            vault.setCollateralOperatorApprovalERC1155(
                loan.collateralAsset,
                conduit,
                true
            );
        }
    }

    /// @dev #818 / #825-r2 (P1) — Tier-1 screen every fee-leg recipient before a
    ///      prepay listing is built or recorded. The holder-only screen on the
    ///      manual post/update paths does NOT cover the caller-supplied
    ///      `feeLegs`: `LibPrepayOrder` appends each leg as a Seaport
    ///      consideration item payable to `feeLegs[i].recipient`, and the
    ///      fee-leg validators only reject a ZERO recipient. Without this a
    ///      clean holder could route principal-asset proceeds to a flagged
    ///      wallet on fill. Reverts `SanctionedAddress(recipient)` for any
    ///      flagged recipient. (The atomic / auto-list paths don't take
    ///      caller-supplied fee legs — atomic passes empty, auto-list derives
    ///      them — so the manual entry points are the only surface.)
    function assertFeeLegRecipientsNotSanctioned(FeeLeg[] calldata feeLegs)
        internal
        view
    {
        for (uint256 i; i < feeLegs.length; i++) {
            LibVaipakam._assertNotSanctioned(feeLegs[i].recipient);
        }
    }
}
