// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title  AdminControl
 * @notice The one rule a deploy or configure script applies before REUSING a
 *         recorded `Ownable2Step` contract instead of deploying a new one:
 *         the admin owns it AND no ownership transfer is pending.
 * @dev    Owner alone is not enough. A pending owner can accept at any time,
 *         and what the script binds to the reused contract — an attestor's
 *         immutable oracle, a timelock's list, the Diamond's screen — then
 *         answers to that account instead of the admin, with nothing in the
 *         script's output to say so. Every reuse decision in the sanctions
 *         scripts goes through this, so the rule is stated once.
 *
 *         Each call is guarded: a contract that does not answer `owner()` or
 *         `pendingOwner()` (no code, another interface) is never reused.
 *
 *         Failing this rule means "do not reuse", never "replace silently": a
 *         script that would deploy a replacement while the unfit contract
 *         still holds a role (a remover of the list, the handler of a
 *         channel) refuses instead, so two live contracts never hold one
 *         role. The refusal is a revert, and each script records its
 *         artifact last, so a refused run sends nothing and records nothing.
 */
library AdminControl {
    /// @notice Whether `target` answers to `admin` alone: owned by it, with no
    ///         transfer pending. False whenever either read fails.
    function aloneControls(address target, address admin) internal view returns (bool) {
        if (target.code.length == 0) return false;
        Ownable2Step owned = Ownable2Step(target);
        try owned.owner() returns (address o) {
            if (o != admin) return false;
        } catch {
            return false;
        }
        try owned.pendingOwner() returns (address pending) {
            return pending == address(0);
        } catch {
            return false;
        }
    }
}
