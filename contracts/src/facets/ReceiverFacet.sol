// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title ReceiverFacet
 * @author Vaipakam Developer Team
 * @notice Adds ERC-721 / ERC-1155 `onReceived` hooks to the **Diamond** so it
 *         can transiently hold an NFT during the leg-1 → leg-2 hop of a #594
 *         consolidation vault→vault move (design
 *         `docs/DesignsAndPlans/CollateralConsolidationToHolder.md` §2 step 6 /
 *         §5 / D-6). Without these selectors the Diamond's fallback reverts on
 *         the unknown `onERC721Received` / `onERC1155Received`, so the
 *         "withdraw NFT to the Diamond" leg-1 would itself revert.
 * @dev    **Gated AND pinned, not an open sink (D-6).** The hooks return the
 *         ERC-165 magic value ONLY when ALL hold:
 *           (a) `s.consolidationInFlight` is set (a move is mid-flight);
 *           (b) `msg.sender == s.consolidationExpectedToken` (the exact NFT
 *               contract being moved);
 *           (c) the `tokenId` (and ERC-1155 `value`) match the expected move.
 *         The pin is **consumed on the first accepted callback** — the hook
 *         clears the expected-token slot + the flag immediately — so a
 *         malicious/non-standard token cannot deliver a *second* matching token
 *         (or, for ERC-1155, a batch) within the same `safeTransferFrom`.
 *         `onERC1155BatchReceived` is rejected outright: a consolidation move
 *         only ever transfers a single `(id, value)`, and a batch could smuggle
 *         the expected id plus extras. Any other inbound NFT reverts — the
 *         Diamond has no NFT sweep/recovery path, so it must never become a sink.
 *
 *         `LibConsolidation` arms the pin (sets the four `consolidation*` slots)
 *         immediately before leg-1 and is `nonReentrant`, so the accept window
 *         is single-move scoped and cannot be raced.
 */
contract ReceiverFacet {
    /// @dev Selector returned by a compliant ERC-721 receiver
    ///      (`IERC721Receiver.onERC721Received`).
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;
    /// @dev Selector returned by a compliant ERC-1155 single-receiver
    ///      (`IERC1155Receiver.onERC1155Received`).
    bytes4 private constant ERC1155_RECEIVED = 0xf23a6e61;

    /// @notice Reverted when the Diamond receives an NFT that does not match an
    ///         in-flight, pinned consolidation move (or a disallowed batch).
    error UnexpectedNFTReceipt();

    /// @notice ERC-721 receiver hook. Accepts (and consumes the pin for) only
    ///         the exact in-flight consolidation token + tokenId.
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        _consumePinOrRevert(msg.sender, tokenId, 1);
        return ERC721_RECEIVED;
    }

    /// @notice ERC-1155 single-receiver hook. Accepts (and consumes the pin
    ///         for) only the exact in-flight consolidation token + id + value.
    function onERC1155Received(
        address,
        address,
        uint256 id,
        uint256 value,
        bytes calldata
    ) external returns (bytes4) {
        _consumePinOrRevert(msg.sender, id, value);
        return ERC1155_RECEIVED;
    }

    /// @notice ERC-1155 batch-receiver hook — always reverts during a move.
    /// @dev    A consolidation move transfers a single `(id, value)`; the batch
    ///         path has no legitimate use here and could smuggle the expected id
    ///         plus extras, so it is rejected outright (D-6 / Codex round-8).
    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert UnexpectedNFTReceipt();
    }

    /// @dev Verify the inbound NFT matches the armed, in-flight pin and consume
    ///      it (single-use). Reverts otherwise so the Diamond is never an open
    ///      NFT sink.
    function _consumePinOrRevert(
        address token,
        uint256 tokenId,
        uint256 amount
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (
            !s.consolidationInFlight ||
            token != s.consolidationExpectedToken ||
            tokenId != s.consolidationExpectedTokenId ||
            amount != s.consolidationExpectedAmount
        ) {
            revert UnexpectedNFTReceipt();
        }
        // Consume the pin on first accept — a second matching delivery within
        // the same `safeTransferFrom` (e.g. a hostile ERC-1155) then reverts.
        s.consolidationInFlight = false;
        s.consolidationExpectedToken = address(0);
        s.consolidationExpectedTokenId = 0;
        s.consolidationExpectedAmount = 0;
    }
}
