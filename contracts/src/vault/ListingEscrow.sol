// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @dev #3431 — the one read an escrow makes of its vault: the Seaport fixed
///      in the vault's code.
interface IEscrowVaultSeaport {
    function SEAPORT() external view returns (address);
}

/**
 * @title  ListingEscrow
 * @author Vaipakam Developer Team
 * @notice One ERC-1155 listing's holder (#3205 part 2,
 *         `VaultOutflowPolicyDesign.md` §3.5 rule 3). An operator-wide
 *         approval would cover every token id of a collection the vault
 *         holds, including ones backing other liens, so the vault never grants
 *         one. Instead the listed id and amount move into this escrow, which
 *         holds nothing else: it is the listing's Seaport offerer, the only
 *         holder of the conduit approval, and it answers the order's ERC-1271
 *         check from its vault's record of the listing.
 * @dev    Created by its vault with CREATE2 (the vault is `msg.sender` at
 *         construction, so a vault can predict its escrows' addresses and the
 *         order can name the escrow as offerer before it exists). Only its
 *         vault may approve, close or send it tokens. It moves nothing but the
 *         lot: back to its vault on {close}, or to a buyer through the
 *         conduit the vault approved for the fill.
 */
contract ListingEscrow is IERC1155Receiver, IERC1271 {
    /// @notice The vault that created this escrow and owns what it holds.
    address public immutable vault;

    /// @dev The collection and conduit currently approved (0 = none).
    address private _asset;
    address private _conduit;

    error NotVault(address caller);
    error UnauthorizedSender(address operator);

    event EscrowApproved(address indexed asset, address indexed conduit);
    event EscrowClosed(address indexed asset, uint256 indexed tokenId, uint256 returned);

    constructor() {
        vault = msg.sender;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault(msg.sender);
        _;
    }

    /// @notice Approve `conduit` for `asset` (this escrow holds only the one
    ///         listed lot, so the approval reaches nothing else). Replaces any
    ///         earlier approval.
    function approve(address asset, address conduit) external onlyVault {
        _revoke();
        IERC1155(asset).setApprovalForAll(conduit, true);
        _asset = asset;
        _conduit = conduit;
        emit EscrowApproved(asset, conduit);
    }

    /// @notice Return everything held of `asset` / `tokenId` to the vault and
    ///         revoke the approval. Returns the units returned (0 after a
    ///         fill).
    function close(address asset, uint256 tokenId) external onlyVault returns (uint256 returned) {
        _revoke();
        returned = IERC1155(asset).balanceOf(address(this), tokenId);
        if (returned != 0) IERC1155(asset).safeTransferFrom(address(this), vault, tokenId, returned, "");
        emit EscrowClosed(asset, tokenId, returned);
    }

    /// @notice ERC-1271, answered by the vault's own record of the listing.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        // #3431 — the escrow answers only Seaport (the vault's own constant),
        // and only with the vault's answer for an order the vault hashed.
        if (msg.sender != IEscrowVaultSeaport(vault).SEAPORT()) return 0xffffffff;
        return IERC1271(vault).isValidSignature(hash, signature);
    }

    /// @dev Only the vault may put tokens here.
    function onERC1155Received(address operator, address, uint256, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (operator != vault) revert UnauthorizedSender(operator);
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address operator, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (operator != vault) revert UnauthorizedSender(operator);
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC1271).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function _revoke() private {
        address asset = _asset;
        if (asset == address(0)) return;
        IERC1155(asset).setApprovalForAll(_conduit, false);
        _asset = address(0);
        _conduit = address(0);
    }
}
