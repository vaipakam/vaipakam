// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";
import {Deployments} from "./Deployments.sol";
import {TotalRead} from "./TotalRead.sol";

/// @dev The one read {SanctionsRecords.serves} makes, as an interface so its
///      selector can be named (a public state variable's getter has none on
///      the contract type).
interface ITimelockList {
    function list() external view returns (address);
}

/**
 * @title  SanctionsRecords
 * @notice The one rule for how a chain's recorded sanctions contracts belong
 *         together: the recorded delisting timelock serves the recorded list.
 * @dev    #2443. A timelock is bound to its list for good (`list()` is
 *         immutable), so a timelock record and a list record that do not
 *         match describe two different delisting set-ups, and wiring the
 *         route to the stale one would leave the current list without it
 *         (and, once the stale timelock holds the clearance channel, block
 *         the right one from taking it).
 *
 *         The rule is kept at both ends:
 *         - **Writers keep the records bound.** `DeploySanctionsDelisting`
 *           records only a timelock that serves the recorded list, and
 *           `DeploySanctionsList` never starts a new list while a timelock is
 *           still recorded (it serves another list, by construction).
 *         - **Readers check it where they act.** `ConfigureSanctionsClearance`
 *           wires a timelock chain only through {requireRecordedTimelock};
 *           the delister bot refuses a chain whose timelock serves another
 *           list (`refusal`).
 *
 *         The attestor chain's run reads the other chains' recorded timelocks
 *         from their artifacts and cannot read those chains, so it relies on
 *         the writers above; the timelock chain's own run then checks the
 *         binding against the contract itself.
 */
library SanctionsRecords {
    /// @notice Whether `timelock` serves `list`: `list()` answers, as a
    ///         {TotalRead}, with that address. Any other outcome — no code, a
    ///         revert, another interface, a malformed answer — is false, never
    ///         a revert.
    function serves(address timelock, address list) internal view returns (bool) {
        if (list == address(0)) return false;
        (bool ok, address served) = TotalRead.addressOf(timelock, ITimelockList.list.selector);
        return ok && served == list;
    }

    /// @notice This chain's recorded timelock, required to serve this chain's
    ///         recorded list. Reverts naming `who` and the remedy otherwise.
    function requireRecordedTimelock(string memory who) internal view returns (SanctionsDelistingTimelock) {
        address list = Deployments.readSanctionsListOptional();
        address timelock = Deployments.readSanctionsDelistingTimelockOptional();
        require(
            serves(timelock, list),
            string.concat(
                who,
                ": this chain's recorded sanctionsDelistingTimelock does not serve its recorded sanctionsList (or one of them is not recorded, or has no code). A timelock is bound to its list for good, so the route is wired only to the timelock of the recorded list - run DeploySanctionsDelisting for that list first. Nothing was sent or recorded"
            )
        );
        return SanctionsDelistingTimelock(payable(timelock));
    }
}
