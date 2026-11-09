// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibVaultOutflow} from "./LibVaultOutflow.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";

/**
 * @title  LibListingEscrow
 * @author Vaipakam Developer Team
 * @notice The one rule for who offers an NFT collateral listing on Seaport
 *         (#3205 part 2, `VaultOutflowPolicyDesign.md` §3.5 rule 3): an
 *         ERC-721 is offered by its vault, under a per-fill grant; an ERC-1155
 *         by the vault's escrow for that listing, which holds the lot and the
 *         only conduit approval, so the vault never grants an operator-wide
 *         approval.
 * @dev    Every order builder, every listing context and the executor's
 *         offerer checks read the offerer through {offerer}, so the order
 *         hash, the counter and the fill-time check agree.
 */
library LibListingEscrow {
    /// @notice The listing key: one per loan-keyed listing and one per
    ///         offer-keyed listing (a loan and an offer may share a number).
    function key(bool offerKeyed, uint256 ref) internal pure returns (bytes32) {
        return keccak256(abi.encode(offerKeyed ? uint8(2) : uint8(1), ref));
    }

    /// @notice The Seaport offerer of a listing of `assetType` collateral held
    ///         in `vault`.
    function offerer(address vault, LibVaipakam.AssetType assetType, bytes32 listingKey)
        internal
        view
        returns (address)
    {
        // No vault yet means no offerer (a read never reverts for it).
        if (assetType != LibVaipakam.AssetType.ERC1155 || vault == address(0)) return vault;
        return VaipakamVaultImplementation(vault).listingEscrowAddress(listingKey);
    }

    /// @notice Arm an ERC-1155 listing: create (once) the vault's escrow for
    ///         `listingKey`, approve `conduit` on it, and move the lot in.
    function open(
        address owner,
        address vault,
        address asset,
        uint256 tokenId,
        uint256 quantity,
        address conduit,
        bytes32 listingKey,
        uint256 ref
    ) internal {
        VaipakamVaultImplementation(vault).openListingEscrow(listingKey, asset, conduit);
        LibVaultOutflow.toListingEscrow(owner, asset, tokenId, quantity, listingKey, ref);
    }

    /// @notice Bring an ERC-1155 listing's remaining lot back to its vault and
    ///         revoke the escrow's approval (a no-op after a fill).
    function close(address vault, address asset, uint256 tokenId, bytes32 listingKey) internal {
        if (vault == address(0)) return;
        VaipakamVaultImplementation(vault).closeListingEscrow(listingKey, asset, tokenId);
    }
}
