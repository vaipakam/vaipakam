// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {console} from "forge-std/console.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {TestnetChains} from "../../src/compliance/TestnetChains.sol";
import {TestnetSanctionsOracleStandIn} from "../../src/compliance/TestnetSanctionsOracleStandIn.sol";
import {AdminControl} from "./AdminControl.sol";
import {Deployments} from "./Deployments.sol";
import {TotalRead} from "./TotalRead.sol";

/**
 * @title  SanctionsClearanceReport
 * @notice How every sanctions script names the oracle a delisting clearance
 *         is read from, and the one report of which clearance check a
 *         timelock has and whether automated delisting is open at all.
 * @dev    #2443. The scripts name an oracle only from what they read, the
 *         same rule the delister bot follows (`identifyOracle`):
 *
 *         - **The stand-in only on its own answer.** {isStandIn} is true only
 *           when the contract answers `isTestnetStandIn()` with true, and the
 *           report then states it is NOT RedStone and who controls it, read
 *           now — never an assumed admin.
 *         - **Never RedStone.** RedStone's oracle carries no marker, so
 *           naming it would mean inferring it. These scripts run on testnets
 *           only, where RedStone has no deployment; an oracle they cannot
 *           identify is reported as not identified.
 *         - **A cross-chain oracle is not read from here.** The attestor's
 *           oracle lives on the attestor chain, which a single-chain run
 *           cannot read. The report says so, and adds what that chain's
 *           ARTIFACT records only when the artifact's attestor is the one the
 *           timelock names — as a record, not as a reading.
 */
library SanctionsClearanceReport {
    /// @notice Whether `oracle` says it is the testnet stand-in: exactly one
    ///         32-byte word equal to 1 from `isTestnetStandIn()`. Any other
    ///         outcome — no code, a revert, another interface, a fallback
    ///         that returns nothing — is false, never a revert.
    function isStandIn(address oracle) internal view returns (bool) {
        (bool ok, bool standIn) = TotalRead.boolOf(oracle, TestnetSanctionsOracleStandIn.isTestnetStandIn.selector);
        return ok && standIn;
    }

    /// @notice Logs which clearance check `tl` has, read from the contract,
    ///         and returns it.
    function logRoute(SanctionsDelistingTimelock tl) internal view returns (SanctionsDelistingTimelock.Route route) {
        route = tl.clearanceRoute();
        if (route == SanctionsDelistingTimelock.Route.Local) {
            address secondary = address(tl.list().secondary());
            console.log("  Clearance check: LOCAL - the list's secondary oracle, read live:", secondary);
            logOracle(secondary);
        } else if (route == SanctionsDelistingTimelock.Route.CrossChain) {
            uint256 source = tl.clearanceSourceChainId();
            address attestor = tl.clearanceAttestor();
            console.log("  Clearance check: CROSS-CHAIN via messenger", tl.clearanceMessenger());
            console.log("    attestor", attestor, "on chain", source);
            console.log("    The oracle that attestor reads lives on that chain and is not read by this run.");
            if (
                TestnetChains.isTestnet(source)
                    && Deployments.readSanctionsClearanceAttestorOptionalForChain(source) == attestor
            ) {
                address recordedStandIn = Deployments.readSanctionsOracleStandInOptionalForChain(source);
                if (recordedStandIn != address(0)) {
                    console.log(
                        "    That chain's artifact records it as reading the TESTNET STAND-IN (not RedStone):",
                        recordedStandIn
                    );
                }
            }
        } else {
            console.log("  Clearance check: none configured.");
        }
        logAutomation(tl, route);
    }

    /// @notice Logs whether automated delisting can happen at all, from the
    ///         two facts that close it for every proposal: the timelock must
    ///         be a remover of its list (revoking that role is the owner's
    ///         one-step shutdown, and the list then refuses every execution
    ///         with `NotRemover`), and it must have a clearance check. Never
    ///         claims more: each proposal must still pass every check
    ///         `execute` makes. Returns whether it reported the route open.
    function logAutomation(SanctionsDelistingTimelock tl, SanctionsDelistingTimelock.Route route)
        internal
        view
        returns (bool open)
    {
        if (!tl.list().isRemover(address(tl))) {
            console.log(
                "  Automated delisting: CLOSED - the timelock is not a remover of its list (the owner's one-step shutdown); every execution reverts NotRemover."
            );
        } else if (route == SanctionsDelistingTimelock.Route.Unavailable) {
            console.log(
                "  Automated delisting: CLOSED - no clearance check is configured; every execution reverts ClearanceUnavailable."
            );
        } else {
            open = true;
            console.log(
                "  Automated delisting: OPEN - the timelock is a remover of its list and has a clearance check; a proposal executes only once it passes every check execute makes, a current clearance included."
            );
        }
    }

    /// @notice Logs what this run can establish about `oracle`, read on this
    ///         chain: the stand-in with its live owner and any pending owner,
    ///         or not identified.
    function logOracle(address oracle) internal view {
        if (!isStandIn(oracle)) {
            console.log(
                "    Not identified: it does not say it is the testnet stand-in, and nothing read here says what it is."
            );
            return;
        }
        console.log("    It says it is the TESTNET STAND-IN - NOT RedStone. It flags only what its owner flags.");
        // Both reads first, each reported on its own: what one established is
        // never dropped because the other failed, and "renounced" is said
        // only when the owner reads as zero AND no transfer reads as pending
        // (the delister's `standInControl` follows the same rule).
        (bool ownerRead, address owner) = AdminControl.ownerOf(oracle);
        (bool pendingRead, address pending) = AdminControl.pendingOwnerOf(oracle);
        if (!ownerRead) {
            console.log("    Its owner could not be read, so who controls its flags is not known.");
        } else if (owner != address(0)) {
            console.log("    owner:", owner);
        } else if (pendingRead && pending == address(0)) {
            console.log(
                "    It has no owner (renounced) and no transfer pending: its flags can no longer change and it can no longer be re-published."
            );
        } else {
            console.log("    It has no owner now.");
        }
        if (!pendingRead) {
            console.log("    Its pending owner could not be read.");
        } else if (pending != address(0)) {
            console.log("    An ownership transfer is PENDING to (it controls it once it accepts):", pending);
        }
    }
}
