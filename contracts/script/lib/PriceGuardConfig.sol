// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {PriceGuard} from "../../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../../src/oracle/PriceGuardState.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";

/**
 * @title  PriceGuardConfig
 * @notice The one way a script writes a chain's {PriceGuard} config (#3272
 *         part 2): bring one entry to a wanted value through the guard's own
 *         delayed change, never around it.
 *
 * @dev    {ensure} reads the entry first and does nothing when it already
 *         holds the value, so a configure step can be re-run. Otherwise it
 *         proposes the change and, when the guard's delay is zero (a testnet,
 *         where the deploy sets no delay), executes it in the same run. On a
 *         chain with a delay it leaves the change pending and says so: anyone
 *         may execute it once the delay has passed, and the launch readiness
 *         check refuses the chain until the entries it reads are in place.
 *         An entry that already has a change pending is left alone, since
 *         only one may be pending per entry.
 *
 *         The caller holds the broadcast, as the guard's owner (the admin
 *         before the handover). After the handover the owner is the Timelock,
 *         and a change is a Timelock proposal of the same `proposeChange`.
 */
library PriceGuardConfig {
    /// @notice What {ensure} did.
    enum Outcome {
        Unchanged,
        Applied,
        Proposed,
        AlreadyPending
    }

    /// @notice Bring `kind`/`subject` to `value`. See the library notes.
    function ensure(PriceGuard guard, PriceGuardState.Kind kind, bytes32 subject, bytes32 value)
        internal
        returns (Outcome)
    {
        if (current(guard, kind, subject) == value) return Outcome.Unchanged;
        (, uint256 executableAt) = guard.pendingChange(kind, subject);
        if (executableAt != 0) {
            console.log("  price guard: a change is already pending for entry", uint256(kind));
            return Outcome.AlreadyPending;
        }
        guard.proposeChange(kind, subject, value);
        if (guard.delay() == 0) {
            guard.executeChange(kind, subject);
            return Outcome.Applied;
        }
        console.log("  price guard: proposed entry", uint256(kind), "- executable after the guard's delay (s):", uint256(guard.delay()));
        return Outcome.Proposed;
    }

    /// @notice The price guard the Diamond reads, through its recorded
    ///         protocol registry.
    function guardOf(address diamond) internal view returns (PriceGuard) {
        return PriceGuard(OracleAdminFacet(diamond).getPriceGuard());
    }

    /// @notice Refuse a feed source keyed by other denominators than the
    ///         guard's fixed identity: its feeds would never resolve.
    function requireIdentity(PriceGuard guard, address numeraireDenominator, address ethDenominator) internal view {
        require(
            guard.NUMERAIRE_DENOMINATOR() == numeraireDenominator,
            "PriceGuardConfig: the feed source's numeraire denominator is not the guard's"
        );
        require(
            ethDenominator == address(0) || guard.ETH_DENOMINATOR() == ethDenominator,
            "PriceGuardConfig: the feed source's ETH denominator is not the guard's"
        );
    }

    /// @notice Point the guard at a feed source, a WETH and an ETH/numeraire
    ///         feed: the three entries a mock or rehearsal rig sets. Each is
    ///         applied at once on a zero-delay chain, and left pending
    ///         otherwise. A zero `ethNumeraireFeed` leaves that entry alone.
    function pointAt(PriceGuard guard, address feedRegistry, address weth, address ethNumeraireFeed) internal {
        ensureAddress(guard, PriceGuardState.Kind.FeedRegistry, bytes32(0), feedRegistry);
        ensureAddress(guard, PriceGuardState.Kind.Weth, bytes32(0), weth);
        if (ethNumeraireFeed != address(0)) {
            ensureAddress(guard, PriceGuardState.Kind.EthNumeraireFeed, bytes32(0), ethNumeraireFeed);
        }
    }

    /// @notice {ensure} for an address-valued entry.
    function ensureAddress(PriceGuard guard, PriceGuardState.Kind kind, bytes32 subject, address value)
        internal
        returns (Outcome)
    {
        return ensure(guard, kind, subject, bytes32(uint256(uint160(value))));
    }

    /// @notice The value an entry holds now, in the word {PriceGuard.proposeChange}
    ///         takes. `SecondaryEnabled` reads 1 while the source counts.
    function current(PriceGuard guard, PriceGuardState.Kind kind, bytes32 subject) internal view returns (bytes32) {
        if (kind == PriceGuardState.Kind.SecondaryEnabled) {
            return guard.secondaryState(PriceGuardState.Source(uint8(uint256(subject)))) == PriceGuardState.SecondaryState.Counted
                ? bytes32(uint256(1))
                : bytes32(0);
        }
        if (kind == PriceGuardState.Kind.RateSourceEnabled) {
            return guard.rateMuted(address(uint160(uint256(subject)))) ? bytes32(0) : bytes32(uint256(1));
        }
        if (kind == PriceGuardState.Kind.RateObservation) return bytes32(uint256(guard.rateObservation()));
        if (kind == PriceGuardState.Kind.Delay) return bytes32(uint256(guard.delay()));
        if (kind == PriceGuardState.Kind.PriceFloor) {
            (uint64 g,, uint64 r) = guard.priceFloor();
            return bytes32(uint256(g) << 64 | r);
        }
        // Every other entry is a stored setting (#3437).
        return guard.config(kind, subject);
    }

    function _w(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
