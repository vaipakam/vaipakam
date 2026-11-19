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

    /// @notice A token priced by an exchange rate (#3683) may be collateral,
    ///         never the asset lent.
    error RatePricedLendingAsset(address asset);

    /// @notice Refuse `asset` as a loan's or offer's principal when the guard
    ///         prices it by an exchange rate (#3683). The rate's rise is
    ///         capped, so a debt in such a token could be valued below what
    ///         it is redeemable for, which overstates every health factor
    ///         against it. With no reachable guard nothing is priced at all,
    ///         rate-priced or not, so there is nothing to refuse.
    function requireNotRatePricedLending(address asset) internal view {
        (bool ok, IPriceGuard g) = tryGuard();
        if (ok && g.isRatePriced(asset)) revert RatePricedLendingAsset(asset);
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

    // ─── Budgeted reads (#3504) ─────────────────────────────────────────
    //
    // The guard reads each outside source (the sequencer feed, Pyth, the
    // secondary quorum) inside its own try/catch, and several Diamond
    // readers catch a refused price and carry on without it. A read that
    // runs out of gas is caught the same way, so whoever sets a
    // transaction's gas limit could otherwise choose to have a source, or
    // the whole price, read as missing. Every read of a price or of the
    // sequencer from the Diamond therefore gives the guard exactly
    // {GUARD_READ_GAS}: it first checks it holds enough to pass all of it
    // on, and reverts {PriceReadOutOfGas} by name when it does not. What
    // the guard answers then depends on the chain's state and the guard's
    // config, never on the caller's gas limit.

    /// @notice The gas the guard is given for one read: exactly this much,
    ///         never more and never less. Measured on Base Sepolia
    ///         (2026-11-11), a whole `getAssetPrice` through the Diamond
    ///         costs 45,000-57,000 gas; a mainnet guard with Pyth, three
    ///         secondary sources, the sequencer feed and a two-hop pivot
    ///         reads more external contracts, so the budget sits several
    ///         times above that. The trade is stated: a guard that one day
    ///         needs more than this reads as refusing the price (fail
    ///         closed) until a facet refresh raises the budget.
    uint256 internal constant GUARD_READ_GAS = 500_000;

    /// @dev The cost of the call itself that the 63/64 rule is applied
    ///      after (base and cold-account charges, the calldata), rounded up.
    uint256 internal constant CALL_OVERHEAD_GAS = 20_000;

    /// @dev What the guard lookup ({guard} / {tryGuard}: the registry
    ///      pointer and the numeraire check) may spend before the read,
    ///      rounded up well past its cost.
    uint256 internal constant GUARD_LOOKUP_GAS = 40_000;

    /// @notice Too little gas was left to give a price read its whole
    ///         budget. Raise the transaction's gas limit; nothing was read.
    error PriceReadOutOfGas();

    /// @notice {guard}, for a read the caller is about to make with
    ///         `{gas: GUARD_READ_GAS}`. Reverts {PriceReadOutOfGas} unless
    ///         that read is sure to receive its whole budget, checked before
    ///         the lookup (so the lookup itself cannot be starved) and again
    ///         after it.
    function guardForRead() internal view returns (IPriceGuard g) {
        requireReadGas(GUARD_LOOKUP_GAS);
        g = guard();
        requireReadGas(0);
    }

    /// @notice {tryGuard}, for a best-effort read the caller is about to
    ///         make with `{gas: GUARD_READ_GAS}`. The same two checks as
    ///         {guardForRead}, so a missing guard is a fact about the chain,
    ///         never a lookup the caller starved.
    function tryGuardForRead() internal view returns (bool ok, IPriceGuard g) {
        requireReadGas(GUARD_LOOKUP_GAS);
        (ok, g) = tryGuard();
        requireReadGas(0);
    }

    /// @dev What a Diamond SELF-call must receive for the facet it reaches to
    ///      pass {guardForRead} / {tryGuardForRead}: the guard's budget with
    ///      its call overhead, the guard lookup, and the Diamond's own
    ///      dispatch (the selector lookup, the delegatecall and the facet's
    ///      dispatch, rounded up well past their cost).
    uint256 internal constant SELF_READ_GAS =
        (GUARD_READ_GAS * 64) / 63 + CALL_OVERHEAD_GAS + GUARD_LOOKUP_GAS + 20_000;

    /// @notice Revert {PriceReadOutOfGas} unless a Diamond self-call made now
    ///         to a facet that reads the guard is sure to receive
    ///         {SELF_READ_GAS}, so the facet's own check passes and the guard
    ///         gets its whole budget. For a reader that reaches the guard
    ///         through the Diamond and treats a failed call as "no answer"
    ///         ({LibPriceRead}, {LibLoanClock.outageWindow}).
    function requireSelfReadGas() internal view {
        if (gasleft() < (SELF_READ_GAS * 64) / 63 + CALL_OVERHEAD_GAS) revert PriceReadOutOfGas();
    }

    /// @notice Revert {PriceReadOutOfGas} unless a call capped at
    ///         {GUARD_READ_GAS}, made after `extra` more gas is spent, is
    ///         sure to receive all of it. A capped call receives the smaller
    ///         of its cap and all but 1/64 of what is left after the call's
    ///         own cost (covered by {CALL_OVERHEAD_GAS}).
    function requireReadGas(uint256 extra) internal view {
        if (gasleft() < (GUARD_READ_GAS * 64) / 63 + CALL_OVERHEAD_GAS + extra) {
            revert PriceReadOutOfGas();
        }
    }
}
