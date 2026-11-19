// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibPriceRead} from "./LibPriceRead.sol";
import {LibPriceGuard} from "./LibPriceGuard.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";

/**
 * @title  LibPairCalm
 * @author Vaipakam Developer Team
 * @notice The one rule for how far a pair's price has moved, and whether the
 *         pair is calm against the hourly price checkpoints (#3359, #3358).
 *
 *         A pair's rate is the collateral asset's oracle price over the
 *         principal asset's. A move is measured against an earlier rate, in
 *         either direction, as a share of that earlier rate. The pair is calm
 *         when the rate now is within the calm bound of the rate at BOTH of
 *         the last two hourly checkpoints, so the look-back is always at
 *         least one hour.
 *
 *         Two readers share it: the forced-sale floor (`SaleFloorFacet`,
 *         which tightens a sale only while the pair is calm) and the maker's
 *         price-move guard (`OfferPriceGuardFacet`, which refuses a fill when
 *         the pair is not calm or has moved past the maker's limit).
 *
 * @dev    Internal library, inlined into each reader. Prices are read with a
 *         Diamond self-call to `OracleFacet.getAssetPrice`, the strict reader:
 *         any reason it refuses (stale, divergent, missing) reads as "no
 *         price", never as a figure.
 */
library LibPairCalm {
    /// @notice Whether the pair is calm against the last two hourly
    ///         checkpoints.
    /// @dev    Calm: within the bound of both. NoCheckpoint: either asset
    ///         lacks a checkpoint for one of the last two hours. Moving: the
    ///         rate moved past the bound against one of them.
    enum Calm {
        Calm,
        NoCheckpoint,
        Moving
    }

    /// @dev `asset`'s oracle price scaled to 1e18, or false when it cannot be
    ///      read (any reason the strict reader refuses) or reads zero. Read
    ///      through {LibPriceRead}, so a caller short of gas gets a revert by
    ///      name, never a pair that reads as unpriced (#3504).
    function price1e18(address asset) internal view returns (bool ok, uint256 p) {
        (bool priced, uint256 price, uint8 dec) = LibPriceRead.tryAssetPrice(asset);
        if (!priced || price == 0) return (false, 0);
        p = dec <= 18 ? price * 10 ** (18 - dec) : price / 10 ** (dec - 18);
        ok = p != 0;
    }

    /// @dev How far the collateral/principal rate moved between an earlier
    ///      reading (`cThen / pThen`) and now (`cNow / pNow`), in bps of the
    ///      earlier rate, ROUNDED UP. Rounding up makes `moveBps(..) > bound`
    ///      exactly "moved more than `bound`", with no rounding gap.
    function moveBps(uint256 cNow, uint256 pNow, uint256 cThen, uint256 pThen)
        internal
        pure
        returns (uint256)
    {
        // now / then = (cNow * pThen) / (pNow * cThen).
        uint256 nowScaled = Math.mulDiv(cNow, pThen * LibVaipakam.BASIS_POINTS, pNow);
        uint256 thenScaled = cThen * LibVaipakam.BASIS_POINTS;
        uint256 diff = nowScaled > thenScaled ? nowScaled - thenScaled : thenScaled - nowScaled;
        return Math.mulDiv(diff, LibVaipakam.BASIS_POINTS, thenScaled, Math.Rounding.Ceil);
    }

    /// @dev Whether the pair is calm now against the checkpoints of the
    ///      last two UTC hours, with the calm bound `boundBps`. Checks the
    ///      hour before this one first, then the one before that.
    ///
    ///      Each comparison has both ends on one price version (#3437): the
    ///      "now" price of an asset is read at the version its checkpoint
    ///      was written under, so a settings change alone never reads as a
    ///      move. `cNow` / `pNow` are the current 1e18 prices of
    ///      `collateralAsset` and `principalAsset`, used as they are when a
    ///      checkpoint was written at the newest version. A checkpoint
    ///      written by another guard, or at a version the guard no longer
    ///      answers (retired by its floor), counts as no checkpoint: not
    ///      calm.
    function calmNow(
        address collateralAsset,
        address principalAsset,
        uint256 cNow,
        uint256 pNow,
        uint256 boundBps
    ) internal view returns (Calm) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 hour = block.timestamp / 1 hours;
        // Within the first two hours of the clock there is no earlier hour to
        // have a checkpoint (never on a live chain, but never a panic either).
        if (hour < 2) return Calm.NoCheckpoint;
        IPriceGuard g = LibPriceGuard.guard();
        (uint64 ge, uint64 re) = g.priceVersion();
        for (uint256 back = 1; back <= 2; ++back) {
            LibVaipakam.HourlyPriceCheckpoint memory c = s.hourlyPriceCheckpoint[collateralAsset][hour - back];
            LibVaipakam.HourlyPriceCheckpoint memory p = s.hourlyPriceCheckpoint[principalAsset][hour - back];
            if (c.price1e18 == 0 || p.price1e18 == 0) return Calm.NoCheckpoint;
            (bool okC, uint256 cAt) = _priceAtCheckpoint(g, ge, re, collateralAsset, c, cNow);
            (bool okP, uint256 pAt) = _priceAtCheckpoint(g, ge, re, principalAsset, p, pNow);
            if (!okC || !okP) return Calm.NoCheckpoint;
            if (moveBps(cAt, pAt, c.price1e18, p.price1e18) > boundBps) return Calm.Moving;
        }
        return Calm.Calm;
    }

    /// @dev `asset`'s price now, 1e18-scaled, at the version checkpoint `c`
    ///      was written under: `current` when that is the newest version
    ///      (`ge`, `re`) of guard `g`; else the guard's as-of read. False
    ///      when `c` is another guard's or the guard refuses the read (a
    ///      retired version included).
    function _priceAtCheckpoint(
        IPriceGuard g,
        uint64 ge,
        uint64 re,
        address asset,
        LibVaipakam.HourlyPriceCheckpoint memory c,
        uint256 current
    ) private view returns (bool ok, uint256 p) {
        if (c.guard != address(g)) return (false, 0);
        if (c.guardEpoch == ge && c.registryEpoch == re) return (true, current);
        LibPriceGuard.requireReadGas(0);
        try g.getAssetPriceAt{gas: LibPriceGuard.GUARD_READ_GAS}(asset, c.guardEpoch, c.registryEpoch) returns (
            uint256 price, uint8 dec
        ) {
            if (price == 0) return (false, 0);
            p = dec <= 18 ? price * 10 ** (18 - dec) : price / 10 ** (dec - 18);
            ok = p != 0;
        } catch (bytes memory reason) {
            LibPriceRead.passOnOutOfGas(reason);
            return (false, 0);
        }
    }
}
