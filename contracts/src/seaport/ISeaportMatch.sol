// src/seaport/ISeaportMatch.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {OrderComponents} from "./ISeaportOrderHash.sol";
import {ItemType} from "./ISeaportZone.sol";

/**
 * @title ISeaportMatch + Seaport AdvancedOrder/Fulfillment shapes
 * @notice T-086 Round-6 / Block D (#345). The atomic match-rotation
 *         flow calls `Seaport.matchAdvancedOrders` to atomically
 *         settle the bidder's signed OpenSea Offer against a Vaipakam-
 *         constructed counter-order. This file vendors the minimal
 *         shape we need from Seaport 1.6's
 *         `ConsiderationInterface.sol` to do that:
 *
 *         - `AdvancedOrder` — the shape `matchAdvancedOrders` consumes
 *           per side; wraps `OrderParameters` + `numerator/denominator`
 *           (always `1/1` for our full-fill match) + `signature` +
 *           `extraData` (the bidder's SIP-7 SignedZone blob for
 *           fee-enforced collections, blank for our Vaipakam side).
 *         - `Fulfillment` — pairs offer-component refs with
 *           consideration-component refs, telling Seaport how to
 *           route items between the two orders.
 *         - `CriteriaResolver` — proves that a specific tokenId
 *           satisfies a collection-criteria offer's Merkle root.
 *
 * @dev   Types are vendored at Seaport 1.6 layout. A future
 *        Seaport upgrade that re-orders fields would force a
 *        coordinated UUPS swap on the executor + new facet
 *        deployment — the executor's `getOrderHash` / `cancel`
 *        usage is already on the same versioning surface so this
 *        adds no new coupling.
 */

/// @dev `OrderParameters` is `OrderComponents` minus `counter` plus
///      `totalOriginalConsiderationItems` (Seaport's consideration-
///      array bounds check). The atomic facet builds these for both
///      sides at match-time; the counter on the components shape
///      lives on the components-level `recordOrder` path instead.
struct OrderParameters {
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
    uint256 totalOriginalConsiderationItems;
}

/// @dev Seaport 1.6's `OfferItem` shape — used in `OrderParameters`.
struct OfferItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

/// @dev Seaport 1.6's `ConsiderationItem` shape — adds a `recipient`
///      tail to `OfferItem`. Each consideration item must be paid in
///      full at match time (and the recipient pinning is what makes
///      Vaipakam's lender + treasury + borrower split safe).
struct ConsiderationItem {
    ItemType itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address payable recipient;
}

/// @dev Seaport 1.6 OrderType enum — `FULL_RESTRICTED` is the
///      Vaipakam-side counter-order's type (FullyFilled + RestrictedZone
///      so only our executor can authorise the fill).
enum OrderType {
    FULL_OPEN,
    PARTIAL_OPEN,
    FULL_RESTRICTED,
    PARTIAL_RESTRICTED,
    CONTRACT
}

/**
 * @dev The shape `matchAdvancedOrders` consumes per side.
 *      For our atomic-match call:
 *        orders[0] = bidder's OpenSea Offer wrapped from
 *                    BidderOrder.components + signature + extraData
 *        orders[1] = Vaipakam counter-order built in
 *                    `NFTPrepayListingAtomicFacet`, signature=""
 *                    (ERC-1271 path via the vault), extraData=""
 *                    (FULL_RESTRICTED zone callback, not SIP-7)
 *      `numerator`/`denominator` are both `1` for our full-fill match.
 */
struct AdvancedOrder {
    OrderParameters parameters;
    uint120 numerator;
    uint120 denominator;
    bytes signature;
    bytes extraData;
}

/// @dev `Side` discriminator on a `CriteriaResolver`. Tells Seaport
///      whether the criteria-item we're resolving is on the offer
///      side or the consideration side of the order at `orderIndex`.
enum Side {
    OFFER,
    CONSIDERATION
}

/**
 * @dev `CriteriaResolver` proves a specific `identifier` is included
 *      in the Merkle root carried by an `ERC721_WITH_CRITERIA` or
 *      `ERC1155_WITH_CRITERIA` item. For OpenSea collection offers
 *      with no traits filter the criteria root is `0` and the proof
 *      is empty; for traited offers the root is a real Merkle root
 *      and the proof comes from OpenSea's API.
 */
struct CriteriaResolver {
    uint256 orderIndex;
    Side side;
    uint256 index;
    uint256 identifier;
    bytes32[] criteriaProof;
}

/**
 * @dev `FulfillmentComponent` references a specific (order, item) pair.
 *      Used inside `Fulfillment.offerComponents` /
 *      `Fulfillment.considerationComponents` to describe which
 *      side-of-which-order an item flow is consuming / satisfying.
 *      Per the §17.9 fulfillment layout, the SAME
 *      `FulfillmentComponent{0, 0}` (bidder offer item 0) appears
 *      in multiple Fulfillments — Seaport decrements `endAmount`
 *      across them.
 */
struct FulfillmentComponent {
    uint256 orderIndex;
    uint256 itemIndex;
}

/// @dev A single matched pair — offer item(s) on one side satisfying
///      consideration item(s) on the other. Seaport aggregates the
///      amounts on both sides and asserts they balance (with any
///      leftover offer-side flowing to `matchAdvancedOrders`'s
///      `recipient` argument).
struct Fulfillment {
    FulfillmentComponent[] offerComponents;
    FulfillmentComponent[] considerationComponents;
}

/**
 * @title ISeaportMatch
 * @notice Minimal Seaport surface for the Round-6 atomic-match flow.
 *         Vendored from `ConsiderationInterface.sol` at Seaport 1.6.
 *
 * @dev    The single function we call is `matchAdvancedOrders` — both
 *         sides as `AdvancedOrder`s, the resolvers + fulfillments, and
 *         the recipient for any unspent offer-side amount (the §17.9
 *         .bis defense-in-depth recipient is the executor itself).
 */
interface ISeaportMatch {
    /// @notice Execute two or more orders simultaneously, paying any
    ///         unspent offer items to `recipient`. Returns the
    ///         consumed `Execution[]` (which we don't introspect).
    function matchAdvancedOrders(
        AdvancedOrder[] calldata orders,
        CriteriaResolver[] calldata criteriaResolvers,
        Fulfillment[] calldata fulfillments,
        address recipient
    ) external payable;

    /// @notice Read the on-chain status of an orderHash.
    /// @dev    Used by the atomic facet's §17.5 cancellation check.
    ///         For fresh off-chain-signed orders, `totalSize == 0`
    ///         and `isValidated == false`; only `isCancelled` is the
    ///         load-bearing field.
    function getOrderStatus(bytes32 orderHash)
        external
        view
        returns (
            bool isValidated,
            bool isCancelled,
            uint256 totalFilled,
            uint256 totalSize
        );
}
