// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPairCalm} from "./LibPairCalm.sol";

/**
 * @title  LibOfferPriceGuard
 * @author Vaipakam Developer Team
 * @notice #3358 — the maker's price-move guard on an offer (owner decision
 *         2026-11-08). An offer's creator may set a limit on how far the
 *         collateral/principal rate may move. A guarded offer refuses a fill
 *         when either:
 *         1. the rate has moved more than the limit since the guard was
 *            recorded (the two prices are stored when it is recorded: at
 *            posting when the creator arms it before posting, otherwise when
 *            they set it); or
 *         2. the pair is not calm against the hourly price checkpoints, the
 *            same calm rule forced sales use (`LibPairCalm`, bound
 *            `SaleFloorConfig.calmMoveBps`).
 *         A price that cannot be read, or a missing checkpoint, refuses the
 *         fill too: the creator asked for the protection, so a fill that
 *         cannot be shown to be inside it does not happen. Off by default.
 *
 * @dev    Every write to `Storage.offerPriceGuard` is here. Inlined into
 *         `OfferPriceGuardFacet` (the setter, the arm and the reads) and
 *         `OfferBookFacet` (which records an armed guard as the offer is
 *         opened on the book).
 */
library LibOfferPriceGuard {
    /// @notice Where a guarded offer stands now.
    /// @dev    Off: no guard. NoOffer: a guard row remains but the offer is
    ///         gone (cancelled, or filled and closed). Clear: a fill passes
    ///         the guard now. Moved: the rate moved past the creator's limit.
    ///         NoCheckpoint: a checkpoint for one of the last two hours is
    ///         missing, so calm cannot be shown. NotCalm: the pair moved past
    ///         the calm bound against a checkpoint. Unpriced: a current
    ///         price cannot be read.
    enum Status {
        Off,
        NoOffer,
        Clear,
        Moved,
        NoCheckpoint,
        NotCalm,
        Unpriced
    }

    /// @dev Transient key base for a guard armed before posting.
    bytes32 private constant ARM_BASE = keccak256("vaipakam.offerPriceGuard.armed");

    /// @notice An offer's price-move guard was recorded or cleared.
    /// @param offerId                The offer.
    /// @param creator                Its creator, who set it.
    /// @param maxMoveBps             The limit now in effect; 0 = cleared.
    /// @param refCollateralPrice1e18 The collateral asset's oracle price the
    ///                               limit is measured from (0 when cleared).
    /// @param refPrincipalPrice1e18  The principal asset's oracle price the
    ///                               limit is measured from (0 when cleared).
    /// @custom:event-category state-change/offer-mutation
    event OfferPriceGuardSet(
        uint256 indexed offerId,
        address indexed creator,
        uint16 maxMoveBps,
        uint256 refCollateralPrice1e18,
        uint256 refPrincipalPrice1e18
    );

    /// @notice A guard cannot be put on this offer: one of its assets is not
    ///         an ERC-20, or a current price for either cannot be read.
    error OfferPriceGuardUnpriced(uint256 offerId);

    /// @notice Arm a guard of `maxMoveBps` for the next offer `creator` posts
    ///         in this transaction. Consumed by {takeArmed}; cleared by the
    ///         end of the transaction if nothing is posted.
    function arm(address creator, uint16 maxMoveBps) internal {
        bytes32 key = keccak256(abi.encode(ARM_BASE, creator));
        assembly ("memory-safe") {
            tstore(key, maxMoveBps)
        }
    }

    /// @notice The guard `creator` armed in this transaction (0 = none),
    ///         clearing it so it applies to one offer only.
    function takeArmed(address creator) internal returns (uint16 maxMoveBps) {
        bytes32 key = keccak256(abi.encode(ARM_BASE, creator));
        uint256 v;
        assembly ("memory-safe") {
            v := tload(key)
        }
        if (v != 0) {
            assembly ("memory-safe") {
                tstore(key, 0)
            }
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        maxMoveBps = uint16(v);
    }

    /// @notice Record a guard of `maxMoveBps` on `offerId`, measured from the
    ///         prices now. The caller has checked who may set it and the
    ///         range.
    function record(LibVaipakam.Storage storage s, uint256 offerId, uint16 maxMoveBps) internal {
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (
            o.assetType != LibVaipakam.AssetType.ERC20
                || o.collateralAssetType != LibVaipakam.AssetType.ERC20
        ) revert OfferPriceGuardUnpriced(offerId);
        (bool okC, uint256 pC) = LibPairCalm.price1e18(o.collateralAsset);
        (bool okP, uint256 pP) = LibPairCalm.price1e18(o.lendingAsset);
        if (!okC || !okP) revert OfferPriceGuardUnpriced(offerId);
        s.offerPriceGuard[offerId] = LibVaipakam.OfferPriceGuard({
            maxMoveBps: maxMoveBps,
            setAt: uint64(block.timestamp),
            refCollateralPrice1e18: pC,
            refPrincipalPrice1e18: pP
        });
        emit OfferPriceGuardSet(offerId, o.creator, maxMoveBps, pC, pP);
    }

    /// @notice Remove `offerId`'s guard.
    function clear(LibVaipakam.Storage storage s, uint256 offerId) internal {
        delete s.offerPriceGuard[offerId];
        emit OfferPriceGuardSet(offerId, s.offers[offerId].creator, 0, 0, 0);
    }

    /// @notice Where `offerId`'s guard stands now.
    /// @return st       The status (see {Status}).
    /// @return moveBps  How far the rate has moved since the guard was
    ///                  recorded, in bps of the recorded rate, rounded up;
    ///                  0 when it could not be measured (Off, NoOffer,
    ///                  Unpriced).
    function status(LibVaipakam.Storage storage s, uint256 offerId)
        internal
        view
        returns (Status st, uint256 moveBps)
    {
        LibVaipakam.OfferPriceGuard storage g = s.offerPriceGuard[offerId];
        if (g.maxMoveBps == 0) return (Status.Off, 0);
        LibVaipakam.Offer storage o = s.offers[offerId];
        if (o.creator == address(0)) return (Status.NoOffer, 0);
        (bool okC, uint256 pC) = LibPairCalm.price1e18(o.collateralAsset);
        (bool okP, uint256 pP) = LibPairCalm.price1e18(o.lendingAsset);
        if (!okC || !okP) return (Status.Unpriced, 0);
        moveBps = LibPairCalm.moveBps(pC, pP, g.refCollateralPrice1e18, g.refPrincipalPrice1e18);
        if (moveBps > g.maxMoveBps) return (Status.Moved, moveBps);
        LibPairCalm.Calm calm = LibPairCalm.calmNow(
            o.collateralAsset, o.lendingAsset, pC, pP, LibVaipakam.cfgSaleFloor().calmMoveBps
        );
        if (calm == LibPairCalm.Calm.NoCheckpoint) return (Status.NoCheckpoint, moveBps);
        if (calm == LibPairCalm.Calm.Moving) return (Status.NotCalm, moveBps);
        return (Status.Clear, moveBps);
    }
}
