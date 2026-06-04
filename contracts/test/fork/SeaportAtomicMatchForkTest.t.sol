// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {
    ISeaportOrderHash,
    OrderComponents,
    OfferItem,
    ConsiderationItem,
    OrderType
} from "../../src/seaport/ISeaportOrderHash.sol";
import {ISeaportMatch} from "../../src/seaport/ISeaportMatch.sol";
import {ItemType} from "../../src/seaport/ISeaportZone.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/**
 * @title SeaportAtomicMatchForkTest
 * @notice T-086 Block D follow-up (#348) — exercises the
 *         **real** Seaport 1.6 deployment at the canonical address
 *         on a Base-Sepolia fork to confirm the §17.5 on-chain
 *         hash re-derive invariant the atomic facet relies on.
 *
 *         The atomic facet's
 *         `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` validates
 *         the bidder's signed Offer by:
 *           1. Re-deriving the orderHash via
 *              `Seaport.getOrderHash(orderComponents)`.
 *           2. Comparing the derived hash to the dapp-pinned
 *              `expectedBidderOrderHash` (pinned from the
 *              earlier offers-list response).
 *           3. Reverting `BidderOrderHashMismatch` on drift.
 *
 *         The whole flow depends on real Seaport returning the
 *         exact bytes the facet expects when fed an
 *         `OrderComponents` struct. The unit-test `MockSeaport`
 *         uses `keccak256(abi.encode(components))` which is
 *         deterministic per-input but NOT EIP-712 — the mock
 *         only proves "the facet calls Seaport in the right
 *         shape", not "real Seaport produces the same hash".
 *
 *         This fork test closes that gap by:
 *           1. Building an OrderComponents struct mirroring what
 *              the dapp would surface from OpenSea Fulfillment
 *              Data (per PR #349).
 *           2. Reading the hash from real Seaport's
 *              `getOrderHash(...)` view.
 *           3. Asserting the hash is non-zero and stable across
 *              repeated calls (Seaport is a pure view here).
 *           4. Verifying `getOrderStatus` returns the
 *              fresh-off-chain-signed shape
 *              `(isValidated=false, isCancelled=false,
 *              totalFilled=0, totalSize=0)` — the atomic facet's
 *              early-fillable check passes for that combination.
 *
 *         The full `matchAdvancedOrders` happy-path settlement
 *         (conduit registration, ERC-1271 vault sig, both orders
 *         signed + matched) is a richer follow-up — it needs a
 *         whole diamond deployed on the fork + a real
 *         ConduitController interaction. This phase-1 fork test
 *         locks the hash-rederive contract that's load-bearing
 *         for §17.5; phase-2 would add the full settlement
 *         walkthrough.
 *
 *         Gated by `FORK_URL_BASE_SEPOLIA`. Silently skipped when
 *         the env is empty so CI without an archive-node URL
 *         passes. (Same fail-soft pattern as Permit2RealForkTest.)
 */
contract SeaportAtomicMatchForkTest is Test {
    // Seaport 1.6 deterministic CREATE2 deploy address — same on
    // every supported chain, including Base-Sepolia.
    address internal constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;

    bool internal forkEnabled;

    // Deterministic test wallet so the constructed OrderComponents
    // is reproducible across runs.
    uint256 internal constant BIDDER_PK =
        uint256(keccak256("vaipakam-seaport-fork-bidder"));
    address internal bidder;
    address internal borrowerVault;

    // Synthetic ERC721 collateral + ERC20 payment token — fresh on
    // the fork so we don't have to impersonate a real OpenSea
    // collection's owner.
    address internal collateral;
    ERC20Mock internal payment;
    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL_BASE_SEPOLIA", string(""));
        if (bytes(url).length == 0) {
            forkEnabled = false;
            return;
        }
        vm.createSelectFork(url);
        forkEnabled = true;

        // Sanity: Seaport 1.6 must be at the canonical address on
        // the chosen fork. Aborts the test with a clear error if
        // the operator pointed FORK_URL_BASE_SEPOLIA at a chain
        // without Seaport 1.6 (e.g. a fresh devnet).
        require(SEAPORT.code.length > 0, "Seaport 1.6 not deployed on this fork");

        bidder = vm.addr(BIDDER_PK);
        borrowerVault = makeAddr("vaipakam-borrower-vault");
        collateral = makeAddr("synthetic-collection");
        payment = new ERC20Mock("ForkPay", "FPAY", 18);
    }

    /// @notice Real Seaport returns a non-zero, stable orderHash
    ///         for a well-formed OrderComponents struct.
    function test_Fork_RealSeaport_GetOrderHash_NonZeroAndStable() public {
        if (!forkEnabled) return;

        OrderComponents memory components = _buildBidderOrderComponents();

        bytes32 hashA = ISeaportOrderHash(SEAPORT).getOrderHash(components);
        bytes32 hashB = ISeaportOrderHash(SEAPORT).getOrderHash(components);

        // §17.5 invariant: the hash must be stable across repeated
        // calls (Seaport's `getOrderHash` is a pure-view EIP-712
        // typed-data derivation; same input → same output).
        assertEq(hashA, hashB, "Seaport.getOrderHash must be deterministic");

        // §17.5 invariant: a real EIP-712 hash is overwhelmingly
        // unlikely to collide with zero. Non-zero confirms Seaport
        // actually computed something rather than reverting silently.
        assertTrue(hashA != bytes32(0), "Seaport.getOrderHash must be non-zero");
    }

    /// @notice Real Seaport's `getOrderStatus` for a freshly-
    ///         constructed (never-validated, never-filled) order
    ///         returns the shape the atomic facet's §17.5 early-
    ///         fillable check passes for.
    function test_Fork_RealSeaport_GetOrderStatus_FreshOrderIsFillable() public {
        if (!forkEnabled) return;

        OrderComponents memory components = _buildBidderOrderComponents();
        bytes32 orderHash = ISeaportOrderHash(SEAPORT).getOrderHash(components);

        (
            bool isValidated,
            bool isCancelled,
            uint256 totalFilled,
            uint256 totalSize
        ) = ISeaportMatch(SEAPORT).getOrderStatus(orderHash);

        // The atomic facet's early-fillable assertion is:
        //   require(!isCancelled, BidderOrderNotFillable(REASON_CANCELLED))
        //   require(!(totalSize != 0 && totalFilled >= totalSize), ...)
        //
        // For a fresh off-chain-signed order Seaport's storage is
        // untouched, so:
        //   - isValidated == false (no on-chain Seaport.validate call)
        //   - isCancelled == false (no on-chain Seaport.cancel call)
        //   - totalFilled == 0, totalSize == 0 (no on-chain fulfill call)
        // Both atomic-facet preconditions hold.
        assertEq(isValidated, false, "fresh order is not pre-validated");
        assertEq(isCancelled, false, "fresh order is not cancelled");
        assertEq(totalFilled, 0, "fresh order has zero fills");
        assertEq(totalSize, 0, "fresh order has zero size on Seaport storage");
    }

    // ─── Helpers ───────────────────────────────────────────────────

    /// @dev Constructs a minimally-valid bidder OrderComponents
    ///      mirroring the shape the dapp would surface from
    ///      OpenSea Fulfillment Data (PR #349): single ERC20 offer
    ///      item + single ERC721 consideration item routed back to
    ///      the bidder. Counter is read from real Seaport so the
    ///      hash matches what a real bidder would have signed.
    function _buildBidderOrderComponents()
        internal
        view
        returns (OrderComponents memory components)
    {
        OfferItem[] memory offer = new OfferItem[](1);
        offer[0] = OfferItem({
            itemType: ItemType.ERC20,
            token: address(payment),
            identifierOrCriteria: 0,
            startAmount: 1_000 ether,
            endAmount: 1_000 ether
        });

        ConsiderationItem[] memory consideration = new ConsiderationItem[](1);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC721,
            token: collateral,
            identifierOrCriteria: TOKEN_ID,
            startAmount: 1,
            endAmount: 1,
            recipient: payable(bidder)
        });

        components = OrderComponents({
            offerer: bidder,
            zone: address(0),
            offer: offer,
            consideration: consideration,
            orderType: OrderType.FULL_OPEN,
            startTime: block.timestamp,
            endTime: block.timestamp + 7 days,
            zoneHash: bytes32(0),
            salt: 12_345,
            conduitKey: bytes32(0),
            counter: ISeaportOrderHash(SEAPORT).getCounter(bidder)
        });
    }
}
