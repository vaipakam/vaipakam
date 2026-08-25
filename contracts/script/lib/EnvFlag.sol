// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title EnvFlag
 * @notice The ONE implementation of "is this deploy-script boolean env flag on?".
 *
 *         An operator flag is on when, and only when, its value is exactly
 *         `"1"`. Everything else — unset, `"0"`, `"true"`, `"yes"`, a typo,
 *         a stale `"2"` — is OFF. There is no second rule to keep in sync.
 *
 * @dev    Why this is a STRING compare and not `envOr(name, uint256(0)) == 1`,
 *         which is what every one of these sites used to be:
 *
 *         The vendored cheatcode interface states, at
 *         `lib/forge-std/src/Vm.sol:507-509`, that the uint256 overload
 *         "Reverts if the variable could not be parsed. Returns
 *         `defaultValue` if the variable was not found." Read literally, a
 *         present-but-nonnumeric `CONFIGURE_VPFI_PEG=true` REVERTS — and a
 *         revert inside `DiamondConfigSpell.run()` aborts a launch ceremony
 *         partway through, after earlier children have already broadcast.
 *
 *         Empirically it does not: on forge 1.5.1 the uint256 overload
 *         returns the default for a nonnumeric value (measured directly, with
 *         the opt-in value set FIRST so a silently-failed `setEnv` could not
 *         produce a false pass). So the old form was not broken — it was
 *         RELYING ON RUNTIME BEHAVIOUR THAT CONTRADICTS ITS OWN VENDORED
 *         CONTRACT, one forge-std bump away from the documented behaviour
 *         becoming the real one.
 *
 *         The string overload has no such gap: every value parses as a
 *         string, so `isOn` cannot revert on any input, under either reading.
 *         The gate fails closed by construction rather than by measurement.
 *
 *         Deliberately NOT applied to numeric TUNING knobs
 *         (`CCIP_RATE_CAPACITY`, `REWARD_GRACE_SECONDS`, `FINALIZE_MAX_DAYS`,
 *         …). Those genuinely want a number, and a loud revert on garbage is
 *         the right outcome there. This is only for flags whose whole domain
 *         is on/off, where an operator naturally reaches for `true`.
 */
library EnvFlag {
    Vm private constant CHEATS = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @param name Environment variable to read.
    /// @return True only when `name` is set to exactly `"1"`.
    function isOn(string memory name) internal view returns (bool) {
        return keccak256(bytes(CHEATS.envOr(name, string("")))) == keccak256(bytes("1"));
    }
}
