// src/libraries/LibPrepayOrder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IVaipakamPrepayContext} from "../seaport/IVaipakamPrepayContext.sol";
import {
    ISeaportOrderHash,
    IConduitController,
    OrderComponents,
    OfferItem,
    ConsiderationItem,
    OrderType
} from "../seaport/ISeaportOrderHash.sol";
import {ItemType} from "../seaport/ISeaportZone.sol";
import {FeeLeg, OfferContext} from "../seaport/PrepayTypes.sol";

/**
 * @title LibPrepayOrder
 * @author Vaipakam Developer Team
 * @notice #306 architectural fix — builds the canonical Seaport
 *         `OrderComponents` struct for a prepay-collateral
 *         listing from VERIFIED loan parameters, then derives
 *         the orderHash via Seaport's own
 *         `getOrderHash(OrderComponents)` view.
 *
 *         The borrower's `postPrepayListing` API no longer
 *         accepts an opaque orderHash. They pass only the
 *         parameters they control (`askPrice`, `salt`,
 *         `conduitKey`); every other field of the Seaport order
 *         is FIXED by protocol invariants:
 *           - offerer       = borrower's per-user vault
 *           - zone          = `CollateralListingExecutor` singleton
 *           - orderType     = `FULL_RESTRICTED`
 *           - offer item    = the loan's collateral NFT (ItemType
 *                             derived from `loan.collateralAssetType`)
 *           - consideration = ONE proceeds leg paid to the Diamond,
 *                             then the listing's fee legs (#2876)
 *           - startTime     = block.timestamp
 *           - endTime       = `loan.gracePeriodEnd` (exclusive
 *                             on the Seaport side too)
 *           - zoneHash      = `bytes32(0)` (no zone-side payload)
 *           - counter       = `seaport.getCounter(vault)` at sign
 *                             time
 *
 *         By computing the hash from this canonical shape via
 *         Seaport's own view, the vault's ERC-1271 path can never
 *         authorise a different shape — closing the #306
 *         vault-ERC-1271-orderHash-shape-flaw.
 *
 *         **One proceeds leg (#2876).** The order pays the sale price,
 *         less its fee legs, to the Diamond as a single leg, the same
 *         shape as the offer-keyed parallel-sale order below. The
 *         Diamond splits it when the fill settles: the lender and the
 *         treasury are paid what a full repayment would owe at that
 *         moment (with the lender's yield-fee discount resolved on the
 *         treasury share), and the borrower position's holder receives
 *         the rest in their vault. So nothing in the signed order names
 *         the lender, the treasury or the borrower: a position-NFT
 *         transfer or a treasury rotation no longer stales a listing,
 *         and the payout always follows the holders at fill time.
 */
library LibPrepayOrder {
    /// @dev #656a — the scalar order-spec values that thread through the
    ///      canonical `OrderComponents` builder, bundled into a MEMORY struct so
    ///      they're read on-demand (one `mload` each at use) instead of living
    ///      as simultaneous stack slots inside `_componentsAtMemory`. The
    ///      whole `buildAndHash*` → `_componentsAtMemory` chain inlines into each
    ///      listing facet, so this struct is what keeps the flattened frame
    ///      under the viaIR whole-unit stack ceiling. Field order is
    ///      documentation-only.
    struct OrderSpec {
        uint256 startAskPrice;
        uint256 endAskPrice;
        /// @dev #2876 — recipient of the proceeds leg. Passed explicitly
        ///      because the executor rebuilds the order for cancellation in
        ///      its own context, where `address(this)` is not the Diamond.
        address diamond;
        uint256 salt;
        bytes32 conduitKey;
        uint256 startTime;
        uint256 seaportEndTime;
        uint256 counter;
    }

    /// @dev Resolve the `OrderComponents` for a fixed-price prepay
    ///      listing and derive its Seaport orderHash. Single source
    ///      of truth consumed by `NFTPrepayListingFacet.postPrepayListing`
    ///      + `updatePrepayListing`. Runs inside the Diamond, so the
    ///      proceeds recipient is `address(this)`.
    ///
    ///      Round-5 Block A (#313): accepts an optional `feeLegs`
    ///      array (length 0..MAX_FEE_LEGS=4). Each fee leg is
    ///      appended after the proceeds leg, in the order the
    ///      caller provides — the dapp orders them per the
    ///      OpenSea Collection API response so OpenSea's
    ///      submission-time enforcement sees the expected shape.
    function buildAndHash(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        address seaport,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) internal view returns (bytes32 orderHash) {
        OrderComponents memory components = _componentsAtCalldata(
            pctx,
            vault,
            executor,
            OrderSpec({
                startAskPrice: askPrice,
                endAskPrice: askPrice,      // fixed-price: end == start
                diamond: address(this),
                salt: salt,
                conduitKey: conduitKey,
                startTime: block.timestamp,
                seaportEndTime: pctx.graceEnd, // fixed-price: endTime = grace
                counter: ISeaportOrderHash(seaport).getCounter(vault)
            }),
            feeLegs
        );
        orderHash = ISeaportOrderHash(seaport).getOrderHash(components);
    }

    /// @dev T-086 Round-6 / Block D (#345) — memory-typed sibling
    ///      of {buildAndHash} used by the auto-list facet. Solidity
    ///      doesn't allow overloading internal library functions by
    ///      data location alone, so a distinct name.
    function buildAndHashMem(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        address seaport,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] memory feeLegs
    ) internal view returns (bytes32 orderHash) {
        OrderComponents memory components = fixedPriceComponentsMem(
            pctx,
            vault,
            executor,
            askPrice,
            salt,
            conduitKey,
            ISeaportOrderHash(seaport).getCounter(vault),
            feeLegs
        );
        orderHash = ISeaportOrderHash(seaport).getOrderHash(components);
    }

    /// @dev The canonical fixed-price components a listing opened at this
    ///      block signs: `startTime = block.timestamp`, `endTime =
    ///      pctx.graceEnd`, proceeds to `address(this)` (the Diamond).
    ///      {buildAndHashMem} hashes them; the atomic OpenSea-offer match
    ///      submits the same items as its counter-order, so the order it
    ///      records and the order it fills cannot differ in shape.
    function fixedPriceComponentsMem(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        uint256 askPrice,
        uint256 salt,
        bytes32 conduitKey,
        uint256 counter,
        FeeLeg[] memory feeLegs
    ) internal view returns (OrderComponents memory) {
        return _componentsAtMemory(
            pctx,
            vault,
            executor,
            OrderSpec({
                startAskPrice: askPrice,
                endAskPrice: askPrice,      // fixed-price: end == start
                diamond: address(this),
                salt: salt,
                conduitKey: conduitKey,
                startTime: block.timestamp,
                seaportEndTime: pctx.graceEnd, // fixed-price: endTime = grace
                counter: counter
            }),
            feeLegs
        );
    }

    /// @dev Round-5 Block B (#309): Dutch-mode variant of
    ///      {buildAndHash}. The proceeds leg decays from
    ///      `startAskPrice − sum(feeLegs.startAmount)` at
    ///      `block.timestamp` down to `endAskPrice −
    ///      sum(feeLegs.endAmount)` at `auctionEndTime`, by Seaport's
    ///      native amount interpolation. The facet has already checked
    ///      that the end proceeds cover the floor projected at
    ///      `auctionEndTime`; the floor only grows, so every earlier fill
    ///      is covered too.
    ///
    ///      The `endTime` on the components struct is
    ///      `auctionEndTime`, NOT `pctx.graceEnd` — past
    ///      `auctionEndTime`, Seaport rejects the order as expired
    ///      and the protocol-side cleanup path handles the still-
    ///      locked NFT (§15.2 "Seaport-side vs protocol-side
    ///      terminal-time boundary").
    function buildAndHashDutch(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        address seaport,
        uint256 startAskPrice,
        uint256 endAskPrice,
        uint256 auctionEndTime,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) internal view returns (bytes32 orderHash) {
        OrderComponents memory components = _componentsAtCalldata(
            pctx,
            vault,
            executor,
            OrderSpec({
                startAskPrice: startAskPrice,
                endAskPrice: endAskPrice,
                diamond: address(this),
                salt: salt,
                conduitKey: conduitKey,
                startTime: block.timestamp,
                seaportEndTime: auctionEndTime,
                counter: ISeaportOrderHash(seaport).getCounter(vault)
            }),
            feeLegs
        );
        orderHash = ISeaportOrderHash(seaport).getOrderHash(components);
    }

    /// @dev Resolve the deployed conduit ADDRESS for a given
    ///      `conduitKey` via Seaport's ConduitController. The
    ///      borrower passes the key (used in the order shape);
    ///      the diamond uses the address for the vault's
    ///      per-token / operator approval, and the executor's
    ///      allow-list is keyed on the address. Binding them
    ///      on-chain prevents a (key, address) mismatch attack.
    function resolveConduit(
        address seaport,
        bytes32 conduitKey
    ) internal view returns (address conduit) {
        address controller = ISeaportOrderHash(seaport).conduitController();
        bool exists;
        (conduit, exists) = IConduitController(controller).getConduit(conduitKey);
        // `getConduit` returns `(address, false)` when the key
        // hasn't been deployed yet; the borrower's frontend
        // should always pass an already-deployed conduit's key.
        require(exists, "conduit key not deployed");
        require(conduit != address(0), "conduit key resolves to zero");
    }

    /// @dev Rebuild the canonical `OrderComponents` for a previously
    ///      recorded fixed-price (or atomic-match) listing, from the
    ///      sign-time inputs the executor pinned in
    ///      {CollateralListingExecutor.OrderContext}, so the executor can
    ///      forward `Seaport.cancel` at terminal cleanup (T-086 #316).
    ///      {buildAndHash} can't be reused: it stamps `startTime =
    ///      block.timestamp`. The order carries no loan amounts (#2876),
    ///      so the rebuild needs only the recorded inputs, the loan's
    ///      collateral and grace end (from `pctx`) and the Diamond.
    function componentsForCancel(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address executor,
        address diamond,
        uint256 askPrice,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 counter,
        FeeLeg[] memory feeLegs
    ) internal pure returns (OrderComponents memory) {
        return _componentsAtMemory(
            pctx,
            pctx.borrowerVault,
            executor,
            OrderSpec({
                startAskPrice: askPrice,
                endAskPrice: askPrice,        // fixed-price: end == start
                diamond: diamond,
                salt: salt,
                conduitKey: conduitKey,
                startTime: startTime,
                seaportEndTime: pctx.graceEnd, // fixed-price: endTime = grace
                counter: counter
            }),
            feeLegs
        );
    }

    /// @dev Round-5 Block B (#309) — Dutch-mode cancel-time
    ///      reconstruction. Every input is recorded at sign time
    ///      (`startAskPrice` / `endAskPrice` / `auctionEndTime` / `salt`
    ///      / `conduitKey` / `startTime` / fee legs); since #2876 the
    ///      order carries no projected loan legs, so a governance change
    ///      mid-auction no longer makes the rebuilt hash drift.
    function componentsForCancelDutch(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address executor,
        address diamond,
        uint256 startAskPrice,
        uint256 endAskPrice,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 auctionEndTime,
        uint256 counter,
        FeeLeg[] memory feeLegs
    ) internal pure returns (OrderComponents memory) {
        return _componentsAtMemory(
            pctx,
            pctx.borrowerVault,
            executor,
            OrderSpec({
                startAskPrice: startAskPrice,
                endAskPrice: endAskPrice,
                diamond: diamond,
                salt: salt,
                conduitKey: conduitKey,
                startTime: startTime,
                seaportEndTime: auctionEndTime,
                counter: counter
            }),
            feeLegs
        );
    }

    // ── Internal helpers ────────────────────────────────────────────

    /// @dev Pure body for the calldata-feeLegs flavour (the sign-time
    ///      path through {buildAndHash} / {buildAndHashDutch}).
    function _componentsAtCalldata(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        OrderSpec memory spec,
        FeeLeg[] calldata feeLegs
    ) private pure returns (OrderComponents memory components) {
        // Copy fee legs into memory so {_componentsAtMemory} can iterate
        // them with a single data-location-agnostic loop. Length is
        // bounded by `MAX_FEE_LEGS = 4` in the facet so the copy
        // cost is trivial.
        FeeLeg[] memory feeLegsMem = new FeeLeg[](feeLegs.length);
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeLegsMem[i] = feeLegs[i];
            unchecked { ++i; }
        }
        return _componentsAtMemory(pctx, vault, executor, spec, feeLegsMem);
    }

    /// @dev Pure body shared by every loan-keyed builder. Fixed-price:
    ///      `startAskPrice == endAskPrice` and `seaportEndTime ==
    ///      pctx.graceEnd`. Dutch: `startAskPrice ≥ endAskPrice` and
    ///      `seaportEndTime == auctionEndTime`. Parameterised on
    ///      `startTime` and `seaportEndTime` so cancel-time
    ///      reconstruction can pin the original sign-time stamps.
    function _componentsAtMemory(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        OrderSpec memory spec,
        FeeLeg[] memory feeLegs
    ) private pure returns (OrderComponents memory components) {
        // ─── Offer (one item: the collateral NFT) ──────────────
        OfferItem[] memory offer = new OfferItem[](1);
        if (pctx.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            offer[0] = OfferItem({
                itemType: ItemType.ERC721,
                token: pctx.collateralAsset,
                identifierOrCriteria: pctx.collateralTokenId,
                startAmount: 1,
                endAmount: 1
            });
        } else {
            // ERC1155 — full vaulted balance per design doc §7.
            offer[0] = OfferItem({
                itemType: ItemType.ERC1155,
                token: pctx.collateralAsset,
                identifierOrCriteria: pctx.collateralTokenId,
                startAmount: pctx.collateralQuantity,
                endAmount: pctx.collateralQuantity
            });
        }

        // ─── Consideration (1 proceeds leg + N fee legs) ───────
        // #2876 — the buyer pays exactly the ask: the fee legs go to
        // their recipients and the rest is ONE proceeds leg to the
        // Diamond, which splits it between lender, treasury and the
        // borrower position at the fill. The facet's floor checks
        // guarantee the subtraction cannot underflow.
        uint256 feeSumStart = 0;
        uint256 feeSumEnd = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSumStart += uint256(feeLegs[i].startAmount);
            feeSumEnd += uint256(feeLegs[i].endAmount);
            unchecked { ++i; }
        }
        ConsiderationItem[] memory consideration = new ConsiderationItem[](1 + feeLegs.length);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: spec.startAskPrice - feeSumStart,
            endAmount: spec.endAskPrice - feeSumEnd,
            recipient: payable(spec.diamond)
        });
        // Append fee legs (Round 5 #313).
        for (uint256 i = 0; i < feeLegs.length; ) {
            consideration[1 + i] = ConsiderationItem({
                itemType: ItemType.ERC20,
                token: pctx.principalAsset,
                identifierOrCriteria: 0,
                startAmount: uint256(feeLegs[i].startAmount),
                endAmount: uint256(feeLegs[i].endAmount),
                recipient: payable(feeLegs[i].recipient)
            });
            unchecked { ++i; }
        }

        components = OrderComponents({
            offerer: vault,
            zone: executor,
            offer: offer,
            consideration: consideration,
            // T-086 prepay listings are ALWAYS FULL_RESTRICTED —
            // see design doc §5.6. The executor's content gate
            // depends on this for the full-balance ERC1155
            // invariant + Seaport's restricted-order routing.
            orderType: OrderType.FULL_RESTRICTED,
            startTime: spec.startTime,
            endTime: spec.seaportEndTime,
            zoneHash: bytes32(0),
            salt: spec.salt,
            conduitKey: spec.conduitKey,
            counter: spec.counter
        });
    }

    // ─── T-086 Round-8 (#358) — No-loan-branch order builder ────────────

    /// @notice T-086 Round-8 (#358) §19.6 — canonical Seaport
    ///         `OrderComponents` builder + hash for the pre-loan
    ///         (no-loan branch) parallel-sale listing. Mirror of
    ///         {buildAndHashMem} for the offer-keyed surface; called
    ///         from `OfferCreateFacet.postParallelSaleListing`.
    /// @dev    The no-loan branch's consideration has the same shape as
    ///         the loan-keyed branch since #2876 (§19.6b):
    ///           - consideration[0] = single proceeds leg paid in
    ///             `principalAsset` to `address(diamond)` (NOT
    ///             directly to the vault — round-3.1 against Codex
    ///             round-3 P1 #1 line 4390; the diamond receives the
    ///             leg and routes it through `recordOfferSaleProceeds`
    ///             which credits the protocol-tracked-balance for the
    ///             borrower so they can `vaultWithdrawERC20` it).
    ///           - consideration[1..N] = optional SELLER-baked fee
    ///             legs (round-3.2 against Codex round-3.2 P2 #5
    ///             line 4759; the vault is the offerer, so the fee
    ///             legs are hashed into the SELLER's signed order at
    ///             sign-time, NOT lifted from a bidder-side
    ///             SignedZone).
    ///
    ///         What differs is the settlement: with no loan yet, the
    ///         Diamond credits the whole proceeds leg to the borrower; once
    ///         a lender has accepted, it splits the leg exactly as a
    ///         loan-keyed sale does.
    ///
    ///         Same FULL_RESTRICTED order-type + zone-vault offerer
    ///         pattern as the loan-keyed builder. The executor's
    ///         zone callback dispatches on whether the orderHash
    ///         lives in `offerContext` vs `orderContext` (§19.6
    ///         dispatch-disjoint invariant).
    function buildAndHashOfferMem(
        OfferContext memory ctx,
        address collateralAsset,
        LibVaipakam.AssetType collateralAssetType,
        uint256 collateralTokenId,
        uint256 collateralQuantity,
        address diamond,
        address executor,
        address seaport,
        FeeLeg[] memory feeLegs
    ) internal view returns (bytes32 orderHash) {
        OrderComponents memory components = _componentsOfferAtMemory(
            ctx,
            collateralAsset,
            collateralAssetType,
            collateralTokenId,
            collateralQuantity,
            diamond,
            executor,
            ISeaportOrderHash(seaport).getCounter(ctx.borrowerVault),
            feeLegs
        );
        orderHash = ISeaportOrderHash(seaport).getOrderHash(components);
    }

    /// @notice T-086 Round-8 (#358) Step 7 — public wrapper around
    ///         {_componentsOfferAtMemory} used by the executor's
    ///         `_tryCancelOnSeaportOffer` reconstruction path. The
    ///         builder is deterministic from `(ctx, feeLegs, counter)`;
    ///         the executor verifies the rebuilt hash matches the
    ///         pinned `orderHash` (via {buildAndHashOfferMem}) before
    ///         forwarding the rebuilt components to `Seaport.cancel`.
    function componentsOfferForCancel(
        OfferContext memory ctx,
        address collateralAsset,
        LibVaipakam.AssetType collateralAssetType,
        uint256 collateralTokenId,
        uint256 collateralQuantity,
        address diamond,
        address executor,
        uint256 counter,
        FeeLeg[] memory feeLegs
    ) internal pure returns (OrderComponents memory) {
        return _componentsOfferAtMemory(
            ctx,
            collateralAsset,
            collateralAssetType,
            collateralTokenId,
            collateralQuantity,
            diamond,
            executor,
            counter,
            feeLegs
        );
    }

    /// @dev T-086 Round-8 (#358) — private builder for the no-loan
    ///      branch's `OrderComponents`. Single-proceeds-leg shape
    ///      (no protocol-leg split). Seaport's amount interpolation
    ///      is unused (start == end on the proceeds leg + every fee
    ///      leg) because v1 is fixed-price only per §19.11.
    function _componentsOfferAtMemory(
        OfferContext memory ctx,
        address collateralAsset,
        LibVaipakam.AssetType collateralAssetType,
        uint256 collateralTokenId,
        uint256 collateralQuantity,
        address diamond,
        address executor,
        uint256 counter,
        FeeLeg[] memory feeLegs
    ) private pure returns (OrderComponents memory components) {
        // ─── Offer (one item: the collateral NFT) ──────────────
        // Same shape as the loan-keyed `_componentsAtMemory` above.
        OfferItem[] memory offer = new OfferItem[](1);
        if (collateralAssetType == LibVaipakam.AssetType.ERC721) {
            offer[0] = OfferItem({
                itemType: ItemType.ERC721,
                token: collateralAsset,
                identifierOrCriteria: collateralTokenId,
                startAmount: 1,
                endAmount: 1
            });
        } else {
            // ERC1155 — full pre-deposited quantity per design doc
            // §7 (same convention the loan-keyed path uses).
            offer[0] = OfferItem({
                itemType: ItemType.ERC1155,
                token: collateralAsset,
                identifierOrCriteria: collateralTokenId,
                startAmount: collateralQuantity,
                endAmount: collateralQuantity
            });
        }

        // ─── Consideration (1 proceeds leg + N fee legs) ───────
        // Codex round-3 P2 #6 — feeSum MUST be subtracted from the
        // proceeds leg so the BUYER's total payment equals exactly
        // `askPrice` (the displayed listing price), the same rule as
        // the loan-keyed `_componentsAtMemory`.
        // Pre-Codex round-3, the proceeds leg got the full askPrice +
        // fee legs were appended on top — so buyers paid
        // `askPrice + feeSum`, charging fees TWICE (once via the
        // floor check's fee-inclusive minimum + again on-chain at
        // fill time). v1 is fixed-price-only so feeSumStart ==
        // feeSumEnd; named feeSum here for symmetry with the
        // loan-keyed helper.
        uint256 feeSum = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSum += uint256(feeLegs[i].startAmount);
            unchecked { ++i; }
        }
        ConsiderationItem[] memory consideration =
            new ConsiderationItem[](1 + feeLegs.length);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: ctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: uint256(ctx.askPrice) - feeSum,
            endAmount: uint256(ctx.askPrice) - feeSum,
            // Round-3.1 against Codex round-3 P1 #1 line 4390 — the
            // diamond is the consideration recipient (NOT the vault
            // directly); the diamond credits the borrower's vault
            // balance via `recordOfferSaleProceeds` ->
            // `LibVaipakam.recordVaultDeposit` afterwards so the
            // proceeds are withdrawable through the standard
            // `vaultWithdrawERC20` path.
            recipient: payable(diamond)
        });

        for (uint256 i = 0; i < feeLegs.length; ) {
            consideration[1 + i] = ConsiderationItem({
                itemType: ItemType.ERC20,
                token: ctx.principalAsset,
                identifierOrCriteria: 0,
                startAmount: uint256(feeLegs[i].startAmount),
                endAmount: uint256(feeLegs[i].endAmount),
                recipient: payable(feeLegs[i].recipient)
            });
            unchecked { ++i; }
        }

        components = OrderComponents({
            offerer: ctx.borrowerVault,
            zone: executor,
            offer: offer,
            consideration: consideration,
            // Same FULL_RESTRICTED routing as the loan-keyed path —
            // the executor's zone callback owns content validation
            // for both branches; the dispatch on `offerContext` vs
            // `orderContext` happens INSIDE `validateOrder` (Step 7).
            orderType: OrderType.FULL_RESTRICTED,
            startTime: uint256(ctx.startTime),
            // §19.6 — pre-loan order's Seaport `endTime` is
            // `offer.expiresAt` if non-zero, else the
            // `block.timestamp + GTC_SEAPORT_END_TIME` finite
            // far-future value (round-3.2 against Raja round-3.2 P2
            // #3; round-3.2 supersedes the round-3.1
            // `type(uint64).max` mapping that several downstream
            // indexers treat as malformed).
            endTime: uint256(ctx.endTime),
            zoneHash: bytes32(0),
            salt: ctx.salt,
            conduitKey: ctx.conduitKey,
            counter: counter
        });
    }
}
