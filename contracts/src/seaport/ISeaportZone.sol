// src/seaport/ISeaportZone.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title ISeaportZone + minimal Seaport 1.6 type definitions
 * @notice Minimal Seaport interface surface T-086 `CollateralListingExecutor`
 *         needs to participate in Seaport's restricted-order flow. Vendored
 *         here as type-only declarations because Seaport itself isn't a
 *         submodule of this repo — pulling the full Seaport tree would
 *         be heavy + add audit-surface we don't need.
 *
 * @dev Source-of-truth: Seaport 1.6 (mainnet `0x0000000000000068F116a894984e2DB1123eB395`).
 *      The full ABI of these types is what Seaport ENCODES + PASSES to the
 *      zone callback, so the field order + names below MUST match Seaport's
 *      `ZoneInterface.sol` definitions byte-for-byte (the calldata layout
 *      is positional). When upgrading to a future Seaport version that
 *      modifies these shapes, this file MUST be updated in lockstep.
 *
 *      We deliberately do NOT redefine the full Order / Item / Conduit
 *      structs Seaport uses internally — only the zone-callback parameter
 *      shape + the ItemType enum, which are the ONLY things the executor
 *      consumes.
 */

/// @dev Seaport item-type enumeration (Item.sol:13). NATIVE = ETH; tokens
///      ordered by ERC standard. The `_WITH_CRITERIA` variants are used
///      for criteria-based fulfillment (single-NFT-from-set patterns);
///      T-086 listings are always concrete-tokenId so we won't construct
///      criteria orders but the enum value space is preserved.
enum ItemType {
    NATIVE,
    ERC20,
    ERC721,
    ERC1155,
    ERC721_WITH_CRITERIA,
    ERC1155_WITH_CRITERIA
}

/// @dev `SpentItem` is what the OFFERER gives up in a Seaport order (the
///      collateral NFT, in T-086's case). Recipient field is implicit —
///      Seaport routes it to the fulfiller.
struct SpentItem {
    ItemType itemType;
    address token;
    uint256 identifier;
    uint256 amount;
}

/// @dev `ReceivedItem` is what the OFFERER receives back (the consideration
///      items: lender payment, treasury fee, borrower residual). The
///      `recipient` is set per-item at sign time and re-verified at fill
///      time by the executor's zone callback.
struct ReceivedItem {
    ItemType itemType;
    address token;
    uint256 identifier;
    uint256 amount;
    address payable recipient;
}

/// @dev `ZoneParameters` is the bundle Seaport hands to a restricted
///      order's zone at fill time. The executor's `validateOrder`
///      callback receives this and:
///        1. Asserts msg.sender == Seaport address (canonical-router gate).
///        2. Re-derives the live floor for `orderHash`'s associated loan.
///        3. Re-verifies consideration[0..2].amount ≥ live floor legs.
///        4. Re-verifies consideration[0].recipient == current lender NFT holder.
///        5. Re-verifies consideration[2].recipient == current borrower NFT holder.
///        6. Calls back into the Vaipakam diamond's executor-callback API.
///
///      The complete `ZoneParameters` shape (matching Seaport's
///      `ZoneInterface.sol` declaration) is preserved here so the calldata
///      decode is correct even though we only read a subset.
struct ZoneParameters {
    bytes32 orderHash;
    address fulfiller;
    address offerer;
    SpentItem[] offer;
    ReceivedItem[] consideration;
    bytes extraData;
    bytes32[] orderHashes;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
}

/**
 * @title ISeaportZone
 * @notice The zone-callback interface Seaport invokes on restricted orders
 *         (`FULL_RESTRICTED` and `PARTIAL_RESTRICTED` order types) at fill
 *         time. T-086 listings are always `FULL_RESTRICTED` per design
 *         doc §5.6 (so a buyer can't acquire only part of an ERC1155
 *         balance and close the loan with partial payment).
 *
 *         The selector return value MUST match
 *         `ISeaportZone.validateOrder.selector` to signal acceptance.
 *         A revert or wrong selector causes Seaport to abort the fill.
 */
interface ISeaportZone {
    function validateOrder(ZoneParameters calldata params)
        external
        returns (bytes4 validOrderMagicValue);
}
