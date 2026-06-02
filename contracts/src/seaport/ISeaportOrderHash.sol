// src/seaport/ISeaportOrderHash.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ItemType} from "./ISeaportZone.sol";

/**
 * @title ISeaportOrderHash + minimal OrderComponents shape
 * @notice T-086 #306 architectural fix — the diamond's
 *         `NFTPrepayListingFacet.postPrepayListing` now CONSTRUCTS
 *         the full Seaport order from verified loan parameters
 *         and derives the orderHash via Seaport's own
 *         `getOrderHash(OrderComponents)` view. This file vendors
 *         the minimal Seaport surface needed: the
 *         `OrderComponents` struct (matching Seaport 1.6's
 *         `seaport-types/src/lib/ConsiderationStructs.sol`
 *         byte-for-byte so the calldata layout is correct) plus
 *         `getOrderHash` + `getCounter` view selectors.
 *
 *         Without this fix, the vault's ERC-1271 returned the
 *         magic value for ANY orderHash the diamond recorded —
 *         the borrower could craft a malicious unrestricted
 *         order (no zone callback) with consideration distribution
 *         favoring themselves, register its hash via the original
 *         opaque-hash API, and have Seaport pull the collateral
 *         without the executor's content gate firing. See #306 +
 *         the round-1 P1 findings on PR #305.
 *
 *         Source of truth: Seaport 1.6 mainnet
 *         `0x0000000000000068F116a894984e2DB1123eB395`.
 */

/// @dev Seaport order-type enumeration (matches
///      `OrderType.sol`'s declaration order).
///      - FULL_OPEN: anyone may fulfill, full fill required.
///      - PARTIAL_OPEN: anyone may fulfill, partial fills allowed.
///      - FULL_RESTRICTED: only `zone` (or offerer) may fulfill;
///                        full fill required. **The T-086 prepay
///                        path uses ONLY this.**
///      - PARTIAL_RESTRICTED: only `zone` (or offerer); partial
///                            fills allowed.
///      - CONTRACT: contract-offered (Seaport's new
///                  contract-account flow); not used by T-086.
enum OrderType {
    FULL_OPEN,
    PARTIAL_OPEN,
    FULL_RESTRICTED,
    PARTIAL_RESTRICTED,
    CONTRACT
}

/// @dev `OfferItem` is what the offerer gives up. Per Seaport's
///      ConsiderationStructs.sol layout.
struct OfferItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

/// @dev `ConsiderationItem` is what the offerer receives back —
///      each leg routed to its own recipient. Per Seaport's
///      ConsiderationStructs.sol layout.
struct ConsiderationItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address payable recipient;
}

/// @dev `OrderComponents` is the input shape Seaport's
///      `getOrderHash` consumes. The hash is an EIP-712 typed-data
///      digest over these fields in this exact order.
struct OrderComponents {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    OrderType orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 counter;
}

/**
 * @title ISeaportOrderHash
 * @notice Minimal Seaport view surface T-086 needs to compute the
 *         orderHash for a verified order shape on-chain.
 * @dev    Selectors taken from Seaport 1.6's
 *         `ConsiderationInterface.sol`. The diamond reads via
 *         `staticcall` into the configured Seaport singleton —
 *         the source of truth lives on Seaport, not in this
 *         repo, so a hashing-scheme change in a future Seaport
 *         version is automatically picked up.
 */
interface ISeaportOrderHash {
    /// @notice Derive the EIP-712 typed-data hash for an order's
    ///         components. Used by the diamond to compute the
    ///         hash from a verified order shape so the vault's
    ///         ERC-1271 path can never authorise a different shape.
    function getOrderHash(OrderComponents calldata order)
        external
        view
        returns (bytes32 orderHash);

    /// @notice Per-offerer counter Seaport bumps on
    ///         `incrementCounter()`. The diamond reads the
    ///         vault's current counter at post time so the
    ///         orderHash matches what Seaport will compute at
    ///         fill time.
    function getCounter(address offerer) external view returns (uint256);

    /// @notice Address of Seaport's ConduitController singleton —
    ///         the diamond resolves a borrower-supplied
    ///         `conduitKey` to its deployed conduit address via
    ///         `IConduitController.getConduit(conduitKey)`.
    function conduitController() external view returns (address);
}

/**
 * @title IConduitController
 * @notice Minimal Seaport ConduitController surface — resolves a
 *         `conduitKey` (32-byte identifier) to its deployed
 *         conduit ADDRESS. The borrower passes the key in the
 *         order; the vault grants approval to the address.
 *         Binding the two on-chain (via this view) prevents the
 *         borrower from supplying a (key, address) mismatch.
 */
interface IConduitController {
    function getConduit(bytes32 conduitKey)
        external
        view
        returns (address conduit, bool exists);
}

/**
 * @title ISeaportCancel
 * @notice Minimal Seaport mutation surface for canceling a previously
 *         signed prepay-listing order on-chain.
 *
 *         T-086 #316: the `CollateralListingExecutor` is the zone
 *         on every prepay-listing order it records — Seaport's
 *         `cancel` accepts the caller iff `msg.sender == offerer ||
 *         msg.sender == zone`. The executor uses that authorization
 *         to fast-cancel the order at terminal cleanup so OpenSea's
 *         catalog refreshes within ~30s of the on-chain event
 *         instead of waiting for OpenSea's lazy stale-listing
 *         detection (~hours).
 *
 * @dev    `cancel` accepts an array so that multiple orders can be
 *         canceled in one Seaport tx; the executor calls it with a
 *         length-1 array per cleanup site. Seaport's per-order
 *         cancel records `_orderStatus[orderHash].isCancelled = true`
 *         and emits `OrderCancelled(orderHash, offerer, zone)`.
 */
interface ISeaportCancel {
    function cancel(OrderComponents[] calldata orders)
        external
        returns (bool cancelled);
}
