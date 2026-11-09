// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VaultOutflowFacet} from "../../src/facets/VaultOutflowFacet.sol";
import {VaultOutflowTypes, OutflowReason} from "../../src/vault/VaultOutflowTypes.sol";

/// @title  LibTestOutflow
/// @notice #3205 part 2 — the test-side replacement for the retired
///         `VaultFactoryFacet.vaultWithdraw*` calls a fixture made AS the
///         Diamond. Every vault outflow now names a class; a fixture that only
///         needs "move this out of that vault" gets the class the old call's
///         recipient implies: the Diamond itself (Diamond transient), the
///         vault's own owner (Owner), or anyone else (Incentive, the class
///         whose recipient the caller names). The caller must be pranked as
///         the Diamond, as before.
library LibTestOutflow {
    function withdrawERC20(address diamond, address user, address token, address recipient, uint256 amount)
        internal
        returns (uint256)
    {
        return _go(diamond, user, VaultOutflowTypes.AssetKind.ERC20, token, 0, amount, recipient);
    }

    function withdrawERC721(address diamond, address user, address nft, uint256 tokenId, address recipient) internal {
        _go(diamond, user, VaultOutflowTypes.AssetKind.ERC721, nft, tokenId, 1, recipient);
    }

    function withdrawERC1155(address diamond, address user, address nft, uint256 tokenId, uint256 amount, address recipient)
        internal
    {
        _go(diamond, user, VaultOutflowTypes.AssetKind.ERC1155, nft, tokenId, amount, recipient);
    }

    function _go(
        address diamond,
        address user,
        VaultOutflowTypes.AssetKind kind,
        address asset,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) private returns (uint256) {
        VaultOutflowTypes.OutflowClass c = recipient == diamond
            ? VaultOutflowTypes.OutflowClass.DiamondTransient
            : (recipient == user ? VaultOutflowTypes.OutflowClass.Owner : VaultOutflowTypes.OutflowClass.Incentive);
        return VaultOutflowFacet(diamond).vaultOutflow(
            user,
            VaultOutflowTypes.Outflow({
                kind: kind,
                asset: asset,
                tokenId: tokenId,
                amount: amount,
                to: recipient,
                class_: c,
                ref: 0,
                positionToken: 0,
                reason: OutflowReason.WITHDRAW,
                counterRef: 0
            })
        );
    }
}
