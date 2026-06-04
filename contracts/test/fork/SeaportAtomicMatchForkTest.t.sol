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

        // Codex round-1 P2: assert chain identity. Seaport 1.6 lives
        // at the same canonical address on every supported chain,
        // so a SEAPORT.code-length sanity check would silently pass
        // even if the operator accidentally pointed
        // FORK_URL_BASE_SEPOLIA at Ethereum mainnet or Base mainnet
        // (Seaport at the same address there too). Base-Sepolia's
        // chainId is 84532; assert it explicitly so a misconfigured
        // fork URL fails loudly with an actionable message.
        require(
            block.chainid == 84_532,
            "FORK_URL_BASE_SEPOLIA must point at Base-Sepolia (chainId 84532)"
        );
        require(SEAPORT.code.length > 0, "Seaport 1.6 not deployed on this fork");

        bidder = vm.addr(BIDDER_PK);
        borrowerVault = makeAddr("vaipakam-borrower-vault");
        collateral = makeAddr("synthetic-collection");
        payment = new ERC20Mock("ForkPay", "FPAY", 18);
    }

    /// @notice Real Seaport's `getOrderHash` matches an
    ///         independently-derived EIP-712 typed-data digest
    ///         over the same OrderComponents — the load-bearing
    ///         §17.5 hash-rederive contract. Codex round-1 P2
    ///         strengthened the prior "stable + non-zero" check
    ///         (which only proved Seaport returned a deterministic
    ///         value, not the RIGHT value).
    function test_Fork_RealSeaport_GetOrderHash_MatchesIndependentDigest()
        public
    {
        if (!forkEnabled) return;

        OrderComponents memory components = _buildBidderOrderComponents();

        bytes32 seaportHash = ISeaportOrderHash(SEAPORT).getOrderHash(components);
        bytes32 derivedHash = _deriveSeaportOrderHashLocally(components);

        // §17.5 hash-rederive contract: the on-chain `getOrderHash`
        // call the facet uses MUST match a locally-derived EIP-712
        // digest using the canonical typehashes. Otherwise the
        // facet's pinned `expectedBidderOrderHash` would never
        // align with Seaport's view at match time.
        assertEq(
            seaportHash,
            derivedHash,
            "Seaport.getOrderHash must match the canonical EIP-712 digest"
        );

        // Determinism check stays — same input must produce same
        // hash across repeated calls (Seaport's `getOrderHash` is
        // a pure view).
        bytes32 seaportHash2 = ISeaportOrderHash(SEAPORT).getOrderHash(components);
        assertEq(
            seaportHash,
            seaportHash2,
            "Seaport.getOrderHash must be deterministic across calls"
        );

        // Non-zero sanity — a real EIP-712 hash is overwhelmingly
        // unlikely to collide with zero.
        assertTrue(seaportHash != bytes32(0), "Seaport.getOrderHash must be non-zero");
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

    // Canonical Seaport 1.6 typehashes, vendored verbatim from
    // ProjectOpenSea/seaport's `OrderHashing.sol` (commit pinned by
    // the deterministic 0x...EB395 deploy). These are what Seaport
    // hashes the OrderComponents struct against to produce the
    // typed-data digest the facet's pinned `expectedBidderOrderHash`
    // must equal.
    bytes32 internal constant OFFER_ITEM_TYPEHASH = keccak256(
        "OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)"
    );
    bytes32 internal constant CONSIDERATION_ITEM_TYPEHASH = keccak256(
        "ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)"
    );
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)"
    );

    /// @dev Replicates Seaport 1.6's EIP-712 typed-data digest for
    ///      an `OrderComponents` struct using the canonical
    ///      typehashes above + Seaport's actual DOMAIN_SEPARATOR()
    ///      read from the fork. The resulting hash MUST equal what
    ///      `Seaport.getOrderHash(components)` returns — if it
    ///      doesn't, our facet's pinned `expectedBidderOrderHash`
    ///      will never match Seaport's view at match time, and the
    ///      atomic match would always revert
    ///      `BidderOrderHashMismatch`.
    function _deriveSeaportOrderHashLocally(
        OrderComponents memory c
    ) internal view returns (bytes32) {
        // Hash each OfferItem entry then keccak the concatenation
        // (per EIP-712 array encoding).
        bytes32[] memory offerHashes = new bytes32[](c.offer.length);
        for (uint256 i = 0; i < c.offer.length; i++) {
            offerHashes[i] = keccak256(
                abi.encode(
                    OFFER_ITEM_TYPEHASH,
                    c.offer[i].itemType,
                    c.offer[i].token,
                    c.offer[i].identifierOrCriteria,
                    c.offer[i].startAmount,
                    c.offer[i].endAmount
                )
            );
        }
        bytes32 offerArrayHash = keccak256(abi.encodePacked(offerHashes));

        // Same for the ConsiderationItem array.
        bytes32[] memory consHashes =
            new bytes32[](c.consideration.length);
        for (uint256 i = 0; i < c.consideration.length; i++) {
            consHashes[i] = keccak256(
                abi.encode(
                    CONSIDERATION_ITEM_TYPEHASH,
                    c.consideration[i].itemType,
                    c.consideration[i].token,
                    c.consideration[i].identifierOrCriteria,
                    c.consideration[i].startAmount,
                    c.consideration[i].endAmount,
                    c.consideration[i].recipient
                )
            );
        }
        bytes32 consArrayHash = keccak256(abi.encodePacked(consHashes));

        // Struct-level hash for the OrderComponents itself.
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                c.offerer,
                c.zone,
                offerArrayHash,
                consArrayHash,
                uint8(c.orderType),
                c.startTime,
                c.endTime,
                c.zoneHash,
                c.salt,
                c.conduitKey,
                c.counter
            )
        );

        // Seaport's documented `_deriveOrderHash` returns the
        // struct hash directly (no \x19\x01 EIP-712 prefix —
        // unlike e.g. Permit2's signature digest, which DOES
        // prepend the domain separator for the actual signed
        // payload). The `extractDomainSeparator` confirmation
        // below is a sanity check that Seaport's domain hasn't
        // drifted, but the returned `orderHash` is the raw
        // struct hash. See:
        // https://github.com/ProjectOpenSea/seaport/blob/main/contracts/lib/OrderHashing.sol
        _assertSeaportDomainIsSane();
        return structHash;
    }

    /// @dev Reads `DOMAIN_SEPARATOR()` off real Seaport and
    ///      asserts it's non-zero. Doesn't compare against a
    ///      hardcoded value — that would couple the test to
    ///      Seaport's nonce / chainId / EIP-712 version (the
    ///      address+chainId vary across the supported chain set).
    ///      Just confirms Seaport is alive at the canonical
    ///      address and that DOMAIN_SEPARATOR() works.
    function _assertSeaportDomainIsSane() internal view {
        (bool ok, bytes memory ret) =
            SEAPORT.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(ok && ret.length == 32, "Seaport.DOMAIN_SEPARATOR() must be callable");
        bytes32 domain = abi.decode(ret, (bytes32));
        require(domain != bytes32(0), "Seaport.DOMAIN_SEPARATOR() must be non-zero");
    }

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
