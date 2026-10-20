// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title  AdminControl
 * @notice The one rule a sanctions deploy or configure script applies to a
 *         recorded `Ownable2Step` contract before it REUSES it, WRITES through
 *         it or BINDS anything to it: the admin owns it AND no ownership
 *         transfer is pending.
 * @dev    Owner alone is not enough. A pending owner can accept at any time,
 *         and whatever the script just set or bound — a list's roles, a
 *         timelock's clearance source, a messenger's lanes and channels, an
 *         attestor's immutable oracle, the Diamond's screen — then answers to
 *         that account instead of the admin, with nothing in the script's
 *         output to say so. Every such decision in the sanctions scripts goes
 *         through this library, so the rule is stated once. (The Diamond
 *         itself is owned in one step, `IERC173`, so it has no pending state
 *         to rule out and is checked by its owner alone.)
 *
 *         Every read is a low-level `staticcall` judged here, so ANY read that
 *         does not return one well-formed address — no code, a revert, another
 *         interface, a fallback that returns nothing — is a no, never a revert
 *         that would stop the script on a decoding failure.
 *
 *         Failing this rule means "do not reuse" or "do not act", never
 *         "replace silently": a script that would deploy a replacement while
 *         the unfit contract still holds a role (a remover of the list, the
 *         handler of a channel) refuses instead, so two live contracts never
 *         hold one role. The refusal is a revert, and each script records its
 *         artifact last, so a refused run sends nothing and records nothing.
 */
library AdminControl {
    /// @notice Whether `target` answers to `admin` alone: owned by it, with no
    ///         transfer pending. False whenever either read fails.
    function aloneControls(address target, address admin) internal view returns (bool) {
        (bool ownerRead, address o) = ownerOf(target);
        if (!ownerRead || o != admin) return false;
        (bool pendingRead, address pending) = pendingOwnerOf(target);
        return pendingRead && pending == address(0);
    }

    /// @notice Reverts unless {aloneControls} holds, naming `what` and the
    ///         remedy. For a recorded contract the script is about to write
    ///         through or bind to, where there is nothing to deploy instead.
    function requireAloneControls(address target, address admin, string memory what) internal view {
        require(
            aloneControls(target, admin),
            string.concat(
                what,
                " is not one the admin alone controls (another owner, or an ownership transfer pending) - cancel or complete the transfer, then re-run. Nothing was sent or recorded"
            )
        );
    }

    /// @notice `target.owner()`, and whether it returned one address.
    function ownerOf(address target) internal view returns (bool ok, address value) {
        return _readAddress(target, Ownable.owner.selector);
    }

    /// @notice `target.pendingOwner()`, and whether it returned one address.
    function pendingOwnerOf(address target) internal view returns (bool ok, address value) {
        return _readAddress(target, Ownable2Step.pendingOwner.selector);
    }

    /// @dev One no-argument view returning an address, judged here: a call
    ///      that fails, returns anything but one 32-byte word, or a word with
    ///      high bits set is `ok == false`.
    function _readAddress(address target, bytes4 selector) private view returns (bool ok, address value) {
        if (target.code.length == 0) return (false, address(0));
        (bool success, bytes memory ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!success || ret.length != 32) return (false, address(0));
        uint256 word = abi.decode(ret, (uint256));
        if (word > type(uint160).max) return (false, address(0));
        return (true, address(uint160(word)));
    }
}
