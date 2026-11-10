// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {IProtocolRegistryReader} from "../interfaces/IProtocolRegistryReader.sol";
import {RegistryKeys} from "../governance/RegistryKeys.sol";

/**
 * @title  LibPriceGuard
 * @author Vaipakam Developer Team
 * @notice How the Diamond finds the price guard (#3272 part 2): through the
 *         Timelock-owned `ProtocolRegistry`, whose address the Diamond
 *         records once at deploy, and the registry's `PRICE_GUARD` pointer.
 *         Never from a price setting in Diamond storage: the Diamond holds
 *         none, so it cannot change what a price is.
 * @dev    The registry is read on every call rather than cached, so a guard
 *         swapped in by the registry's delayed pointer change is used from
 *         the block it lands, as long as it prices in the numeraire the
 *         Diamond recorded. Every read fails closed: an unrecorded registry,
 *         an unset pointer or a guard in another numeraire reverts, never
 *         reading as "no price".
 */
library LibPriceGuard {
    /// @notice The Diamond has not recorded its protocol registry yet.
    error ProtocolRegistryUnset();

    /// @notice The guard the registry points at prices in a different
    ///         numeraire from the one the Diamond recorded at deploy.
    error PriceGuardNumeraireMismatch(address guard, bytes32 recorded, bytes32 guardNumeraire);

    /// @notice The protocol registry the Diamond records; reverts
    ///         {ProtocolRegistryUnset} until the deploy records one.
    function registry() internal view returns (address r) {
        r = LibVaipakam.storageSlot().protocolRegistry;
        if (r == address(0)) revert ProtocolRegistryUnset();
    }

    /// @notice The price guard the registry points at now. Reverts when the
    ///         registry is unrecorded, names no guard, or names a guard in a
    ///         numeraire other than the one the Diamond recorded.
    /// @dev    The numeraire check is what keeps the Diamond's thresholds and
    ///         its prices in one unit (owner decision 2026-11-09, "Fix
    ///         numeraire at deploy"): a guard swap may replace feeds, never
    ///         the unit. It reads one immutable, so it costs one warm call.
    function guard() internal view returns (IPriceGuard g) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address r = s.protocolRegistry;
        if (r == address(0)) revert ProtocolRegistryUnset();
        g = IPriceGuard(IProtocolRegistryReader(r).requirePointer(RegistryKeys.PRICE_GUARD));
        bytes32 n = g.NUMERAIRE_SYMBOL();
        if (n != s.numeraireSymbol) revert PriceGuardNumeraireMismatch(address(g), s.numeraireSymbol, n);
    }

    /// @notice {guard} without the revert, for a best-effort reader that
    ///         treats a missing guard as an unset feed. `ok` is false
    ///         whenever {guard} would revert.
    function tryGuard() internal view returns (bool ok, IPriceGuard g) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address r = s.protocolRegistry;
        if (r == address(0)) return (false, g);
        address a;
        try IProtocolRegistryReader(r).pointer(RegistryKeys.PRICE_GUARD) returns (address p) {
            a = p;
        } catch {
            return (false, g);
        }
        if (a.code.length == 0) return (false, g);
        try IPriceGuard(a).NUMERAIRE_SYMBOL() returns (bytes32 n) {
            if (n != s.numeraireSymbol) return (false, g);
        } catch {
            return (false, g);
        }
        return (true, IPriceGuard(a));
    }

    /// @notice The chain's WETH, as the guard has it (zero while unset).
    ///         The liquidity probe routes over it and the risk gate counts
    ///         it as blue-chip.
    function weth() internal view returns (address) {
        return guard().weth();
    }
}
