// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {LibAccessControl} from "../../src/libraries/LibAccessControl.sol";
import {ChainContracts} from "./ChainContracts.sol";

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
 *      The owned contracts come in two parts ({targets}). `read` lists the
 *      contracts a chain MUST carry, from its `addresses.json`: per the
 *      omit-keys policy, canonical and mirror keys are mutually exclusive on
 *      one chain. A key the chain's role does not call for is left out when
 *      absent; a key it DOES call for stays in the list with a zero address,
 *      so an incomplete artifact is a finding rather than a smaller plan.
 *      `read` also says which of them must carry the Pauser Safe as
 *      guardian. Everything ELSE the chain's contracts include that answers
 *      `owner()` is found, not listed (#2743): `ChainContracts.walk` covers
 *      the artifact and the contracts the Diamond itself names (its
 *      registered swap adapters, its rate model, its satellites), so an
 *      owned contract nobody thought to list (the swap adapters were one)
 *      cannot stay on the admin key through the handover.
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

    /// @notice Every Diamond role the protocol defines
    ///         (`LibAccessControl.knownRoles()`, the one list). The handover
    ///         gate checks each one's holders against the plan; the launch
    ///         gate refuses while the deploy key holds any of them.
    function diamondRoles() internal pure returns (bytes32[] memory) {
        return LibAccessControl.knownRoles();
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

    /// @notice One two-step-owned contract in the plan.
    /// @dev `addr` is zero only for a `required` slot the artifact does not
    ///      record. A missing required contract is never read as "nothing to
    ///      hand over": the handover refuses it on a production chain and the
    ///      gate fails it there (reports it as not checked on a testnet).
    ///      `guardian` marks a `GuardianPausable` contract, whose
    ///      `guardian()` must be readable and must be the Pauser Safe.
    struct Target {
        string label;
        address addr;
        OwnableKind kind;
        bool required;
        bool guardian;
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

    /// @notice The listed contracts: the ones this chain MUST carry, with
    ///         their guardian flags. {targets} adds every other owned one.
    /// @dev Which contracts a chain MUST carry follows `DeployCrosschain`:
    ///      the messenger, the VPFI pool, its rate governor and the reward
    ///      messenger everywhere; on canonical Base the token, the buyback
    ///      receiver and the vpfi-return receiver; on a mirror the mirror
    ///      token, the reward remittance receiver and the vpfi-return sender.
    ///      Those are listed even when the artifact lacks them (zero
    ///      address). A contract recorded for the OTHER chain role is still
    ///      listed, not required, so it is handed over rather than ignored.
    ///      The guardian flags follow which contracts inherit
    ///      `GuardianPausable`: the CCIP pool and the rate governor do not.
    ///      The canonical token does since #937.
    function read(string memory json) internal view returns (Target[] memory targets) {
        bool canonical = isCanonical();
        Target[] memory all = new Target[](10);
        uint256 n;
        n = _slot(all, n, "ccipMessenger", readOptional(json, "ccipMessenger"), OwnableKind.OpenZeppelin, true, true);
        n = _slot(all, n, "vpfiTokenPool", readOptional(json, "vpfiTokenPool"), OwnableKind.Chainlink, true, false);
        n = _slot(
            all, n, "vpfiPoolRateGovernor", readOptional(json, "vpfiPoolRateGovernor"), OwnableKind.OpenZeppelin, true, false
        );
        // Pre-#272 artifacts stored the reward messenger under the
        // LayerZero-era key `rewardOApp`; without the fallback the messenger
        // would drop out of both the handover and the gate on such an
        // artifact.
        address rewardMessenger = readOptional(json, "rewardMessenger");
        if (rewardMessenger == address(0)) rewardMessenger = readOptional(json, "rewardOApp");
        n = _slot(all, n, "rewardMessenger", rewardMessenger, OwnableKind.OpenZeppelin, true, true);
        n = _slot(all, n, "vpfiMirror", readOptional(json, "vpfiMirror"), OwnableKind.OpenZeppelin, !canonical, true);
        n = _slot(
            all,
            n,
            "buybackRemittanceReceiver",
            readOptional(json, "buybackRemittanceReceiver"),
            OwnableKind.OpenZeppelin,
            canonical,
            true
        );
        n = _slot(
            all,
            n,
            "rewardRemittanceReceiver",
            readOptional(json, "rewardRemittanceReceiver"),
            OwnableKind.OpenZeppelin,
            !canonical,
            true
        );
        n = _slot(
            all, n, "vpfiReturnSender", readOptional(json, "vpfiReturnSender"), OwnableKind.OpenZeppelin, !canonical, true
        );
        n = _slot(
            all, n, "vpfiReturnReceiver", readOptional(json, "vpfiReturnReceiver"), OwnableKind.OpenZeppelin, canonical, true
        );
        // Canonical VPFI only: on a mirror the local ERC-20 IS `vpfiMirror`,
        // already listed above.
        if (canonical) {
            n = _slot(all, n, "vpfiToken", readOptional(json, "vpfiToken"), OwnableKind.OpenZeppelin, true, true);
        }
        targets = new Target[](n);
        for (uint256 i; i < n; ++i) {
            targets[i] = all[i];
        }
    }

    /// @notice Every owned contract the handover moves to the Timelock and
    ///         the gate checks: the listed ones ({read}) followed by every
    ///         other contract `ChainContracts.walk` finds that answers
    ///         `owner()` (#2743).
    /// @dev A found contract is left out only when it is the Diamond or the
    ///      Timelock (each has its own leg), or when its owner is:
    ///        - the Diamond: its authority is exercised through Diamond
    ///          code, so it is governed by whoever governs the Diamond (the
    ///          backstop vault, the aggregator adapter proxies);
    ///        - zero: nobody holds it (an implementation contract whose
    ///          initializers are disabled, or renounced ownership).
    ///      Anyone else, the admin before the handover and the Timelock
    ///      after it included, keeps it in the plan, so the gate checks it.
    ///      There is no list of contracts to skip. An artifact key naming a
    ///      third-party contract that answers `owner()` (today the artifact
    ///      names none: its tokens are WETH and the testnet mocks are not
    ///      ownable) is therefore reported rather than ignored, and the
    ///      operator decides about it.
    ///
    ///      A found contract's pending owner is read with `pendingOwner()`
    ///      where it answers (OpenZeppelin's two-step). Where it does not,
    ///      the contract is checked like CHAINLINK's shape, from its
    ///      `OwnershipTransferRequested` events: a one-step `Ownable` emits
    ///      none, so it always reads as settled, which is right, since its
    ///      `transferOwnership` takes effect at once.
    function targets(string memory json, address diamond, address timelock) internal view returns (Target[] memory all) {
        Target[] memory listed = read(json);
        ChainContracts.Found[] memory found = ChainContracts.walk(diamond, json);
        Target[] memory buf = new Target[](listed.length + found.length);
        uint256 n;
        for (uint256 i; i < listed.length; ++i) {
            buf[n++] = listed[i];
        }
        for (uint256 i; i < found.length; ++i) {
            address a = found[i].addr;
            if (a == diamond || a == timelock || _listed(listed, a)) continue;
            (bool owned, address owner_) = ownerOf(a);
            if (!owned || owner_ == diamond || owner_ == address(0)) continue;
            (bool readable,) = pendingOwnerOf(a);
            buf[n++] = Target({
                label: found[i].source,
                addr: a,
                kind: readable ? OwnableKind.OpenZeppelin : OwnableKind.Chainlink,
                required: false,
                guardian: false
            });
        }
        all = new Target[](n);
        for (uint256 i; i < n; ++i) {
            all[i] = buf[i];
        }
    }

    /// @notice `a.owner()`, and whether `a` answers it with one word.
    function ownerOf(address a) internal view returns (bool readable, address owner_) {
        if (a.code.length == 0) return (false, address(0));
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || ret.length != 32) return (false, address(0));
        uint256 w = abi.decode(ret, (uint256));
        if (w >> 160 != 0) return (false, address(0));
        return (true, address(uint160(w)));
    }

    /// @notice `a.pendingOwner()`, and whether `a` answers it with one word.
    function pendingOwnerOf(address a) internal view returns (bool readable, address pending) {
        if (a.code.length == 0) return (false, address(0));
        (bool ok, bytes memory ret) = a.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (!ok || ret.length != 32) return (false, address(0));
        uint256 w = abi.decode(ret, (uint256));
        if (w >> 160 != 0) return (false, address(0));
        return (true, address(uint160(w)));
    }

    function _listed(Target[] memory listed, address a) private pure returns (bool) {
        for (uint256 i; i < listed.length; ++i) {
            if (listed[i].addr == a) return true;
        }
        return false;
    }

    /// @notice `json.<key>` as an address, or zero when the key is absent.
    function readOptional(string memory json, string memory key) internal view returns (address) {
        try CHEATS.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
            return a;
        } catch {
            return address(0);
        }
    }

    function _slot(
        Target[] memory all,
        uint256 n,
        string memory label,
        address addr,
        OwnableKind kind,
        bool required,
        bool guardian
    ) private pure returns (uint256) {
        if (addr == address(0) && !required) return n;
        all[n] = Target({label: label, addr: addr, kind: kind, required: required, guardian: guardian});
        return n + 1;
    }
}
