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
import {FeeLeg} from "../seaport/PrepayTypes.sol";

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
 *           - consideration = lender / treasury / borrower split,
 *                             amounts + recipients derived from
 *                             the live floor at this block
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
 */
library LibPrepayOrder {
    /// @dev Resolve the `OrderComponents` for a prepay listing and
    ///      derive its Seaport orderHash. Single source of truth
    ///      consumed by `NFTPrepayListingFacet.postPrepayListing` +
    ///      `updatePrepayListing`.
    ///
    ///      Round-5 Block A (#313): accepts an optional `feeLegs`
    ///      array (length 0..MAX_FEE_LEGS=4). Each fee leg is
    ///      appended after the borrower leg, in the order the
    ///      caller provides — the dapp orders them per the
    ///      OpenSea Collection API response so OpenSea's
    ///      submission-time enforcement sees the expected shape.
    function buildAndHash(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        address seaport,
        uint256 askPrice,
        uint256 lenderLeg,
        uint256 treasuryLeg,
        uint256 salt,
        bytes32 conduitKey,
        FeeLeg[] calldata feeLegs
    ) internal view returns (bytes32 orderHash) {
        OrderComponents memory components = _components(
            pctx,
            vault,
            executor,
            askPrice,
            lenderLeg,
            treasuryLeg,
            salt,
            conduitKey,
            ISeaportOrderHash(seaport).getCounter(vault),
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
    ///      recorded listing, using the sign-time inputs the executor
    ///      pinned in {CollateralListingExecutor.OrderContext}.
    ///
    ///      T-086 #316: the executor calls this from `clearOrder` to
    ///      reconstruct the order it originally authorised so it can
    ///      forward `Seaport.cancel` at terminal cleanup. We CAN'T
    ///      reuse {buildAndHash} for this: it stamps
    ///      `startTime = block.timestamp` (only correct AT SIGN TIME)
    ///      and re-derives the live floor at the CURRENT block (only
    ///      correct if the floor hasn't drifted). Cancel-time
    ///      reconstruction needs the original `startTime` + the
    ///      sign-time pctx (the caller derives `pctx` by calling
    ///      `getPrepayContext(loanId, ctx.startTime)` so the floor
    ///      legs evaluate as-of the original timestamp).
    ///
    ///      Pure function: the executor's `clearOrder` is the
    ///      single internal consumer.
    function componentsForCancel(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address executor,
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
            askPrice,
            pctx.lenderLeg,
            pctx.treasuryLeg,
            salt,
            conduitKey,
            startTime,
            counter,
            feeLegs
        );
    }

    // ── Internal helpers ────────────────────────────────────────────

    function _components(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        uint256 askPrice,
        uint256 lenderLeg,
        uint256 treasuryLeg,
        uint256 salt,
        bytes32 conduitKey,
        uint256 counter,
        FeeLeg[] calldata feeLegs
    ) private view returns (OrderComponents memory) {
        return _componentsAtCalldata(
            pctx,
            vault,
            executor,
            askPrice,
            lenderLeg,
            treasuryLeg,
            salt,
            conduitKey,
            block.timestamp,
            counter,
            feeLegs
        );
    }

    /// @dev Pure body for the calldata-feeLegs flavour (the sign-time
    ///      path through {buildAndHash} → {_components}).
    function _componentsAtCalldata(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        uint256 askPrice,
        uint256 lenderLeg,
        uint256 treasuryLeg,
        uint256 salt,
        bytes32 conduitKey,
        uint256 startTime,
        uint256 counter,
        FeeLeg[] calldata feeLegs
    ) private pure returns (OrderComponents memory components) {
        // Copy fee legs into memory so {_componentsCore} can iterate
        // them with a single data-location-agnostic loop. Length is
        // bounded by `MAX_FEE_LEGS = 4` in the facet so the copy
        // cost is trivial.
        FeeLeg[] memory feeLegsMem = new FeeLeg[](feeLegs.length);
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeLegsMem[i] = feeLegs[i];
            unchecked { ++i; }
        }
        return _componentsAtMemory(
            pctx,
            vault,
            executor,
            askPrice,
            lenderLeg,
            treasuryLeg,
            salt,
            conduitKey,
            startTime,
            counter,
            feeLegsMem
        );
    }

    /// @dev Pure body for the memory-feeLegs flavour (the cancel-time
    ///      reconstruction path through {componentsForCancel}, where
    ///      the executor reads the fee legs out of storage into
    ///      memory before calling). Parameterised on `startTime`
    ///      so the cancel-reconstruction can pin the ORIGINAL
    ///      sign-time stamp instead of the current block.
    function _componentsAtMemory(
        IVaipakamPrepayContext.PrepayContext memory pctx,
        address vault,
        address executor,
        uint256 askPrice,
        uint256 lenderLeg,
        uint256 treasuryLeg,
        uint256 salt,
        bytes32 conduitKey,
        uint256 startTime,
        uint256 counter,
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

        // ─── Consideration (3 protocol legs + N fee legs) ──────
        ConsiderationItem[] memory consideration = new ConsiderationItem[](3 + feeLegs.length);
        consideration[0] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: lenderLeg,
            endAmount: lenderLeg,
            recipient: payable(pctx.lenderNftOwner)
        });
        consideration[1] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: treasuryLeg,
            endAmount: treasuryLeg,
            recipient: payable(pctx.treasury)
        });
        // Borrower remainder. Round 5 (#313) deducts the sum of
        // fee-leg start amounts in addition to lender + treasury.
        // The facet's `_requireAskCoversFloor` + start-state-
        // solvency check (§14.5 + §15.2) ensure the underflow is
        // guarded by the earlier revert, not by `unchecked`.
        // Block A is fixed-price-only, so `startAmount == endAmount`
        // for every fee leg (enforced by the facet); the
        // borrower leg therefore has the same property naturally.
        // Block B will introduce decay on the borrower leg via the
        // Dutch entry points + the unified `FeeLeg` shape already
        // carries `(startAmount, endAmount)` for forward
        // compatibility.
        uint256 feeSumStart = 0;
        uint256 feeSumEnd = 0;
        for (uint256 i = 0; i < feeLegs.length; ) {
            feeSumStart += uint256(feeLegs[i].startAmount);
            feeSumEnd += uint256(feeLegs[i].endAmount);
            unchecked { ++i; }
        }
        consideration[2] = ConsiderationItem({
            itemType: ItemType.ERC20,
            token: pctx.principalAsset,
            identifierOrCriteria: 0,
            startAmount: askPrice - lenderLeg - treasuryLeg - feeSumStart,
            endAmount: askPrice - lenderLeg - treasuryLeg - feeSumEnd,
            recipient: payable(pctx.borrowerNftOwner)
        });
        // Append fee legs (Round 5 #313).
        for (uint256 i = 0; i < feeLegs.length; ) {
            consideration[3 + i] = ConsiderationItem({
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
            startTime: startTime,
            endTime: pctx.graceEnd,
            zoneHash: bytes32(0),
            salt: salt,
            conduitKey: conduitKey,
            counter: counter
        });
    }
}
