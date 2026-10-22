// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";

/**
 * @title HandoverPlan
 * @notice The ONE statement of what the governance handover produces on a
 *         chain: which Diamond role goes to which principal, and which
 *         two-step-owned contracts move to the Timelock.
 *
 * @dev `Handover.s.sol` performs this plan and `HandoverGate.s.sol` verifies
 *      the live chain against it. Both read it from here, so the gate can
 *      never check a different topology from the one the handover built: a
 *      role or a target added to the handover and forgotten by the gate would
 *      pass the gate while the admin key still held it (#944).
 *
 *      Two-step targets are read from the chain's `addresses.json`. Per the
 *      omit-keys policy, canonical and mirror keys are mutually exclusive on
 *      one chain; a key absent from the artifact is a contract not deployed
 *      here and is left out of the list.
 */
library HandoverPlan {
    address private constant VM_ADDR = address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @dev OpenZeppelin AccessControl's root admin slot.
    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);
    /// @dev OpenZeppelin `TimelockController` roles.
    bytes32 internal constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 internal constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 internal constant CANCELLER_ROLE = keccak256("CANCELLER_ROLE");

    /// @notice The Diamond roles that go to the Timelock besides the role
    ///         root: every action that should wait out the review window.
    /// @dev UNPAUSER_ROLE is here deliberately: PAUSER_ROLE stays on the
    ///      fast-key Pauser Safe and unpause waits for the Timelock, so a
    ///      compromised Pauser key cannot undo its own pause without the
    ///      delay. DEFAULT_ADMIN_ROLE is NOT in this list even though it also
    ///      goes to the Timelock (D1): the handover grants it first and the
    ///      admin renounces it last, outside the loops.
    function timelockRoles() internal pure returns (bytes32[] memory r) {
        r = new bytes32[](6);
        r[0] = LibAccessControl.ADMIN_ROLE;
        r[1] = LibAccessControl.UNPAUSER_ROLE;
        r[2] = LibAccessControl.KYC_ADMIN_ROLE;
        r[3] = LibAccessControl.ORACLE_ADMIN_ROLE;
        r[4] = LibAccessControl.RISK_ADMIN_ROLE;
        r[5] = LibAccessControl.VAULT_ADMIN_ROLE;
    }

    /// @notice The off-chain bot roles, in the order `botRoleEnvNames`
    ///         names their holders. Each goes to its own bot key at handover;
    ///         none of them carries authority over another role.
    function botRoles() internal pure returns (bytes32[] memory r) {
        r = new bytes32[](3);
        r[0] = LibAccessControl.KEEPER_ROLE;
        r[1] = LibAccessControl.WATCHER_ROLE;
        r[2] = LibAccessControl.NOTIF_BILLER_ROLE;
    }

    /// @notice The env variable naming each bot role's holder, parallel to
    ///         `botRoles()`. A zero address means the role is deliberately
    ///         left unheld after the handover.
    function botRoleEnvNames() internal pure returns (string[] memory n) {
        n = new string[](3);
        n[0] = "KEEPER_ADDRESS";
        n[1] = "WATCHER_ADDRESS";
        n[2] = "NOTIF_BILLER_ADDRESS";
    }

    // ── Two-step-owned targets ─────────────────────────────────────────────

    /// @notice How a target's pending owner can be read back.
    /// @dev `OpenZeppelin`: `Ownable2Step(Upgradeable)`, which exposes
    ///      `pendingOwner()`. `Chainlink`: CHAINLINK's `Ownable2Step` (the
    ///      CCIP `TokenPool`), whose pending owner is private and is only
    ///      observable from its `OwnershipTransferRequested` /
    ///      `OwnershipTransferred` events.
    enum OwnableKind {
        OpenZeppelin,
        Chainlink
    }

    struct Target {
        string label;
        address addr;
        OwnableKind kind;
    }

    /// @notice Whether the current chain carries canonical VPFI (Base or
    ///         Base Sepolia). On canonical the token is `vpfiToken`; on a
    ///         mirror it is `vpfiMirror`.
    function isCanonical() internal view returns (bool) {
        return block.chainid == 8453 || block.chainid == 84532;
    }

    /// @notice The chain's VPFI ERC-20: the canonical token on Base, the
    ///         mirror token elsewhere. Zero when the artifact records neither.
    function vpfiToken(string memory json) internal view returns (address) {
        return isCanonical() ? readOptional(json, "vpfiToken") : readOptional(json, "vpfiMirror");
    }

    /// @notice Every two-step-owned contract recorded in `json`.
    function read(string memory json) internal view returns (Target[] memory targets) {
        Target[] memory all = new Target[](10);
        uint256 n;
        n = _push(all, n, "ccipMessenger", readOptional(json, "ccipMessenger"), OwnableKind.OpenZeppelin);
        n = _push(all, n, "vpfiTokenPool", readOptional(json, "vpfiTokenPool"), OwnableKind.Chainlink);
        n = _push(all, n, "vpfiPoolRateGovernor", readOptional(json, "vpfiPoolRateGovernor"), OwnableKind.OpenZeppelin);
        // Pre-#272 artifacts stored the reward messenger under the
        // LayerZero-era key `rewardOApp`; without the fallback the messenger
        // would drop out of both the handover and the gate on such an
        // artifact.
        address rewardMessenger = readOptional(json, "rewardMessenger");
        if (rewardMessenger == address(0)) rewardMessenger = readOptional(json, "rewardOApp");
        n = _push(all, n, "rewardMessenger", rewardMessenger, OwnableKind.OpenZeppelin);
        n = _push(all, n, "vpfiMirror", readOptional(json, "vpfiMirror"), OwnableKind.OpenZeppelin);
        n = _push(
            all, n, "buybackRemittanceReceiver", readOptional(json, "buybackRemittanceReceiver"), OwnableKind.OpenZeppelin
        );
        n = _push(
            all, n, "rewardRemittanceReceiver", readOptional(json, "rewardRemittanceReceiver"), OwnableKind.OpenZeppelin
        );
        n = _push(all, n, "vpfiReturnSender", readOptional(json, "vpfiReturnSender"), OwnableKind.OpenZeppelin);
        n = _push(all, n, "vpfiReturnReceiver", readOptional(json, "vpfiReturnReceiver"), OwnableKind.OpenZeppelin);
        // Canonical VPFI only: on a mirror the local ERC-20 IS `vpfiMirror`,
        // already listed above.
        if (isCanonical()) {
            n = _push(all, n, "vpfiToken", readOptional(json, "vpfiToken"), OwnableKind.OpenZeppelin);
        }
        targets = new Target[](n);
        for (uint256 i; i < n; ++i) {
            targets[i] = all[i];
        }
    }

    /// @notice `json.<key>` as an address, or zero when the key is absent.
    function readOptional(string memory json, string memory key) internal view returns (address) {
        try CHEATS.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _push(Target[] memory all, uint256 n, string memory label, address addr, OwnableKind kind)
        private
        pure
        returns (uint256)
    {
        if (addr == address(0)) return n;
        all[n] = Target({label: label, addr: addr, kind: kind});
        return n + 1;
    }
}
